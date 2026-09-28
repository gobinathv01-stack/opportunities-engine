# DESIGN — Bulk Stage Move

Part 1 is deliberately minimal, per the brief ("do not polish this"); this document covers Part 2, the actual exercise. Every number here was measured on the machine described in BENCHMARKS.md, which says how to reproduce it.

**Shape:**
- `POST /bulk-moves` validates and records the job, returns a job handle (`202`) at once — cost doesn't depend on how many deals match.
- A separate **worker process** builds the snapshot first (matching deals → `bulk_job_items`, numbered `1..n`) in batches, then walks the items in small transactions.
- `GET /bulk-moves/:id` reports committed state only.
- All job state (key, cursor, counters, lease) is rows in Postgres — a process can die at any moment and lose nothing but the one chunk in flight.
- No Redis or Kafka: a queue would be a second source of truth that could disagree with the data after a crash. The job row and the moved deals commit together in one transaction instead.

## 1. Chunking and the cursor

- **Snapshot batches:** the worker appends up to 10,000 matching deals per transaction, scanning `id > snapshot_cursor_id` on the primary key (ascending id order) — one pass over the workspace, however many batches it takes.
- Each batch, the new `snapshot_cursor_id`, and the running `total` commit together. A short batch (fewer rows than the batch size) means the scan is done, so the job flips `phase` from `snapshot` to `move`.
- **Resumable:** a kill mid-snapshot resumes from the last committed batch — no gap, no duplicate (tested). Snapshot batches share the same lease, fencing, pacing and timeouts as chunks.
- **Move phase — the index that makes chunking cheap:** items are numbered `1..n`, so a chunk is the contiguous range `(cursor, cursor + 500]`, read and marked through the primary key `(workspace_id, job_id, seq)`. No other index is needed.
- One chunk is **one transaction, one SQL statement**: move each deal (only if its `version` still matches the snapshot), insert transitions, mark items, advance `cursor_seq` and the counters — all or nothing. After a restart the next worker just reads `cursor_seq`.
- **Example — a defect this caught:** the first version marked items by joining to the chunk. On a job with no planner statistics yet, Postgres scanned *all* of that job's items on every chunk (~15 million row comparisons per chunk on a 30k-item job) — the first chunks took 2-4 s each, and 50,000 rows took 36-63 s total. Fix: mark by the same primary-key range, with the chunk `MATERIALIZED`. Result: 50,000 rows now take 2.8-6.6 s. A regression test asserts a chunk reads only its own items and fails if the old shape comes back.

## 2. Idempotency

- **Key:** the client's required `Idempotency-Key` header, scoped per workspace, plus a hash of the canonicalized request (filter + target; statuses sorted, absent fields dropped).
- **Storage:** a committed row in `bulk_jobs`, `UNIQUE (workspace_id, idempotency_key)` — no TTL, no cache, so it survives a process restart by construction.
- **What it protects:**
  - A retry returns the same job (`Idempotent-Replayed: true`) and does no new work.
  - Simultaneous submits are serialized by the unique constraint (`ON CONFLICT DO NOTHING` waits for the first to commit). *Example:* 8 concurrent submits with the same key create exactly 1 job.
  - The same key with a *different* request body is a `422`, not a silent retry.
  - Two deeper layers guard below the key itself: a chunk's moves/transitions/cursor commit together (a replayed chunk can't re-apply), and `UNIQUE (job_id, opportunity_id)` on transitions plus the version guard stop a double-move of one deal.
- **Where a retry can still slip through:**
  1. A client that invents a *new key* on retry looks like a brand-new request — blocked by the one-active-job rule while the first job is running, but not once it finishes.
  2. Keys never expire, so the table grows unbounded; if they were purged, an old retry would create a fresh job.
  3. Canonicalization is syntactic, not semantic. *Example:* `{}` and `{"value":{"min":0}}` select the same deals but count as different requests.

## 3. Resumable, and what "correctly" means

- **Correct** means, after any kill and resume:
  - every snapshot item ends with exactly one outcome (`moved` or `skipped_conflict`)
  - every moved deal is in the target stage with `version = snapshot version + 1` and exactly one bulk transition
  - every skipped deal has neither, and was untouched by the job
  - the counters equal the item counts, and the cursor sits at the end
  - *Verified:* the benchmark checks all of this with SQL after every run, including after a real `kill -9`.
