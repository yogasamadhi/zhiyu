export const outputsPostgresMigration001 = `
CREATE TABLE output_destinations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('webhook','postgres')),
  config JSONB NOT NULL,
  credential_ref TEXT,
  enabled BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE task_output_bindings (
  task_id TEXT NOT NULL,
  destination_id TEXT NOT NULL REFERENCES output_destinations(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (task_id,destination_id)
);
CREATE INDEX outputs_task_bindings_destination_idx ON task_output_bindings(destination_id);

CREATE TABLE delivery_attempts (
  id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  response_status INTEGER,
  error TEXT,
  next_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX outputs_delivery_run_idx ON delivery_attempts(run_id,created_at DESC);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  task_ids JSONB NOT NULL,
  rate_limit_per_minute INTEGER NOT NULL CHECK (rate_limit_per_minute BETWEEN 1 AND 10000),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);
`;
