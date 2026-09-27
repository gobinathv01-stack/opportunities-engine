-- Part 2: bulk stage move.

-- bulk jobs: a workspace's active bulk jobs.
CREATE TABLE bulk_jobs (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  workspace_id     text NOT NULL REFERENCES workspaces (id),
  -- Idempotency: the client's key, plus a hash of the canonical request so the
  -- same key with a different request can be told apart from a true retry.
  idempotency_key  text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  request_hash     text NOT NULL,
  filter           jsonb NOT NULL,
  target_stage_sk  integer NOT NULL,
  state            text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'completed', 'failed')),
  -- snapshot: the worker is still building bulk_job_items below (in batches). move: the list is complete.
  phase            text NOT NULL DEFAULT 'snapshot' CHECK (phase IN ('snapshot', 'move')),
  -- The last opportunity id the snapshot scan has covered (ids are scanned in ascending order).
  snapshot_cursor_id bigint NOT NULL DEFAULT 0 CHECK (snapshot_cursor_id >= 0),
  total            integer NOT NULL DEFAULT 0 CHECK (total >= 0),
  -- The resume cursor: every item with seq <= cursor_seq is finished. It is advanced
  -- in the same transaction that moves the deals, so it can never disagree with them.
  cursor_seq       integer NOT NULL DEFAULT 0 CHECK (cursor_seq >= 0),
  moved            integer NOT NULL DEFAULT 0,
  skipped_conflict integer NOT NULL DEFAULT 0,
  attempt          integer NOT NULL DEFAULT 0,
  -- Lease: which worker owns the job right now. lease_token is a fencing token: a
  -- worker whose lease was taken over can no longer commit.
  lease_token      uuid,
  lease_expires_at timestamptz,
  last_progress_at timestamptz,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, target_stage_sk) REFERENCES stages (workspace_id, sk),
  CHECK (moved + skipped_conflict <= total)
);

-- At most one active job per workspace: a workspace cannot fan out its own load.
CREATE UNIQUE INDEX bulk_jobs_one_active_per_workspace
  ON bulk_jobs (workspace_id) WHERE state IN ('queued', 'running');

-- bulk_job_items: exactly which opportunities are in the job, and what stage they were in when the job was started.
CREATE TABLE bulk_job_items (
  workspace_id     text    NOT NULL,
  job_id           uuid    NOT NULL,
  seq              integer NOT NULL CHECK (seq >= 1),
  opportunity_id   bigint  NOT NULL,
  from_stage_sk    integer NOT NULL,
  expected_version integer NOT NULL,
  outcome          text    CHECK (outcome IN ('moved', 'skipped_conflict')),  -- NULL until processed
  -- Chunking is a range scan on this key: WHERE job_id = ? AND seq > cursor ORDER BY seq LIMIT n.
  PRIMARY KEY (workspace_id, job_id, seq),
  FOREIGN KEY (workspace_id, job_id) REFERENCES bulk_jobs (workspace_id, id),
  FOREIGN KEY (workspace_id, opportunity_id) REFERENCES opportunities (workspace_id, id)
);

-- Transitions written by a job carry its id.
ALTER TABLE transitions ADD COLUMN job_id uuid;
ALTER TABLE transitions ADD CONSTRAINT transitions_job_fk
  FOREIGN KEY (workspace_id, job_id) REFERENCES bulk_jobs (workspace_id, id);
ALTER TABLE transitions ADD CONSTRAINT transitions_source_job_check
  CHECK ((source = 'bulk') = (job_id IS NOT NULL));
-- Record-level idempotency: one job can record at most one transition per opportunity,
-- however many times a chunk is retried or replayed.
CREATE UNIQUE INDEX transitions_one_per_job_opportunity
  ON transitions (job_id, opportunity_id) WHERE job_id IS NOT NULL;
