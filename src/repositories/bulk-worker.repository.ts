import { Injectable } from '@nestjs/common';
import { CanonicalRequest } from '../common/bulk-request';
import { Queryable } from '../interfaces/queryable';
import { DatabaseService } from '../services/database.service';
import { buildFilterSql, FilterCriteria } from './bulk-filter';

/**
 * SQL the background worker runs. Everything that changes job state is fenced by the lease token.
 */
export const CHUNK_SQL = `
  WITH chunk AS MATERIALIZED (
    SELECT seq, opportunity_id, from_stage_sk, expected_version
      FROM bulk_job_items
     WHERE workspace_id = $1::text AND job_id = $2::uuid AND seq > $3::int AND seq <= $3::int + $4::int
  ), moved AS (
    UPDATE opportunities o
       SET stage_sk = $5::int, version = o.version + 1, updated_at = now()
      FROM chunk c
     WHERE o.workspace_id = $1::text AND o.id = c.opportunity_id AND o.version = c.expected_version
    RETURNING o.id, c.seq, c.from_stage_sk
  ), recorded AS (
    INSERT INTO transitions (workspace_id, opportunity_id, from_stage_sk, to_stage_sk, source, job_id)
    SELECT $1::text, m.id, m.from_stage_sk, $5::int, 'bulk', $2::uuid FROM moved m
    ON CONFLICT (job_id, opportunity_id) WHERE job_id IS NOT NULL DO NOTHING
    RETURNING 1
  ), marked AS (
    UPDATE bulk_job_items i
       SET outcome = CASE WHEN EXISTS (SELECT 1 FROM moved m WHERE m.seq = i.seq) THEN 'moved' ELSE 'skipped_conflict' END
     WHERE i.workspace_id = $1::text AND i.job_id = $2::uuid AND i.seq > $3::int AND i.seq <= $3::int + $4::int
    RETURNING i.seq, i.outcome
  )
  SELECT count(*) FILTER (WHERE outcome = 'moved')::int AS moved,
         count(*) FILTER (WHERE outcome = 'skipped_conflict')::int AS skipped,
         coalesce(max(seq), $3::int)::int AS max_seq
    FROM marked`;

export type Phase = 'snapshot' | 'move';

/** A job this worker currently owns. leaseToken is the fencing token: only its holder may commit. */
export interface Claim {
  workspaceId: string;
  jobId: string;
  leaseToken: string;
  targetStageSk: number;
  /** The job's stored (canonical) filter. */
  filter: CanonicalRequest['filter'];
  /** `filter` as SQL criteria, resolved once by the worker on first use. */
  criteria?: FilterCriteria;
}

export interface JobProgress {
  phase: Phase;
  cursorSeq: number;
  /** Items in the snapshot: final once phase is 'move', the count so far while it is 'snapshot'. */
  total: number;
  done: number; // moved + skipped so far
  snapshotCursorId: string; // last opportunity id the snapshot scan covered (a bigint, so a string)
  submittedAt: string; // as text, to keep the database's microseconds
}

export interface SnapshotBatch {
  found: number;
  lastId: string | null;
}

/** What the snapshot phase should record after a batch. */
export interface SnapshotOutcome {
  cursorId: string;
  total: number;
  phase: 'snapshot' | 'move';
  state: 'running' | 'completed' | 'failed';
  error: string | null;
}

export interface ChunkResult {
  moved: number;
  skipped: number;
  maxSeq: number;
}

/** SQL the background worker runs. Everything that changes job state is fenced by the lease token. */
@Injectable()
export class BulkWorkerRepository {
  constructor(private readonly db: DatabaseService) {}

