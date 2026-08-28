import { z } from 'zod';

export const taskStatusSchema = z.enum(['draft', 'ready', 'running', 'succeeded', 'failed']);
export const runStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']);
export const generatedBySchema = z.enum(['human', 'ai', 'system']);
export const scheduleModeSchema = z.enum(['manual', 'cron']);

export const taskCredentialBindingsSchema = z.object({
  secretHeadersRef: z.string().min(1).optional(),
  cookiesRef: z.string().min(1).optional(),
  proxyRef: z.string().min(1).optional(),
  browserStorageStateRef: z.string().min(1).optional(),
  aiApiKeyRef: z.string().min(1).optional(),
});

export const cookieSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  domain: z.string().optional(),
  path: z.string().default('/'),
  expires: z.number().optional(),
  httpOnly: z.boolean().default(false),
  secure: z.boolean().default(false),
  sameSite: z.enum(['Strict', 'Lax', 'None']).default('Lax'),
});

export const proxySchema = z.object({
  url: z.string().url(),
  username: z.string().optional(),
  password: z.string().optional(),
});

export const requestSettingsSchema = z.object({
  headers: z.record(z.string(), z.string()).default({}),
  cookies: z.array(cookieSchema).default([]),
  proxy: proxySchema.optional(),
  timeoutMs: z.number().int().min(1_000).max(300_000).default(30_000),
  retries: z.number().int().min(0).max(10).default(2),
  retryBackoffMs: z.number().int().min(0).max(60_000).default(1_000),
  concurrency: z.number().int().min(1).max(50).default(2),
  delayMs: z.number().int().min(0).max(60_000).default(500),
  maxRequests: z.number().int().min(1).max(10_000).default(100),
  maxRuntimeMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
  domainRateLimitPerMinute: z.number().int().min(1).max(10_000).default(60),
  respectRobotsTxt: z.boolean().default(true),
  maxResponseBytes: z
    .number()
    .int()
    .min(1_024)
    .max(100 * 1024 * 1024)
    .default(20 * 1024 * 1024),
  redirectLimit: z.number().int().min(0).max(20).default(10),
  userAgent: z.string().min(1).max(500).optional(),
});

export const browserActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), selector: z.string().min(1) }),
  z.object({ type: z.literal('fill'), selector: z.string().min(1), value: z.string() }),
  z.object({ type: z.literal('select'), selector: z.string().min(1), value: z.string() }),
  z.object({ type: z.literal('press'), selector: z.string().min(1), key: z.string().min(1) }),
  z.object({ type: z.literal('hover'), selector: z.string().min(1) }),
  z.object({ type: z.literal('wait'), milliseconds: z.number().int().min(0).max(60_000) }),
  z.object({ type: z.literal('waitFor'), selector: z.string().min(1) }),
  z.object({ type: z.literal('scroll'), count: z.number().int().min(1).max(100).default(1) }),
]);

export const browserSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).default('domcontentloaded'),
  storageState: z.record(z.string(), z.unknown()).optional(),
  actions: z.array(browserActionSchema).default([]),
});

export const paginationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('next'),
    selector: z.string().min(1),
    maxPages: z.number().int().min(1).max(100).default(10),
  }),
  z.object({
    type: z.literal('page'),
    urlTemplate: z.string().min(1),
    startPage: z.number().int().min(0).default(1),
    maxPages: z.number().int().min(1).max(100).default(10),
  }),
  z.object({
    type: z.literal('loadMore'),
    selector: z.string().min(1),
    maxClicks: z.number().int().min(1).max(100).default(10),
    waitMs: z.number().int().min(0).max(30_000).default(500),
  }),
  z.object({
    type: z.literal('infinite'),
    maxScrolls: z.number().int().min(1).max(100).default(10),
    waitMs: z.number().int().min(0).max(30_000).default(500),
  }),
]);

export const outputSettingsSchema = z.object({
  persistRecords: z.boolean().default(true),
});

export const scheduleSchema = z.object({
  mode: scheduleModeSchema.default('manual'),
  cron: z.string().optional(),
  timezone: z.string().default('Asia/Shanghai'),
  misfirePolicy: z.enum(['skip', 'run-once']).default('skip'),
});

