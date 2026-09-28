import { Client } from 'pg';

export interface WorkspaceSeed {
  id: string;
  name: string;
  /** Stage keys in pipeline order; position is index + 1. The last stage is treated as "won". */
  stages: string[];
  /** Share of deals per stage (same length as stages, sums to 1): deliberately uneven. */
  weights: number[];
  count: number;
  /** setseed() value in (-1, 1): makes the data reproducible. */
  seed: number;
}

/** Creates the workspace and its pipeline if missing. Safe to re-run. */
export async function ensureWorkspace(client: Client, w: WorkspaceSeed) {
  await client.query(`INSERT INTO workspaces (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [w.id, w.name]);
  for (const [i, key] of w.stages.entries()) {
    await client.query(`INSERT INTO stages (workspace_id, key, position) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [w.id, key, i + 1]);
  }
}

/**
 * Inserts w.count opportunities. Uneven on purpose: stage shares follow w.weights, a few owners hold most
 * deals, values are skewed low ($1k-$250k), and created_at spreads over 18 months. Deals past the first stage
 * also get the transitions they would really have (stage 1 -> 2 -> ... -> current), and version = 1 + moves.
 * Deterministic per seed, apart from "now".
 */
export async function seedOpportunities(client: Client, w: WorkspaceSeed) {
  const total = w.weights.reduce((a, b) => a + b, 0);
  if (Math.abs(total - 1) > 1e-9) throw new Error(`weights for ${w.id} sum to ${total}, expected 1`);
  let cum = 0;
  const stageCase = w.weights
    .slice(0, -1)
    .map((weight, i) => `WHEN r_stage < ${(cum += weight).toFixed(6)} THEN ${i + 1}`)
    .join(' ');
  const lastPos = w.stages.length;

  await client.query('SELECT setseed($1)', [w.seed]);
  await client.query(
    `WITH gen AS (
       SELECT random() AS r_stage, random() AS r_owner, random() AS r_status, random() AS r_value,
              random() AS r_age, random() AS r_co, random() AS r_kind, random() AS r_upd
         FROM generate_series(1, $2::int)
     ), picked AS (
       SELECT gen.*,
              CASE ${stageCase} ELSE ${lastPos} END AS pos,
              now() - (r_age * 540) * interval '1 day' AS created
         FROM gen
     )
     INSERT INTO opportunities (workspace_id, stage_sk, name, value, status, owner_id, version, created_at, updated_at)
     SELECT $1, s.sk,
            (ARRAY['Globex','Initech','Umbrella','Hooli','Stark Industries','Wayne Enterprises','Wonka','Cyberdyne',
                   'Soylent','Tyrell','Aperture','Oscorp','Vandelay','Pied Piper','Dunder Mifflin','Massive Dynamic',
                   'Gringotts','Acme Labs','Nakatomi','Monarch'])[1 + floor(p.r_co * 20)::int]
              || ' - ' ||
            (ARRAY['Renewal','Expansion','New Business','Upsell','Pilot','Onboarding'])[1 + floor(p.r_kind * 6)::int],
            round((1000 * exp(p.r_value * ln(250)))::numeric, 2),
            CASE WHEN p.pos = ${lastPos} THEN 'won'
                 WHEN p.r_status < 0.85 THEN 'open' WHEN p.r_status < 0.94 THEN 'lost' ELSE 'abandoned' END,
            CASE WHEN p.r_owner < 0.28 THEN 'priya' WHEN p.r_owner < 0.50 THEN 'ravi' WHEN p.r_owner < 0.66 THEN 'sam'
                 WHEN p.r_owner < 0.78 THEN 'anita' WHEN p.r_owner < 0.87 THEN 'kiran' WHEN p.r_owner < 0.93 THEN 'meera'
                 WHEN p.r_owner < 0.97 THEN 'john' ELSE 'zara' END,
            p.pos,
            p.created,
            p.created + (now() - p.created) * p.r_upd
       FROM picked p
       JOIN stages s ON s.workspace_id = $1 AND s.position = p.pos`,
    [w.id, w.count],
  );

  await client.query(
    `INSERT INTO transitions (workspace_id, opportunity_id, from_stage_sk, to_stage_sk, source, created_at)
     SELECT o.workspace_id, o.id, f.sk, t.sk, 'manual',
            o.created_at + (o.updated_at - o.created_at) * ((t.position - 1)::float8 / (cur.position - 1))
       FROM opportunities o
       JOIN stages cur ON cur.sk = o.stage_sk
       JOIN stages t ON t.workspace_id = o.workspace_id AND t.position BETWEEN 2 AND cur.position
       JOIN stages f ON f.workspace_id = o.workspace_id AND f.position = t.position - 1
      WHERE o.workspace_id = $1`,
    [w.id],
  );
}

/** Seeds one workspace unless it already has deals. Returns deals per stage. */
export async function seedWorkspace(client: Client, w: WorkspaceSeed): Promise<Record<string, number>> {
  await ensureWorkspace(client, w);
  const existing = await client.query(`SELECT count(*)::int AS n FROM opportunities WHERE workspace_id = $1`, [w.id]);
  if (existing.rows[0].n === 0) await seedOpportunities(client, w);
  else console.log(`workspace "${w.id}" already has ${existing.rows[0].n} opportunities; not adding more (run "npm run db:reset" first to start over)`);
  const byStage = await client.query(
    `SELECT s.key AS stage, count(o.id)::int AS n
       FROM stages s LEFT JOIN opportunities o ON o.stage_sk = s.sk AND o.workspace_id = s.workspace_id
      WHERE s.workspace_id = $1 GROUP BY s.key, s.position ORDER BY s.position`,
    [w.id],
  );
  return Object.fromEntries(byStage.rows.map((r) => [r.stage, r.n]));
}