  /** Takes the next queued job, or one whose worker died (lease expired). Oldest-served first. `only` is for tests. */
  async claimNext(leaseTtlMs: number, only?: { workspaceId: string; jobId: string }): Promise<Claim | null> {
    const { rows } = await this.db.query(
      `UPDATE bulk_jobs j
          SET state = 'running',
              lease_token = gen_random_uuid(),
              lease_expires_at = now() + ($1::int * interval '1 millisecond'),
              -- attempt counts starts and crash recoveries; resuming after a deliberate yield is not a retry
              attempt = j.attempt + CASE WHEN j.state = 'queued' AND j.started_at IS NOT NULL THEN 0 ELSE 1 END,
              started_at = coalesce(j.started_at, now()),
              last_progress_at = now()
        WHERE (j.workspace_id, j.id) = (
                SELECT workspace_id, id FROM bulk_jobs
                 WHERE (state = 'queued' OR (state = 'running' AND lease_expires_at < now()))
                   AND ($2::uuid IS NULL OR (workspace_id = $3::text AND id = $2::uuid))
                 ORDER BY coalesce(last_progress_at, created_at)
                 LIMIT 1
                 FOR UPDATE SKIP LOCKED)
        RETURNING j.workspace_id, j.id, j.lease_token, j.target_stage_sk, j.filter -> 'filter' AS request_filter`,
      [leaseTtlMs, only?.jobId ?? null, only?.workspaceId ?? null],
    );
    const r = rows[0];
    return r
      ? { workspaceId: r.workspace_id, jobId: r.id, leaseToken: r.lease_token, targetStageSk: r.target_stage_sk, filter: r.request_filter }
      : null;
  }

  /** Locks the job row if this worker still holds the lease; null means the lease was lost. */
  async lockJob(claim: Claim, q: Queryable): Promise<JobProgress | null> {
    const { rows } = await q.query(
      `SELECT phase, cursor_seq, total, moved + skipped_conflict AS done, snapshot_cursor_id::text AS snapshot_cursor_id, created_at::text AS submitted_at
         FROM bulk_jobs
        WHERE workspace_id = $1 AND id = $2 AND lease_token = $3 AND state = 'running'
          FOR UPDATE`,
      [claim.workspaceId, claim.jobId, claim.leaseToken],
    );
    const r = rows[0];
    return r
      ? { phase: r.phase, cursorSeq: r.cursor_seq, total: r.total, done: r.done, snapshotCursorId: r.snapshot_cursor_id, submittedAt: r.submitted_at }
      : null;
  }

  /** Appends the next `limit` matching deals (ascending id, after the scan cursor) to the item list, numbered from `total+1`. */
  async applySnapshotBatch(
    claim: Claim, criteria: FilterCriteria, job: JobProgress, limit: number, q: Queryable,
  ): Promise<SnapshotBatch> {
    const filter = buildFilterSql(criteria, 8);
    const { rows } = await q.query(
      `WITH picked AS (
         SELECT o.id, o.stage_sk, o.version
           FROM opportunities o
          WHERE o.workspace_id = $1::text AND o.id > $3::bigint AND o.stage_sk <> $4::int AND o.created_at <= $7::timestamptz
            AND ${filter.sql}
          ORDER BY o.id
          LIMIT $5::int
       ), numbered AS (
         SELECT id, stage_sk, version, $6::int + row_number() OVER (ORDER BY id) AS seq FROM picked
       ), inserted AS (
         INSERT INTO bulk_job_items (workspace_id, job_id, seq, opportunity_id, from_stage_sk, expected_version)
         SELECT $1::text, $2::uuid, seq, id, stage_sk, version FROM numbered
         RETURNING 1
       )
       SELECT (SELECT count(*) FROM inserted)::int AS found, (SELECT max(id) FROM picked)::text AS last_id`,
      [claim.workspaceId, claim.jobId, job.snapshotCursorId, claim.targetStageSk, limit, job.total, job.submittedAt, ...filter.params],
    );
    return { found: rows[0].found, lastId: rows[0].last_id };
  }

