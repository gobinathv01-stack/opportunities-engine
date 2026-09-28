# Opportunities engine

A small multi-tenant CRM service (NestJS, TypeScript, PostgreSQL) whose real subject is one operation: **moving up to 50,000 deals to another pipeline stage as a background job that is idempotent, resumable, observable, correct under concurrent edits, and polite to everything else.**

- `DESIGN.md`: the decisions, the trade-offs and where it is still weak (the most important document).
- `BENCHMARKS.md`: measured throughput, latency, kill-and-resume, hardware and method.

## Run it (one command)

```bash
node scripts/setup.js
```

Works the same on Windows, macOS and Linux: it detects whichever container engine you have (`docker compose`, `podman compose`, or standalone `docker-compose`) and runs it. It starts Postgres, applies the migrations, **seeds a small dataset** (6 workspaces, 6-10 stages each, 15-50 deals each), starts the API on <http://localhost:3000> and the background worker, and **runs the test suite** in its own container (77 tests, about 6 s). Watch for `Tests: 77 passed`. Stop with Ctrl+C, then `docker compose down -v` (or `podman compose down -v`).

Ports can be changed if 3000 or 5432 are taken, as plain arguments (not a shell env-var prefix, which differs between bash/cmd/PowerShell): `node scripts/setup.js API_PORT=3010 DB_PORT=5433`.

> Verified here with Podman: the whole stack came up in about 16 s. `node scripts/setup.js` detects Docker or docker-compose the same way — or run `docker compose up --build` directly.

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

Same auto-detection and port auto-pick as the full one-command setup, but only `postgres` runs in a container; the script then runs `npm ci`, builds, migrates, seeds, and starts both the API and the worker natively, pointed at that container. Ctrl+C stops both; the Postgres container keeps running until stopped separately (`docker compose down`). `npm test` afterwards needs `DATABASE_URL`/`TEST_DATABASE_URL` exported to match the port it printed, if it wasn't the default 5432.

## API

Every request needs `X-Workspace-Id: <workspace slug>` (a tenant; no auth, as specified). Opportunity ids are bigint strings; bulk job ids are UUIDs. Stage keys are short slugs such as `contacted`. Errors use Nest's default shape: `{"statusCode": 409, "message": "...", "error": "Conflict"}`.

| Endpoint | Body / query | Response |
|---|---|---|
| `POST /opportunities` | `{name, value, owner_id, stage, status?}` | `201` the created deal (not a stage change: writes no transition). `422` unknown stage. |
| `POST /opportunities/:id/move` | `{stage}` | `200` the updated deal, `stage`/`version` bumped, transition recorded. `404` not found, `422` unknown stage, `409` already there. |
| `GET /opportunities?stage=&limit=&cursor=` | `stage` required, `limit` 1-200 (default 50), `cursor` = last item's `id` | `200` `{items, next_cursor}`, keyset-paginated (`next_cursor` is `null` on the last page). |
| `POST /bulk-moves` + header `Idempotency-Key` | `{filter, target_stage}` | `202` a job handle at once — see below. |
| `GET /bulk-moves/:id` | — | `200` the same job shape, evolving as the worker runs. `404` not found. |

Worked examples, one request/response pair per endpoint, so every field above can be checked against a real payload:

```jsonc
// POST /opportunities  ->  201
{ "name": "Acme renewal", "value": 12000, "owner_id": "u-1", "stage": "contacted" }
{ "id": "42", "workspace_id": "acme", "stage": "contacted", "name": "Acme renewal", "value": 12000,
  "status": "open", "owner_id": "u-1", "version": 1, "created_at": "2026-01-01T00:00:00.000Z", "updated_at": "2026-01-01T00:00:00.000Z" }

// POST /opportunities/42/move  ->  200 (same shape, stage + version updated, a transition recorded)
{ "stage": "qualified" }
{ "id": "42", "workspace_id": "acme", "stage": "qualified", "name": "Acme renewal", "value": 12000,
  "status": "open", "owner_id": "u-1", "version": 2, "created_at": "2026-01-01T00:00:00.000Z", "updated_at": "2026-01-01T00:05:00.000Z" }

// GET /opportunities?stage=qualified&limit=1  ->  200
{ "items": [ { "id": "42", "workspace_id": "acme", "stage": "qualified", "...": "the same Opportunity shape as above" } ], "next_cursor": "42" }
```

