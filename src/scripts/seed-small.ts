import { Client } from 'pg';
import { config } from '../config/configuration';
import { seedWorkspace, WorkspaceSeed } from './seed-lib';

// Every pipeline starts at 'new-lead' and ends at 'closed-won'; a workspace's stage
// count picks how many of these middle stages it also has, so shorter pipelines skip
// the later-added complexity rather than a random middle stage.
const MIDDLE_STAGES = ['contacted', 'qualified', 'needs-analysis', 'proposal-sent', 'negotiation', 'verbal-commit', 'contract-sent', 'legal-review'];

function pipelineOf(stageCount: number): string[] {
  return ['new-lead', ...MIDDLE_STAGES.slice(0, stageCount - 2), 'closed-won'];
}

// A funnel shape (most deals early, fewer as they advance), for any stage count.
function frontLoadedWeights(stageCount: number, decay = 0.78): number[] {
  const raw = Array.from({ length: stageCount }, (_, i) => decay ** i);
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => w / total);
}

const WORKSPACES: WorkspaceSeed[] = [
  { id: 'acme', name: 'Acme', stageCount: 6, count: 15 },
  { id: 'globex', name: 'Globex', stageCount: 8, count: 28 },
  { id: 'initech', name: 'Initech', stageCount: 10, count: 50 },
  { id: 'umbrella', name: 'Umbrella', stageCount: 7, count: 20 },
  { id: 'hooli', name: 'Hooli', stageCount: 9, count: 35 },
  { id: 'stark', name: 'Stark Industries', stageCount: 6, count: 44 },
].map((w, i) => ({
  id: w.id,
  name: w.name,
  stages: pipelineOf(w.stageCount),
  weights: frontLoadedWeights(w.stageCount),
  count: w.count,
  seed: 0.42 + i / 10,
}));

/** Demo data for development and the quick test run: 6 workspaces, 6-10 stages each, 15-50 deals each. Safe to re-run. */
async function main() {
  const client = new Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    const summary: Record<string, Record<string, number>> = {};
    for (const w of WORKSPACES) summary[w.id] = await seedWorkspace(client, w);
    await client.query('COMMIT');
    console.log(JSON.stringify(summary, null, 2));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