- **Ownership:** a worker claims a job with `FOR UPDATE SKIP LOCKED` and a **lease** (default 30 s). Each chunk locks the job row and checks a **fencing token** twice — on entry, and again on the final progress update. Either check failing rolls back the whole chunk, so a worker that stalled and lost its lease can never commit, even if it wakes up later.
- **What a kill actually does:**

| Event | Result |
|---|---|
| Killed between chunks | Committed chunks stay. After the lease expires, another worker resumes from `cursor_seq`. |
| Killed mid-chunk | The transaction rolls back, leaving no trace; the chunk is redone. |
| Killed while snapshotting | Committed batches stay; the next worker continues the scan from `snapshot_cursor_id`. Same rollback rule for a batch in flight. |
| Worker paused, not dead | Its lease expires and a new worker takes over; the old one's commit is refused. |
| Transient error | Retried with backoff (5 attempts). |
| Persistent error | The job becomes `failed` with the error; committed work is kept. |

- **Half-applied, from the user's side:**
  - Snapshotting: `phase: snapshot`, a running "found" count, nothing moved yet.
  - Mid-move: `running` with real counts. The workspace holds a mix, but every deal is either fully moved or untouched — never partial. There is no rollback; the job is forward-only.
  - *Example (measured):* killed at 30,000 of 49,991, the job finished 12.7 s after the kill — 10.1 s waiting for the 10 s lease to expire, 2.6 s redoing the remaining 19,991 rows. Recovery latency ≈ the lease TTL, a tunable knob (shorter = faster recovery, more takeovers).

## 4. Observable

