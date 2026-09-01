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

const sensitiveFillSelector = /password|passwd|pwd|type\s*=\s*["']?password/i;

export const browserElementMetadataSchema = z.object({
  tag: z.string().min(1),
  inputType: z.string().min(1).nullable(),
  sensitive: z.boolean(),
});

const browserActionTarget = {
  target: browserElementMetadataSchema.optional(),
};

export const browserActionSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('click'), selector: z.string().min(1), ...browserActionTarget }),
    z.object({
      type: z.literal('fill'),
      selector: z.string().min(1),
      value: z.string(),
      ...browserActionTarget,
    }),
    z.object({
      type: z.literal('select'),
      selector: z.string().min(1),
      value: z.string(),
      ...browserActionTarget,
    }),
    z.object({
      type: z.literal('press'),
      selector: z.string().min(1),
      key: z.string().min(1),
      ...browserActionTarget,
    }),
    z.object({ type: z.literal('hover'), selector: z.string().min(1), ...browserActionTarget }),
    z.object({ type: z.literal('wait'), milliseconds: z.number().int().min(0).max(60_000) }),
    z.object({ type: z.literal('waitFor'), selector: z.string().min(1), ...browserActionTarget }),
    z.object({ type: z.literal('scroll'), count: z.number().int().min(1).max(100).default(1) }),
  ])
  .superRefine((action, context) => {
    if (
      action.type === 'fill' &&
      action.value.length > 0 &&
      (sensitiveFillSelector.test(action.selector) || action.target?.sensitive === true)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: '禁止在浏览器动作中保存密码；请使用安全 Login Session 或 CredentialStore。',
      });
    }
  });

export const inspectionStepInputSchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  action: browserActionSchema,
});

export const inspectionStepResultSchema = z.object({
  stepIndex: z.number().int().nonnegative(),
  status: z.enum(['succeeded', 'failed']),
  url: z.string(),
  screenshot: z.object({
    image: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  error: z.string().nullable(),
  target: browserElementMetadataSchema.nullable().optional(),
});

export const inspectionElementSelectionSchema = z.object({
  selector: z.string().min(1),
  tag: z.string().min(1),
  text: z.string(),
  attributes: z.record(z.string(), z.string()),
  box: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  }),
  metadata: browserElementMetadataSchema,
});

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

interface CronFieldDefinition {
  label: string;
  minimum: number;
  maximum: number;
  normalize?: (value: number) => number;
}

interface ParsedCronField {
  values: ReadonlySet<number>;
  wildcard: boolean;
}

interface ParsedFiveFieldCron {
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
}

const cronFieldDefinitions: readonly CronFieldDefinition[] = [
  { label: 'minute', minimum: 0, maximum: 59 },
  { label: 'hour', minimum: 0, maximum: 23 },
  { label: 'day of month', minimum: 1, maximum: 31 },
  { label: 'month', minimum: 1, maximum: 12 },
  { label: 'day of week', minimum: 0, maximum: 7, normalize: (value) => value % 7 },
];

/**
 * Validates the deterministic five-field Cron subset persisted by ZhiYun.
 *
 * The scheduler deliberately excludes Croner's time-of-construction `?` token and
 * named/extended fields so the same persisted expression has identical semantics in
 * the API, desktop client and headless scheduler.
 */
export function validateFiveFieldCron(expression: string): string[] {
  const fields = expression.trim().split(/\s+/).filter(Boolean);
  if (fields.length !== cronFieldDefinitions.length) {
    return ['cron must contain exactly five fields'];
  }

  const parsed: ParsedCronField[] = [];
  const errors: string[] = [];
  for (const [index, definition] of cronFieldDefinitions.entries()) {
    const result = parseCronField(fields[index] ?? '', definition);
    if (!result.ok) errors.push(result.message);
    else parsed.push(result.value);
  }
  if (errors.length > 0 || parsed.length !== cronFieldDefinitions.length) return errors;

  const cron: ParsedFiveFieldCron = {
    minute: parsed[0]!,
    hour: parsed[1]!,
    dayOfMonth: parsed[2]!,
    month: parsed[3]!,
    dayOfWeek: parsed[4]!,
  };
  const calendar = analyzeCronCalendar(cron);
  if (!calendar.hasExecutionDate) {
    errors.push('cron does not contain a possible execution date');
    return errors;
  }
  if (minimumCronIntervalMinutes(cron, calendar.hasConsecutiveExecutionDates) < 5) {
    errors.push('scheduled tasks must run at intervals of at least five minutes');
  }
  return errors;
}

