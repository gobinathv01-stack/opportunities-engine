import { ChildProcess, execSync, spawn } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import { join } from 'path';
import { performance } from 'perf_hooks';
import { Client } from 'pg';
import { config } from '../config/configuration';
import { sleep } from '../common/utils';

/**
 * Measures the bulk move on the seeded benchmark database (see BENCHMARKS.md for method and results).
 * It runs the API and the worker as real child processes so the worker can be killed with SIGKILL.
 */
const PORT = Number(process.env.BENCH_PORT ?? 3222);
const BASE = `http://localhost:${PORT}`;
const JOB_SIZE = Number(process.env.BENCH_JOB_SIZE ?? 50_000);
const VUS = Number(process.env.BENCH_VUS ?? 8); // simulated interactive users per group
const BASELINE_SECONDS = Number(process.env.BENCH_BASELINE_SECONDS ?? 15);
const LEASE_TTL_MS = Number(process.env.BENCH_LEASE_TTL_MS ?? 10_000);
const KILL_AT = Number(process.env.BENCH_KILL_AT ?? 30_000);
const THINK_MS = 15;
const LABEL = process.env.BENCH_LABEL ?? 'run';
/** Runs each paced/unpaced pair in the opposite order, to expose any effect of running second on a dataset the first one changed. */
const UNPACED_FIRST = process.env.BENCH_UNPACED_FIRST === '1';
/** Also moves (nearly) the whole 500,000-deal workspace in one job, with interactive load. Takes a few minutes. */
const ONLY_HUGE = process.env.BENCH_ONLY_HUGE === '1'; // skip the 50k scenarios, so the job finds the whole workspace unmoved
const HUGE = ONLY_HUGE || process.env.BENCH_HUGE === '1';
const BIG = 'bigco';
const OTHER = 'small-1';
const TARGET = 'contract-sent';
const PING = ['legal-review', 'verbal-commit']; // stages interactive users move deals between (outside every job's set)
const LIST_STAGES = ['legal-review', 'verbal-commit', 'negotiation', 'closed-won', 'contract-sent'];

const children: ChildProcess[] = [];
const cleanup = () => children.forEach((c) => c.exitCode === null && c.kill('SIGKILL'));
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

