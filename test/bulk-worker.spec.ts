import { Client } from 'pg';
import { computeHealth } from '../src/common/bulk-health';
import { CHUNK_SQL } from '../src/repositories/bulk-worker.repository';
import { LeaseLostError } from '../src/services/bulk-worker.service';
import { TEST_DATABASE_URL } from './test-db';
import { addDeals, api, createEnv, createWorkspace, expectJobCorrect, expireLease, many, slug, stageOf, takeSnapshot, TestEnv } from './helpers';

// The worker: completion, resume after a kill, fencing, and the collision with manual edits.
describe('bulk move: worker', () => {
  let env: TestEnv;
  let call: ReturnType<typeof api>;
  beforeAll(async () => {
    env = await createEnv();
    call = api(env);
  });
  afterAll(() => env.app.close());

  /**
   * A workspace with `n` deals in "lead", and a submitted job moving them all to "done".
   * Unless `snapshot` is false its snapshot is already taken, so a test can start straight at the moves.
   */
  async function setup(n = 45, name = 'w', snapshot = true) {
    // The worker claims the oldest runnable job in the whole database, so a job left over from an
    // earlier test would be picked up instead of this test's own. Start every test with none.
    await env.db.query(
      `UPDATE bulk_jobs SET state = 'failed', error = 'test cleanup', lease_token = NULL, lease_expires_at = NULL WHERE state IN ('queued', 'running')`,
    );
    const ws = await createWorkspace(env.db, slug(name));
    const ids = await addDeals(env.db, ws, many(n, { stage: 'lead' }));
    const res = await call.submit(ws, 'job', { filter: { stage: 'lead' }, target_stage: 'done' }).expect(202);
    if (snapshot) await takeSnapshot(env, ws, res.body.id);
    return { ws, ids, jobId: res.body.id as string };
  }
  const claim = async () => (await env.worker.claim())!;
  const repo = () => (env.worker as any).repo;

  it('moves every matching deal exactly once, in chunks, and ends in a provably correct state', async () => {
    const { ws, jobId } = await setup(45);
    expect(await env.worker.runOnce()).toBe(true);
    const { job, moved } = await expectJobCorrect(env.db, ws, jobId, 'done');
    expect(moved).toHaveLength(45);
    expect(job.attempt).toBe(1);
    expect(job.lease_token).toBeNull(); // lease released at completion
    const view = (await call.progress(ws, jobId).expect(200)).body;
    expect(view).toMatchObject({ state: 'completed', health: 'completed', total: 45, moved: 45, remaining: 0, percent: 100 });
  });

  it('commits chunk by chunk, and progress reports exactly what is committed', async () => {
    const { ws, jobId } = await setup(45);
    const c = await claim();
    await env.worker.processChunk(c);
    let view = (await call.progress(ws, jobId).expect(200)).body;
    expect(view).toMatchObject({ state: 'running', total: 45, processed: 10, moved: 10, remaining: 35, percent: 22.2 });
    await env.worker.processChunk(c);
    view = (await call.progress(ws, jobId).expect(200)).body;
    expect(view).toMatchObject({ processed: 20, remaining: 25 });
    const inDb = (await env.db.query(`SELECT count(*)::int n FROM bulk_job_items WHERE job_id = $1 AND outcome = 'moved'`, [jobId])).rows[0].n;
    expect(inDb).toBe(view.processed); // the endpoint agrees with the rows, not with any counter in memory
  });

  describe('resumable', () => {
    it('killed between chunks: a later worker finishes the job, and the result is correct', async () => {
      const { ws, jobId } = await setup(45);
      const a = await claim();
      await env.worker.processChunk(a);
      await env.worker.processChunk(a);
      // ...worker A is killed here: 20 of 45 committed. It never runs again.

      // What the user sees while half applied: running, 20/45, some deals moved and some not.
      let view = (await call.progress(ws, jobId).expect(200)).body;
      expect(view).toMatchObject({ state: 'running', processed: 20, remaining: 25, health: 'progressing' });
      const halfway = (await env.db.query(
        `SELECT s.key, count(*)::int n FROM opportunities o JOIN stages s ON s.sk = o.stage_sk WHERE o.workspace_id = $1 GROUP BY 1 ORDER BY 1`, [ws],
      )).rows;
      expect(halfway).toEqual([{ key: 'done', n: 20 }, { key: 'lead', n: 25 }]); // mixed, but no deal is half-moved

      // Before the lease expires nobody may take over; after it expires the job is visibly stalled.
      expect(await env.worker.claim()).toBeNull();
      await expireLease(env.db, ws, jobId);
      view = (await call.progress(ws, jobId).expect(200)).body;
      expect(view).toMatchObject({ state: 'running', health: 'stalled', processed: 20 });

      // Worker B takes over from the committed cursor.
      expect(await env.worker.runOnce()).toBe(true);
      const { job } = await expectJobCorrect(env.db, ws, jobId, 'done');
      expect(job.attempt).toBe(2);
    });

    it('killed in the middle of a chunk: that chunk leaves no trace and is redone', async () => {
      const { ws, ids, jobId } = await setup(25);
      const c = await claim();
      const original = repo().recordProgress;
      repo().recordProgress = async () => { throw new Error('worker killed mid-chunk'); }; // dies after moving the deals, before commit
      try {
        await expect(env.worker.processChunk(c)).rejects.toThrow('killed mid-chunk');
      } finally {
        repo().recordProgress = original;
      }
      // Everything the chunk did was rolled back: deals, transitions, item marks and cursor.
      for (const id of ids) expect(await stageOf(env.db, ws, id)).toEqual({ stage: 'lead', version: 1 });
      expect((await env.db.query(`SELECT count(*)::int n FROM transitions WHERE job_id = $1`, [jobId])).rows[0].n).toBe(0);
      expect((await env.db.query(`SELECT count(*)::int n FROM bulk_job_items WHERE job_id = $1 AND outcome IS NOT NULL`, [jobId])).rows[0].n).toBe(0);
      expect((await env.db.query(`SELECT cursor_seq FROM bulk_jobs WHERE id = $1`, [jobId])).rows[0].cursor_seq).toBe(0);

      await env.worker.runJob(c); // the same worker carries on and finishes
      await expectJobCorrect(env.db, ws, jobId, 'done');
    });

    it('a transient failure is retried and the job still ends correct', async () => {
      const { ws, jobId } = await setup(25);
      const c = await claim();
      const original = repo().applyChunk;
      let failures = 0;
      repo().applyChunk = async (...args: unknown[]) => {
        if (failures++ < 2) throw new Error('connection reset');
        return original.apply(repo(), args);
      };
      try {
        await env.worker.runJob(c);
      } finally {
        repo().applyChunk = original;
      }
      expect(failures).toBeGreaterThan(2);
      await expectJobCorrect(env.db, ws, jobId, 'done');
    });

    it('a persistent failure marks the job failed, keeps what was committed, and says why', async () => {
      const { ws, jobId } = await setup(45);
      const c = await claim();
      await env.worker.processChunk(c); // 10 committed
      const original = repo().applyChunk;
      repo().applyChunk = async () => { throw new Error('disk on fire'); };
      const before = env.worker.options.maxChunkAttempts;
      env.worker.options.maxChunkAttempts = 2;
      try {
        await env.worker.runJob(c);
      } finally {
        repo().applyChunk = original;
        env.worker.options.maxChunkAttempts = before;
      }
      const view = (await call.progress(ws, jobId).expect(200)).body;
      expect(view).toMatchObject({ state: 'failed', health: 'failed', processed: 10, moved: 10, remaining: 35 });
      expect(view.error).toBe('disk on fire');
      expect((await env.db.query(`SELECT count(*)::int n FROM opportunities WHERE workspace_id = $1 AND stage_sk = (SELECT sk FROM stages WHERE workspace_id = $1 AND key = 'done')`, [ws])).rows[0].n).toBe(10);
      // A failed job frees the workspace for a new one.
      await call.submit(ws, 'next', { filter: { stage: 'lead' }, target_stage: 'done' }).expect(202);
    });
  });

  describe('snapshot phase (the worker builds the list of deals, in batches)', () => {
    const items = async (jobId: string) =>
      (await env.db.query(`SELECT seq, opportunity_id::text AS opp FROM bulk_job_items WHERE job_id = $1 ORDER BY seq`, [jobId])).rows;
    const view = async (ws: string, jobId: string) => (await call.progress(ws, jobId).expect(200)).body;

    it('commits the snapshot batch by batch; progress shows how far it got, and no total until it is complete', async () => {
      const { ws, ids, jobId } = await setup(60, 'snap', false); // batches of 25
      const c = await claim();
      await env.worker.processChunk(c);
      expect(await view(ws, jobId)).toMatchObject({ state: 'running', phase: 'snapshot', snapshotted: 25, total: null, remaining: null, percent: null });
      await env.worker.processChunk(c);
      expect(await view(ws, jobId)).toMatchObject({ phase: 'snapshot', snapshotted: 50, total: null });
      await env.worker.processChunk(c); // 10 left, fewer than a batch: the scan is finished
      expect(await view(ws, jobId)).toMatchObject({ state: 'running', phase: 'move', snapshotted: 60, total: 60, processed: 0, remaining: 60 });

      const rows = await items(jobId);
      expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1)); // numbered 1..60, no gaps
      expect(rows.map((r) => r.opp)).toEqual(ids); // in ascending id order, each deal once
      await env.worker.runJob(c);
      await expectJobCorrect(env.db, ws, jobId, 'done');
    });

    it('killed between batches: another worker resumes the scan, and the snapshot has no gap and no duplicate', async () => {
      const { ws, ids, jobId } = await setup(60, 'snapkill', false);
      const a = await claim();
      await env.worker.processChunk(a);
      await env.worker.processChunk(a);
      // ...worker A is killed here, 50 of 60 snapshotted. It never runs again.
      expect(await view(ws, jobId)).toMatchObject({ phase: 'snapshot', snapshotted: 50, health: 'progressing' });
      await expireLease(env.db, ws, jobId);
      expect(await view(ws, jobId)).toMatchObject({ health: 'stalled' });

      expect(await env.worker.runOnce()).toBe(true); // worker B: resumes the scan from the committed cursor, then moves
      const { job } = await expectJobCorrect(env.db, ws, jobId, 'done');
      expect(job.attempt).toBe(2);
      expect((await items(jobId)).map((r) => r.opp)).toEqual(ids);
    });

    it('killed in the middle of a batch: that batch leaves no trace and is redone', async () => {
      const { ws, ids, jobId } = await setup(30, 'snapmid', false);
      const c = await claim();
      const original = repo().recordSnapshot;
      repo().recordSnapshot = async () => { throw new Error('worker killed mid-batch'); }; // dies after inserting, before commit
      try {
        await expect(env.worker.processChunk(c)).rejects.toThrow('killed mid-batch');
      } finally {
        repo().recordSnapshot = original;
      }
      expect(await items(jobId)).toHaveLength(0);
      expect((await env.db.query(`SELECT total, snapshot_cursor_id::int AS cursor FROM bulk_jobs WHERE id = $1`, [jobId])).rows[0]).toEqual({ total: 0, cursor: 0 });
      await env.worker.runJob(c);
      await expectJobCorrect(env.db, ws, jobId, 'done');
      expect((await items(jobId)).map((r) => r.opp)).toEqual(ids);
    });

    it('a worker that lost its lease cannot add a batch', async () => {
      const { ws, jobId } = await setup(30, 'snapfence', false);
      const a = await claim();
      await expireLease(env.db, ws, jobId);
      const b = await claim();
      await expect(env.worker.processChunk(a)).rejects.toBeInstanceOf(LeaseLostError);
      expect(await items(jobId)).toHaveLength(0);
      await env.worker.runJob(b);
      await expectJobCorrect(env.db, ws, jobId, 'done');
    });

    it('is a view of the set as the scan reaches it: deals created after submission never join; deals edited into or out of the filter before the scan do or do not', async () => {
      const ws = await createWorkspace(env.db, slug('snapview'));
      const lead = await addDeals(env.db, ws, many(20, { stage: 'lead' }));
      const [wasElsewhere] = await addDeals(env.db, ws, [{ stage: 'contacted' }]);
      await env.db.query(`UPDATE bulk_jobs SET state = 'failed', error = 'test cleanup', lease_token = NULL, lease_expires_at = NULL WHERE state IN ('queued', 'running')`);
      const res = await call.submit(ws, 'job', { filter: { stage: 'lead' }, target_stage: 'done' }).expect(202);

      await call.move(ws, lead[0], 'qualified').expect(200); // leaves the filter before the scan reaches it
      await call.move(ws, wasElsewhere, 'lead').expect(200); // enters the filter before the scan reaches it
      const [late] = await env.db // created after submission, in the filter's stage
        .query(
          `INSERT INTO opportunities (workspace_id, stage_sk, name, value, owner_id)
           SELECT $1, sk, 'late', 1, 'priya' FROM stages WHERE workspace_id = $1 AND key = 'lead' RETURNING id::text`, [ws],
        ).then((r) => r.rows.map((x) => x.id as string));

      await env.worker.runOnce();
      const { job, moved, skipped } = await expectJobCorrect(env.db, ws, res.body.id, 'done');
      expect(job.total).toBe(20); // 20 - 1 (left) + 1 (entered)
      const inJob = [...moved, ...skipped].map((i) => i.opp);
      expect(inJob).toContain(wasElsewhere);
      expect(inJob).not.toContain(lead[0]);
      expect(inJob).not.toContain(late);
      expect((await stageOf(env.db, ws, late)).stage).toBe('lead'); // never touched
    });

    it('a filter matching more than the cap fails the job with a reason, keeps the copy bounded, and frees the workspace', async () => {
      const { ws, jobId } = await setup(30, 'cap', false);
      const before = { ...env.worker.options };
      Object.assign(env.worker.options, { maxItems: 10, snapshotBatchSize: 4 });
      try {
        await env.worker.runOnce();
      } finally {
        Object.assign(env.worker.options, before);
      }
      const v = await view(ws, jobId);
      expect(v).toMatchObject({ state: 'failed', health: 'failed', moved: 0 });
      expect(v.error).toMatch(/more than 10 opportunities/);
      expect(await items(jobId)).toHaveLength(11); // batches of 4, 4, then only 3: it never copies more than cap + 1
      expect((await env.db.query(`SELECT count(*)::int n FROM opportunities WHERE workspace_id = $1 AND version > 1`, [ws])).rows[0].n).toBe(0); // nothing moved
      await call.submit(ws, 'again', { filter: { stage: 'lead' }, target_stage: 'done' }).expect(202); // the workspace is free again
    });

    it('a job with exactly the cap is fine', async () => {
      const { ws, jobId } = await setup(12, 'capok', false);
      const before = { ...env.worker.options };
      Object.assign(env.worker.options, { maxItems: 12, snapshotBatchSize: 5 });
      try {
        await env.worker.runOnce();
      } finally {
        Object.assign(env.worker.options, before);
      }
      await expectJobCorrect(env.db, ws, jobId, 'done');
    });
  });

  describe('fencing', () => {
    it('a worker that lost its lease cannot commit, even though it is still running', async () => {
      const { ws, jobId } = await setup(25);
      const a = await claim(); // worker A
      await expireLease(env.db, ws, jobId); // A stalls (GC pause, network partition...) and its lease expires
      const b = await claim(); // worker B takes over
      expect(b.leaseToken).not.toBe(a.leaseToken);

      // A wakes up and tries to carry on. It must be refused and must change nothing.
      await expect(env.worker.processChunk(a)).rejects.toBeInstanceOf(LeaseLostError);
      expect((await env.db.query(`SELECT count(*)::int n FROM transitions WHERE job_id = $1`, [jobId])).rows[0].n).toBe(0);
      expect((await env.db.query(`SELECT cursor_seq FROM bulk_jobs WHERE id = $1`, [jobId])).rows[0].cursor_seq).toBe(0);

      await env.worker.runJob(b);
      await expectJobCorrect(env.db, ws, jobId, 'done');
      await expect(env.worker.processChunk(a)).rejects.toBeInstanceOf(LeaseLostError); // and still refused afterwards
    });

    it('two workers polling at once never run the same job', async () => {
      const { ws, jobId } = await setup(25);
      const claims = await Promise.all([env.worker.claim(), env.worker.claim(), env.worker.claim()]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      await env.worker.runJob(claims.find(Boolean)!);
      await expectJobCorrect(env.db, ws, jobId, 'done');
    });
  });

  describe('correct under concurrent edits', () => {
    it('a deal moved by hand after the snapshot is skipped: the person wins, the job never overwrites', async () => {
      const { ws, ids, jobId } = await setup(30);
      const manual = [ids[3], ids[14], ids[22]];
      for (const id of manual) await call.move(ws, id, 'contacted').expect(200); // a person moves 3 deals inside the job's set
      await env.worker.runOnce();

      const { job, skipped } = await expectJobCorrect(env.db, ws, jobId, 'done');
      expect(job).toMatchObject({ moved: 27, skipped_conflict: 3 });
      expect(skipped.map((s) => s.opp).sort()).toEqual([...manual].sort());
      for (const id of manual) {
        expect((await stageOf(env.db, ws, id)).stage).toBe('contacted'); // still where the person put it
        const history = (await env.db.query(`SELECT source FROM transitions WHERE opportunity_id = $1 ORDER BY id`, [id])).rows;
        expect(history).toEqual([{ source: 'manual' }]); // and its history has no bulk entry
      }
    });

    it('any write since the snapshot counts, not only stage moves', async () => {
      const { ws, ids, jobId } = await setup(12);
      // e.g. someone edited the owner; every write bumps `version`
      await env.db.query(`UPDATE opportunities SET owner_id = 'sam', version = version + 1 WHERE workspace_id = $1 AND id = $2`, [ws, ids[5]]);
      await env.worker.runOnce();
      const { job } = await expectJobCorrect(env.db, ws, jobId, 'done');
      expect(job).toMatchObject({ moved: 11, skipped_conflict: 1 });
      expect((await stageOf(env.db, ws, ids[5])).stage).toBe('lead');
    });

    it('a manual move that is still in flight when the job reaches the row: the job waits, then skips it', async () => {
      const { ws, ids, jobId } = await setup(15);
      env.worker.options.lockTimeoutMs = 10_000;
      const c = await claim();
      const person = new Client({ connectionString: TEST_DATABASE_URL });
      await person.connect();
      try {
        await person.query('BEGIN');
        // The person is mid-move on ids[2]: row locked, not yet committed.
        await person.query(
          `UPDATE opportunities SET stage_sk = (SELECT sk FROM stages WHERE workspace_id = $1 AND key = 'contacted'),
                  version = version + 1, updated_at = now() WHERE workspace_id = $1 AND id = $2`,
          [ws, ids[2]],
        );
        let finished = false;
        const chunk = env.worker.processChunk(c).then((r) => { finished = true; return r; });
        await new Promise((r) => setTimeout(r, 400));
        expect(finished).toBe(false); // the job is waiting on the person's lock, not overwriting it
        await person.query('COMMIT');
        const result = await chunk;
        expect(result.skipped).toBe(1); // after the lock cleared, the version no longer matched
      } finally {
        await person.end();
        env.worker.options.lockTimeoutMs = 2_000;
      }
      await env.worker.runJob(c);
      const { job } = await expectJobCorrect(env.db, ws, jobId, 'done');
      expect(job.skipped_conflict).toBe(1);
      expect((await stageOf(env.db, ws, ids[2])).stage).toBe('contacted');
    });

    it('operates on the snapshot: deals entering the filter later are left alone, deals leaving are skipped', async () => {
      const { ws, ids, jobId } = await setup(20);
      const [late] = await addDeals(env.db, ws, [{ stage: 'lead' }]); // matches the filter, but was created after submission
      await call.move(ws, ids[0], 'qualified').expect(200); // leaves the filter set
      await env.worker.runOnce();
      const { job } = await expectJobCorrect(env.db, ws, jobId, 'done');
      expect(job.total).toBe(20); // fixed at submission
      expect(job).toMatchObject({ moved: 19, skipped_conflict: 1 });
      expect((await stageOf(env.db, ws, late)).stage).toBe('lead'); // never picked up
    });
  });

  it('a chunk touches only its own items, however many the job has (cost must not grow with job size)', async () => {
    const { ws, jobId } = await setup(300); // fresh items with no planner statistics: the worst case
    const c = await claim();
    const scanned = await env.db.tx(async (tx) => {
      const { rows } = await tx.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${CHUNK_SQL}`, [ws, jobId, 0, 10, c.targetStageSk]);
      await tx.query('SELECT 1');
      // Rows actually read from bulk_job_items by scan nodes (the update node itself is not a scan).
      const rowsScanned = (node: any): number =>
        (node['Relation Name'] === 'bulk_job_items' && /Scan/.test(node['Node Type']) ? node['Actual Rows'] * node['Actual Loops'] : 0) +
        (node.Plans ?? []).reduce((sum: number, child: any) => sum + rowsScanned(child), 0);
      const total = rowsScanned(rows[0]['QUERY PLAN'][0].Plan);
      throw Object.assign(new Error('rollback'), { total });
    }).catch((e) => e.total as number);
    // Reading the chunk (10) and marking it (10). A plan that scans the whole job (300) and filters would blow past this.
    expect(scanned).toBeLessThanOrEqual(30);
  });

  describe('record-level safety net', () => {
    it('replaying a chunk that was already applied moves nothing and duplicates nothing', async () => {
      const { ws, jobId } = await setup(12);
      const c = await claim();
      await env.worker.runJob(c);
      const before = (await env.db.query(`SELECT count(*)::int n FROM transitions WHERE job_id = $1`, [jobId])).rows[0].n;
      const replay = await env.db
        .tx(async (tx) => {
          const r = await repo().applyChunk(c, 0, 10, tx); // the chunk at cursor 0 again
          await tx.query('SELECT 1');
          throw Object.assign(new Error('rollback'), { r });
        })
        .catch((e) => e.r);
      expect(replay.moved).toBe(0); // every deal fails the version guard: already moved
      expect((await env.db.query(`SELECT count(*)::int n FROM transitions WHERE job_id = $1`, [jobId])).rows[0].n).toBe(before);
    });

    it('the database refuses a second bulk transition for the same job and deal', async () => {
      const { ws, jobId } = await setup(3);
      await env.worker.runOnce();
      await expect(
        env.db.query(
          `INSERT INTO transitions (workspace_id, opportunity_id, from_stage_sk, to_stage_sk, source, job_id)
           SELECT workspace_id, opportunity_id, from_stage_sk, to_stage_sk, 'bulk', job_id FROM transitions WHERE job_id = $1 LIMIT 1`,
          [jobId],
        ),
      ).rejects.toThrow(/duplicate key/i);
      void ws;
    });
  });

  describe('health (computed from committed data only)', () => {
    const opts = { stuckAfterMs: 30_000, slowRowsPerSec: 100 };
    const base = { state: 'running', processed: 500, lease_expired: false, secs_since_progress: 1, active_secs: 2 };
    it.each([
      ['queued, not started', { state: 'queued', processed: 0 }, 'queued'],
      ['queued again after yielding the worker mid-job', { state: 'queued', processed: 500 }, 'waiting'],
      ['completed', { state: 'completed' }, 'completed'],
      ['failed', { state: 'failed' }, 'failed'],
      ['healthy rate', {}, 'progressing'],
      ['worker died (lease expired)', { lease_expired: true }, 'stalled'],
      ['alive but nothing committed for a long time', { secs_since_progress: 45 }, 'stuck'],
      ['committing, but below the rows/second floor', { processed: 50, active_secs: 10 }, 'slow'],
      ['just claimed, no progress yet', { processed: 0, secs_since_progress: 0.5, active_secs: 0 }, 'progressing'],
    ])('%s -> %s', (_n, patch, expected) => {
      expect(computeHealth({ ...base, ...patch } as any, opts)).toBe(expected);
    });
  });
});
