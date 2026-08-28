import {
  boolean,
  bigserial,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type {
  BrowserSettings,
  CrawlPlanDefinition,
  DatasetSettings,
  DatasetStats,
  GeneratedBy,
  NetworkPolicy,
  Pagination,
  PreferenceContent,
  PreferencePlatform,
  RequestSettings,
  RetentionPolicy,
  Schedule,
  TaskCredentialBindings,
} from '@zhiyun/shared';

export const taskStatusEnum = pgEnum('task_status', [
  'draft',
  'ready',
  'running',
  'succeeded',
  'failed',
]);
export const runStatusEnum = pgEnum('run_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
]);
export const generatedByEnum = pgEnum('generated_by', ['human', 'ai', 'system']);

export const tasks = pgTable(
  'tasks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    startUrl: text('start_url').notNull(),
    instruction: text('instruction').notNull(),
    status: taskStatusEnum('status').notNull().default('draft'),
    schedule: jsonb('schedule').$type<Schedule>().notNull(),
    requestSettings: jsonb('request_settings').$type<RequestSettings>().notNull(),
    browserSettings: jsonb('browser_settings').$type<BrowserSettings>().notNull(),
    pagination: jsonb('pagination').$type<Pagination>().notNull(),
    outputSettings: jsonb('output_settings').$type<{ persistRecords: boolean }>().notNull(),
    credentialBindings: jsonb('credential_bindings')
      .$type<TaskCredentialBindings>()
      .notNull()
      .default({}),
    datasetSettings: jsonb('dataset_settings')
      .$type<DatasetSettings>()
      .notNull()
      .default({ mode: 'snapshot', keyFields: [], detectRemoved: true }),
    retentionPolicy: jsonb('retention_policy')
      .$type<RetentionPolicy>()
      .notNull()
      .default({ runDays: null, maxRuns: null, artifactDays: null, logDays: null }),
    networkPolicy: jsonb('network_policy')
      .$type<NetworkPolicy>()
      .notNull()
      .default({ allowPrivateNetworks: false, allowedHosts: [], allowedCidrs: [] }),
    outputBindings: jsonb('output_bindings').$type<string[]>().notNull().default([]),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('tasks_status_idx').on(table.status)],
);

export const trendSources = pgTable(
  'trend_sources',
  {
    key: text('key').primaryKey(),
    platform: text('platform').$type<PreferencePlatform>().notNull(),
    taskId: uuid('task_id')
      .unique()
      .references(() => tasks.id, { onDelete: 'set null' }),
    enabled: boolean('enabled').notNull().default(true),
    autoRefresh: boolean('auto_refresh').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('trend_sources_task_idx').on(table.taskId)],
);

export const preferenceSignals = pgTable(
  'preference_signals',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    targetKey: text('target_key').notNull(),
    kind: text('kind').$type<'like' | 'dislike' | 'completed'>().notNull(),
    platform: text('platform').$type<PreferencePlatform>().notNull(),
    contentType: text('content_type').notNull(),
    externalId: text('external_id').notNull(),
    title: text('title').notNull(),
    content: jsonb('content').$type<PreferenceContent>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('preference_signals_target_kind_uq').on(table.targetKey, table.kind),
    index('preference_signals_updated_idx').on(table.updatedAt),
  ],
);

export const extractionRules = pgTable(
  'rules',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    activeVersionId: uuid('active_version_id').references((): AnyPgColumn => ruleVersions.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('rules_task_idx').on(table.taskId)],
);

export const ruleVersions = pgTable(
  'rule_versions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => extractionRules.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    definition: jsonb('definition').$type<CrawlPlanDefinition>().notNull(),
    generatedBy: generatedByEnum('generated_by').$type<GeneratedBy>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('rule_versions_rule_version_uq').on(table.ruleId, table.version)],
);

export const crawlRuns = pgTable(
  'runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    status: runStatusEnum('status').notNull().default('queued'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    requestCount: integer('request_count').notNull().default(0),
    recordCount: integer('record_count').notNull().default(0),
    browserUsed: boolean('browser_used').notNull().default(false),
    aiUsed: boolean('ai_used').notNull().default(false),
    error: text('error'),
    errorCode: text('error_code'),
    phase: text('phase').notNull().default('queued'),
    progress: real('progress').notNull().default(0),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    datasetStats: jsonb('dataset_stats')
      .$type<DatasetStats>()
      .notNull()
      .default({ added: 0, updated: 0, removed: 0, unchanged: 0, current: 0 }),
    deliveryStatus: text('delivery_status').notNull().default('idle'),
    warningCount: integer('warning_count').notNull().default(0),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('runs_task_created_idx').on(table.taskId, table.createdAt)],
);

export const extractedRecords = pgTable(
  'records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => crawlRuns.id, { onDelete: 'cascade' }),
    recordKey: text('record_key').notNull(),
    contentHash: text('content_hash').notNull(),
    sourceUrl: text('source_url').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('records_run_idx').on(table.runId),
    index('records_task_idx').on(table.taskId),
    index('records_run_key_idx').on(table.runId, table.recordKey),
  ],
);

