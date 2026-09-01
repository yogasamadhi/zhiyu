export const outputsSqliteMigration001 = `
CREATE TABLE output_destinations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('webhook','postgres')),
  config TEXT NOT NULL,
  credential_ref TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_output_bindings (
  task_id TEXT NOT NULL,
  destination_id TEXT NOT NULL REFERENCES output_destinations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
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
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX outputs_delivery_run_idx ON delivery_attempts(run_id,created_at DESC);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  task_ids TEXT NOT NULL,
  rate_limit_per_minute INTEGER NOT NULL CHECK (rate_limit_per_minute BETWEEN 1 AND 10000),
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
`;

export const outputsSqliteMigration002 = `
CREATE TABLE output_destinations_v2 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('webhook','postgres','local-directory','google-sheets','s3')),
  config TEXT NOT NULL,
  credential_ref TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO output_destinations_v2
SELECT id,name,type,config,credential_ref,enabled,created_at,updated_at FROM output_destinations;

CREATE TABLE task_output_bindings_v2 (
  task_id TEXT NOT NULL,
  destination_id TEXT NOT NULL REFERENCES output_destinations_v2(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id,destination_id)
);
INSERT INTO task_output_bindings_v2
SELECT task_id,destination_id,created_at FROM task_output_bindings;

DROP TABLE task_output_bindings;
DROP TABLE output_destinations;
ALTER TABLE output_destinations_v2 RENAME TO output_destinations;
ALTER TABLE task_output_bindings_v2 RENAME TO task_output_bindings;
CREATE INDEX outputs_task_bindings_destination_idx ON task_output_bindings(destination_id);
`;

export const outputsSqliteMigration003 = `
CREATE TABLE event_notification_attempts (
  id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'run.succeeded','run.failed','dataset.changed','quality.issue.detected','quality.recovered'
  )),
  occurred_at TEXT NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  severity TEXT NOT NULL CHECK (severity IN ('info','warning','error')),
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  response_status INTEGER,
  error TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(destination_id,event_id)
);
CREATE INDEX outputs_event_notification_event_idx
ON event_notification_attempts(event_id,created_at DESC);
CREATE INDEX outputs_event_notification_pending_idx
ON event_notification_attempts(status,next_attempt_at,created_at);
`;

export const outputsSqliteMigration004 = `
ALTER TABLE delivery_attempts
ADD COLUMN format TEXT CHECK (format IS NULL OR format IN ('csv','jsonl','parquet'));
ALTER TABLE delivery_attempts ADD COLUMN artifact_id TEXT;
ALTER TABLE delivery_attempts ADD COLUMN final_location TEXT;
ALTER TABLE delivery_attempts
ADD COLUMN sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64);
ALTER TABLE delivery_attempts
ADD COLUMN delivered_record_count INTEGER
CHECK (delivered_record_count IS NULL OR delivered_record_count >= 0);
CREATE INDEX outputs_delivery_artifact_idx ON delivery_attempts(artifact_id)
WHERE artifact_id IS NOT NULL;
`;

export const outputsSqliteMigration005 = `
UPDATE output_destinations
SET config = json_remove(
  json_set(
    config,
    '$.events',
    json_array(COALESCE(json_extract(config,'$.event'),'run.succeeded'))
  ),
  '$.event'
)
WHERE type='webhook' AND json_type(config,'$.events') IS NULL;
`;
