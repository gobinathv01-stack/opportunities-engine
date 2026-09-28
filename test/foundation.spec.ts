import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { DatabaseService } from '../src/services/database.service';
import { listenOnLoopback } from './helpers';

// Part 1 smoke test: create, move (with transition), paginated list, tenant scoping.
describe('foundation', () => {
  let app: INestApplication;
  let url: string; // the app listens on an explicit loopback port; see test/helpers.ts (listenOnLoopback)
  let db: DatabaseService;
  let ws: string;
  let other: string;
  const lead = 'lead';
  const contacted = 'contacted';

  async function workspaceWithStages(id: string, keys: string[]) {
    await db.query(`INSERT INTO workspaces (id, name) VALUES ($1, $1)`, [id]);
    for (const [i, key] of keys.entries()) {
      await db.query(`INSERT INTO stages (workspace_id, key, position) VALUES ($1, $2, $3)`, [id, key, i + 1]);
    }
    return id;
  }

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    configureApp(app);
    await app.init();
    url = await listenOnLoopback(app);
    db = app.get(DatabaseService);
    const run = Date.now();
    ws = await workspaceWithStages(`t-${run}-a`, [lead, contacted, 'qualified']);
    other = await workspaceWithStages(`t-${run}-b`, [lead, contacted, 'b-only']);
  });
  afterAll(() => app.close());

  const create = (name: string, stage = lead, workspace = ws) =>
    request(url).post('/opportunities').set('X-Workspace-Id', workspace)
      .send({ name, value: 100, owner_id: 'priya', stage });

  it('moves an opportunity and records one manual transition', async () => {
    const { body: opp } = await create('Globex').expect(201);
    const moved = await request(url).post(`/opportunities/${opp.id}/move`)
      .set('X-Workspace-Id', ws).send({ stage: contacted }).expect(200);
    expect(moved.body.stage).toBe(contacted);
    expect(moved.body.version).toBe(2);

    const t = await db.query(
      `SELECT f.key AS from_stage, t.key AS to_stage, tr.source
         FROM transitions tr
         JOIN stages f ON f.sk = tr.from_stage_sk
         JOIN stages t ON t.sk = tr.to_stage_sk
        WHERE tr.opportunity_id = $1`,
      [opp.id],
    );
    expect(t.rows).toEqual([{ from_stage: lead, to_stage: contacted, source: 'manual' }]);

    await request(url).post(`/opportunities/${opp.id}/move`)
      .set('X-Workspace-Id', ws).send({ stage: contacted }).expect(409);
  });

  it('paginates a stage with a keyset cursor', async () => {
    for (const n of ['a', 'b', 'c']) await create(`page-${n}`, contacted).expect(201);
    const list = (cursor?: string) =>
      request(url).get('/opportunities').set('X-Workspace-Id', ws)
        .query({ stage: contacted, limit: 2, ...(cursor ? { cursor } : {}) }).expect(200);
    const p1 = await list();
    expect(p1.body.items).toHaveLength(2);
    const p2 = await list(p1.body.next_cursor);
    expect(p2.body.items.length).toBeGreaterThan(0);
    const ids = [...p1.body.items, ...p2.body.items].map((o: any) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects a missing or malformed workspace header', async () => {
    await request(url).get('/opportunities').query({ stage: lead }).expect(400);
    await request(url).get('/opportunities').set('X-Workspace-Id', 'not a slug!').query({ stage: lead }).expect(400);
  });

  it('never crosses workspaces', async () => {
    const { body: opp } = await create('Private').expect(201);
    await request(url).post(`/opportunities/${opp.id}/move`)
      .set('X-Workspace-Id', other).send({ stage: contacted }).expect(404);
    const seen = await request(url).get('/opportunities').set('X-Workspace-Id', other)
      .query({ stage: lead }).expect(200);
    expect(seen.body.items).toEqual([]);
  });

  it('cannot use a stage that only exists in another workspace', async () => {
    // 'b-only' exists in workspace B, not in A.
    await create('x', 'b-only', ws).expect(422);
    await create('ok', 'b-only', other).expect(201);
    const { body: opp } = await create('mine').expect(201);
    await request(url).post(`/opportunities/${opp.id}/move`)
      .set('X-Workspace-Id', ws).send({ stage: 'b-only' }).expect(422);
  });
});