- The progress endpoint reads only committed rows (including the snapshot's `snapshotted` count and `phase`) and derives health at read time:
  - `queued`, `waiting` (yielded to another workspace, will resume), `progressing`, `slow` (< 100 rows/s), `stuck` (live lease but no committed progress for 30 s — e.g. blocked on a lock), `stalled` (lease expired — the worker is dead), `completed`, `failed`.
- **Limits:**
  - A dead worker still reads `progressing` until its lease expires. *Measured:* right after `kill -9` it still showed `progressing`, so detection takes up to one lease TTL.
  - `slow` averages since the job's start, so a resumed job can briefly look slow.

## 5. Concurrent edits, and snapshot versus live

- **Rule: the person wins.** The job moves a deal only `WHERE version = <version at snapshot>`. Any write bumps `version`, so any edit since the snapshot makes the job skip that deal (`skipped_conflict`) — it never overwrites.
  - *Why:* a person's deliberate, later action outranks a bulk request built from a stale list, and a skip is recoverable (reported, re-runnable) while an overwrite is not. Skipping on *any* edit is deliberately conservative — an owner or value change could mean the deal no longer matches the filter, and the job can't tell cheaply.
  - *Example:* a person is mid-move on a row the job reaches — the job's update waits on the row lock, then re-evaluates: the version changed, so it skips (tested with two connections). If the job commits first instead, the person's move applies on top and both transitions appear in order.
- **Snapshot, not live.** The matching ids and versions are fixed once the worker's scan has passed them; the move phase never re-evaluates the filter.
  - *Why:* the total and percent stay meaningful, the job is deterministic and resumable by a plain cursor, the cap is checked during the scan, and it does exactly what the user selected ("these deals").
  - *Consequence:* deals that start matching later are never moved; deals that stop matching are skipped by the version guard; longer jobs mean more skips. A live filter would move deals nobody selected and make the total drift.
- **What batching the snapshot softens:** the list isn't built in one instant — each batch is read at its own moment (whole scan ≈ 1 s for 50,000 deals, 7 s for 492,000).
  - *Example:* a deal edited into or out of the filter between submission and the scan reaching it is judged on its state at scan time (tested). Deals created after submission never join (`created_at <=` the submission time).
  - Correctness doesn't depend on this timing: each item records the version it had when scanned, and any later edit makes the job skip it.
  - *Why not the alternatives:* one long `REPEATABLE READ` transaction would hold back vacuum for the whole scan; the old synchronous (submit-time) snapshot held an API request and one huge transaction.

## 6. Isolation mechanism, and the hole it leaves

Implemented, each with a test (except where noted):
1. **Separate worker process** with its own small connection pool (4) — bulk work can never exhaust the API's pool.
2. **Short chunk transactions** (500 rows), `lock_timeout` 2 s — a person editing a deal waits at most one chunk; lock timeouts count as back-pressure, not failure.
3. **Pacing:** duty cycle 0.5 — after each chunk, sleep `chunk_time * (1/duty - 1)` (capped at `maxPauseMs`), so the job spends at most half its wall-clock time on database work. No adaptive backoff: a fixed duty cycle already bounds the job's database time regardless of chunk speed, so an adaptive layer on top was removed as unneeded complexity.
4. **One active job per workspace** (partial unique index).
5. **Time-sliced fair claiming:** a job yields after 3 s if another workspace's job is waiting; the least-recently-served job goes next. *Example (tested):* with one worker slot, a small job finishes while a big one sits at 20/50 done.
6. **The snapshot runs in the worker, not the API.** Submit is one small insert; batches (10,000 rows, ~0.1 s) use the worker's pool, the same pacing and `statement_timeout`, and the same yield-to-another-workspace rule (tested).

**The hole: everything shares one Postgres.** CPU, I/O, WAL and autovacuum are shared, so isolation is reduced, not eliminated.
- *Measured:* during a 50k job, p95 rose 0.2-2 ms and p99 stayed within the baseline's run-to-run noise (10-17 ms) — same workspace and a different one alike; during a 492k job, neither moved.
- Pacing wasn't shown to help those latency numbers: the unpaced job (~20,000 rows/s) hurt no more than the paced one, within noise. So pacing is demonstrated as a cap on the job's own database time (it roughly halves throughput), not as a measured latency benefit to others.

## 7. What breaks at 10x

- **500,000-record move** — measured, not just reasoned:
  - One paced job moved **492,332 deals in 47 s** (7 s snapshot, then ~10,000 rows/s moving), with no measurable latency change on interactive load in the same workspace, and all seven correctness checks passed.
  - *What already broke at this size, and was fixed:* the old design ran the snapshot inside the submit request (~4 s at 500k, holding an API connection and one huge transaction). It now runs in the worker in resumable batches, so submit stays at a few milliseconds.
  - *What I'd watch next:* (1) the job's item rows (~100 MB for this job, never cleaned up); (2) 500k non-HOT updates leave dead tuples in two indexes (vacuum load, not measured); (3) a longer job widens the window for edit-driven skips.
  - The cap is 1,000,000; another 10x past this needs item-row cleanup and a vacuum review first.
- **20 million opportunities in a workspace:**
  - Keyset listing and per-deal locks stay flat (index lookups).
  - An unindexed filter (e.g. owner only) scans the workspace: 21 ms on 500k rows (parallel scan) → an *extrapolated* 0.9 s at 20M — not a failure yet.
  - **The real new risk is the snapshot scan.** Each batch walks the primary key in id order from the cursor until it has 10,000 matches.
    - Filter matches most rows → an ordered index scan, ~4 ms/batch (checked with `EXPLAIN` on 500k).
    - Filter matches few rows → a batch may read a large part of the workspace before finding 10,000 (still one pass overall) — but the planner switched to a bitmap scan plus sort for a filter matching nothing (14 ms on 500k). If that happened on every batch of a large job, the cost would turn quadratic.
    - A single batch scanning 20 million rows could exceed the 20 s `statement_timeout`, fail 5 times, and mark the job failed.
  - *Not measured directly* — these are estimates from the 500k runs. Fix: bound each batch by a window of ids scanned, not matches found.
  - Next likely failure: cache pressure and table/index bloat (the primary key and stage index grow to gigabytes; moving many rows in a stage churns them).
  - Options at that scale: filter indexes (each taxes every moved row), partitioning by workspace, or a dedicated database for very large tenants.

## 8. With another week, ranked

1. Test isolation under heavy load and multiple concurrent jobs to find where pacing actually matters; add a global rows-per-second budget.
2. Cancel and retry endpoints, a job list, and a paginated view of skipped items.
3. Clean up a finished job's `bulk_job_items` (a retention policy), and enforce stage-key immutability; add an idempotency-key retention policy.
4. Tune write cost: fillfactor and HOT eligibility, and measure vacuum behaviour on `opportunities`.
5. Run the compose flow and the benchmark under real Docker on Linux (only Podman on macOS was used here), and add CI.
