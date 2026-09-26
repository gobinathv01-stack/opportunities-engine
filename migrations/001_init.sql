-- workspaces: one tenant per workspace
CREATE TABLE workspaces (
  id         text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- stages: stage specific to a workspace
CREATE TABLE stages (
  sk           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces (id),
  key          text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
  position     int  NOT NULL CHECK (position >= 1),
  UNIQUE (workspace_id, key),
  UNIQUE (workspace_id, position),
  -- Target for the composite FKs below: lets the database prove that a stage
  -- referenced by a row belongs to that row's own workspace.
  UNIQUE (workspace_id, sk)
);

-- opportunities: one deal per workspace
CREATE TABLE opportunities (
  id           bigint GENERATED ALWAYS AS IDENTITY,
  workspace_id text NOT NULL REFERENCES workspaces (id),
  stage_sk     integer NOT NULL,
  name         text NOT NULL CHECK (btrim(name) <> '' AND char_length(name) <= 200),
  value        numeric(14, 2) NOT NULL CHECK (value >= 0),
  status       text NOT NULL DEFAULT 'open'
               CHECK (status IN ('open', 'won', 'lost', 'abandoned')),
  owner_id     text NOT NULL CHECK (btrim(owner_id) <> '' AND char_length(owner_id) <= 100),
  -- Incremented by every write. The bulk job uses it to detect that a human
  -- touched a record after the job's snapshot was taken.
  version      int  NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (updated_at >= created_at),
  PRIMARY KEY (workspace_id, id),
  -- Composite FK: the database itself guarantees the stage belongs to the
  -- opportunity's own workspace.
  FOREIGN KEY (workspace_id, stage_sk) REFERENCES stages (workspace_id, sk)
);

-- "List opportunities in a stage" with keyset pagination.
CREATE INDEX opportunities_ws_stage_id_idx ON opportunities (workspace_id, stage_sk, id);

-- Every stage change, manual or bulk, is one row here.
CREATE TABLE transitions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id   text   NOT NULL REFERENCES workspaces (id),
  opportunity_id bigint NOT NULL,
  from_stage_sk  integer NOT NULL,
  to_stage_sk    integer NOT NULL,
  source         text   NOT NULL CHECK (source IN ('manual', 'bulk')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (from_stage_sk <> to_stage_sk),
  FOREIGN KEY (workspace_id, opportunity_id) REFERENCES opportunities (workspace_id, id),
  FOREIGN KEY (workspace_id, from_stage_sk) REFERENCES stages (workspace_id, sk),
  FOREIGN KEY (workspace_id, to_stage_sk)   REFERENCES stages (workspace_id, sk)
);

CREATE INDEX transitions_opportunity_idx ON transitions (workspace_id, opportunity_id, id);