function parseCronField(
  expression: string,
  definition: CronFieldDefinition,
): { ok: true; value: ParsedCronField } | { ok: false; message: string } {
  if (expression.includes('?')) {
    return {
      ok: false,
      message: `cron ${definition.label} cannot use the non-deterministic question-mark token`,
    };
  }
  if (!expression || !/^[-\d*/,]+$/.test(expression)) {
    return { ok: false, message: `cron ${definition.label} contains unsupported characters` };
  }

  const values = new Set<number>();
  for (const item of expression.split(',')) {
    if (!item) return { ok: false, message: `cron ${definition.label} contains an empty item` };
    const parts = item.split('/');
    if (parts.length > 2) {
      return { ok: false, message: `cron ${definition.label} contains an invalid step` };
    }
    const base = parts[0] ?? '';
    const stepText = parts[1];
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step <= 0) {
      return { ok: false, message: `cron ${definition.label} step must be a positive integer` };
    }

    let start: number;
    let end: number;
    if (base === '*') {
      start = definition.minimum;
      end = definition.maximum;
    } else if (/^\d+$/.test(base)) {
      start = Number(base);
      end = stepText === undefined ? start : definition.maximum;
    } else {
      const range = /^(\d+)-(\d+)$/.exec(base);
      if (!range) {
        return { ok: false, message: `cron ${definition.label} contains an invalid range` };
      }
      start = Number(range[1]);
      end = Number(range[2]);
    }
    if (
      start < definition.minimum ||
      start > definition.maximum ||
      end < definition.minimum ||
      end > definition.maximum ||
      start > end
    ) {
      return {
        ok: false,
        message: `cron ${definition.label} must be between ${definition.minimum} and ${definition.maximum}`,
      };
    }
    for (let value = start; value <= end; value += step) {
      values.add(definition.normalize?.(value) ?? value);
    }
  }

  const cardinality =
    definition.normalize === undefined
      ? definition.maximum - definition.minimum + 1
      : new Set(
          Array.from({ length: definition.maximum - definition.minimum + 1 }, (_, index) =>
            definition.normalize?.(definition.minimum + index),
          ),
        ).size;
  return { ok: true, value: { values, wildcard: values.size === cardinality } };
}

function analyzeCronCalendar(cron: ParsedFiveFieldCron): {
  hasExecutionDate: boolean;
  hasConsecutiveExecutionDates: boolean;
} {
  // A 28-year window covers every weekday/leap-year combination used by a yearless Cron.
  const start = Date.UTC(2000, 0, 1);
  const end = Date.UTC(2028, 0, 2);
  const dayMs = 24 * 60 * 60 * 1_000;
  let previousMatches = false;
  let hasExecutionDate = false;
  for (let timestamp = start; timestamp < end; timestamp += dayMs) {
    const matches = cronDateMatches(new Date(timestamp), cron);
    if (matches) hasExecutionDate = true;
    if (matches && previousMatches) {
      return { hasExecutionDate: true, hasConsecutiveExecutionDates: true };
    }
    previousMatches = matches;
  }
  return { hasExecutionDate, hasConsecutiveExecutionDates: false };
}

function cronDateMatches(date: Date, cron: ParsedFiveFieldCron): boolean {
  if (!cron.month.values.has(date.getUTCMonth() + 1)) return false;
  const dayOfMonthMatches = cron.dayOfMonth.values.has(date.getUTCDate());
  const dayOfWeekMatches = cron.dayOfWeek.values.has(date.getUTCDay());
  if (cron.dayOfMonth.wildcard && cron.dayOfWeek.wildcard) return true;
  if (cron.dayOfMonth.wildcard) return dayOfWeekMatches;
  if (cron.dayOfWeek.wildcard) return dayOfMonthMatches;
  // Match Vixie Cron/Croner's legacy behavior when both day fields are restricted.
  return dayOfMonthMatches || dayOfWeekMatches;
}

function minimumCronIntervalMinutes(
  cron: ParsedFiveFieldCron,
  hasConsecutiveExecutionDates: boolean,
): number {
  const times = [...cron.hour.values]
    .flatMap((hour) => [...cron.minute.values].map((minute) => hour * 60 + minute))
    .sort((left, right) => left - right);
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = 1; index < times.length; index += 1) {
    minimum = Math.min(minimum, (times[index] ?? 0) - (times[index - 1] ?? 0));
  }
  if (hasConsecutiveExecutionDates && times.length > 0) {
    minimum = Math.min(minimum, 24 * 60 - (times.at(-1) ?? 0) + (times[0] ?? 0));
  }
  return minimum;
}

