# BENCHMARKS

Measured, not modelled. Everything below comes from `benchmarks/results-*.json`, produced by `npm run bench`. These are rough single-machine numbers with two runs each, so read them as orders of magnitude and trends, not as precise figures.

## Hardware and environment

| | |
|---|---|
| Machine | Apple M3 Pro, 12 cores, 36 GB RAM, macOS (Darwin 25.4, arm64) |
| Postgres | 16.15, **inside a Podman VM (Apple virtualization) with 6 CPUs and 8 GB RAM**, default configuration (`shared_buffers` 128 MB, `work_mem` 4 MB, `max_wal_size` 1 GB) |
| App | Node 22.14; the API and the worker run as separate processes on the host (not in containers) |
| Client | the benchmark harness on the same host, using the API over HTTP on localhost |

Postgres in a VM on a laptop is slower and noisier than bare Linux; absolute numbers will differ on your hardware. Everything ran on one machine, so client, API, worker and database compete for the same CPU.

## Data

`npm run seed:large` (26 s): **500,000 opportunities** in `bigco` across **12 stages, unevenly filled** (22% / 17% / 13% / 11% / 9% / 8% / 6% / 5% / 4% / 2.5% / 1.5% / 1%), `created_at` spread over **18 months**, plus **five small workspaces** of 2,000 / 2,500 / 3,000 / 3,500 / 4,000 deals. 1.56 million transitions (each deal has the history of the stages it passed through). The tables are about 106 MB (opportunities) and 226 MB (transitions), each including its indexes.

## Method

`npm run bench:prepare` recreates the database (`opps_bench`) and seeds it; `npm run bench` then does the following against real processes.

- **Bulk job.** Move **49,991 deals** (a source stage plus a `created` cutoff) to another stage. Wall-clock is measured from sending the submit request to first seeing `completed` while polling every 250 ms. **It includes the snapshot phase**, because the worker builds the item list after submit; `snapshot done after` is when the progress endpoint first showed `phase: move`. "Sustained" is total rows divided by the job's own `finished_at - started_at` in the database. Settings: move chunk 500 rows, snapshot batch 10,000 rows, duty cycle 0.5 (paced) or 1.0 (unpaced), the API and worker started fresh for each scenario.
- **Interactive load.** Two groups of 8 simulated users, one in the **same workspace** (`bigco`) and one in a **different** workspace (`small-1`), each sending 70% list requests (50 rows) and 30% single-deal moves with 15 ms think time: about 420 requests/s per group. The users move deals that are not in the job's set, so this measures interference, not lock collisions (the collision is covered by tests). A 15 s baseline runs with no bulk job.
- **Kill and resume.** The worker is killed with `SIGKILL` when 30,000 rows are committed; a new worker is started at once. The lease TTL is set to 10 s for this run (the default is 30 s).
- **Correctness proof.** After every job, SQL checks that: the job is `completed`; every item has exactly one outcome; the counters equal the item counts; the cursor is at the end; every moved deal is in the target stage with `version = snapshot version + 1`; there is exactly one bulk transition per moved deal and none for skipped ones; no deal outside the snapshot was touched.
- **Ordering.** Each scenario uses a different, untouched set of deals. To expose any effect of running second on a dataset the first one changed, the whole benchmark ran twice with the paced/unpaced order swapped (run C: paced first, run D: unpaced first), each on a freshly seeded database.
- **Whole-workspace move (10x).** A separate run (`BENCH_ONLY_HUGE=1`) on a fresh database: one paced job over everything in `bigco` created before the interactive users' own deals (so the job never touches deals the users are editing), with the same interactive load.

## Results

### Bulk move of 49,991 deals

| Scenario | Wall-clock C / D | Snapshot done after C / D | Sustained rows/s C / D |
|---|---|---|---|
| Paced (duty 0.5), no other load | 6.6 s / 6.6 s | 1.0 s / 1.0 s | 7,948 / 7,863 |
| **Unpaced (duty 1)**, no other load | 3.3 s / 2.8 s | 0.8 s / 0.5 s | 16,596 / 19,086 |
| Paced, with interactive load | 6.0 s / 5.5 s | 1.0 s / 1.0 s | 8,613 / 9,145 |
| Unpaced, with interactive load | 3.0 s / 3.0 s | 0.5 s / 0.5 s | 17,879 / 17,237 |

