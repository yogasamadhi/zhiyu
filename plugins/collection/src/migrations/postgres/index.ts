export const collectionPostgresMigration001 = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  start_url TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','ready','running','succeeded','failed')),
  schedule JSONB NOT NULL,
  request_settings JSONB NOT NULL,
  browser_settings JSONB NOT NULL,
  pagination JSONB NOT NULL,
  output_settings JSONB NOT NULL,
  credential_bindings JSONB NOT NULL,
  dataset_settings JSONB NOT NULL,
  retention_policy JSONB NOT NULL,
  network_policy JSONB NOT NULL,
  revision INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX collection_tasks_status_idx ON tasks(status,updated_at DESC,id DESC);

CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  active_version_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX collection_rules_task_idx ON rules(task_id);

CREATE TABLE rule_versions (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  definition JSONB NOT NULL,
  generated_by TEXT NOT NULL CHECK (generated_by IN ('human','ai','system')),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(rule_id,version)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','canceled')),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  request_count INTEGER NOT NULL,
  record_count INTEGER NOT NULL,
  browser_used BOOLEAN NOT NULL,
  ai_used BOOLEAN NOT NULL,
  error TEXT,
  error_code TEXT,
  phase TEXT NOT NULL,
  progress DOUBLE PRECISION NOT NULL CHECK (progress BETWEEN 0 AND 1),
  cancel_requested_at TIMESTAMPTZ,
  dataset_stats JSONB NOT NULL,
  dataset_id TEXT,
  dataset_snapshot_id TEXT,
  delivery_status TEXT NOT NULL,
  warning_count INTEGER NOT NULL,
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX collection_runs_task_idx ON runs(task_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX collection_runs_active_uq ON runs(task_id)
WHERE status IN ('queued','running');

CREATE TABLE run_logs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('debug','info','warn','error')),
  phase TEXT NOT NULL,
  message TEXT NOT NULL,
  url TEXT,
  error_code TEXT,
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE(run_id,sequence)
);

CREATE TABLE run_requests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('list','pagination','detail','api')),
  status TEXT NOT NULL CHECK (status IN ('succeeded','failed','skipped')),
  status_code INTEGER,
  duration_ms INTEGER NOT NULL,
  error_code TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX collection_run_requests_cursor_idx ON run_requests(run_id,created_at,id);

CREATE TABLE task_schedules (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  misfire_policy TEXT NOT NULL,
  last_triggered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE rule_repair_proposals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  run_id TEXT,
  definition JSONB NOT NULL,
  explanation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','applied','rejected')),
  tested_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);
`;

export const collectionPostgresMigration002 = `
ALTER TABLE tasks ADD COLUMN origin JSONB NOT NULL DEFAULT '{"kind":"manual"}'::jsonb;
`;
