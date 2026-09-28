import { Client } from 'pg';
import { config } from '../config/configuration';
import { seedWorkspace, WorkspaceSeed } from './seed-lib';

// One large workspace (12 stages, unevenly filled) plus five small ones, so isolation can be measured.
const STAGES = [
  'new-lead', 'contacted', 'qualified', 'discovery', 'demo-scheduled', 'demo-done',
  'proposal-sent', 'negotiation', 'legal-review', 'verbal-commit', 'contract-sent', 'closed-won',
];
// Front-loaded, like a real funnel: 22% of deals in the first stage, 1% in the last.
const WEIGHTS = [0.22, 0.17, 0.13, 0.11, 0.09, 0.08, 0.06, 0.05, 0.04, 0.025, 0.015, 0.01];

const LARGE = Number(process.env.SEED_LARGE_OPPORTUNITIES ?? 500_000);
const SMALL_SIZES = [2_000, 2_500, 3_000, 3_500, 4_000];

const WORKSPACES: WorkspaceSeed[] = [
  { id: 'bigco', name: 'BigCo', stages: STAGES, weights: WEIGHTS, count: LARGE, seed: 0.11 },
  ...SMALL_SIZES.map((count, i) => ({ id: `small-${i + 1}`, name: `Small ${i + 1}`, stages: STAGES, weights: WEIGHTS, count, seed: 0.2 + i / 20 })),
];

/** Benchmark data: 500,000 deals in `bigco` and a few thousand in each of five small workspaces. Safe to re-run. */
async function main() {
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    const started = Date.now();
    const summary: Record<string, unknown> = {};
    for (const w of WORKSPACES) {
      const t = Date.now();
      await client.query('BEGIN');
      await client.query('SET LOCAL synchronous_commit = off'); // bulk load: durability of a half-finished seed does not matter
      const byStage = await seedWorkspace(client, w);
      await client.query('COMMIT');
      const total = Object.values(byStage).reduce((a, b) => a + b, 0);
      summary[w.id] = { deals: total, seconds: Number(((Date.now() - t) / 1000).toFixed(1)), by_stage: byStage };
      console.error(`seeded ${w.id}: ${total} deals in ${((Date.now() - t) / 1000).toFixed(1)}s`);
    }
    await client.query('ANALYZE'); // so the planner sees the real sizes, as it would in steady state
    console.log(JSON.stringify({ total_seconds: Number(((Date.now() - started) / 1000).toFixed(1)), workspaces: summary }, null, 2));
  } finally {
    await client.end();
  }
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