"Snapshot done after" is measured with 250 ms polling, so read it as +/-0.25 s. "Sustained" is the whole worker run (snapshot batches and moves together). The order swap made no difference (unpaced was about 2x faster in both orders). The default is paced, which costs about 2x the throughput. "Paced, with load" was slightly *faster* than "paced, no load", but the two use different source stages (different rows), so they are not directly comparable. **Submit itself now takes 3-25 ms** (it only records the job); it took 0.37-0.47 s in the earlier version, which took the snapshot inside the request.

Moving the snapshot into the worker cost a little wall-clock time (the unpaced job went from 2.5-2.8 s to 2.8-3.3 s; the paced one is unchanged at about 6.6 s): the snapshot batches are now paced like the moves, and a job waits for the worker to poll for it. The earlier runs are kept in `benchmarks/before-snapshot-in-worker/`.

### Whole-workspace move: 492,332 deals in one job

Fresh database, paced (default), with the same interactive load on `bigco` and `small-1`.

| | |
|---|---|
| Deals in the job | 492,332 (all of `bigco` created before the users' deals, except those already in the target stage) |
| Submit request | 4 ms |
| Snapshot phase (about 50 batches of 10,000, paced) | 7.0 s |
| **Total wall-clock** | **47.4 s** |
| Sustained (snapshot and moves together) | 10,411 rows/s |
| Moved / skipped | 492,332 / 0 |
| Attempts | 1 |
| All 7 correctness checks | pass |
| Job item rows | about 200 bytes each including the primary-key index (about 49 MB for 250,000 rows measured), so roughly 100 MB for this job |

Interactive requests during the job (about 21,000 per group over 47 s, zero errors):

| | p50 / p95 / p99 (ms) |
|---|---|
| Baseline, no job (15 s, about 6,500 requests per group), same workspace | 1.8 / 4.5 / 10.8 |
| **During the 492k job, same workspace** | 1.8 / 4.6 / 7.7 |
| **During the 492k job, other workspace** | 1.8 / 4.6 / 7.9 |

No degradation was measurable in this run. The p99 during the job is *lower* than the baseline's, which says the baseline's p99 (10-17 ms across runs) is noise-limited, not that a job speeds requests up.

### Interactive requests while the 50k job ran

Latency in milliseconds (all request types combined). `n` is about 6,500 per group for the baseline and 1,500-2,800 per group during a job.

| | Same workspace p50 / p95 / p99 | Other workspace p50 / p95 / p99 |
|---|---|---|
| Baseline, no bulk job (C) | 1.8 / 4.5 / 17.0 | 1.9 / 4.6 / 15.9 |
| Baseline, no bulk job (D) | 1.7 / 4.5 / 12.0 | 1.9 / 4.6 / 11.4 |
| During **paced** job (C) | 1.9 / 5.4 / 20.3 | 2.0 / 5.6 / 20.2 |
| During **paced** job (D) | 1.8 / 4.7 / 13.1 | 1.8 / 4.7 / 15.0 |
| During **unpaced** job (C) | 2.0 / 5.4 / 19.4 | 2.0 / 5.4 / 15.3 |
| During **unpaced** job (D) | 2.1 / 6.5 / 12.7 | 2.3 / 6.4 / 17.1 |

Zero errors in every scenario. What this shows:
- The median is unchanged, and p95 rises by 0.2-2 ms while a job runs.
- **p99 is within the run-to-run noise of the baseline.** The two baselines alone differ by 5 ms at p99 (12.0 versus 17.0), and each cell's p99 is the top 1% of only 1,500-2,800 requests (15-28 requests). The earlier version's runs showed p99 roughly doubling under a job (10-12 ms to 12-30 ms); these runs do not show a clear effect either way, so I do not claim one.
- The **other workspace looks the same as the same workspace**. That is what a shared database predicts (CPU, I/O, WAL): workspace isolation here is at the application level, not the resource level.
- **Pacing did not measurably help.** The unpaced job did no more damage than the paced one, within noise. At this light load the job is simply not heavy enough to hurt, so this benchmark cannot show what pacing buys. It is demonstrated only as a cap on the job's database time.

### Kill and resume

Killed with `SIGKILL` at 30,000 of 49,991 rows committed; lease TTL 10 s.

| | Run C | Run D |
|---|---|---|
| Committed when killed | 30,000 | 30,000 |
| What the progress endpoint said right after the kill | `running` / `progressing` (lease still alive) | same |
| Kill to first resumed progress | 10.2 s | 10.2 s |
| Resumed work (remaining 19,991 rows) | 2.3 s | 2.5 s |
| **Kill to completion** | **12.5 s** | **12.7 s** |
| Whole job, submit to done | 16.8 s | 17.1 s |
| Attempts | 2 | 2 |
| All 7 correctness checks | pass | pass |

Resume time is dominated by the lease TTL (about 10 s of the 12.5 s); with the default 30 s TTL I would expect about 33 s (not measured). The 2.3-2.5 s of real work is the remaining 40% of the job. Killing the worker *during the snapshot phase* is covered by tests (`test/bulk-worker.spec.ts`), not by the benchmark.

### Correctness proof

All scenarios passed all seven SQL checks listed under Method: 10 jobs of about 50,000 rows (5 per run, including both kill-and-resume runs), the 492,332-row job, and a 242,377-row job in run C that shared its dataset with the earlier scenarios. `skipped_conflict` was 0 in every run because the users moved deals outside the job's set; collisions are proven by the tests (`test/bulk-worker.spec.ts`), where a manual edit before or during a chunk makes the job skip the deal.

## What the benchmark found: a defect in my first version

The first benchmark run gave much worse numbers, and I investigated instead of reporting them. Those results are kept in `benchmarks/before-chunk-plan-fix/`.

| Scenario | Before the fix | After the fix |
|---|---|---|
| Paced, no load | 35.7 s (1,406 rows/s) | 6.6-6.9 s |
| Unpaced, no load | 48.5 s (1,034 rows/s) | 2.5-2.8 s |
| Paced, with load | 63.3 s (792 rows/s) | 5.5-5.8 s |
| Kill to completion | 14.0 s | 12.7 s (the lease wait dominates) |

(The "after" column is the version with the snapshot still in the submit request; the tables above are for the current code.)

In every job the first ~10 chunks took 2-4 s each, and later ones 43-100 ms. `EXPLAIN (ANALYZE, BUFFERS)` on the first chunk showed that the statement marking the items joined to the chunk and Postgres, with no statistics yet on the freshly inserted rows, scanned **all** of the job's items for each chunk (about 15 million comparisons per chunk). The fix addresses items by the primary-key range directly and materialises the chunk; a test now fails if a job-sized scan comes back. The odd result that paced was faster than unpaced in that first run was this defect interacting with autovacuum timing, not a real effect.

A second, smaller lesson: jobs now finish so quickly that the harness's own verification queries hit the same missing-statistics problem, so the harness runs `ANALYZE` before verifying. That concerns the checks, not the system.

## Limits of these measurements

- One machine, Postgres in a VM, default Postgres settings; two runs per 50k scenario, one run of the 492k job.
- The interactive load is light (about 420 requests/s per group) and closed-loop. It does not saturate the API's 10-connection pool or the database.
- Tail percentiles rest on 15-28 requests per cell in the 50k runs (see above); the 492k run has about 21,000 requests per group, so its percentiles are much steadier.
- Only one job at a time was run; multiple concurrent jobs in different workspaces were not benchmarked.
- The snapshot's query plan was checked with `EXPLAIN` on the 500k dataset (an ordered primary-key scan, about 4 ms for a 10,000-row batch when the filter matches most rows). A very selective filter on a much larger workspace was **not** measured (see `DESIGN.md`, 2.7).
- 20 million rows were **not** run; `DESIGN.md`'s "10x" section is reasoning plus the 500k measurements above.
- Docker was not available here; the containerised flow was verified with `podman compose` only.

## Reproduce

```bash
npm ci && npm run build
export DATABASE_URL=postgres://opps:opps@localhost:5432/opps_bench   # the name must contain "bench"
npm run bench:prepare    # recreates the benchmark database and seeds 500k + 5 small workspaces (~30 s)
npm run bench            # ~1.5 minutes; prints JSON and writes benchmarks/results-<label>-<time>.json
# swap the paced/unpaced order:   BENCH_UNPACED_FIRST=1 BENCH_LABEL=D npm run bench
# the whole-workspace move on its own (run bench:prepare first):   BENCH_ONLY_HUGE=1 BENCH_LABEL=huge npm run bench
# (each run consumes the dataset: run bench:prepare again before the next one)
```
Tunables: `BENCH_JOB_SIZE`, `BENCH_VUS`, `BENCH_BASELINE_SECONDS`, `BENCH_KILL_AT`, `BENCH_LEASE_TTL_MS`.
