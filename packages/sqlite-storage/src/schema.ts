import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const desktopTasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  startUrl: text('start_url').notNull(),
  instruction: text('instruction').notNull(),
  status: text('status').notNull(),
  schedule: text('schedule', { mode: 'json' }).notNull(),
  requestSettings: text('request_settings', { mode: 'json' }).notNull(),
  browserSettings: text('browser_settings', { mode: 'json' }).notNull(),
  pagination: text('pagination', { mode: 'json' }).notNull(),
  outputSettings: text('output_settings', { mode: 'json' }).notNull(),
  credentialBindings: text('credential_bindings', { mode: 'json' }).notNull(),
  datasetSettings: text('dataset_settings', { mode: 'json' }).notNull(),
  retentionPolicy: text('retention_policy', { mode: 'json' }).notNull(),
  networkPolicy: text('network_policy', { mode: 'json' }).notNull(),
  outputBindings: text('output_bindings', { mode: 'json' }).notNull(),
  revision: integer('revision').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const desktopTrendSources = sqliteTable(
  'trend_sources',
  {
    key: text('key').primaryKey(),
    platform: text('platform').notNull(),
    taskId: text('task_id').unique(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull(),
    autoRefresh: integer('auto_refresh', { mode: 'boolean' }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('desktop_trend_sources_task_idx').on(table.taskId)],
);

export const desktopPreferenceSignals = sqliteTable(
  'preference_signals',
  {
    id: text('id').primaryKey(),
    targetKey: text('target_key').notNull(),
    kind: text('kind').notNull(),
    platform: text('platform').notNull(),
    contentType: text('content_type').notNull(),
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    content: text('content', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('desktop_preference_signals_target_kind_uq').on(table.targetKey, table.kind),
    index('desktop_preference_signals_updated_idx').on(table.updatedAt),
  ],
);

export const desktopRuns = sqliteTable('runs', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  status: text('status').notNull(),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  requestCount: integer('request_count').notNull(),
  recordCount: integer('record_count').notNull(),
  browserUsed: integer('browser_used', { mode: 'boolean' }).notNull(),
  aiUsed: integer('ai_used', { mode: 'boolean' }).notNull(),
  error: text('error'),
  errorCode: text('error_code'),
  phase: text('phase').notNull(),
  progress: real('progress').notNull(),
  cancelRequestedAt: text('cancel_requested_at'),
  datasetStats: text('dataset_stats', { mode: 'json' }).notNull(),
  deliveryStatus: text('delivery_status').notNull(),
  warningCount: integer('warning_count').notNull(),
  metadata: text('metadata', { mode: 'json' }).notNull(),
  createdAt: text('created_at').notNull(),
});

export const desktopDomainEvents = sqliteTable(
  'domain_events',
  {
    cursor: integer('cursor').primaryKey({ autoIncrement: true }),
    id: text('id').notNull(),
    type: text('type').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payload: text('payload', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [uniqueIndex('desktop_domain_event_id_uq').on(table.id)],
);

export const desktopDatasets = sqliteTable('datasets', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull().unique(),
  settings: text('settings', { mode: 'json' }).notNull(),
  currentCount: integer('current_count').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const desktopDatasetRecords = sqliteTable(
  'dataset_records',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id').notNull(),
    taskId: text('task_id').notNull(),
    recordKey: text('record_key').notNull(),
    sourceUrl: text('source_url').notNull(),
    data: text('data', { mode: 'json' }).notNull(),
    contentHash: text('content_hash').notNull(),
    removed: integer('removed', { mode: 'boolean' }).notNull(),
    firstRunId: text('first_run_id'),
    lastRunId: text('last_run_id'),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
  },
  (table) => [
    uniqueIndex('desktop_dataset_record_key_uq').on(table.datasetId, table.recordKey),
    index('desktop_dataset_task_removed_idx').on(table.taskId, table.removed, table.lastSeenAt),
    index('desktop_dataset_record_cursor_idx').on(
      table.taskId,
      table.removed,
      table.lastSeenAt,
      table.id,
    ),
  ],
);

export const desktopRecordChanges = sqliteTable(
  'record_changes',
  {
    id: text('id').primaryKey(),
    datasetId: text('dataset_id').notNull(),
    datasetRecordId: text('dataset_record_id').notNull(),
    runId: text('run_id').notNull(),
    type: text('type').notNull(),
    before: text('before', { mode: 'json' }),
    after: text('after', { mode: 'json' }),
    createdAt: text('created_at').notNull(),
  },
  (table) => [
    index('desktop_record_changes_cursor_idx').on(table.datasetId, table.createdAt, table.id),
  ],
);

export const desktopRunLogs = sqliteTable(
  'run_logs',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull(),
    sequence: integer('sequence').notNull(),
    level: text('level').notNull(),
    phase: text('phase').notNull(),
    message: text('message').notNull(),
    url: text('url'),
    errorCode: text('error_code'),
    metadata: text('metadata', { mode: 'json' }).notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [uniqueIndex('desktop_run_logs_sequence_uq').on(table.runId, table.sequence)],
);

export const desktopRunRequests = sqliteTable('run_requests', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  url: text('url').notNull(),
  kind: text('kind').notNull(),
  status: text('status').notNull(),
  statusCode: integer('status_code'),
  durationMs: integer('duration_ms').notNull(),
  errorCode: text('error_code'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
});

export const desktopOutputDestinations = sqliteTable('output_destinations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  config: text('config', { mode: 'json' }).notNull(),
  credentialRef: text('credential_ref'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const desktopTaskOutputBindings = sqliteTable(
  'task_output_bindings',
  {
    taskId: text('task_id').notNull(),
    destinationId: text('destination_id').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.destinationId] })],
);

export const desktopDeliveryAttempts = sqliteTable('delivery_attempts', {
  id: text('id').primaryKey(),
  destinationId: text('destination_id').notNull(),
  taskId: text('task_id').notNull(),
  runId: text('run_id').notNull(),
  status: text('status').notNull(),
  attempt: integer('attempt').notNull(),
  responseStatus: integer('response_status'),
  error: text('error'),
  nextAttemptAt: text('next_attempt_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const desktopApiTokens = sqliteTable('api_tokens', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  taskIds: text('task_ids', { mode: 'json' }).notNull(),
  rateLimitPerMinute: integer('rate_limit_per_minute').notNull(),
  expiresAt: text('expires_at'),
  revokedAt: text('revoked_at'),
  createdAt: text('created_at').notNull(),
});

export const desktopRuleRepairProposals = sqliteTable('rule_repair_proposals', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  ruleId: text('rule_id').notNull(),
  runId: text('run_id'),
  definition: text('definition', { mode: 'json' }).notNull(),
  explanation: text('explanation').notNull(),
  status: text('status').notNull(),
  testedAt: text('tested_at'),
  createdAt: text('created_at').notNull(),
});