export const scheduleSchema = z
  .object({
    mode: scheduleModeSchema.default('manual'),
    cron: z.string().optional(),
    timezone: z.string().default('Asia/Shanghai'),
    misfirePolicy: z.enum(['skip', 'run-once']).default('skip'),
  })
  .superRefine((schedule, context) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: schedule.timezone }).format(new Date());
    } catch {
      context.addIssue({
        code: 'custom',
        path: ['timezone'],
        message: 'timezone must be a valid IANA timezone',
      });
    }
    if (schedule.mode !== 'cron') return;
    for (const message of validateFiveFieldCron(schedule.cron ?? '')) {
      context.addIssue({
        code: 'custom',
        path: ['cron'],
        message,
      });
    }
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

export const qualityIssueKindSchema = z.enum([
  'run-failed',
  'empty-result',
  'record-count-drop',
  'field-missing',
  'null-rate-spike',
  'type-change',
  'content-change',
]);

export const qualityRuleSchema = z.object({
  kind: qualityIssueKindSchema,
  enabled: z.boolean().default(true),
  threshold: z.number().min(0).max(1).optional(),
  baselineThreshold: z.number().min(0).max(1).optional(),
  deltaThreshold: z.number().min(0).max(1).optional(),
  fields: z.array(z.string().min(1)).default([]),
});

export const qualityPolicySchema = z
  .object({
    enabled: z.boolean().default(true),
    baselineRuns: z.number().int().min(1).max(20).default(5),
    minimumBaselineRuns: z.number().int().min(1).max(20).default(3),
    rules: z.array(qualityRuleSchema).default([
      { kind: 'run-failed', enabled: true, fields: [] },
      { kind: 'empty-result', enabled: true, fields: [] },
      { kind: 'record-count-drop', enabled: true, threshold: 0.5, fields: [] },
      {
        kind: 'field-missing',
        enabled: true,
        threshold: 0.1,
        baselineThreshold: 0.9,
        fields: [],
      },
      {
        kind: 'null-rate-spike',
        enabled: true,
        threshold: 0.5,
        deltaThreshold: 0.3,
        fields: [],
      },
      { kind: 'type-change', enabled: true, threshold: 0.8, fields: [] },
      { kind: 'content-change', enabled: false, threshold: 0.2, fields: [] },
    ]),
  })
  .refine((policy) => policy.minimumBaselineRuns <= policy.baselineRuns, {
    path: ['minimumBaselineRuns'],
    message: 'minimumBaselineRuns cannot exceed baselineRuns',
  });

export const qualityFieldProfileSchema = z.object({
  present: z.number().int().nonnegative(),
  nulls: z.number().int().nonnegative(),
  types: z.record(z.string(), z.number().int().nonnegative()),
});

export const qualityProfileSchema = z.object({
  recordCount: z.number().int().nonnegative(),
  fields: z.record(z.string(), qualityFieldProfileSchema),
});

export const qualityIssueSchema = z.object({
  kind: qualityIssueKindSchema,
  severity: z.enum(['warning', 'critical']).default('warning'),
  message: z.string().min(1),
  field: z.string().nullable().default(null),
  actual: z.number().nullable().default(null),
  expected: z.number().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export const taskHealthStatusSchema = z.enum(['unknown', 'healthy', 'warning', 'failing']);

export const qualityEvaluationSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  runId: z.string().uuid(),
  status: taskHealthStatusSchema,
  profile: qualityProfileSchema,
  issues: z.array(qualityIssueSchema),
  createdAt: z.string().datetime(),
});

export const taskHealthSchema = z.object({
  taskId: z.string().uuid(),
  status: taskHealthStatusSchema,
  latestRunId: z.string().uuid().nullable(),
  issues: z.array(qualityIssueSchema),
  baselineReady: z.boolean(),
  updatedAt: z.string().datetime().nullable(),
});

export const taskOriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }),
  z.object({ kind: z.literal('ai') }),
  z.object({
    kind: z.literal('template'),
    templateId: z.string().min(1),
    templateVersion: z.number().int().positive(),
  }),
]);

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
  origin: taskOriginSchema.default({ kind: 'manual' }),
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
  apiVersion: z.literal('v2'),
});

