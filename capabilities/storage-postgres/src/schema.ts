export const postgresPlatformMigration001 = `
CREATE TABLE zhiyun_meta (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  product_schema_version TEXT NOT NULL,
  graph_revision TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE plugin_migrations (
  plugin_id TEXT NOT NULL,
  migration_id TEXT NOT NULL,
  plugin_version TEXT NOT NULL,
  checksum TEXT NOT NULL,
  executed_at TIMESTAMPTZ NOT NULL,
  duration_ms INTEGER NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('succeeded','failed')),
  PRIMARY KEY (plugin_id,migration_id)
);

CREATE TABLE platform_jobs (
  id TEXT PRIMARY KEY,
  owner_plugin_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  resource_class TEXT NOT NULL CHECK (resource_class IN ('browser-heavy','python-heavy','io','delivery')),
  state TEXT NOT NULL CHECK (state IN ('queued','claimed','running','persisting','canceling','canceled','interrupted','succeeded','failed')),
  progress DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  phase TEXT NOT NULL DEFAULT 'queued',
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  available_at TIMESTAMPTZ NOT NULL,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX platform_jobs_claim_idx ON platform_jobs(state,available_at,created_at);
CREATE INDEX platform_jobs_owner_idx ON platform_jobs(owner_plugin_id,created_at DESC);

CREATE TABLE platform_events (
  cursor BIGSERIAL PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  producer_plugin_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX platform_events_aggregate_idx ON platform_events(aggregate_type,aggregate_id,cursor);

CREATE TABLE event_consumer_checkpoints (
  consumer_id TEXT PRIMARY KEY,
  cursor BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE event_dead_letters (
  consumer_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_cursor BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  error TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  first_failed_at TIMESTAMPTZ NOT NULL,
  last_failed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (consumer_id,event_id)
);

CREATE TABLE platform_artifacts (
  id TEXT PRIMARY KEY,
  owner_plugin_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size BIGINT NOT NULL,
  checksum TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX platform_artifacts_owner_idx ON platform_artifacts(owner_plugin_id,created_at DESC);

CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (scope,key)
);

CREATE TABLE runtime_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
`;

export const postgresPlatformMigrations = [
  {
    pluginId: 'platform',
    migrationId: '001-initial',
    pluginVersion: '1.0.0',
    sql: postgresPlatformMigration001,
  },
] as const;