export const fieldDataTypeSchema = z.enum(['string', 'url', 'number', 'date', 'json']);
export const domFieldRuleSchema = z
  .object({
    selector: z.string().min(1),
    value: z.enum(['text', 'html', 'attribute', 'index']).default('text'),
    attribute: z.string().min(1).optional(),
    dataType: fieldDataTypeSchema.default('string'),
  })
  .refine((field) => field.value !== 'attribute' || Boolean(field.attribute), {
    message: 'attribute is required when value is attribute',
  });

export const jsonFieldRuleSchema = z.object({
  path: z.string().min(1),
  dataType: fieldDataTypeSchema.default('string'),
});

export const cssRuleSchema = z.object({
  type: z.literal('css'),
  container: z.string().min(1),
  fields: z.record(z.string().min(1), domFieldRuleSchema),
});

export const xpathRuleSchema = z.object({
  type: z.literal('xpath'),
  container: z.string().min(1),
  fields: z.record(z.string().min(1), domFieldRuleSchema),
});

export const jsonRuleSchema = z.object({
  type: z.literal('json'),
  container: z.string().min(1).default('$'),
  fields: z.record(z.string().min(1), jsonFieldRuleSchema),
});

export const extractionRuleDefinitionSchema = z.discriminatedUnion('type', [
  cssRuleSchema,
  xpathRuleSchema,
  jsonRuleSchema,
]);

export const extractionSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('script-json-assignment'),
    selector: z.string().min(1).default('script'),
    marker: z.string().min(1),
  }),
]);

export const discoverySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sitemap'),
    urlField: z.string().min(1).default('url'),
    lastModifiedField: z.string().min(1).optional(),
    include: z.array(z.string().min(1)).default([]),
    exclude: z.array(z.string().min(1)).default([]),
    sameOrigin: z.boolean().default(true),
    maxDepth: z.number().int().min(0).max(3).default(1),
    maxSitemaps: z.number().int().min(1).max(100).default(50),
    maxUrls: z.number().int().min(1).max(10_000).default(1_000),
  }),
]);

export const crawlModeSchema = z.enum(['auto', 'http', 'browser']);
export const detailFailureStrategySchema = z.enum(['skip', 'keep-list-record', 'fail-run']);
export const crawlPlanDefinitionSchema = z.object({
  version: z.literal(1).default(1),
  list: z.object({
    rule: extractionRuleDefinitionSchema,
    source: extractionSourceSchema.optional(),
    mode: crawlModeSchema.default('auto'),
    actions: z.array(browserActionSchema).default([]),
  }),
  discovery: discoverySchema.optional(),
  pagination: paginationSchema.default({ type: 'none' }),
  detail: z
    .object({
      urlField: z.string().min(1),
      rule: extractionRuleDefinitionSchema,
      source: extractionSourceSchema.optional(),
      mode: crawlModeSchema.default('auto'),
      actions: z.array(browserActionSchema).default([]),
      mergeStrategy: z.enum(['detailWins', 'listWins']).default('detailWins'),
      onError: detailFailureStrategySchema.default('keep-list-record'),
      concurrency: z.number().int().min(1).max(20).default(2),
    })
    .optional(),
  dedupe: z
    .object({
      strategy: z.enum(['hash', 'fields', 'none']).default('hash'),
      fields: z.array(z.string().min(1)).default([]),
    })
    .default({ strategy: 'hash', fields: [] }),
  limits: z
    .object({
      maxRequests: z.number().int().min(1).max(10_000).optional(),
      maxRuntimeMs: z.number().int().min(1_000).max(3_600_000).optional(),
      maxRecords: z.number().int().min(1).max(10_000_000).default(1_000_000),
    })
    .default({ maxRecords: 1_000_000 }),
});

export const ruleDefinitionInputSchema = z.union([
  extractionRuleDefinitionSchema,
  crawlPlanDefinitionSchema,
]);

