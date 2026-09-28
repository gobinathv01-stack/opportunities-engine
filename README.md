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

Every request needs `X-Workspace-Id: <workspace slug>` (a tenant; no auth, as specified). Stages are identified by short keys such as `contacted`.

| Endpoint | Purpose |
|---|---|
| `POST /opportunities` `{name, value, owner_id, stage, status?}` | Create a deal |
| `POST /opportunities/:id/move` `{stage}` | Move one deal and record a transition |
| `GET /opportunities?stage=&limit=&cursor=` | List a stage, keyset-paginated (`next_cursor`) |
| `POST /bulk-moves` `{filter, target_stage}` + header `Idempotency-Key` | Submit a bulk move: **202 and a job handle** |
| `GET /bulk-moves/:id` | Progress: state, phase (`snapshot` then `move`), health, counts, percent, error |

Bulk `filter` fields, all optional and ANDed: `stage`, `owner`, `status` (list), `value` `{min,max}`, `created` `{from,to}` (inclusive; a date-only `to` includes that whole day, UTC). Errors: 400 invalid input, 409 (a bulk move is already active in this workspace), 422 (unknown stage, or an `Idempotency-Key` reused for a different request). Submit only records the job, so it is instant whatever the size. While the worker is still building the list of deals (`phase: snapshot`) `total`, `remaining` and `percent` are `null` and `snapshotted` counts the deals found so far. A filter matching more than the cap (`BULK_MAX_ITEMS`, default 1,000,000) makes the job `failed` with a reason.

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

## Tests

`npm test` runs 77 tests against a real Postgres (no mocks), in a separate `opps_test` database. The ones that matter, each verified to **fail when its safety mechanism is removed**: idempotent retries and simultaneous submits; the one-active-job rule; killed-between-chunks and killed-mid-chunk resume; fencing of a worker that lost its lease; a manual edit before or during a chunk; snapshot semantics, including killing the worker between and in the middle of snapshot batches and the cap; contention as back-pressure; time-sliced fairness; a chunk reading only its own items; and database constraints checked by bypassing the application.

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