`filter` fields, all optional and ANDed: `stage`, `owner`, `status` (list), `value {min,max}`, `created {from,to}` (inclusive, UTC; a date-only `to` includes that whole day). A retried `POST /bulk-moves` with the same `Idempotency-Key` and body returns the same job untouched, with response header `Idempotent-Replayed: true`. Errors: `400` invalid input; `409` a bulk move already active in this workspace (`active_job_id` in the body); `422` unknown stage, or the key reused for a different request. A filter over the cap (`BULK_MAX_ITEMS`, default 1,000,000) fails the job with a reason — it is never truncated.

```jsonc
// POST /bulk-moves, header Idempotency-Key: try-1  ->  202 (and GET /bulk-moves/:id returns this same shape, evolving)
{ "filter": { "status": ["open"] }, "target_stage": "closed-won" }
{
  "id": "b6f1c2a0-6e3a-4b8b-9b2a-1e2f3a4b5c6d", "state": "queued", "phase": "snapshot", "health": "queued",
  "target_stage": "closed-won", "filter": { "status": ["open"] },
  "snapshotted": 0, "total": null, "processed": 0, "moved": 0, "skipped_conflict": 0,
  "remaining": null, "percent": null, "attempt": 0,
  "created_at": "2026-01-01T00:00:00.000Z", "started_at": null, "last_progress_at": null, "finished_at": null, "error": null
}
```

While `phase` is `snapshot`, `total`/`remaining`/`percent` are `null` and `snapshotted` counts what's found so far; once `phase` is `move`, `total` is fixed and `percent` = `processed / total`. `health` is one of `queued | waiting | progressing | slow | stuck | stalled | completed | failed`, computed from committed timestamps and counters — never an in-memory value that could lie after a restart.

## What is and is not implemented

**Implemented:** Part 1 (create, single move with a transition, paginated list); the bulk move with all five properties: idempotent (key stored in Postgres), resumable (cursor plus lease and fencing, tested with kills), observable (progress from committed rows, with slow/stuck/stalled/failed), correct under concurrent edits (a version guard: the person wins; snapshot semantics), well-behaved (separate worker pool, short chunks and snapshot batches with lock timeouts, pacing, one job per workspace, fair time-slicing). The snapshot is taken by the worker in resumable batches, so a job of any size (tested up to 500,000, see `BENCHMARKS.md`) is accepted in constant time. Seed scripts for the small and the 500k dataset; a benchmark harness with kill-and-resume proof.

**Not implemented:** stage management (stages come from the seed), clean-up of a finished job's item rows (they are kept), and any Redis or Kafka (deliberately; see `DESIGN.md`). Everything the brief marks explicitly out of scope (UI, auth, pipeline summaries, rich filtering, events/consumers, deployment/CI, custom fields) is left out too.

## Assumptions

- Creating a deal is not a stage change, so it writes no transition. A move can go to any stage; moving to the current stage is a 409.
- Stage and status are independent (moving a stage does not change status). One pipeline per workspace; stages are created by seed and their keys never change.
- The brief's "up to 50,000" is the size the system is tested and measured at, not a hard limit: the cap is a safety valve (`BULK_MAX_ITEMS`, default 1,000,000) and a job over it fails, it is never truncated. Deals already in the target stage are not part of the job.
- The list of deals is built by the worker just after submission, in batches, so it is "the matching deals as the worker's scan saw them" (deals created after submission never join; see `DESIGN.md` §5). A manual edit made after the snapshot always wins — the job skips that deal (`skipped_conflict`).
- `Idempotency-Key` is required; at most one bulk move is active per workspace (a second gets 409). The `created` filter uses `created_at`, inclusive, in UTC.
- An unknown workspace behaves like an empty one (no tenant-existence leak). `value` is stored as `numeric(14,2)` and returned as a JSON number.

## Seed data

`src/scripts/seed-small.ts` and `seed-large.ts` (shared logic in `seed-lib.ts`) are deterministic and safe to re-run — a workspace that already has deals is left alone; `npm run db:reset` clears everything for a clean redo.