export function normalizeCrawlPlan(value: unknown): CrawlPlanDefinition {
  const primitive = extractionRuleDefinitionSchema.safeParse(value);
  if (primitive.success) {
    return crawlPlanDefinitionSchema.parse({ list: { rule: primitive.data } });
  }
  return crawlPlanDefinitionSchema.parse(value);
}

export const datasetModeSchema = z.enum(['snapshot', 'upsert', 'append']);
export const datasetSettingsSchema = z.object({
  mode: datasetModeSchema.default('snapshot'),
  keyFields: z.array(z.string().min(1)).default([]),
  detectRemoved: z.boolean().default(true),
});

export const retentionPolicySchema = z.object({
  runDays: z.number().int().min(1).max(3650).nullable().default(null),
  maxRuns: z.number().int().min(1).max(100_000).nullable().default(null),
  artifactDays: z.number().int().min(1).max(3650).nullable().default(null),
  logDays: z.number().int().min(1).max(3650).nullable().default(null),
});

export const networkPolicySchema = z.object({
  allowPrivateNetworks: z.boolean().default(false),
  allowedHosts: z.array(z.string().min(1)).default([]),
  allowedCidrs: z.array(z.string().min(1)).default([]),
});

export const datasetStatsSchema = z.object({
  added: z.number().int().nonnegative().default(0),
  updated: z.number().int().nonnegative().default(0),
  removed: z.number().int().nonnegative().default(0),
  unchanged: z.number().int().nonnegative().default(0),
  current: z.number().int().nonnegative().default(0),
});

export const taskCreateSchema = z.object({
  name: z.string().min(1).max(120),
  startUrl: z
    .string()
    .url()
    .refine((url) => ['http:', 'https:'].includes(new URL(url).protocol), {
      message: 'Only HTTP and HTTPS URLs are supported',
    }),
  instruction: z.string().min(1).max(2_000),
  schedule: scheduleSchema.default({
    mode: 'manual',
    timezone: 'Asia/Shanghai',
    misfirePolicy: 'skip',
  }),
  requestSettings: requestSettingsSchema.default({
    headers: {},
    cookies: [],
    timeoutMs: 30_000,
    retries: 2,
    retryBackoffMs: 1_000,
    concurrency: 2,
    delayMs: 500,
    maxRequests: 100,
    maxRuntimeMs: 300_000,
    domainRateLimitPerMinute: 60,
    respectRobotsTxt: true,
    maxResponseBytes: 20 * 1024 * 1024,
    redirectLimit: 10,
  }),
  browserSettings: browserSettingsSchema.default({
    enabled: false,
    waitUntil: 'domcontentloaded',
    actions: [],
  }),
  pagination: paginationSchema.default({ type: 'none' }),
  outputSettings: outputSettingsSchema.default({ persistRecords: true }),
  credentialBindings: taskCredentialBindingsSchema.default({}),
  datasetSettings: datasetSettingsSchema.default({
    mode: 'snapshot',
    keyFields: [],
    detectRemoved: true,
  }),
  retentionPolicy: retentionPolicySchema.default({
    runDays: null,
    maxRuns: null,
    artifactDays: null,
    logDays: null,
  }),
  networkPolicy: networkPolicySchema.default({
    allowPrivateNetworks: false,
    allowedHosts: [],
    allowedCidrs: [],
  }),
  outputBindings: z.array(z.string().uuid()).default([]),
});

export const taskUpdateSchema = taskCreateSchema.partial();

export const taskSchema = taskCreateSchema.extend({
  id: z.string().uuid(),
  status: taskStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  revision: z.number().int().positive().default(1),
});

export const extractionRuleSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  name: z.string(),
  activeVersionId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const ruleVersionSchema = z.object({
  id: z.string().uuid(),
  ruleId: z.string().uuid(),
  version: z.number().int().positive(),
  definition: crawlPlanDefinitionSchema,
  generatedBy: generatedBySchema,
  createdAt: z.string().datetime(),
});