export const taskSchedules = pgTable('task_schedules', {
  taskId: uuid('task_id')
    .primaryKey()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  cron: text('cron').notNull(),
  timezone: text('timezone').notNull(),
  misfirePolicy: text('misfire_policy').notNull().default('skip'),
  lastTriggeredAt: timestamp('last_triggered_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const runtimeSettings = pgTable('runtime_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const runtimeJobs = pgTable(
  'runtime_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    runId: uuid('run_id').references(() => crawlRuns.id, { onDelete: 'cascade' }),
    state: text('state').notNull(),
    availableAt: timestamp('available_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('runtime_jobs_state_idx').on(table.state, table.availableAt)],
);

export const domainEvents = pgTable(
  'domain_events',
  {
    cursor: bigserial('cursor', { mode: 'number' }).primaryKey(),
    id: uuid('id').defaultRandom().notNull().unique(),
    type: text('type').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('domain_events_aggregate_idx').on(table.aggregateType, table.aggregateId)],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    fingerprint: text('fingerprint').notNull(),
    response: jsonb('response').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('idempotency_scope_key_uq').on(table.scope, table.key)],
);

export const artifacts = pgTable(
  'artifacts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => crawlRuns.id, { onDelete: 'cascade' }),
    format: text('format').notNull(),
    filename: text('filename').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    storageKey: text('storage_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('artifacts_run_idx').on(table.runId)],
);

export const datasets = pgTable('datasets', {
  id: uuid('id').defaultRandom().primaryKey(),
  taskId: uuid('task_id')
    .notNull()
    .unique()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').$type<DatasetSettings>().notNull(),
  currentCount: integer('current_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const datasetRecords = pgTable(
  'dataset_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    recordKey: text('record_key').notNull(),
    sourceUrl: text('source_url').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    contentHash: text('content_hash').notNull(),
    removed: boolean('removed').notNull().default(false),
    firstRunId: uuid('first_run_id').references(() => crawlRuns.id, { onDelete: 'set null' }),
    lastRunId: uuid('last_run_id').references(() => crawlRuns.id, { onDelete: 'set null' }),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('dataset_records_dataset_key_uq').on(table.datasetId, table.recordKey),
    index('dataset_records_task_removed_idx').on(table.taskId, table.removed, table.lastSeenAt),
    index('dataset_records_cursor_idx').on(table.taskId, table.removed, table.lastSeenAt, table.id),
  ],
);

export const recordChanges = pgTable(
  'record_changes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    datasetId: uuid('dataset_id')
      .notNull()
      .references(() => datasets.id, { onDelete: 'cascade' }),
    datasetRecordId: uuid('dataset_record_id')
      .notNull()
      .references(() => datasetRecords.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => crawlRuns.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    before: jsonb('before').$type<Record<string, unknown> | null>(),
    after: jsonb('after').$type<Record<string, unknown> | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('record_changes_dataset_created_idx').on(table.datasetId, table.createdAt),
    index('record_changes_cursor_idx').on(table.datasetId, table.createdAt, table.id),
  ],
);

export const runLogs = pgTable(
  'run_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => crawlRuns.id, { onDelete: 'cascade' }),
    sequence: integer('sequence').notNull(),
    level: text('level').notNull(),
    phase: text('phase').notNull(),
    message: text('message').notNull(),
    url: text('url'),
    errorCode: text('error_code'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('run_logs_run_sequence_uq').on(table.runId, table.sequence)],
);

export const runRequests = pgTable(
  'run_requests',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => crawlRuns.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    statusCode: integer('status_code'),
    durationMs: integer('duration_ms').notNull(),
    errorCode: text('error_code'),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('run_requests_run_created_idx').on(table.runId, table.createdAt)],
);

export const outputDestinations = pgTable('output_destinations', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull(),
  credentialRef: text('credential_ref'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const taskOutputBindings = pgTable(
  'task_output_bindings',
  {
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    destinationId: uuid('destination_id')
      .notNull()
      .references(() => outputDestinations.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.destinationId] })],
);

export const deliveryAttempts = pgTable(
  'delivery_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    destinationId: uuid('destination_id')
      .notNull()
      .references(() => outputDestinations.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => crawlRuns.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    attempt: integer('attempt').notNull().default(1),
    responseStatus: integer('response_status'),
    error: text('error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('delivery_attempts_run_idx').on(table.runId, table.createdAt)],
);

export const apiTokens = pgTable('api_tokens', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  taskIds: jsonb('task_ids').$type<string[]>().notNull().default([]),
  rateLimitPerMinute: integer('rate_limit_per_minute').notNull().default(60),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const ruleRepairProposals = pgTable('rule_repair_proposals', {
  id: uuid('id').defaultRandom().primaryKey(),
  taskId: uuid('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  ruleId: uuid('rule_id')
    .notNull()
    .references(() => extractionRules.id, { onDelete: 'cascade' }),
  runId: uuid('run_id').references(() => crawlRuns.id, { onDelete: 'set null' }),
  definition: jsonb('definition').$type<CrawlPlanDefinition>().notNull(),
  explanation: text('explanation').notNull(),
  status: text('status').notNull().default('pending'),
  testedAt: timestamp('tested_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
