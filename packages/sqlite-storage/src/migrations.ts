import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type Database from 'better-sqlite3';

const migration001 = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  start_url TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL,
  schedule TEXT NOT NULL,
  request_settings TEXT NOT NULL,
  browser_settings TEXT NOT NULL,
  pagination TEXT NOT NULL,
  output_settings TEXT NOT NULL,
  credential_bindings TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  active_version_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE rule_versions (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  definition TEXT NOT NULL,
  generated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(rule_id, version)
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','canceled')),
  started_at TEXT,
  finished_at TEXT,
  request_count INTEGER NOT NULL DEFAULT 0,
  record_count INTEGER NOT NULL DEFAULT 0,
  browser_used INTEGER NOT NULL DEFAULT 0,
  ai_used INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX runs_one_active_per_task_uq ON runs(task_id)
  WHERE status IN ('queued','running');
CREATE INDEX runs_task_created_idx ON runs(task_id, created_at DESC);
CREATE TABLE records (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX records_run_idx ON records(run_id, created_at, id);
CREATE TABLE task_schedules (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE runtime_jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('queued','running')),
  scheduled INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX runtime_jobs_state_idx ON runtime_jobs(state, available_at);
CREATE TABLE domain_events (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX domain_events_aggregate_idx ON domain_events(aggregate_type, aggregate_id);
CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(scope, key)
);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  format TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX artifacts_run_idx ON artifacts(run_id);
`;

const migration002 = `
ALTER TABLE tasks ADD COLUMN dataset_settings TEXT NOT NULL DEFAULT '{"mode":"snapshot","keyFields":[],"detectRemoved":true}';
ALTER TABLE tasks ADD COLUMN retention_policy TEXT NOT NULL DEFAULT '{"runDays":null,"maxRuns":null,"artifactDays":null,"logDays":null}';
ALTER TABLE tasks ADD COLUMN network_policy TEXT NOT NULL DEFAULT '{"allowPrivateNetworks":true,"allowedHosts":[],"allowedCidrs":[]}';
ALTER TABLE tasks ADD COLUMN output_bindings TEXT NOT NULL DEFAULT '[]';
ALTER TABLE runs ADD COLUMN error_code TEXT;
ALTER TABLE runs ADD COLUMN phase TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE runs ADD COLUMN progress REAL NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN cancel_requested_at TEXT;
ALTER TABLE runs ADD COLUMN dataset_stats TEXT NOT NULL DEFAULT '{"added":0,"updated":0,"removed":0,"unchanged":0,"current":0}';
ALTER TABLE runs ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE runs ADD COLUMN warning_count INTEGER NOT NULL DEFAULT 0;
UPDATE rule_versions
SET definition = json_object(
  'version', 1,
  'list', json_object('rule', json(definition), 'mode', 'auto', 'actions', json('[]')),
  'pagination', json_object('type', 'none'),
  'dedupe', json_object('strategy', 'hash', 'fields', json('[]')),
  'limits', json_object('maxRecords', 1000000)
)
WHERE json_extract(definition, '$.type') IS NOT NULL;
CREATE TABLE datasets (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
  settings TEXT NOT NULL,
  current_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE dataset_records (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  record_key TEXT NOT NULL,
  source_url TEXT NOT NULL,
  data TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0,
  first_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  last_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(dataset_id, record_key)
);
CREATE INDEX dataset_records_task_removed_idx ON dataset_records(task_id, removed, last_seen_at);
CREATE TABLE record_changes (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  dataset_record_id TEXT NOT NULL REFERENCES dataset_records(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('added','updated','removed')),
  before TEXT,
  after TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX record_changes_dataset_created_idx ON record_changes(dataset_id, created_at, id);
CREATE TABLE run_logs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  level TEXT NOT NULL,
  phase TEXT NOT NULL,
  message TEXT NOT NULL,
  url TEXT,
  error_code TEXT,
  metadata TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(run_id, sequence)
);
CREATE TABLE run_requests (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  status_code INTEGER,
  duration_ms INTEGER NOT NULL,
  error_code TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX run_requests_run_created_idx ON run_requests(run_id, created_at, id);
CREATE TABLE output_destinations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('webhook','postgres')),
  config TEXT NOT NULL,
  credential_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE task_output_bindings (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  destination_id TEXT NOT NULL REFERENCES output_destinations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY(task_id, destination_id)
);
CREATE TABLE delivery_attempts (
  id TEXT PRIMARY KEY,
  destination_id TEXT NOT NULL REFERENCES output_destinations(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 1,
  response_status INTEGER,
  error TEXT,
  next_attempt_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX delivery_attempts_run_idx ON delivery_attempts(run_id, created_at);
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  task_ids TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE rule_repair_proposals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  definition TEXT NOT NULL,
  explanation TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL
);
`;

const migration003 = `
ALTER TABLE rule_repair_proposals ADD COLUMN tested_at TEXT;
`;

const migration004 = `
ALTER TABLE api_tokens ADD COLUMN rate_limit_per_minute INTEGER NOT NULL DEFAULT 60;
`;

const migration005 = `
INSERT OR IGNORE INTO task_output_bindings(task_id,destination_id,created_at)
SELECT tasks.id,json_each.value,CURRENT_TIMESTAMP
FROM tasks,json_each(tasks.output_bindings)
JOIN output_destinations ON output_destinations.id=json_each.value;
`;

const migration006 = `
CREATE INDEX dataset_records_cursor_idx
ON dataset_records(task_id,removed,last_seen_at DESC,id DESC);
CREATE INDEX record_changes_cursor_idx
ON record_changes(dataset_id,created_at DESC,id DESC);
`;

const migration007 = `
ALTER TABLE record_changes RENAME TO record_changes_before_nullable_runs;
ALTER TABLE dataset_records RENAME TO dataset_records_before_nullable_runs;
CREATE TABLE dataset_records (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  record_key TEXT NOT NULL,
  source_url TEXT NOT NULL,
  data TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0,
  first_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  last_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(dataset_id, record_key)
);
INSERT INTO dataset_records(
  id,dataset_id,task_id,record_key,source_url,data,content_hash,removed,
  first_run_id,last_run_id,first_seen_at,last_seen_at
)
SELECT
  id,dataset_id,task_id,record_key,source_url,data,content_hash,removed,
  first_run_id,last_run_id,first_seen_at,last_seen_at
FROM dataset_records_before_nullable_runs;
CREATE TABLE record_changes (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  dataset_record_id TEXT NOT NULL REFERENCES dataset_records(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('added','updated','removed')),
  before TEXT,
  after TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO record_changes(id,dataset_id,dataset_record_id,run_id,type,before,after,created_at)
SELECT id,dataset_id,dataset_record_id,run_id,type,before,after,created_at
FROM record_changes_before_nullable_runs;
DROP TABLE record_changes_before_nullable_runs;
DROP TABLE dataset_records_before_nullable_runs;
CREATE INDEX dataset_records_task_removed_idx ON dataset_records(task_id,removed,last_seen_at);
CREATE INDEX dataset_records_cursor_idx ON dataset_records(task_id,removed,last_seen_at DESC,id DESC);
CREATE INDEX record_changes_dataset_created_idx ON record_changes(dataset_id,created_at,id);
CREATE INDEX record_changes_cursor_idx ON record_changes(dataset_id,created_at DESC,id DESC);
`;

const migration008 = `
ALTER TABLE records ADD COLUMN record_key TEXT;
ALTER TABLE records ADD COLUMN content_hash TEXT;
CREATE INDEX records_run_key_idx ON records(run_id,record_key);
`;

const migration009 = `
ALTER TABLE task_schedules ADD COLUMN misfire_policy TEXT NOT NULL DEFAULT 'skip';
ALTER TABLE task_schedules ADD COLUMN last_triggered_at TEXT;
UPDATE tasks
SET schedule=json_set(schedule,'$.misfirePolicy','skip')
WHERE json_extract(schedule,'$.misfirePolicy') IS NULL;
CREATE TABLE runtime_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

const migration010 = `
CREATE TABLE trend_sources (
  key TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  task_id TEXT UNIQUE REFERENCES tasks(id) ON DELETE SET NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  auto_refresh INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX trend_sources_task_idx ON trend_sources(task_id);
CREATE TABLE preference_signals (
  id TEXT PRIMARY KEY,
  target_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('like','dislike','completed')),
  platform TEXT NOT NULL,
  content_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(target_key,kind)
);
CREATE INDEX preference_signals_updated_idx ON preference_signals(updated_at DESC);
`;

export const sqliteMigrations = [
  { version: 1, sql: migration001 },
  { version: 2, sql: migration002 },
  { version: 3, sql: migration003 },
  { version: 4, sql: migration004 },
  { version: 5, sql: migration005 },
  { version: 6, sql: migration006 },
  { version: 7, sql: migration007 },
  { version: 8, sql: migration008 },
  { version: 9, sql: migration009 },
  { version: 10, sql: migration010 },
] as const;

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export function migrateDesktopDatabase(database: Database.Database, filePath: string): void {
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.exec(
    'CREATE TABLE IF NOT EXISTS _zhiyun_migrations (version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const rows = database
    .prepare('SELECT version, checksum FROM _zhiyun_migrations ORDER BY version')
    .all() as Array<{ version: number; checksum: string }>;
  for (const row of rows) {
    const migration = sqliteMigrations.find((candidate) => candidate.version === row.version);
    if (!migration || checksum(migration.sql) !== row.checksum) {
      throw new Error(`SQLite migration checksum mismatch at version ${row.version}`);
    }
  }
  const current = rows.at(-1)?.version ?? 0;
  if (current > 0 && current < sqliteMigrations.length && existsSync(filePath)) {
    mkdirSync(dirname(filePath), { recursive: true });
    copyFileSync(filePath, `${filePath}.backup-${Date.now()}`);
  }
  for (const migration of sqliteMigrations.filter((candidate) => candidate.version > current)) {
    database.transaction(() => {
      database.exec(migration.sql);
      database
        .prepare('INSERT INTO _zhiyun_migrations(version, checksum, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, checksum(migration.sql), new Date().toISOString());
    })();
  }
  const integrity = database.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${String(integrity)}`);
}
