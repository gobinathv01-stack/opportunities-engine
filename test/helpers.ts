import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { BulkWorkerModule } from '../src/modules/bulk-worker.module';
import { BulkJobsService } from '../src/services/bulk-jobs.service';
import { BulkWorkerService } from '../src/services/bulk-worker.service';
import { DatabaseService } from '../src/services/database.service';

export const STAGES = ['lead', 'contacted', 'qualified', 'done'];

/**
 * Starts the app on a loopback port chosen by the OS and returns its URL, for supertest to call.
 * Passing the server itself to supertest makes it listen on all interfaces on a fresh port per request, and on a
 * developer machine another process (an editor helper, a port forwarder) may already hold that port on 127.0.0.1;
 * the request then reaches that process and comes back as a spurious 400/404. Binding 127.0.0.1 explicitly cannot clash.
 */
export async function listenOnLoopback(app: INestApplication): Promise<string> {
  await app.listen(0, '127.0.0.1');
  return app.getUrl();
}

export interface TestEnv {
  app: INestApplication;
  url: string;
  db: DatabaseService;
  worker: BulkWorkerService;
  jobs: BulkJobsService;
}

/** The API plus the worker service in one process. Loops are not started: tests drive the worker step by step. */
export async function createEnv(): Promise<TestEnv> {
  const mod = await Test.createTestingModule({ imports: [AppModule, BulkWorkerModule] }).compile();
  const app = mod.createNestApplication();
  configureApp(app);
  await app.init();
  const url = await listenOnLoopback(app);
  const worker = app.get(BulkWorkerService);
  worker.options.chunkSize = 10;
  worker.options.snapshotBatchSize = 25;
  return { app, url, db: app.get(DatabaseService), worker, jobs: app.get(BulkJobsService) };
}

let counter = 0;
/** A fresh, valid workspace slug (2-32 chars) per call. */
export const slug = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function createWorkspace(db: DatabaseService, id: string, stages: string[] = STAGES) {
  await db.query(`INSERT INTO workspaces (id, name) VALUES ($1, $1)`, [id]);
  for (const [i, key] of stages.entries()) {
    await db.query(`INSERT INTO stages (workspace_id, key, position) VALUES ($1, $2, $3)`, [id, key, i + 1]);
  }
  return id;
}

export interface Deal {
  stage: string;
  owner?: string;
  status?: string;
  value?: number;
  created?: string;
}

/** Inserts deals directly (fast, and lets tests control owner/status/value/created_at). Returns their ids in order. */
export async function addDeals(db: DatabaseService, ws: string, deals: Deal[]): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, d] of deals.entries()) {
    const created = d.created ?? new Date(Date.now() - 86_400_000 * (i + 1)).toISOString();
    const { rows } = await db.query(
      `INSERT INTO opportunities (workspace_id, stage_sk, name, value, status, owner_id, created_at, updated_at)
       SELECT $1, sk, $3, $4, $5, $6, $7::timestamptz, $7::timestamptz FROM stages WHERE workspace_id = $1 AND key = $2
       RETURNING id::text`,
      [ws, d.stage, `deal-${i}`, d.value ?? 1000, d.status ?? 'open', d.owner ?? 'priya', created],
    );
    ids.push(rows[0].id);
  }
  return ids;
}

export const many = (n: number, deal: Deal): Deal[] => Array.from({ length: n }, () => ({ ...deal }));

export function api(env: TestEnv) {
  const http = () => request(env.url);
  return {
    submit: (ws: string, key: string | null, body: object) => {
      const r = http().post('/bulk-moves').set('X-Workspace-Id', ws);
      return (key === null ? r : r.set('Idempotency-Key', key)).send(body);
    },
    progress: (ws: string, id: string) => http().get(`/bulk-moves/${id}`).set('X-Workspace-Id', ws),
    move: (ws: string, id: string, stage: string) =>
      http().post(`/opportunities/${id}/move`).set('X-Workspace-Id', ws).send({ stage }),
  };
}

/**
 * Runs only the snapshot phase of a submitted job, then hands the job back: it is left queued with its item list
 * complete and nothing moved (or completed, if nothing matched; or failed, if the filter was too broad).
 */
