# Opportunities engine

A small multi-tenant CRM service (NestJS, TypeScript, PostgreSQL) whose real subject is one operation: **moving up to 50,000 deals to another pipeline stage as a background job that is idempotent, resumable, observable, correct under concurrent edits, and polite to everything else.**

- `DESIGN.md`: the decisions, the trade-offs and where it is still weak (the most important document).
- `BENCHMARKS.md`: measured throughput, latency, kill-and-resume, hardware and method.

## Run it (one command)

```bash
node scripts/setup.js
```

Works the same on Windows, macOS and Linux: it detects whichever container engine you have (`docker compose`, `podman compose`, or standalone `docker-compose`) and runs it. It starts Postgres, applies the migrations, **seeds a small dataset** (6 workspaces, 6-10 stages each, 15-50 deals each), starts the API on [http://localhost:3000](http://localhost:3000) and the background worker, and **runs the test suite** in its own container (77 tests, about 6 s). Watch for `Tests: 77 passed`. Stop with Ctrl+C, then `docker compose down -v` (or `podman compose down -v`).

Ports can be changed if 3000 or 5432 are taken, as plain arguments (not a shell env-var prefix, which differs between bash/cmd/PowerShell): `node scripts/setup.js API_PORT=3010 DB_PORT=5433`.

> Verified here with Podman (Docker was not installed on the author's machine), on which the whole stack came up in about 16 s and the containerised test run passed. It uses only standard compose features; the migrations also wait for the database themselves, so start order does not matter. If you have Docker or docker-compose instead, `node scripts/setup.js` finds and uses it the same way — or run `docker compose up --build` / `docker-compose up --build` directly.

Try it with the seeded workspace `acme`:

```bash
# list a stage
curl -s "localhost:3000/opportunities?stage=contacted&limit=5" -H "X-Workspace-Id: acme"

# move all open deals to closed-won, as a background job
curl -s -X POST localhost:3000/bulk-moves -H "X-Workspace-Id: acme" \
  -H "Content-Type: application/json" -H "Idempotency-Key: try-1" \
  -d '{"filter":{"status":["open"]},"target_stage":"closed-won"}'
# -> 202 with a job id at once (the worker snapshots the matching deals, then moves them). Poll it:
curl -s localhost:3000/bulk-moves/<id> -H "X-Workspace-Id: acme"
# repeating the same POST returns the same job (header Idempotent-Replayed: true), it does not run twice
```



## Run without Docker

Needs Node 22 and PostgreSQL 16 (defaults: `postgres://opps:opps@localhost:5432/opps`; override with `DATABASE_URL`). No local Postgres install? Use the hybrid path below instead.

```bash
npm ci && npm run build
npm run migrate          # applies migrations/*.sql, once each
npm run seed:small       # demo data; safe to re-run. `npm run db:reset` clears all data
npm start                # the API
npm run start:worker     # the background worker: a separate process
npm test                 # needs Postgres; creates and uses its own database `opps_test`
```



### Hybrid: Postgres in a container, API and worker running natively

No local Postgres install needed, but the API and worker run as plain `node` processes on the host — faster iteration than rebuilding a container image on every change.

```bash
node scripts/setup.js --db-only
```

Same auto-detection, port auto-pick, and self-heal-on-rerun as the full one-command setup, but only `postgres` runs in a container. The script itself then runs `npm ci`, builds, migrates, seeds, and starts both the API and the worker natively, pointed at that container. Ctrl+C stops both; the Postgres container keeps running until you stop it separately (`docker compose down` / `podman compose down`). `npm test` afterwards needs `DATABASE_URL`/`TEST_DATABASE_URL` exported to match the port it printed, if it wasn't the default 5432.

## API

Every request needs `X-Workspace-Id: <workspace slug>` (a tenant; no auth, as specified). Opportunity ids are bigints as strings (up to 18 digits); bulk job ids are UUIDs. Stage keys are short slugs such as `contacted`. Errors use Nest's default shape: `{"statusCode": 409, "message": "...", "error": "Conflict"}`.

### `POST /opportunities` — create a deal

Not a stage change: writes no transition. `status` defaults to `open`.

```jsonc
// request
{ "name": "Acme renewal", "value": 12000, "owner_id": "u-1", "stage": "contacted", "status": "open" }
```

```jsonc
// 201
{
  "id": "42", "workspace_id": "acme", "stage": "contacted", "name": "Acme renewal",
  "value": 12000, "status": "open", "owner_id": "u-1", "version": 1,
  "created_at": "2026-01-01T00:00:00.000Z", "updated_at": "2026-01-01T00:00:00.000Z"
}
```

Errors: `422` unknown stage.

### `POST /opportunities/:id/move` — move one deal and record a transition

```jsonc
// request
{ "stage": "qualified" }
```

`200`: the same Opportunity shape as above, `stage` and `version` updated. Errors: `404` not found, `422` unknown target stage, `409` already in that stage.

### `GET /opportunities?stage=&limit=&cursor=` — list a stage, keyset-paginated

`stage` required; `limit` 1-200 (default 50); `cursor` is the `id` of the last item of the previous page.

```jsonc
// 200
{
  "items": [ { "id": "42", "workspace_id": "acme", "stage": "contacted", "...": "..." } ],
  "next_cursor": "57"   // null on the last page
}
```



### `POST /bulk-moves` — submit a bulk move

Header `Idempotency-Key` required (1-128 chars). `filter` fields all optional and ANDed: `stage`, `owner`, `status` (list), `value` `{min,max}`, `created` `{from,to}` (inclusive; a date-only `to` includes that whole day, UTC).

```jsonc
// request, header Idempotency-Key: try-1
{
  "filter": { "stage": "contacted", "status": ["open"], "value": { "min": 1000 }, "created": { "from": "2026-01-01", "to": "2026-03-31" } },
  "target_stage": "closed-won"
}
```

```jsonc
// 202 — submit only records the job, so this is instant whatever the size
{
  "id": "b6f1c2a0-6e3a-4b8b-9b2a-1e2f3a4b5c6d", "state": "queued", "phase": "snapshot",
  "health": "queued", "target_stage": "closed-won",
  "filter": { "stage": "contacted", "status": ["open"], "value": { "min": 1000 }, "created": { "from": "2026-01-01", "to": "2026-03-31" } },
  "snapshotted": 0, "total": null, "processed": 0, "moved": 0, "skipped_conflict": 0,
  "remaining": null, "percent": null, "attempt": 0,
  "created_at": "2026-01-01T00:00:00.000Z", "started_at": null, "last_progress_at": null, "finished_at": null, "error": null
}
```

A retried submit with the same key and the same body returns this same job unchanged, with response header `Idempotent-Replayed: true`, and does no work. Errors: `400` invalid input (e.g. `filter.value.min > max`); `409` a bulk move is already active in this workspace (body includes `active_job_id`); `422` unknown stage, or this `Idempotency-Key` reused for a different request body. A filter matching more than the cap (`BULK_MAX_ITEMS`, default 1,000,000) makes the job `failed` with a reason, not truncated.

### `GET /bulk-moves/:id` — progress

Same response shape as submit's, evolving as the worker runs. `health` is one of `queued | waiting | progressing | slow | stuck | stalled | completed | failed`, computed from committed timestamps and counters (never an in-memory counter). While `phase` is `snapshot`, `total`/`remaining`/`percent` are `null` and `snapshotted` counts deals found so far; once `phase` is `move`, `total` is fixed and `percent` = `processed / total`. Errors: `404` job not found.

## What is and is not implemented

**Implemented:** Part 1 (create, single move with a transition, paginated list); the bulk move with all five properties: idempotent (key stored in Postgres), resumable (cursor plus lease and fencing, tested with kills), observable (progress from committed rows, with slow/stuck/stalled/failed), correct under concurrent edits (a version guard: the person wins; snapshot semantics), well-behaved (separate worker pool, short chunks and snapshot batches with lock timeouts, pacing, one job per workspace, fair time-slicing). The snapshot is taken by the worker in resumable batches, so a job of any size (tested up to 500,000, see `BENCHMARKS.md`) is accepted in constant time. Seed scripts for the small and the 500k dataset; a benchmark harness with kill-and-resume proof.

**Not implemented:** stage management (stages come from the seed), clean-up of a finished job's item rows (they are kept), and any Redis or Kafka (deliberately; see `DESIGN.md`). Everything the brief marks explicitly out of scope (UI, auth, pipeline summaries, rich filtering, events/consumers, deployment/CI, custom fields) is left out too.

## Assumptions

- Creating a deal is not a stage change, so it writes no transition. A move can go to any stage; moving to the current stage is a 409.
- Stage and status are independent (moving a stage does not change status).
- One pipeline per workspace; stages are created by seed. Stage keys never change.
- The brief's "up to 50,000" is the size the system is tested and measured at, not a hard limit: the cap is a safety valve (`BULK_MAX_ITEMS`, default 1,000,000) and a job over it fails, it is never truncated. Deals already in the target stage are not part of the job.
- The list of deals is built by the worker just after submission, in batches, so it is "the matching deals as the worker's scan saw them" (deals created after submission never join). See `DESIGN.md` §5.
- A manual edit made after the job's snapshot always wins: the job skips that deal (`skipped_conflict`).
- `Idempotency-Key` is required. At most one bulk move is active per workspace; a second gets 409.
- The `created` filter uses `created_at`, inclusive, in UTC.
- An unknown workspace behaves like an empty one (no tenant-existence leak).
- `value` is stored as `numeric(14,2)` and returned as a JSON number.

## Seed data

Both seed scripts live in `src/scripts/` (shared logic in `seed-lib.ts`), are deterministic (`setseed()` per workspace, so a re-run reproduces the same rows), safe to re-run (a workspace that already has deals is left alone — `npm run db:reset` truncates everything first if you want a clean redo), and give every deal past its first stage the transition history it would really have (stage 1 → 2 → ... → current), values skewed low ($1k-$250k), and `created_at` spread over the last ~18 months.

- **`npm run seed:small`** — the demo dataset (also what `node scripts/setup.js` seeds automatically): 6 workspaces (`acme`, `globex`, `initech`, `umbrella`, `hooli`, `stark`), 6-10 stages each, 15-50 deals each, front-loaded across the pipeline (most deals in the earlier stages).
- **`npm run seed:large`** — the benchmark dataset, matching the brief's data spec exactly: 1 large workspace `bigco` (500,000 deals across 12 stages, front-loaded 22% down to 1%) plus 5 small workspaces `small-1`..`small-5` (2,000-4,000 deals each) so isolation is measurable. `npm run bench:prepare` runs this into a separate, throwaway database (its name must contain `bench`, e.g. `opps_bench` — the script refuses anything else before it drops and recreates it), so it never touches your dev data; see `BENCHMARKS.md`.

## Tests

`npm test` runs 77 tests against a real Postgres (no mocks), in a separate `opps_test` database. The ones that matter, each verified to **fail when its safety mechanism is removed**: idempotent retries and simultaneous submits; the one-active-job rule; killed-between-chunks and killed-mid-chunk resume; fencing of a worker that lost its lease; a manual edit before or during a chunk; snapshot semantics, including killing the worker between and in the middle of snapshot batches and the cap; contention as back-pressure; time-sliced fairness; a chunk reading only its own items; and database constraints checked by bypassing the application.

### How to check each of the five required properties yourself

| Property | Automated proof | Live check |
|---|---|---|
| 1. Idempotent | `test/bulk-submit.spec.ts` › `idempotency` (retry, reordered fields, an 8-way simultaneous burst, per-workspace keys) | Resubmit the same `POST /bulk-moves` with the same `Idempotency-Key` (see the "Try it" block above) — same job back, header `Idempotent-Replayed: true`, `moved` unchanged |
| 2. Resumable | `test/bulk-worker.spec.ts` › `resumable` and `snapshot phase` (killed between/mid chunk, killed between/mid snapshot batch) | `npm run bench:prepare && npm run bench` kills the worker at 30,000 rows and reports time-to-completion plus a correctness check (`BENCHMARKS.md`) |
| 3. Observably progressing | `test/bulk-worker.spec.ts` › `health (computed from committed data only)` | Poll `GET /bulk-moves/:id` while a job runs: `health` moves `queued → progressing → completed`, and reports `slow`/`stuck`/`stalled` from committed timestamps — restart the API mid-job and it still reads the same state |
| 4. Correct under concurrent edits | `test/bulk-worker.spec.ts` › `correct under concurrent edits` (a manual move before, during, and racing a chunk) | Submit a bulk move, then `POST /opportunities/:id/move` one of its matching deals by hand before the worker reaches it — it comes back in `skipped_conflict`, never overwritten |
| 5. Well-behaved | `test/bulk-wellbehaved.spec.ts` (yields to a smaller job, fair time-slicing, lock contention as back-pressure, its own connection pool) | `BENCHMARKS.md`'s p95/p99 interactive latency, measured in the same and a different workspace while a 492,332-deal job runs |

## Benchmarks

`npm run bench:prepare && npm run bench` (see `BENCHMARKS.md`). Headline, on an M3 Pro with Postgres in a VM: 49,991 deals moved in **2.8-3.3 s unpaced / 6.6 s paced**; a **492,332-deal** job in 47 s with no measurable effect on interactive latency; killed at 30,000 rows, the job finished **12.5-12.7 s** later (10 s of that is the lease TTL) with every correctness check passing.

## Layout

```
src/controllers, services, repositories, modules, dto, entities   layered NestJS code (HTTP -> rules -> SQL)
src/main.ts, src/worker.main.ts                                    the two processes: API and worker
src/scripts                                                        migrate, seed (small/large), reset, benchmark harness
migrations/                                                        001 (Part 1), 002 (bulk jobs), 003 (snapshot in the worker)
test/                                                              Jest suites and the test-database setup
```

Configuration is environment variables read in one place (`src/config/configuration.ts`): `DATABASE_URL`, `PORT`, `DB_POOL_MAX`, and `BULK_*` for the worker (chunk and snapshot batch size, cap, lease, duty cycle, timeouts).