export const runtimeMetadataSchema = z.object({
  runtimeId: z.string().uuid(),
  generation: z.number().int().nonnegative(),
  apiVersion: z.literal('v2'),
  mode: z.enum(['headless', 'desktop']),
  productVersion: z.literal('1.0.0'),
  profileId: z.string().min(1),
  graphRevision: z.string().min(1),
  enabledPluginIds: z.array(z.string().min(1)),
  enabledUiContributionIds: z.array(z.string().min(1)),
  analyticsWorkerStatus: z.enum(['starting', 'ready', 'degraded', 'unavailable']),
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
  aggregateType: z.enum([
    'task',
    'run',
    'rule',
    'artifact',
    'runtime',
    'task-health',
    'quality-evaluation',
    'output-destination',
    'collection-task',
    'user',
    'invitation',
    'audit-event',
  ]),
  aggregateId: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});

export const realtimeEventSchema = z.object({
  id: z.union([z.number().int().nonnegative(), z.string().uuid()]),
  type: z.enum([
    'run.progress',
    'runtime.connection',
    'crawler.progress',
    'ai.turn.delta',
    'ai.turn.status',
    'ai.tool.status',
    'ai.draft.updated',
  ]),
  runId: z.string().uuid().optional(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime().optional(),
  occurredAt: z.string().datetime().optional(),
});

export const artifactDescriptorSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  format: z.enum(['csv', 'json', 'jsonl', 'xlsx', 'parquet']),
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

const outputDestinationBaseSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  credentialRef: z.string().nullable(),
  enabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const webhookEventTypeSchema = z.enum([
  'run.succeeded',
  'run.failed',
  'dataset.changed',
  'quality.issue.detected',
  'quality.recovered',
]);

const outputFieldListSchema = z.array(z.string().min(1));
const outputPathTemplateSchema = z.string().min(1);

const webhookOutputDestinationConfigSchema = z
  .object({
    url: z.string().url().optional(),
    event: webhookEventTypeSchema.optional(),
    events: z.array(webhookEventTypeSchema).optional(),
  })
  .strip();

const postgresOutputDestinationConfigSchema = z
  .object({
    schema: z.string().optional(),
    table: z.string().optional(),
  })
  .strip();

const localDirectoryOutputDestinationConfigSchema = z
  .object({
    format: z.enum(['csv', 'jsonl', 'parquet']).default('csv'),
    pathTemplate: outputPathTemplateSchema
      .default('{taskSlug}/{yyyy}/{mm}/{runId}.{ext}')
      .refine((value) => value.includes('{runId}'), {
        message: 'Local-directory pathTemplate must contain {runId}',
      }),
    updateLatest: z.boolean().default(true),
    // Compatibility aliases are read by the adapters while old destinations are migrated.
    latest: z.boolean().optional(),
    basePath: z.string().optional(),
    subdirectory: z.string().optional(),
    taskSlug: z.string().optional(),
    fields: outputFieldListSchema.optional(),
    columns: outputFieldListSchema.optional(),
    includeSourceUrl: z.boolean().optional(),
  })
  .strip();

const googleSheetsOutputDestinationConfigSchema = z
  .object({
    spreadsheetId: z.string().min(1),
    sheetName: z.string().min(1).default('Records'),
    mode: z.enum(['auto', 'replace', 'append']).default('auto'),
    columns: outputFieldListSchema.default([]),
    fields: outputFieldListSchema.optional(),
    includeSourceUrl: z.boolean().optional(),
    clientEmail: z.string().min(3).optional(),
  })
  .strip();

const s3OutputDestinationConfigSchema = z
  .object({
    bucket: z.string().min(1),
    region: z.string().min(1).default('us-east-1'),
    prefix: z.string().default(''),
    pathTemplate: outputPathTemplateSchema
      .default('{taskSlug}/{yyyy}/{mm}/{runId}.{ext}')
      .refine((value) => value.includes('{runId}'), {
        message: 'S3 pathTemplate must contain {runId}',
      }),
    format: z.enum(['csv', 'jsonl', 'parquet']).default('csv'),
    updateLatest: z.boolean().default(true),
    latest: z.boolean().optional(),
    endpoint: z.string().url().optional(),
    forcePathStyle: z.boolean().default(false),
    serverSideEncryption: z.enum(['AES256', 'aws:kms']).optional(),
    kmsKeyId: z.string().optional(),
    taskSlug: z.string().optional(),
    fields: outputFieldListSchema.optional(),
    columns: outputFieldListSchema.optional(),
    includeSourceUrl: z.boolean().optional(),
  })
  .strip();

const outputDestinationConfigSchemas = {
  webhook: webhookOutputDestinationConfigSchema,
  postgres: postgresOutputDestinationConfigSchema,
  'local-directory': localDirectoryOutputDestinationConfigSchema,
  'google-sheets': googleSheetsOutputDestinationConfigSchema,
  s3: s3OutputDestinationConfigSchema,
} as const;

export type OutputDestinationType = keyof typeof outputDestinationConfigSchemas;

const sensitiveOutputConfigKey =
  /password|passwd|passphrase|secret|token|credential|privatekey|accesskey|apikey|authorization|cookie|session|storagestate|connectionstring|serviceaccount/u;
const privateKeyMaterial = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/u;

interface SensitiveOutputConfigEntry {
  path: Array<string | number>;
  displayPath: string;
}

function sensitiveOutputConfigEntries(value: unknown): SensitiveOutputConfigEntry[] {
  const entries: SensitiveOutputConfigEntry[] = [];
  const visited = new WeakSet<object>();
  const visit = (item: unknown, path: Array<string | number>) => {
    if (typeof item === 'string') {
      if (privateKeyMaterial.test(item)) {
        entries.push({ path, displayPath: displayOutputConfigPath(path) });
      }
      return;
    }
    if (!item || typeof item !== 'object') return;
    if (visited.has(item)) return;
    visited.add(item);
    if (Array.isArray(item)) {
      item.forEach((entry, index) => visit(entry, [...path, index]));
      return;
    }
    for (const [key, entry] of Object.entries(item as Record<string, unknown>)) {
      const entryPath = [...path, key];
      const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
      if (sensitiveOutputConfigKey.test(normalizedKey)) {
        entries.push({ path: entryPath, displayPath: displayOutputConfigPath(entryPath) });
        continue;
      }
      visit(entry, entryPath);
    }
  };
  visit(value, []);
  return entries;
}

function displayOutputConfigPath(path: readonly (string | number)[]): string {
  return path.reduce<string>(
    (result, part) =>
      typeof part === 'number' ? `${result}[${part}]` : `${result}${result ? '.' : ''}${part}`,
    'config',
  );
}

/** Returns every nested config location that looks like inline credential material. */
export function sensitiveOutputConfigPaths(value: unknown): string[] {
  return sensitiveOutputConfigEntries(value).map((entry) => entry.displayPath);
}

/** Rejects credentials in destination config; callers must store them in CredentialStore. */
export function assertNoSensitiveOutputConfig(value: unknown): void {
  const paths = sensitiveOutputConfigPaths(value);
  if (paths.length > 0) {
    throw new Error(`Output Destination config must not contain credentials: ${paths.join(', ')}`);
  }
}

/** Applies the per-type allowlist while reading legacy or otherwise untrusted stored config. */
export function stripOutputDestinationConfig(
  type: OutputDestinationType,
  value: unknown,
): Record<string, unknown> {
  return outputDestinationConfigSchemas[type].parse(value) as Record<string, unknown>;
}

function protectedOutputDestinationConfigSchema<T extends z.ZodType>(schema: T) {
  return z.preprocess((value, context) => {
    for (const entry of sensitiveOutputConfigEntries(value)) {
      context.addIssue({
        code: 'custom',
        path: entry.path,
        message: 'Output Destination credentials must be stored in CredentialStore',
      });
    }
    return value;
  }, schema);
}

export const outputDestinationSchema = z.discriminatedUnion('type', [
  outputDestinationBaseSchema.extend({
    type: z.literal('webhook'),
    config: protectedOutputDestinationConfigSchema(webhookOutputDestinationConfigSchema),
  }),
  outputDestinationBaseSchema.extend({
    type: z.literal('postgres'),
    config: protectedOutputDestinationConfigSchema(postgresOutputDestinationConfigSchema),
  }),
  outputDestinationBaseSchema.extend({
    type: z.literal('local-directory'),
    config: protectedOutputDestinationConfigSchema(localDirectoryOutputDestinationConfigSchema),
  }),
  outputDestinationBaseSchema.extend({
    type: z.literal('google-sheets'),
    config: protectedOutputDestinationConfigSchema(googleSheetsOutputDestinationConfigSchema),
  }),
  outputDestinationBaseSchema.extend({
    type: z.literal('s3'),
    config: protectedOutputDestinationConfigSchema(s3OutputDestinationConfigSchema),
  }),
]);

export const taskTemplateParameterSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean', 'selector']),
  required: z.boolean().default(true),
  defaultValue: z.unknown().optional(),
});

