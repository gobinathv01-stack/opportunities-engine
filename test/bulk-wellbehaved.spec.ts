import { Client } from 'pg';
import { TEST_DATABASE_URL } from './test-db';
import { addDeals, api, createEnv, createWorkspace, expectJobCorrect, many, slug, takeSnapshot, TestEnv } from './helpers';

// "Well-behaved": a big job must not starve other workspaces' jobs or block people editing deals.
describe('bulk move: well-behaved', () => {
  let env: TestEnv;
  let call: ReturnType<typeof api>;
  const defaults = { dutyCycle: 0, sliceMs: 0, lockTimeoutMs: 0, maxChunkAttempts: 0, pollIntervalMs: 0, workerConcurrency: 0 };
  beforeAll(async () => {
    env = await createEnv();
    call = api(env);
    Object.assign(defaults, env.worker.options);
  });
  afterEach(() => Object.assign(env.worker.options, defaults));
  afterAll(() => env.app.close());

  const clearOtherJobs = () =>
    env.db.query(`UPDATE bulk_jobs SET state = 'failed', error = 'test cleanup', lease_token = NULL, lease_expires_at = NULL WHERE state IN ('queued', 'running')`);
  /** Submits a job of `n` deals. Its snapshot is taken up front unless `snapshot` is false. */
  const submit = async (n: number, name: string, snapshot = true) => {
    const ws = await createWorkspace(env.db, slug(name));
    const ids = await addDeals(env.db, ws, many(n, { stage: 'lead' }));
    const res = await call.submit(ws, 'job', { filter: {}, target_stage: 'done' }).expect(202);
    if (snapshot) await takeSnapshot(env, ws, res.body.id);
    return { ws, ids, jobId: res.body.id as string };
  };
  const processed = async (ws: string, jobId: string) => (await call.progress(ws, jobId).expect(200)).body;

  it('a huge job yields the worker, so a small job in another workspace is not stuck behind it', async () => {
    await clearOtherJobs();
    env.worker.options.dutyCycle = 1; // unpaced: this test is about turn-taking, not sleeping
    env.worker.options.sliceMs = 0; // yield after every chunk when someone else is waiting
    const big = await submit(50, 'big');
    const small = await submit(20, 'small');

    const order: string[] = [];
    while (await env.worker.runOnce()) {
      const [b, s] = [await processed(big.ws, big.jobId), await processed(small.ws, small.jobId)];
      order.push(`big=${b.processed} small=${s.processed}`);
    }
    // One worker slot, two workspaces: they take turns chunk by chunk. The small job finishes
    // while the big one is still only 20/50 done, instead of waiting for all 50.
    expect(order).toEqual(['big=10 small=0', 'big=10 small=10', 'big=20 small=10', 'big=20 small=20', 'big=50 small=20']);
    await expectJobCorrect(env.db, big.ws, big.jobId, 'done');
    await expectJobCorrect(env.db, small.ws, small.jobId, 'done');
    expect((await processed(big.ws, big.jobId)).attempt).toBe(1); // yielding is not a retry
  });

  it('building a snapshot takes turns as well: a small job finishes its snapshot before a big one has finished its own', async () => {
    await clearOtherJobs();
    env.worker.options.dutyCycle = 1;
    env.worker.options.sliceMs = 0;
    env.worker.options.snapshotBatchSize = 10;
    const big = await submit(40, 'sbig', false);
    const small = await submit(10, 'ssmall', false);
    const reachedMove: Record<string, number> = {};
    for (let step = 1; await env.worker.runOnce(); step++) {
      for (const j of [big, small]) {
        const v = await processed(j.ws, j.jobId);
        if (v.phase === 'move' && reachedMove[j.jobId] === undefined) reachedMove[j.jobId] = step;
      }
    }
    expect(reachedMove[small.jobId]).toBeLessThan(reachedMove[big.jobId]);
    await expectJobCorrect(env.db, big.ws, big.jobId, 'done');
    await expectJobCorrect(env.db, small.ws, small.jobId, 'done');
  });

  it('a job that has yielded is reported as waiting, with its progress intact', async () => {
    await clearOtherJobs();
    env.worker.options.dutyCycle = 1;
    env.worker.options.sliceMs = 0;
    const a = await submit(30, 'wa');
    await submit(30, 'wb'); // someone else is waiting, so a's slice ends after one chunk
    await env.worker.runOnce();
    const view = await processed(a.ws, a.jobId);
    expect(view).toMatchObject({ state: 'queued', health: 'waiting', processed: 10 });
  });

  it('waiting for a row a person holds is back-pressure, not a failure: the job retries and still finishes', async () => {
    await clearOtherJobs();
    env.worker.options.dutyCycle = 1;
    env.worker.options.lockTimeoutMs = 120; // give up waiting quickly...
    env.worker.options.maxChunkAttempts = 1; // ...and if a lock timeout counted as a failure, one would kill the job
    const { ws, ids, jobId } = await submit(15, 'lock');
    const person = new Client({ connectionString: TEST_DATABASE_URL });
    await person.connect();
    try {
      await person.query('BEGIN');
      await person.query(`UPDATE opportunities SET version = version + 1, owner_id = 'sam' WHERE workspace_id = $1 AND id = $2`, [ws, ids[2]]);
      const running = env.worker.runOnce();
      await new Promise((r) => setTimeout(r, 900)); // several lock timeouts happen while the person holds the row
      expect((await processed(ws, jobId)).state).toBe('running'); // still trying, not failed
      await person.query('COMMIT');
      await running;
    } finally {
      await person.end();
    }
    const { job } = await expectJobCorrect(env.db, ws, jobId, 'done');
    expect(job.skipped_conflict).toBe(1); // the person's edit won
  });

  it('the real polling loop picks a job up, finishes it, and stops cleanly', async () => {
    await clearOtherJobs();
    env.worker.options.dutyCycle = 1;
    env.worker.options.pollIntervalMs = 20;
    env.worker.options.workerConcurrency = 1;
    env.worker.start();
    try {
      const { ws, jobId } = await submit(25, 'loop', false); // the loop itself does the snapshot too
      const deadline = Date.now() + 8_000;
      let view = await processed(ws, jobId);
      while (view.state !== 'completed' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
        view = await processed(ws, jobId);
      }
      expect(view.state).toBe('completed');
      await expectJobCorrect(env.db, ws, jobId, 'done');
    } finally {
      await env.worker.stop();
    }
  });

  it('the worker process runs on its own small connection pool', () => {
    let poolMax: string | undefined;
    jest.isolateModules(() => {
      const saved = process.env.DB_POOL_MAX;
      delete process.env.DB_POOL_MAX;
      require('../src/worker.env');
      poolMax = process.env.DB_POOL_MAX;
      if (saved !== undefined) process.env.DB_POOL_MAX = saved;
      else delete process.env.DB_POOL_MAX;
    });
    expect(poolMax).toBe('4');
  });
});