// ---------- helpers ----------
const spawnNode = (script: string, env: Record<string, string>) => {
  const child = spawn('node', [join(__dirname, '..', script)], { env: { ...process.env, ...env }, stdio: 'ignore' });
  children.push(child);
  return child;
};
async function call(method: string, path: string, ws: string, body?: unknown, key?: string) {
  const t = performance.now();
  const res = await fetch(BASE + path, {
    method,
    headers: { 'X-Workspace-Id': ws, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, ms: performance.now() - t, json: text ? JSON.parse(text) : null };
}
const pct = (sorted: number[], q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] : NaN);
const round = (n: number, d = 1) => Number(n.toFixed(d));

async function waitFor(what: string, fn: () => Promise<boolean>, timeoutMs: number, everyMs = 100) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------- interactive load ----------
interface Group { name: string; ws: string; deals: string[] }
type Samples = Record<string, { list: number[]; move: number[]; errors: number }>;

async function runLoad(groups: Group[], stop: { done: boolean }, samples: Samples) {
  for (const g of groups) samples[g.name] = { list: [], move: [], errors: 0 };
  const users: Promise<void>[] = [];
  for (const g of groups) {
    g.deals.forEach((deal, i) => {
      users.push((async () => {
        let at = PING[0];
        while (!stop.done) {
          let r;
          let kind: 'list' | 'move';
          if (Math.random() < 0.7) {
            kind = 'list';
            r = await call('GET', `/opportunities?stage=${LIST_STAGES[(Math.random() * LIST_STAGES.length) | 0]}&limit=50`, g.ws);
          } else {
            kind = 'move';
            const next = at === PING[0] ? PING[1] : PING[0];
            r = await call('POST', `/opportunities/${deal}/move`, g.ws, { stage: next });
            if (r.status === 200) at = next;
          }
          if (r.status >= 300) samples[g.name].errors++;
          else samples[g.name][kind].push(r.ms);
          await sleep(THINK_MS + (i % 3)); // small per-user offset so users do not march in lockstep
        }
      })());
    });
  }
  await Promise.all(users);
}

const summarise = (s: Samples[string], seconds: number) => {
  const all = [...s.list, ...s.move].sort((a, b) => a - b);
  const one = (arr: number[]) => { const a = [...arr].sort((x, y) => x - y); return { n: a.length, p50: round(pct(a, 0.5)), p95: round(pct(a, 0.95)), p99: round(pct(a, 0.99)), max: round(a[a.length - 1] ?? NaN) }; };
  return { requests: all.length, per_second: round(all.length / seconds), errors: s.errors, all: one(all), list: one(s.list), move: one(s.move) };
};

// ---------- bulk job ----------
async function submitJob(db: Client, stage: string, key: string, filterOverride?: object) {
  let filter = filterOverride;
  if (!filter) {
    const sk = (await db.query(`SELECT sk FROM stages WHERE workspace_id = $1 AND key = $2`, [BIG, stage])).rows[0].sk;
    // The oldest JOB_SIZE-ish deals of this stage: pick the created_at of the (size-10)th, so the job has about JOB_SIZE deals.
    const cut = (await db.query(
      `SELECT created_at FROM opportunities WHERE workspace_id = $1 AND stage_sk = $2 ORDER BY created_at OFFSET $3 LIMIT 1`,
      [BIG, sk, JOB_SIZE - 10],
    )).rows[0];
    if (!cut) throw new Error(`stage ${stage} has fewer than ${JOB_SIZE} deals left; run "npm run bench:prepare"`);
    filter = { stage, created: { to: cut.created_at.toISOString() } };
  }
  const t = performance.now();
  const res = await call('POST', '/bulk-moves', BIG, { filter, target_stage: TARGET }, key);
  if (res.status !== 202) throw new Error(`submit failed: ${res.status} ${JSON.stringify(res.json)}`);
  return { job: res.json, submit_ms: round(performance.now() - t), startedAt: performance.now() };
}
const progress = async (id: string) => (await call('GET', `/bulk-moves/${id}`, BIG)).json;

async function verifyJob(db: Client, jobId: string) {
  // A job now finishes in seconds, before autovacuum has analysed its brand-new rows; without statistics the
  // planner can choose a terrible plan for these checks. This is about the checks, not the system under test.
  await db.query('ANALYZE bulk_job_items');
  await db.query('ANALYZE transitions');
  const q = async (sql: string) => (await db.query(sql.replace(/\$JOB/g, `'${jobId}'`).replace(/\$TARGET/g, `(SELECT sk FROM stages WHERE workspace_id='${BIG}' AND key='${TARGET}')`))).rows[0];
  const job = await q(`SELECT state, total, moved, skipped_conflict, cursor_seq, attempt FROM bulk_jobs WHERE id = $JOB`);
  const items = await q(`SELECT count(*)::int AS items, count(*) FILTER (WHERE outcome IS NULL)::int AS pending,
                                count(*) FILTER (WHERE outcome = 'moved')::int AS moved, count(*) FILTER (WHERE outcome = 'skipped_conflict')::int AS skipped
                           FROM bulk_job_items WHERE job_id = $JOB`);
  const wrongState = await q(`SELECT count(*)::int AS n FROM bulk_job_items i JOIN opportunities o ON o.workspace_id = i.workspace_id AND o.id = i.opportunity_id
                               WHERE i.job_id = $JOB AND i.outcome = 'moved' AND (o.stage_sk <> $TARGET OR o.version <> i.expected_version + 1)`);
  const wrongTransitions = await q(`SELECT count(*)::int AS n FROM bulk_job_items i
                                     LEFT JOIN (SELECT opportunity_id, count(*) AS n FROM transitions WHERE job_id = $JOB GROUP BY 1) t ON t.opportunity_id = i.opportunity_id
                                    WHERE i.job_id = $JOB AND ((i.outcome = 'moved' AND coalesce(t.n, 0) <> 1) OR (i.outcome = 'skipped_conflict' AND coalesce(t.n, 0) <> 0))`);
  const strays = await q(`SELECT count(*)::int AS n FROM transitions t WHERE t.job_id = $JOB
                           AND NOT EXISTS (SELECT 1 FROM bulk_job_items i WHERE i.job_id = t.job_id AND i.opportunity_id = t.opportunity_id)`);
  const transitions = await q(`SELECT count(*)::int AS n FROM transitions WHERE job_id = $JOB`);
  const checks = {
    job_completed: job.state === 'completed',
    every_item_has_one_outcome: items.pending === 0 && items.items === job.total,
    counters_match_items: job.moved === items.moved && job.skipped_conflict === items.skipped && job.moved + job.skipped_conflict === job.total,
    cursor_at_end: job.cursor_seq === job.total,
    moved_deals_at_target_with_version_plus_one: wrongState.n === 0,
    exactly_one_transition_per_moved_deal_none_for_skipped: wrongTransitions.n === 0 && transitions.n === job.moved,
    no_deal_outside_the_snapshot_touched: strays.n === 0,
  };
  return { ...job, ...{ items: items.items, skipped_items: items.skipped }, checks, all_checks_pass: Object.values(checks).every(Boolean) };
}

async function startWorker(env: Record<string, string> = {}) {
  return spawnNode('worker.main.js', { BULK_LEASE_TTL_MS: String(LEASE_TTL_MS), BULK_POLL_INTERVAL_MS: '100', ...env });
}

// ---------- scenarios ----------
async function scenario(db: Client, name: string, stage: string, opts: { duty: number; load: boolean; huge?: boolean }) {
  console.error(`\n[${name}] duty=${opts.duty} load=${opts.load} ${opts.huge ? 'whole workspace' : `stage=${stage}`}`);
  const worker = await startWorker({ BULK_DUTY_CYCLE: String(opts.duty) });
  await sleep(1500);
  const groups = opts.load ? await loadGroups(db, opts.huge) : [];
  // The huge job covers everything created before the oldest of the interactive users' deals, so it never
  // touches the deals the users are moving (which would make the correctness check meaningless for them).
  let filterOverride: object | undefined;
  if (opts.huge) {
    const oldestUserDeal = (await db.query(
      `SELECT min(created_at) AS t FROM opportunities WHERE workspace_id = $1 AND id = ANY($2::bigint[])`, [BIG, groups[0].deals],
    )).rows[0].t as Date;
    filterOverride = { created: { to: new Date(oldestUserDeal.getTime() - 1).toISOString() } };
  }
  const stop = { done: false };
  const samples: Samples = {};
  let loadRun: Promise<void> | undefined;
  let loadStart = 0;
  if (opts.load) { loadStart = performance.now(); loadRun = runLoad(groups, stop, samples); await sleep(500); }

  const { job, submit_ms, startedAt } = await submitJob(db, stage, `bench-${name}-${Date.now()}`, filterOverride);
  const timeline: [number, number][] = [];
  let view = job;
  let snapshotDoneAt: number | undefined; // when the worker finished building the item list
  while (view.state !== 'completed' && view.state !== 'failed') {
    await sleep(250);
    view = await progress(job.id);
    if (snapshotDoneAt === undefined && view.phase === 'move') snapshotDoneAt = performance.now();
    timeline.push([round((performance.now() - startedAt) / 1000, 2), view.processed]);
    if ((performance.now() - startedAt) > 600_000) throw new Error('job did not finish in 10 minutes');
  }
  const wall = (performance.now() - startedAt) / 1000;
  stop.done = true;
  if (loadRun) await loadRun;
  const loadSeconds = (performance.now() - loadStart) / 1000;
  worker.kill('SIGKILL');
  const verified = await verifyJob(db, job.id);
  const dbTimes = (await db.query(`SELECT extract(epoch FROM (finished_at - started_at))::float8 AS s FROM bulk_jobs WHERE id = $1`, [job.id])).rows[0].s;
  const result = {
    scenario: name, duty_cycle: opts.duty, interactive_load: opts.load, source_stage: stage,
    total: view.total, moved: view.moved, skipped_conflict: view.skipped_conflict, state: view.state,
    submit_ms, snapshot_done_after_s: snapshotDoneAt === undefined ? null : round((snapshotDoneAt - startedAt) / 1000, 2),
    wall_clock_s: round(wall, 2), worker_run_s: round(dbTimes, 2),
    sustained_rows_per_s: round(view.total / dbTimes, 0), rows_per_s_incl_submit: round(view.total / wall, 0),
    interactive: opts.load ? Object.fromEntries(Object.entries(samples).map(([g, s]) => [g, summarise(s, loadSeconds)])) : undefined,
    verification: verified,
  };
  console.error(`[${name}] ${result.total} rows in ${result.wall_clock_s}s (${result.sustained_rows_per_s} rows/s), checks pass: ${verified.all_checks_pass}`);
  await sleep(3000);
  return result;
}

async function loadGroups(db: Client, newest = false): Promise<Group[]> {
  // `newest`: the users' deals are the most recently created ones, so a "created before" filter can exclude them.
  const deals = async (ws: string) => (await db.query(
    `SELECT id::text FROM opportunities WHERE workspace_id = $1 AND stage_sk = (SELECT sk FROM stages WHERE workspace_id = $1 AND key = $2)
      ORDER BY ${newest ? 'created_at DESC, id' : 'id'} LIMIT $3`,
    [ws, PING[0], VUS],
  )).rows.map((r) => r.id as string);
  return [{ name: 'same workspace (bigco)', ws: BIG, deals: await deals(BIG) }, { name: 'other workspace (small-1)', ws: OTHER, deals: await deals(OTHER) }];
}

async function baseline(db: Client) {
  console.error(`\n[baseline] interactive load only, ${BASELINE_SECONDS}s`);
  const groups = await loadGroups(db);
  const stop = { done: false };
  const samples: Samples = {};
  const run = runLoad(groups, stop, samples);
  await sleep(BASELINE_SECONDS * 1000);
  stop.done = true;
  await run;
  return Object.fromEntries(Object.entries(samples).map(([g, s]) => [g, summarise(s, BASELINE_SECONDS)]));
}

async function killAndResume(db: Client) {
  console.error(`\n[kill-and-resume] kill -9 the worker at ~${KILL_AT} rows, lease ttl ${LEASE_TTL_MS}ms`);
  const a = await startWorker({ BULK_DUTY_CYCLE: String(config.bulk.dutyCycle) });
  await sleep(1500);
  const { job, startedAt } = await submitJob(db, 'qualified', `bench-kill-${Date.now()}`);
  let view = job;
  while (view.processed < KILL_AT) { await sleep(50); view = await progress(job.id); }
  a.kill('SIGKILL'); // no chance to clean up: this is the crash
  const tKill = performance.now();
  await new Promise((r) => a.once('exit', r));
  const atKill = (await db.query(`SELECT cursor_seq, moved, skipped_conflict, state, lease_expires_at > now() AS lease_alive FROM bulk_jobs WHERE id = $1`, [job.id])).rows[0];
  const halfApplied = await progress(job.id);
  const b = await startWorker({ BULK_DUTY_CYCLE: String(config.bulk.dutyCycle) });
  let firstProgressAt = 0;
  while (view.state !== 'completed' && view.state !== 'failed') {
    await sleep(100);
    view = await progress(job.id);
    if (!firstProgressAt && view.processed > atKill.moved + atKill.skipped_conflict) firstProgressAt = performance.now();
    if (performance.now() - tKill > 600_000) throw new Error('resume did not finish');
  }
  const tDone = performance.now();
  b.kill('SIGKILL');
  const verified = await verifyJob(db, job.id);
  const result = {
    total: view.total,
    committed_at_kill: atKill.moved + atKill.skipped_conflict,
    state_seen_right_after_kill: { state: halfApplied.state, health: halfApplied.health, processed: halfApplied.processed, remaining: halfApplied.remaining },
    lease_ttl_ms: LEASE_TTL_MS,
    kill_to_first_resumed_progress_s: round((firstProgressAt - tKill) / 1000, 2),
    resumed_work_s: round((tDone - firstProgressAt) / 1000, 2),
    kill_to_completion_s: round((tDone - tKill) / 1000, 2),
    whole_job_wall_clock_s: round((tDone - startedAt) / 1000, 2),
    attempts: verified.attempt,
    verification: verified,
  };
  console.error(`[kill-and-resume] killed at ${result.committed_at_kill}/${result.total}; done ${result.kill_to_completion_s}s after the kill; checks pass: ${verified.all_checks_pass}`);
  return result;
}

// ---------- main ----------
async function main() {
  const db = new Client({ connectionString: config.databaseUrl });
  await db.connect();
  try {
    const counts = (await db.query(`SELECT (SELECT count(*)::int FROM opportunities WHERE workspace_id = 'bigco') AS big, (SELECT count(*)::int FROM bulk_jobs) AS jobs`)).rows[0];
    if (counts.big < 500_000) throw new Error('the benchmark database needs the large seed: run "npm run bench:prepare"');
    if (counts.jobs > 0) throw new Error('the benchmark database already has bulk jobs from an earlier run: run "npm run bench:prepare" for a fresh dataset');

    const pg = (await db.query('SHOW server_version')).rows[0].server_version;
    let podman: unknown = null;
    try { podman = JSON.parse(execSync('podman machine inspect', { stdio: ['ignore', 'pipe', 'ignore'] }).toString())[0]?.Resources; } catch { /* not using podman */ }
    const hardware = {
      cpu: os.cpus()[0].model, cpu_cores: os.cpus().length, memory_gb: round(os.totalmem() / 2 ** 30, 0),
      os: `${os.type()} ${os.release()} ${os.arch()}`, node: process.version, postgres: pg, postgres_runs_in_vm: podman,
    };

    const api = spawnNode('main.js', { PORT: String(PORT) });
    void api;
    await waitFor('API to start', async () => { try { return (await call('GET', '/bulk-moves/00000000-0000-0000-0000-000000000000', BIG)).status === 404; } catch { return false; } }, 30_000, 250);

    const results: Record<string, unknown> = { hardware, settings: { label: LABEL, unpaced_first: UNPACED_FIRST, job_size: JOB_SIZE, huge: HUGE, chunk_size: config.bulk.chunkSize, duty_cycle: config.bulk.dutyCycle, users_per_group: VUS, think_ms: THINK_MS, lease_ttl_ms: LEASE_TTL_MS } };
    results.baseline_no_bulk = await baseline(db);
    if (!ONLY_HUGE) {
      const alonePaced = () => scenario(db, 'bulk-alone-paced', 'new-lead', { duty: config.bulk.dutyCycle, load: false });
      const aloneUnpaced = () => scenario(db, 'bulk-alone-unpaced', 'discovery', { duty: 1, load: false });
      const loadPaced = () => scenario(db, 'bulk-with-load-paced', 'contacted', { duty: config.bulk.dutyCycle, load: true });
      const loadUnpaced = () => scenario(db, 'bulk-with-load-unpaced', 'new-lead', { duty: 1, load: true });
      // Note: the two scenarios on "new-lead" keep their relative order (alone before with-load) in both orderings.
      if (UNPACED_FIRST) {
        results.bulk_alone_unpaced = await aloneUnpaced();
        results.bulk_alone_paced = await alonePaced();
        results.bulk_with_load_unpaced = await loadUnpaced();
        results.bulk_with_load_paced = await loadPaced();
      } else {
        results.bulk_alone_paced = await alonePaced();
        results.bulk_alone_unpaced = await aloneUnpaced();
        results.bulk_with_load_paced = await loadPaced();
        results.bulk_with_load_unpaced = await loadUnpaced();
      }
      results.kill_and_resume = await killAndResume(db);
    }
    if (HUGE) results.bulk_whole_workspace_paced_with_load = await scenario(db, 'bulk-whole-workspace-paced-with-load', '', { duty: config.bulk.dutyCycle, load: true, huge: true });

    mkdirSync('benchmarks', { recursive: true });
    const file = join('benchmarks', `results-${LABEL}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(file, JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
    console.error(`\nresults written to ${file}`);
  } finally {
    await db.end();
    cleanup();
  }
}
main().then(() => process.exit(0)).catch((err) => { console.error(err); cleanup(); process.exit(1); });