export const crawlRunSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  status: runStatusSchema,
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  requestCount: z.number().int().nonnegative(),
  recordCount: z.number().int().nonnegative(),
  browserUsed: z.boolean(),
  aiUsed: z.boolean(),
  error: z.string().nullable(),
  errorCode: z.string().nullable().default(null),
  phase: z.string().default('queued'),
  progress: z.number().min(0).max(1).default(0),
  cancelRequestedAt: z.string().datetime().nullable().default(null),
  datasetStats: datasetStatsSchema.default({
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    current: 0,
  }),
  deliveryStatus: z.enum(['idle', 'pending', 'succeeded', 'failed']).default('idle'),
  warningCount: z.number().int().nonnegative().default(0),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});

export const activeRuleRecordSchema = z.object({
  rule: extractionRuleSchema,
  version: ruleVersionSchema,
});

export const taskListItemSchema = taskSchema.extend({
  latestRun: crawlRunSchema.nullable(),
});

export const taskDetailSchema = taskSchema.extend({
  activeRule: activeRuleRecordSchema.nullable(),
});

export const extractedRecordSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  runId: z.string().uuid(),
  sourceUrl: z.string().url(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});

export const analysisResultSchema = z.object({
  engine: z.enum(['json', 'http', 'browser']),
  candidate: crawlPlanDefinitionSchema,
  preview: z.array(z.record(z.string(), z.unknown())),
  sourceUrl: z.string().url(),
  aiUsed: z.boolean(),
  warnings: z.array(z.string()),
  apiCandidates: z
    .array(
      z.object({
        url: z.string().url(),
        method: z.string(),
        contentType: z.string(),
        sample: z.string(),
      }),
    )
    .default([]),
});

export const runtimeBootstrapSchema = z.object({
  baseUrl: z.string().url(),
  sessionNonce: z.string().min(16),
  runtimeId: z.string().uuid(),
  generation: z.number().int().nonnegative(),
  apiVersion: z.literal('v1'),
});

export const runtimeMetadataSchema = z.object({
  runtimeId: z.string().uuid(),
  generation: z.number().int().nonnegative(),
  apiVersion: z.literal('v1'),
  mode: z.enum(['headless', 'desktop']),
  version: z.string(),
  startedAt: z.string().datetime(),
});

export const runtimeCapabilitiesSchema = z.object({
  platform: z.enum(['headless', 'darwin', 'win32']),
  browser: z.boolean(),
  cron: z.boolean(),
  credentials: z.boolean(),
  artifactSaveDialog: z.boolean(),
  notifications: z.boolean(),
  tray: z.boolean(),
});

export const problemDetailsSchema = z.object({
  type: z.string().url(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string(),
  instance: z.string(),
  code: z.string(),
  traceId: z.string(),
  errors: z.unknown().optional(),
});

export const domainEventSchema = z.object({
  cursor: z.number().int().nonnegative(),
  id: z.string().uuid(),
  type: z.string().min(1),
  aggregateType: z.enum(['task', 'run', 'rule', 'artifact', 'runtime']),
  aggregateId: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});

export const realtimeEventSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(['run.progress', 'runtime.connection', 'crawler.progress']),
  runId: z.string().uuid().optional(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});

export const artifactDescriptorSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  format: z.enum(['csv', 'json', 'xlsx']),
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

export const connectionStateSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('connecting') }),
  z.object({ status: z.literal('connected'), metadata: runtimeMetadataSchema }),
  z.object({ status: z.literal('reconnecting'), attempt: z.number().int().positive() }),
  z.object({ status: z.literal('degraded'), reason: z.string() }),
]);

export const cursorPageSchema = <T extends z.ZodType>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    nextCursor: z.string().nullable(),
  });

export const datasetRecordSchema = z.object({
  id: z.string().uuid(),
  datasetId: z.string().uuid(),
  taskId: z.string().uuid(),
  recordKey: z.string(),
  sourceUrl: z.string().url(),
  data: z.record(z.string(), z.unknown()),
  contentHash: z.string(),
  removed: z.boolean(),
  firstRunId: z.string().uuid().nullable(),
  lastRunId: z.string().uuid().nullable(),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
});

export const recordChangeSchema = z.object({
  id: z.string().uuid(),
  datasetId: z.string().uuid(),
  datasetRecordId: z.string().uuid(),
  runId: z.string().uuid(),
  type: z.enum(['added', 'updated', 'removed']),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime(),
});

