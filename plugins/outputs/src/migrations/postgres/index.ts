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

export const outputsPostgresMigration002 = `
ALTER TABLE output_destinations DROP CONSTRAINT IF EXISTS output_destinations_type_check;
ALTER TABLE output_destinations ADD CONSTRAINT output_destinations_type_check
CHECK (type IN ('webhook','postgres','local-directory','google-sheets','s3'));

UPDATE output_destinations
SET config = jsonb_set(
  config - 'event',
  '{events}',
  COALESCE(config->'events', jsonb_build_array(COALESCE(config->>'event','run.succeeded'))),
  true
)
WHERE type='webhook' AND NOT (config ? 'events');
`;

export const outputsPostgresMigration003 = `
CREATE TABLE event_notification_attempts (
  id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'run.succeeded','run.failed','dataset.changed','quality.issue.detected','quality.recovered'
  )),
  occurred_at TIMESTAMPTZ NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','error')),
  payload JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  response_status INTEGER,
  error TEXT,
  next_attempt_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE(destination_id,event_id)
);
CREATE INDEX outputs_event_notification_event_idx
ON event_notification_attempts(event_id,created_at DESC);
CREATE INDEX outputs_event_notification_pending_idx
ON event_notification_attempts(status,next_attempt_at,created_at);
`;

export const outputsPostgresMigration004 = `
ALTER TABLE delivery_attempts
ADD COLUMN format TEXT CHECK (format IS NULL OR format IN ('csv','jsonl','parquet')),
ADD COLUMN artifact_id TEXT,
ADD COLUMN final_location TEXT,
ADD COLUMN sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
ADD COLUMN delivered_record_count INTEGER
CHECK (delivered_record_count IS NULL OR delivered_record_count >= 0);
CREATE INDEX outputs_delivery_artifact_idx ON delivery_attempts(artifact_id)
WHERE artifact_id IS NOT NULL;
`;

export const outputsPostgresMigration005 = `
UPDATE output_destinations
SET config = jsonb_set(
  config - 'event',
  '{events}',
  COALESCE(config->'events', jsonb_build_array(COALESCE(config->>'event','run.succeeded'))),
  true
)
WHERE type='webhook' AND NOT (config ? 'events');
`;