export const taskTemplateCompatibilitySchema = z.object({
  browserRequired: z.boolean().default(false),
  loginSupported: z.boolean().default(false),
  capabilities: z.array(z.string().min(1)).default([]),
});

export const taskTemplateSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().min(1),
  category: z.string().min(1),
  parameters: z.array(taskTemplateParameterSchema),
  compatibility: taskTemplateCompatibilitySchema,
  taskDefaults: taskCreateSchema.partial().omit({ startUrl: true }),
  ruleDefinition: crawlPlanDefinitionSchema,
  qualityPolicy: qualityPolicySchema.optional(),
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
  format: z.enum(['csv', 'jsonl', 'parquet']).nullable().default(null),
  artifactId: z.string().min(1).nullable().default(null),
  finalLocation: z.string().nullable().default(null),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable()
    .default(null),
  deliveredRecordCount: z.number().int().nonnegative().nullable().default(null),
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
  'qidian',
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
export type BrowserAction = z.infer<typeof browserActionSchema>;
export type BrowserSettings = z.infer<typeof browserSettingsSchema>;
export type BrowserElementMetadata = z.infer<typeof browserElementMetadataSchema>;
export type InspectionStepInput = z.infer<typeof inspectionStepInputSchema>;
export type InspectionStepResult = z.infer<typeof inspectionStepResultSchema>;
export type InspectionElementSelection = z.infer<typeof inspectionElementSelectionSchema>;
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
export type QualityIssueKind = z.infer<typeof qualityIssueKindSchema>;
export type QualityRule = z.infer<typeof qualityRuleSchema>;
export type QualityPolicy = z.infer<typeof qualityPolicySchema>;
export type QualityFieldProfile = z.infer<typeof qualityFieldProfileSchema>;
export type QualityProfile = z.infer<typeof qualityProfileSchema>;
export type QualityIssue = z.infer<typeof qualityIssueSchema>;
export type TaskHealthStatus = z.infer<typeof taskHealthStatusSchema>;
export type QualityEvaluation = z.infer<typeof qualityEvaluationSchema>;
export type TaskHealth = z.infer<typeof taskHealthSchema>;
export type TaskOrigin = z.infer<typeof taskOriginSchema>;
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
export type WebhookEventType = z.infer<typeof webhookEventTypeSchema>;
export type TaskTemplateParameter = z.infer<typeof taskTemplateParameterSchema>;
export type TaskTemplateCompatibility = z.infer<typeof taskTemplateCompatibilitySchema>;
export type TaskTemplate = z.infer<typeof taskTemplateSchema>;
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