export const datasetDiffEntrySchema = z.object({
  recordKey: z.string(),
  type: z.enum(['added', 'updated', 'removed']),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
});

export const datasetDiffStatsSchema = z.object({
  added: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
});

export const runLogEntrySchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  sequence: z.number().int().positive(),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  phase: z.string(),
  message: z.string(),
  url: z.string().url().nullable(),
  errorCode: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});

export const runRequestEntrySchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  url: z.string().url(),
  kind: z.enum(['list', 'pagination', 'detail', 'api']),
  status: z.enum(['succeeded', 'failed', 'skipped']),
  statusCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  errorCode: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const outputDestinationSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  type: z.enum(['webhook', 'postgres']),
  config: z.record(z.string(), z.unknown()),
  credentialRef: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const deliveryAttemptSchema = z.object({
  id: z.string().uuid(),
  destinationId: z.string().uuid(),
  taskId: z.string().uuid(),
  runId: z.string().uuid(),
  status: z.enum(['pending', 'running', 'succeeded', 'failed']),
  attempt: z.number().int().positive(),
  responseStatus: z.number().int().nullable(),
  error: z.string().nullable(),
  nextAttemptAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const apiTokenSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  taskIds: z.array(z.string().uuid()),
  rateLimitPerMinute: z.number().int().min(1).max(10_000),
  expiresAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const ruleRepairProposalSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  ruleId: z.string().uuid(),
  runId: z.string().uuid().nullable(),
  definition: crawlPlanDefinitionSchema,
  explanation: z.string(),
  status: z.enum(['pending', 'applied', 'rejected']),
  testedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});

export const preferencePlatformSchema = z.enum([
  'hongguo',
  'fanqie',
  'bilibili',
  'douyin',
  'manual',
]);
export const preferenceContentTypeSchema = z.enum(['short_drama', 'novel', 'video', 'topic']);
export const preferenceSignalKindSchema = z.enum(['like', 'dislike', 'completed']);

