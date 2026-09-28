import { api, createEnv, createWorkspace, addDeals, many, slug, takeSnapshot, TestEnv } from './helpers';

// Submitting a bulk move, and the snapshot the worker takes for it: the filter, and idempotency.
describe('bulk move: submit', () => {
  let env: TestEnv;
  let call: ReturnType<typeof api>;
  beforeAll(async () => {
    env = await createEnv();
    call = api(env);
  });
  afterAll(() => env.app.close());

  const jobCount = async (ws: string) => (await env.db.query(`SELECT count(*)::int n FROM bulk_jobs WHERE workspace_id = $1`, [ws])).rows[0].n;
  const itemCount = async (ws: string) => (await env.db.query(`SELECT count(*)::int n FROM bulk_job_items WHERE workspace_id = $1`, [ws])).rows[0].n;
  const complete = (ws: string) => env.db.query(`UPDATE bulk_jobs SET state = 'completed', finished_at = now() WHERE workspace_id = $1`, [ws]);

  const total = async (ws: string, jobId: string) => (await call.progress(ws, jobId).expect(200)).body.total;

  it('returns a job handle at once, before any snapshot exists: submit does no work that grows with the job', async () => {
    const ws = await createWorkspace(env.db, slug('sub'));
    await addDeals(env.db, ws, many(5, { stage: 'lead' }));
    const res = await call.submit(ws, 'k0', { filter: {}, target_stage: 'qualified' }).expect(202);
    expect(res.body).toMatchObject({ state: 'queued', phase: 'snapshot', total: null, snapshotted: 0, remaining: null, percent: null, target_stage: 'qualified' });
    expect(await itemCount(ws)).toBe(0); // the worker has not looked at the deals yet
  });

  it('the snapshot phase captures exactly the matching deals, not those already at the target', async () => {
    const ws = await createWorkspace(env.db, slug('sub'));
    await addDeals(env.db, ws, [...many(5, { stage: 'lead' }), ...many(3, { stage: 'contacted' }), ...many(2, { stage: 'qualified' })]);
    const res = await call.submit(ws, 'k1', { filter: {}, target_stage: 'qualified' }).expect(202);
    await takeSnapshot(env, ws, res.body.id);
    expect((await call.progress(ws, res.body.id).expect(200)).body).toMatchObject({
      state: 'queued', phase: 'move', total: 8, snapshotted: 8, processed: 0, remaining: 8, percent: 0, // 10 deals, 2 already at target
    });
    expect(await itemCount(ws)).toBe(8);
    const items = (await env.db.query(`SELECT seq, expected_version FROM bulk_job_items WHERE workspace_id = $1 ORDER BY seq`, [ws])).rows;
    expect(items.map((i) => i.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(items.every((i) => i.expected_version === 1)).toBe(true);
  });

  describe('filters (ANDed; every field optional)', () => {
    let ws: string;
    beforeAll(async () => {
      ws = await createWorkspace(env.db, slug('flt'));
      await addDeals(env.db, ws, [
        { stage: 'lead', owner: 'priya', status: 'open', value: 100, created: '2026-01-10T10:00:00Z' },
        { stage: 'lead', owner: 'priya', status: 'lost', value: 500, created: '2026-02-15T10:00:00Z' },
        { stage: 'lead', owner: 'ravi', status: 'open', value: 900, created: '2026-03-31T23:30:00Z' }, // last day of March
        { stage: 'contacted', owner: 'ravi', status: 'open', value: 2000, created: '2026-04-01T00:00:00Z' },
        { stage: 'contacted', owner: 'priya', status: 'abandoned', value: 50, created: '2025-12-31T23:59:59Z' },
      ]);
    });
    const matches = async (i: number, filter: object) => {
      const res = await call.submit(ws, `f${i}`, { filter, target_stage: 'done' }).expect(202);
      await takeSnapshot(env, ws, res.body.id);
      const n = await total(ws, res.body.id);
      await complete(ws);
      return n;
    };
    it.each([
      ['stage', { stage: 'lead' }, 3],
      ['owner', { owner: 'priya' }, 3],
      ['status list', { status: ['lost', 'abandoned'] }, 2],
      ['value range (inclusive)', { value: { min: 100, max: 900 } }, 3],
      ['value min only', { value: { min: 900 } }, 2],
      ['created range; a date-only "to" includes that whole day', { created: { from: '2026-01-01', to: '2026-03-31' } }, 3],
      ['created "to" with a time is inclusive to that instant', { created: { to: '2026-03-31T23:30:00Z' } }, 4],
      ['combined', { stage: 'lead', owner: 'priya', status: ['open'] }, 1],
      ['empty filter = everything', {}, 5],
    ])('%s', async (_name, filter, expected) => {
      expect(await matches(Math.random() * 1e9 | 0, filter as object)).toBe(expected);
    });
  });

  describe('idempotency', () => {
    it('a retry with the same key returns the same job and creates nothing new', async () => {
      const ws = await createWorkspace(env.db, slug('idem'));
      await addDeals(env.db, ws, many(6, { stage: 'lead' }));
      const first = await call.submit(ws, 'retry-me', { filter: { stage: 'lead' }, target_stage: 'done' }).expect(202);
      const second = await call.submit(ws, 'retry-me', { filter: { stage: 'lead' }, target_stage: 'done' }).expect(202);
      expect(second.body.id).toBe(first.body.id);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(await jobCount(ws)).toBe(1);
      await takeSnapshot(env, ws, first.body.id);
      expect(await itemCount(ws)).toBe(6); // one snapshot for the one job
    });

    it('recognises the same request written differently (field order, status order)', async () => {
      const ws = await createWorkspace(env.db, slug('canon'));
      await addDeals(env.db, ws, many(3, { stage: 'lead' }));
      const a = await call.submit(ws, 'canon', { filter: { status: ['open', 'lost'], stage: 'lead' }, target_stage: 'done' }).expect(202);
      const b = await call.submit(ws, 'canon', { target_stage: 'done', filter: { stage: 'lead', status: ['lost', 'open'] } }).expect(202);
      expect(b.body.id).toBe(a.body.id);
      expect(b.headers['idempotent-replayed']).toBe('true');
      expect(await jobCount(ws)).toBe(1);
    });

    it('the same key with a different request is rejected, not treated as a retry', async () => {
      const ws = await createWorkspace(env.db, slug('clash'));
      await addDeals(env.db, ws, many(4, { stage: 'lead' }));
      await call.submit(ws, 'same-key', { filter: { stage: 'lead' }, target_stage: 'done' }).expect(202);
      const res = await call.submit(ws, 'same-key', { filter: { stage: 'lead' }, target_stage: 'qualified' });
      expect(res.status).toBe(422);
      expect(await jobCount(ws)).toBe(1);
    });

    it('many simultaneous submits of one key create exactly one job (the unique constraint serialises them)', async () => {
      const ws = await createWorkspace(env.db, slug('race'));
      await addDeals(env.db, ws, many(7, { stage: 'lead' }));
      const results = await Promise.all(
        Array.from({ length: 8 }, () => call.submit(ws, 'burst', { filter: { stage: 'lead' }, target_stage: 'done' })),
      );
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(202));
      expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
      expect(await jobCount(ws)).toBe(1);
      await takeSnapshot(env, ws, results[0].body.id);
      expect(await itemCount(ws)).toBe(7); // one snapshot, not eight
    });

    it('keys are per workspace: two workspaces may use the same key independently', async () => {
      const a = await createWorkspace(env.db, slug('ka'));
      const b = await createWorkspace(env.db, slug('kb'));
      await addDeals(env.db, a, many(2, { stage: 'lead' }));
      await addDeals(env.db, b, many(3, { stage: 'lead' }));
      const ra = await call.submit(a, 'shared', { filter: {}, target_stage: 'done' }).expect(202);
      const rb = await call.submit(b, 'shared', { filter: {}, target_stage: 'done' }).expect(202);
      expect(ra.body.id).not.toBe(rb.body.id);
      await takeSnapshot(env, a, ra.body.id);
      await takeSnapshot(env, b, rb.body.id);
      expect([await total(a, ra.body.id), await total(b, rb.body.id)]).toEqual([2, 3]);
    });
  });

  describe('guard rails', () => {
    it('allows only one active job per workspace, and records nothing for the rejected one', async () => {
      const ws = await createWorkspace(env.db, slug('one'));
      await addDeals(env.db, ws, many(5, { stage: 'lead' }));
      const first = await call.submit(ws, 'first', { filter: {}, target_stage: 'done' }).expect(202);
      const second = await call.submit(ws, 'second', { filter: {}, target_stage: 'qualified' });
      expect(second.status).toBe(409);
      expect(second.body.active_job_id).toBe(first.body.id);
      expect(await jobCount(ws)).toBe(1);
      await takeSnapshot(env, ws, first.body.id);
      expect(await itemCount(ws)).toBe(5); // only the first job's snapshot
      await complete(ws);
      await call.submit(ws, 'third', { filter: {}, target_stage: 'qualified' }).expect(202); // free again once the first finished
    });

    it('a filter that matches nothing completes once its snapshot is taken', async () => {
      const ws = await createWorkspace(env.db, slug('none'));
      await addDeals(env.db, ws, many(2, { stage: 'lead' }));
      const res = await call.submit(ws, 'nothing', { filter: { owner: 'nobody' }, target_stage: 'done' }).expect(202);
      await takeSnapshot(env, ws, res.body.id);
      expect((await call.progress(ws, res.body.id).expect(200)).body).toMatchObject({ state: 'completed', phase: 'move', total: 0, percent: 100 });
    });

    it('only ever selects deals of its own workspace', async () => {
      const mine = await createWorkspace(env.db, slug('mine'));
      const theirs = await createWorkspace(env.db, slug('theirs'));
      await addDeals(env.db, mine, many(2, { stage: 'lead' }));
      await addDeals(env.db, theirs, many(9, { stage: 'lead' }));
      const res = await call.submit(mine, 'iso', { filter: {}, target_stage: 'done' }).expect(202);
      await takeSnapshot(env, mine, res.body.id);
      expect(await total(mine, res.body.id)).toBe(2);
      await call.progress(theirs, res.body.id).expect(404);
    });

    it.each([
      ['a missing Idempotency-Key', null, { filter: {}, target_stage: 'done' }, 400],
      ['an invalid Idempotency-Key', 'bad key!', { filter: {}, target_stage: 'done' }, 400],
      ['an unknown target stage', 'v1', { filter: {}, target_stage: 'nowhere' }, 422],
      ['an unknown filter stage', 'v2', { filter: { stage: 'nowhere' }, target_stage: 'done' }, 422],
      ['a missing filter', 'v3', { target_stage: 'done' }, 400],
      ['an unknown filter field', 'v4', { filter: { colour: 'red' }, target_stage: 'done' }, 400],
      ['value min > max', 'v5', { filter: { value: { min: 10, max: 5 } }, target_stage: 'done' }, 400],
      ['duplicate statuses', 'v6b', { filter: { status: ['open', 'open'] }, target_stage: 'done' }, 400],
      ['an empty status list', 'v6', { filter: { status: [] }, target_stage: 'done' }, 400],
      ['an unknown status', 'v7', { filter: { status: ['weird'] }, target_stage: 'done' }, 400],
      ['a malformed date', 'v8', { filter: { created: { from: 'yesterday' } }, target_stage: 'done' }, 400],
      ['created from after to', 'v9', { filter: { created: { from: '2026-05-01', to: '2026-04-01' } }, target_stage: 'done' }, 400],
      ['a negative value bound', 'v10', { filter: { value: { min: -1 } }, target_stage: 'done' }, 400],
    ])('rejects %s', async (_name, key, body, status) => {
      const ws = await createWorkspace(env.db, slug('val'));
      await addDeals(env.db, ws, many(1, { stage: 'lead' }));
      const res = await call.submit(ws, key as string | null, body);
      expect(res.status).toBe(status);
      expect(await jobCount(ws)).toBe(0);
    });
  });
});