const sensitiveValueName =
  /token|secret|password|passwd|authorization|proxy[-_ ]?authorization|cookie|signature|session|credential|api[-_ ]?key|access[-_ ]?key|private[-_ ]?key/i;

/** Removes credentials and sensitive query values before errors or events are persisted. */
export function redactSensitiveUrl(value: string): string {
  try {
    const parsed = new URL(value, 'http://zhiyun.invalid');
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (sensitiveValueName.test(key)) parsed.searchParams.set(key, '[REDACTED]');
    }
    return parsed.origin === 'http://zhiyun.invalid'
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

/** Redacts common header, URL, DSN and inline credential forms from diagnostic text. */
export function redactSensitiveText(value: string): string {
  return value
    .replaceAll(/https?:\/\/[^\s"'<>]+/gi, (url) => redactSensitiveUrl(url))
    .replaceAll(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replaceAll(
      /((?:authorization|cookie|proxy-authorization|api[-_ ]?key|access[-_ ]?key|password|passwd|token|secret|session)\s*[:=：]\s*)[^\s,;]+/gi,
      '$1[REDACTED]',
    )
    .replaceAll(/(postgres(?:ql)?:\/\/)[^\s@]+@/gi, '$1[REDACTED]@');
}

/** Recursively redacts an event payload while retaining non-sensitive diagnostics. */
export function redactSensitiveValue(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[TRUNCATED]';
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitiveValue(item, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = sensitiveValueName.test(key)
      ? '[REDACTED]'
      : redactSensitiveValue(item, depth + 1);
  }
  return result;
}