export async function takeSnapshot(env: TestEnv, ws: string, jobId: string) {
  const claim = await env.worker.claim({ workspaceId: ws, jobId });
  if (!claim) throw new Error('the job cannot be claimed (already running or finished?)');
  const snapshotting = async () =>
    (await env.db.query(
      `SELECT (phase = 'snapshot' AND state = 'running') AS yes FROM bulk_jobs WHERE workspace_id = $1 AND id = $2`, [ws, jobId],
    )).rows[0].yes as boolean;
  while (await snapshotting()) await env.worker.processChunk(claim);
  await env.db.query(
    `UPDATE bulk_jobs SET state = 'queued', lease_token = NULL, lease_expires_at = NULL WHERE workspace_id = $1 AND id = $2 AND state = 'running'`,
    [ws, jobId],
  );
}

/** Makes a running job's lease look expired, as if its worker had died a while ago. */
export const expireLease = (db: DatabaseService, ws: string, jobId: string) =>
  db.query(`UPDATE bulk_jobs SET lease_expires_at = now() - interval '1 second' WHERE workspace_id = $1 AND id = $2`, [ws, jobId]);

export const stageOf = async (db: DatabaseService, ws: string, id: string) =>
  (await db.query(
    `SELECT s.key AS stage, o.version FROM opportunities o JOIN stages s ON s.sk = o.stage_sk WHERE o.workspace_id = $1 AND o.id = $2`,
    [ws, id],
  )).rows[0] as { stage: string; version: number };

/**
 * What "correct" means for a finished job (this is the definition used in DESIGN.md):
 *  - every snapshot item has exactly one terminal outcome, and the counters equal the item counts
 *  - every moved item's deal is in the target stage, its version went up by exactly one,
 *    and it has exactly one bulk transition from its original stage
 *  - every skipped item has no bulk transition and was not touched by the job
 */
export async function expectJobCorrect(db: DatabaseService, ws: string, jobId: string, targetStage: string) {
  const job = (await db.query(`SELECT * FROM bulk_jobs WHERE workspace_id = $1 AND id = $2`, [ws, jobId])).rows[0];
  const items = (await db.query(
    `SELECT i.seq, i.outcome, i.from_stage_sk, i.expected_version, i.opportunity_id::text AS opp, s.key AS stage, o.version,
            (SELECT count(*)::int FROM transitions t WHERE t.job_id = i.job_id AND t.opportunity_id = i.opportunity_id
                AND t.from_stage_sk = i.from_stage_sk AND t.to_stage_sk = j.target_stage_sk) AS bulk_transitions
       FROM bulk_job_items i
       JOIN bulk_jobs j ON j.workspace_id = i.workspace_id AND j.id = i.job_id
       JOIN opportunities o ON o.workspace_id = i.workspace_id AND o.id = i.opportunity_id
       JOIN stages s ON s.sk = o.stage_sk
      WHERE i.workspace_id = $1 AND i.job_id = $2 ORDER BY i.seq`,
    [ws, jobId],
  )).rows;

  expect(job.state).toBe('completed');
  expect(items).toHaveLength(job.total);
  expect(items.every((i) => i.outcome !== null)).toBe(true);
  const moved = items.filter((i) => i.outcome === 'moved');
  const skipped = items.filter((i) => i.outcome === 'skipped_conflict');
  expect(job.moved).toBe(moved.length);
  expect(job.skipped_conflict).toBe(skipped.length);
  expect(job.moved + job.skipped_conflict).toBe(job.total);
  expect(job.cursor_seq).toBe(job.total);
  for (const m of moved) {
    expect(m.stage).toBe(targetStage);
    expect(m.version).toBe(m.expected_version + 1);
    expect(m.bulk_transitions).toBe(1);
  }
  for (const s of skipped) expect(s.bulk_transitions).toBe(0);
  const total = (await db.query(`SELECT count(*)::int AS n FROM transitions WHERE job_id = $1`, [jobId])).rows[0].n;
  expect(total).toBe(moved.length);
  return { job, moved, skipped };
}