- **`npm run seed:small`** — the demo dataset (also what `node scripts/setup.js` seeds automatically): 6 workspaces, 6-10 stages each, 15-50 deals each.
- **`npm run seed:large`** — the benchmark dataset, per the brief's spec: 1 large workspace `bigco` (500,000 deals across 12 front-loaded stages) plus 5 small workspaces (2,000-4,000 deals each) for isolation testing. `npm run bench:prepare` loads it into a separate, throwaway database (its name must contain `bench`) so it never touches dev data.

## Tests

`npm test` runs 77 tests against a real Postgres (no mocks), in a separate `opps_test` database. Each one that matters is verified to **fail when its safety mechanism is removed**, one file per property of the exercise: idempotent retries and simultaneous submits (`bulk-submit.spec.ts`); killed-between/mid-chunk and killed-between/mid-snapshot-batch resume, and lease fencing (`bulk-worker.spec.ts` › `resumable`); a manual edit before, during, or racing a chunk (`bulk-worker.spec.ts` › `correct under concurrent edits`); health computed only from committed data (`bulk-worker.spec.ts` › `health`); pacing, fairness and lock contention as back-pressure (`bulk-wellbehaved.spec.ts`); plus database constraints checked by bypassing the application entirely.

### How to check each of the five required properties yourself

| Property | Automated proof | Live check |
|---|---|---|
| 1. Idempotent | `test/bulk-submit.spec.ts` › `idempotency` (retry, reordered fields, an 8-way simultaneous burst, per-workspace keys) | Resubmit the same `POST /bulk-moves` with the same `Idempotency-Key` (see the "Try it" block above) — same job back, header `Idempotent-Replayed: true`, `moved` unchanged |
| 2. Resumable | `test/bulk-worker.spec.ts` › `resumable` and `snapshot phase` (killed between/mid chunk, killed between/mid snapshot batch) | `npm run bench:prepare && npm run bench` kills the worker at 30,000 rows and reports time-to-completion plus a correctness check (`BENCHMARKS.md`) |
| 3. Observably progressing | `test/bulk-worker.spec.ts` › `health (computed from committed data only)` | Poll `GET /bulk-moves/:id` while a job runs: `health` moves `queued → progressing → completed`, and reports `slow`/`stuck`/`stalled` from committed timestamps — restart the API mid-job and it still reads the same state |
| 4. Correct under concurrent edits | `test/bulk-worker.spec.ts` › `correct under concurrent edits` (a manual move before, during, and racing a chunk) | Submit a bulk move, then `POST /opportunities/:id/move` one of its matching deals by hand before the worker reaches it — it comes back in `skipped_conflict`, never overwritten |
| 5. Well-behaved | `test/bulk-wellbehaved.spec.ts` (yields to a smaller job, fair time-slicing, lock contention as back-pressure, its own connection pool) | `BENCHMARKS.md`'s p95/p99 interactive latency, measured in the same and a different workspace while a 492,332-deal job runs |

## Benchmarks

`npm run bench:prepare && npm run bench` (see `BENCHMARKS.md`). Headline, on an M3 Pro with Postgres in a VM: 49,991 deals moved in **2.8-3.3 s unpaced / 6.6 s paced**; a **492,332-deal** job in 47 s with no measurable effect on interactive latency (same or a different workspace); killed at 30,000 rows, the job finished **12.5-12.7 s** later (10 s of that is the lease TTL), with every correctness check passing.

## Layout

```
src/controllers, services, repositories, modules, dto, entities   layered NestJS code (HTTP -> rules -> SQL)
src/main.ts, src/worker.main.ts                                    the two processes: API and worker
src/scripts                                                        migrate, seed (small/large), reset, benchmark harness
migrations/                                                        001 (Part 1), 002 (bulk jobs, including the worker-built snapshot)
test/                                                              Jest suites and the test-database setup
```

Configuration is environment variables read in one place (`src/config/configuration.ts`): `DATABASE_URL`, `PORT`, `DB_POOL_MAX`, and `BULK_*` for the worker (chunk and snapshot batch size, cap, lease, duty cycle, timeouts).