export const preferenceContentSchema = z.object({
  platform: preferencePlatformSchema,
  contentType: preferenceContentTypeSchema,
  externalId: z.string().min(1).max(500),
  title: z.string().min(1).max(1_000),
  url: z.string().url().nullable().default(null),
  coverUrl: z.string().url().nullable().default(null),
  author: z.string().max(500).nullable().default(null),
  summary: z.string().max(10_000).nullable().default(null),
  tags: z.array(z.string().min(1).max(100)).max(100).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const preferenceSignalFields = {
  kind: preferenceSignalKindSchema,
  content: preferenceContentSchema,
};

function validatePreferenceSignal(
  value: {
    kind: z.infer<typeof preferenceSignalKindSchema>;
    content: z.infer<typeof preferenceContentSchema>;
  },
  context: z.RefinementCtx,
) {
  if (
    value.kind === 'completed' &&
    value.content.platform === 'manual' &&
    value.content.contentType === 'topic'
  ) {
    context.addIssue({
      code: 'custom',
      path: ['kind'],
      message: 'Manual topic tags only support like or dislike',
    });
  }
}

export const preferenceSignalInputSchema = z
  .object(preferenceSignalFields)
  .superRefine(validatePreferenceSignal);

export const preferenceSignalSchema = z
  .object({
    ...preferenceSignalFields,
    id: z.string().uuid(),
    targetKey: z.string().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine(validatePreferenceSignal);

export const preferenceScoreSchema = z.object({
  key: z.string(),
  label: z.string(),
  score: z.number(),
  evidenceCount: z.number().int().nonnegative(),
});

export const preferenceProfileSchema = z.object({
  positiveTags: z.array(preferenceScoreSchema),
  negativeTags: z.array(preferenceScoreSchema),
  contentTypes: z.array(preferenceScoreSchema),
  platforms: z.array(preferenceScoreSchema),
  signalCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime().nullable(),
  recentSignals: z.array(preferenceSignalSchema),
});

export const trendSourceStatusSchema = z.enum([
  'not-installed',
  'idle',
  'queued',
  'running',
  'succeeded',
  'failed',
  'planned',
]);

export const trendSourceSchema = z.object({
  key: z.string().min(1),
  platform: preferencePlatformSchema,
  name: z.string(),
  description: z.string(),
  supported: z.boolean(),
  enabled: z.boolean(),
  autoRefresh: z.boolean(),
  scheduleLabel: z.string().nullable(),
  taskId: z.string().uuid().nullable(),
  status: trendSourceStatusSchema,
  lastRunId: z.string().uuid().nullable(),
  lastSucceededAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
});

export const trendItemSchema = preferenceContentSchema.extend({
  id: z.string().min(1),
  sourceKey: z.string().min(1),
  rank: z.number().int().positive().nullable(),
  score: z.number().min(0).max(100),
  metrics: z.record(z.string(), z.number()).default({}),
  updatedAt: z.string().datetime().nullable(),
  matchingTags: z.array(z.string()).default([]),
});

export const trendTermSchema = z.object({
  term: z.string().min(1),
  score: z.number().nonnegative(),
  platforms: z.array(preferencePlatformSchema),
  contentTypes: z.array(preferenceContentTypeSchema),
  itemCount: z.number().int().positive(),
  examples: z.array(trendItemSchema).max(3),
});

export const trendsResponseSchema = z.object({
  items: z.array(trendItemSchema),
  terms: z.array(trendTermSchema),
  generatedAt: z.string().datetime(),
});

export const trendSourceUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    autoRefresh: z.boolean().optional(),
  })
  .refine((value) => value.enabled !== undefined || value.autoRefresh !== undefined, {
    message: 'At least one setting is required',
  });

export const preferenceImportSchema = z.object({
  url: z.string().url(),
  kind: preferenceSignalKindSchema.default('like'),
});

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type GeneratedBy = z.infer<typeof generatedBySchema>;
export type RequestSettings = z.infer<typeof requestSettingsSchema>;
export type BrowserSettings = z.infer<typeof browserSettingsSchema>;
export type Pagination = z.infer<typeof paginationSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type ExtractionRuleDefinition = z.infer<typeof extractionRuleDefinitionSchema>;
export type ExtractionSource = z.infer<typeof extractionSourceSchema>;
export type Discovery = z.infer<typeof discoverySchema>;
export type CrawlMode = z.infer<typeof crawlModeSchema>;
export type CrawlPlanDefinition = z.infer<typeof crawlPlanDefinitionSchema>;
export type RuleDefinitionInput = z.infer<typeof ruleDefinitionInputSchema>;
export type DatasetSettings = z.infer<typeof datasetSettingsSchema>;
export type DatasetStats = z.infer<typeof datasetStatsSchema>;
export type RetentionPolicy = z.infer<typeof retentionPolicySchema>;
export type NetworkPolicy = z.infer<typeof networkPolicySchema>;
export type DomFieldRule = z.infer<typeof domFieldRuleSchema>;
export type TaskCreate = z.infer<typeof taskCreateSchema>;
export type TaskUpdate = z.infer<typeof taskUpdateSchema>;
export type CrawlTask = z.infer<typeof taskSchema>;
export type CrawlRun = z.infer<typeof crawlRunSchema>;
export type ActiveRule = z.infer<typeof activeRuleRecordSchema>;
export type TaskList = z.infer<typeof taskListItemSchema>;
export type TaskDetails = z.infer<typeof taskDetailSchema>;
export type ExtractedRecord = z.infer<typeof extractedRecordSchema>;
export type AnalysisResult = z.infer<typeof analysisResultSchema>;
export type TaskCredentialBindings = z.infer<typeof taskCredentialBindingsSchema>;
export type RuntimeBootstrap = z.infer<typeof runtimeBootstrapSchema>;
export type RuntimeMetadata = z.infer<typeof runtimeMetadataSchema>;
export type RuntimeCapabilities = z.infer<typeof runtimeCapabilitiesSchema>;
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
export type DomainEvent = z.infer<typeof domainEventSchema>;
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;
export type ArtifactDescriptor = z.infer<typeof artifactDescriptorSchema>;
export type ConnectionState = z.infer<typeof connectionStateSchema>;
export type DatasetRecord = z.infer<typeof datasetRecordSchema>;
export type RecordChange = z.infer<typeof recordChangeSchema>;
export type DatasetDiffEntry = z.infer<typeof datasetDiffEntrySchema>;
export type DatasetDiffStats = z.infer<typeof datasetDiffStatsSchema>;
export type RunLogEntry = z.infer<typeof runLogEntrySchema>;
export type RunRequestEntry = z.infer<typeof runRequestEntrySchema>;
export type OutputDestination = z.infer<typeof outputDestinationSchema>;
export type DeliveryAttempt = z.infer<typeof deliveryAttemptSchema>;
export type ApiToken = z.infer<typeof apiTokenSchema>;
export type RuleRepairProposal = z.infer<typeof ruleRepairProposalSchema>;
export type PreferencePlatform = z.infer<typeof preferencePlatformSchema>;
export type PreferenceContentType = z.infer<typeof preferenceContentTypeSchema>;
export type PreferenceSignalKind = z.infer<typeof preferenceSignalKindSchema>;
export type PreferenceContent = z.infer<typeof preferenceContentSchema>;
export type PreferenceSignalInput = z.infer<typeof preferenceSignalInputSchema>;
export type PreferenceSignal = z.infer<typeof preferenceSignalSchema>;
export type PreferenceScore = z.infer<typeof preferenceScoreSchema>;
export type PreferenceProfile = z.infer<typeof preferenceProfileSchema>;
export type TrendSourceStatus = z.infer<typeof trendSourceStatusSchema>;
export type TrendSource = z.infer<typeof trendSourceSchema>;
export type TrendItem = z.infer<typeof trendItemSchema>;
export type TrendTerm = z.infer<typeof trendTermSchema>;
export type TrendsResponse = z.infer<typeof trendsResponseSchema>;
export type TrendSourceUpdate = z.infer<typeof trendSourceUpdateSchema>;
export type PreferenceImport = z.infer<typeof preferenceImportSchema>;

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NAVIGATION_ERROR'
  | 'CRAWLER_ERROR'
  | 'EXTRACTION_ERROR'
  | 'RULE_ERROR'
  | 'AI_ERROR'
  | 'STORAGE_ERROR'
  | 'EXPORT_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'PRECONDITION_REQUIRED'
  | 'PRECONDITION_FAILED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RUNTIME_INTERRUPTED'
  | 'RUNTIME_UNAVAILABLE'
  | 'CANCELED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CREDENTIAL_ERROR'
  | 'NETWORK_POLICY_ERROR'
  | 'BROWSER_MISSING'
  | 'BROWSER_CRASHED';

export class ZhiYunError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends ZhiYunError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_ERROR', message, details);
  }
}
export class NavigationError extends ZhiYunError {
  constructor(message: string, details?: unknown) {
    super('NAVIGATION_ERROR', message, details);
  }
}
export class CrawlerError extends ZhiYunError {
  constructor(message: string, details?: unknown) {
    super('CRAWLER_ERROR', message, details);
  }
}
export class ExtractionError extends ZhiYunError {
  constructor(message: string, details?: unknown) {
    super('EXTRACTION_ERROR', message, details);
  }
}
export class RuleError extends ZhiYunError {
  constructor(message: string, details?: unknown) {
    super('RULE_ERROR', message, details);
  }
}
export class AiError extends ZhiYunError {
  constructor(message: string, details?: unknown) {
    super('AI_ERROR', message, details);
  }
}
export class StorageError extends ZhiYunError {
  constructor(message: string, details?: unknown) {
    super('STORAGE_ERROR', message, details);
  }
}
export class ExportError extends ZhiYunError {
  constructor(message: string, details?: unknown) {
    super('EXPORT_ERROR', message, details);
  }
}
export class NetworkPolicyError extends ZhiYunError {
  constructor(message: string, details?: unknown) {
    super('NETWORK_POLICY_ERROR', message, details);
  }
}
