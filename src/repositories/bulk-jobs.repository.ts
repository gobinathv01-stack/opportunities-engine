import { Injectable } from '@nestjs/common';
import { BulkJobRow } from '../entities/bulk-job.entity';
import { Queryable } from '../interfaces/queryable';
import { DatabaseService } from '../services/database.service';

const JOB_SELECT = `
  SELECT j.id, j.workspace_id, j.state, j.phase, j.request_hash, j.total, j.moved, j.skipped_conflict, j.attempt, j.error,
         j.filter, j.filter ->> 'target_stage' AS target_stage, j.created_at, j.started_at, j.last_progress_at, j.finished_at, j.lease_expires_at,
         extract(epoch FROM (now() - j.last_progress_at))::float8 AS secs_since_progress,
         extract(epoch FROM (j.last_progress_at - j.started_at))::float8 AS active_secs,
         coalesce(j.lease_expires_at < now(), false) AS lease_expired
    FROM bulk_jobs j`;

export interface NewJob {
  workspaceId: string;
  idempotencyKey: string;
  requestHash: string;
  filter: unknown;
  targetStageSk: number;
}

/** SQL for submitting a job and reading its progress. The worker's SQL (snapshot batches, chunks) is in BulkWorkerRepository. */
@Injectable()
export class BulkJobsRepository {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Inserts the job unless this workspace already used the key. Returns the new id, or null if the key exists.
   * The job starts in phase 'snapshot' (the column default): the worker builds its item list later.
   */
  async insert(j: NewJob, q: Queryable = this.db): Promise<string | null> {
    const { rows } = await q.query<{ id: string }>(
      `INSERT INTO bulk_jobs (workspace_id, idempotency_key, request_hash, filter, target_stage_sk)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [j.workspaceId, j.idempotencyKey, j.requestHash, JSON.stringify(j.filter), j.targetStageSk],
    );
    return rows[0]?.id ?? null;
  }

  async findById(workspaceId: string, id: string, q: Queryable = this.db): Promise<BulkJobRow | null> {
    const { rows } = await q.query<BulkJobRow>(`${JOB_SELECT} WHERE j.workspace_id = $1 AND j.id = $2`, [workspaceId, id]);
    return rows[0] ?? null;
  }

  async findByKey(workspaceId: string, key: string, q: Queryable = this.db): Promise<BulkJobRow | null> {
    const { rows } = await q.query<BulkJobRow>(`${JOB_SELECT} WHERE j.workspace_id = $1 AND j.idempotency_key = $2`, [workspaceId, key]);
    return rows[0] ?? null;
  }

  async findActiveId(workspaceId: string, q: Queryable = this.db): Promise<string | null> {
    const { rows } = await q.query<{ id: string }>(
      `SELECT id FROM bulk_jobs WHERE workspace_id = $1 AND state IN ('queued', 'running')`, [workspaceId],
    );
    return rows[0]?.id ?? null;
  }
}