  /** Records the scan cursor, running total, and the phase/state switch when the scan ends. False = lease lost. */
  async recordSnapshot(claim: Claim, o: SnapshotOutcome, leaseTtlMs: number, q: Queryable): Promise<boolean> {
    const { rowCount } = await q.query(
      `UPDATE bulk_jobs
          SET snapshot_cursor_id = $4::bigint,
              total = $5::int,
              phase = $6::text,
              state = $7::text,
              error = $8::text,
              last_progress_at = now(),
              finished_at = CASE WHEN $7::text <> 'running' THEN now() END,
              lease_token = CASE WHEN $7::text <> 'running' THEN NULL ELSE lease_token END,
              lease_expires_at = CASE WHEN $7::text <> 'running' THEN NULL ELSE now() + ($9::int * interval '1 millisecond') END
        WHERE workspace_id = $1 AND id = $2 AND lease_token = $3`,
      [claim.workspaceId, claim.jobId, claim.leaseToken, o.cursorId, o.total, o.phase, o.state, o.error, leaseTtlMs],
    );
    return rowCount === 1;
  }

  /** Moves each deal still at its snapshot version, records transitions, and marks every item. A manual edit since the snapshot wins. */
  async applyChunk(claim: Claim, cursorSeq: number, chunkSize: number, q: Queryable): Promise<ChunkResult> {
    const { rows } = await q.query(CHUNK_SQL, [claim.workspaceId, claim.jobId, cursorSeq, chunkSize, claim.targetStageSk]);
    return { moved: rows[0].moved, skipped: rows[0].skipped, maxSeq: rows[0].max_seq };
  }

  /** Advances the cursor and counters; completes the job when nothing is left. False = lease lost. */
  async recordProgress(claim: Claim, r: ChunkResult, finished: boolean, leaseTtlMs: number, q: Queryable): Promise<boolean> {
    const { rowCount } = await q.query(
      `UPDATE bulk_jobs
          SET cursor_seq = $4,
              moved = moved + $5,
              skipped_conflict = skipped_conflict + $6,
              last_progress_at = now(),
              state = CASE WHEN $7 THEN 'completed' ELSE 'running' END,
              finished_at = CASE WHEN $7 THEN now() END,
              lease_token = CASE WHEN $7 THEN NULL ELSE lease_token END,
              lease_expires_at = CASE WHEN $7 THEN NULL ELSE now() + ($8::int * interval '1 millisecond') END
        WHERE workspace_id = $1 AND id = $2 AND lease_token = $3`,
      [claim.workspaceId, claim.jobId, claim.leaseToken, r.maxSeq, r.moved, r.skipped, finished, leaseTtlMs],
    );
    return rowCount === 1;
  }

  /** Keeps the lease alive between attempts (e.g. while backing off after an error). False = lease lost. */
  async extendLease(claim: Claim, leaseTtlMs: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE bulk_jobs SET lease_expires_at = now() + ($4::int * interval '1 millisecond')
        WHERE workspace_id = $1 AND id = $2 AND lease_token = $3 AND state = 'running'`,
      [claim.workspaceId, claim.jobId, claim.leaseToken, leaseTtlMs],
    );
    return rowCount === 1;
  }

  async fail(claim: Claim, message: string): Promise<void> {
    await this.db.query(
      `UPDATE bulk_jobs
          SET state = 'failed', error = $4, finished_at = now(), lease_token = NULL, lease_expires_at = NULL
        WHERE workspace_id = $1 AND id = $2 AND lease_token = $3`,
      [claim.workspaceId, claim.jobId, claim.leaseToken, message.slice(0, 1000)],
    );
  }

  /** True if another job is waiting for a worker (queued, or running with an expired lease). */
  async otherJobWaiting(claim: Claim): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `SELECT 1 FROM bulk_jobs
        WHERE (state = 'queued' OR (state = 'running' AND lease_expires_at < now()))
          AND NOT (workspace_id = $1 AND id = $2)
        LIMIT 1`,
      [claim.workspaceId, claim.jobId],
    );
    return rowCount === 1;
  }

  /** Hands the job back to the queue at once, progress kept, to wait its turn behind whatever's waiting longer. */
  async yieldJob(claim: Claim): Promise<void> {
    await this.db.query(
      `UPDATE bulk_jobs SET state = 'queued', lease_token = NULL, lease_expires_at = NULL
        WHERE workspace_id = $1 AND id = $2 AND lease_token = $3 AND state = 'running'`,
      [claim.workspaceId, claim.jobId, claim.leaseToken],
    );
  }
}
