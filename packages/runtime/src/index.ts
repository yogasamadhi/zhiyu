import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import cors from '@fastify/cors';
import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z } from 'zod';
import { DefaultDataExporter, type ExportFormat } from '@zhiyun/exporters';
import { assertNetworkAllowed, fetchPageSource } from '@zhiyun/crawler-runtime';
import { outputAdapter } from '@zhiyun/outputs';
import {
  TREND_SOURCE_CATALOG,
  buildPreferenceProfile,
  buildTrendTerms,
  contentResolver,
  matchPreferenceTags,
  normalizeTrendRecords,
  preferenceContentFromResolved,
  preferenceTargetKey,
  sourceCatalogEntry,
} from '@zhiyun/preferences';
import { validateCrawlPlan } from '@zhiyun/rules';
import {
  generatedBySchema,
  analysisResultSchema,
  apiTokenSchema,
  artifactDescriptorSchema,
  crawlPlanDefinitionSchema,
  crawlRunSchema,
  datasetDiffEntrySchema,
  datasetDiffStatsSchema,
  datasetRecordSchema,
  datasetStatsSchema,
  deliveryAttemptSchema,
  domainEventSchema,
  extractedRecordSchema,
  outputDestinationSchema,
  preferenceImportSchema,
  preferenceProfileSchema,
  preferenceSignalInputSchema,
  preferenceSignalSchema,
  problemDetailsSchema,
  recordChangeSchema,
  ruleRepairProposalSchema,
  ruleVersionSchema,
  runLogEntrySchema,
  runRequestEntrySchema,
  runtimeCapabilitiesSchema,
  runtimeMetadataSchema,
  taskCreateSchema,
  taskDetailSchema,
  taskListItemSchema,
  taskUpdateSchema,
  trendItemSchema,
  trendSourceSchema,
  trendSourceUpdateSchema,
  trendTermSchema,
  trendsResponseSchema,
  ZhiYunError,
  type AiProvider,
  type ArtifactStore,
  type BrowserSettings,
  type CredentialStore,
  type CrawlerService,
  type HostCapabilities,
  type ProblemDetails,
  type QueueAdapter,
  type RealtimeEvent,
  type Repository,
  type RuntimeJob,
  type SchedulerAdapter,
  type TaskCreate,
  type TaskCredentialBindings,
  type TaskUpdate,
} from '@zhiyun/contracts';
import { analyzePage } from './analyzer.js';
import { InspectionManager } from './inspection.js';

const idParams = z.object({ id: z.string().uuid() });
const ruleParams = z.object({ id: z.string().uuid(), ruleId: z.string().uuid() });
const sourceParams = z.object({ key: z.string().min(1).max(100) });
const exportFormatSchema = z.enum(['csv', 'json', 'xlsx']);
const datasetFilterSchema = z
  .record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/),
    z.union([z.string(), z.number(), z.boolean(), z.null()]),
  )
  .refine((value) => Object.keys(value).length <= 20, 'At most 20 field filters are allowed');
const datasetFilterQuerySchema = z
  .string()
  .max(5_000)
  .transform((source, context) => {
    try {
      const parsed = datasetFilterSchema.safeParse(JSON.parse(source));
      if (parsed.success) return parsed.data;
      context.addIssue({ code: 'custom', message: 'Invalid Dataset field filter' });
      return z.NEVER;
    } catch {
      context.addIssue({ code: 'custom', message: 'Dataset filter must be valid JSON' });
      return z.NEVER;
    }
  });

export interface RuntimeDependencies {
  repository: Repository;
  queue: QueueAdapter;
  scheduler: SchedulerAdapter;
  crawler: CrawlerService;
  ai: AiProvider;
  credentialStore: CredentialStore;
  artifactStore: ArtifactStore;
  host: HostCapabilities;
}

export interface RuntimeOptions {
  sessionNonce: string;
  allowedOrigins: string[];
  reusableSessionNonce?: boolean;
  logger?: boolean | Record<string, unknown>;
  adminToken?: string;
  trustProxy?: boolean;
}

export interface ZhiYunRuntime {
  app: FastifyInstance;
  listen(options?: { host?: string; port?: number }): Promise<string>;
  close(): Promise<void>;
  issueSessionNonce(nonce: string): void;
  readonly token: string | null;
}

function statusForCode(code: string): number {
  if (code === 'VALIDATION_ERROR') return 400;
  if (code === 'UNAUTHORIZED') return 401;
  if (code === 'FORBIDDEN') return 403;
  if (code === 'NOT_FOUND') return 404;
  if (code === 'CONFLICT' || code === 'IDEMPOTENCY_CONFLICT') return 409;
  if (code === 'PRECONDITION_FAILED') return 412;
  if (code === 'PRECONDITION_REQUIRED') return 428;
  if (code === 'NAVIGATION_ERROR') return 422;
  if (code === 'BROWSER_MISSING') return 503;
  if (code === 'BROWSER_CRASHED') return 502;
  if (code === 'CREDENTIAL_ERROR') return 422;
  if (code === 'NETWORK_POLICY_ERROR') return 403;
  return 500;
}

const sensitiveQueryName = /token|key|secret|password|passwd|auth|cookie|signature|session/i;

function safeUrl(value: string): string {
  try {
    const parsed = new URL(value, 'http://zhiyun.invalid');
    parsed.username = '';
    parsed.password = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (sensitiveQueryName.test(key)) parsed.searchParams.set(key, '[REDACTED]');
    }
    return parsed.origin === 'http://zhiyun.invalid'
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

function safeText(value: string): string {
  return value
    .replaceAll(/https?:\/\/[^\s"'<>]+/gi, (url) => safeUrl(url))
    .replaceAll(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replaceAll(
      /((?:authorization|cookie|proxy-authorization|api[-_ ]?key)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[REDACTED]',
    )
    .replaceAll(/(postgres(?:ql)?:\/\/)[^\s@]+@/gi, '$1[REDACTED]@');
}

function safeMetadata(value: unknown): unknown {
  if (typeof value === 'string') return safeText(value);
  if (Array.isArray(value)) return value.map(safeMetadata);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sensitiveQueryName.test(key) ? '[REDACTED]' : safeMetadata(item),
      ]),
    );
  }
  return value;
}

function problem(
  request: FastifyRequest,
  status: number,
  code: string,
  detail: string,
  errors?: unknown,
): ProblemDetails {
  return {
    type: `https://zhiyun.dev/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    title: code
      .toLowerCase()
      .split('_')
      .map((word) => word[0]?.toUpperCase() + word.slice(1))
      .join(' '),
    status,
    detail: safeText(detail),
    instance: safeUrl(request.url),
    code,
    traceId: request.id,
    ...(errors === undefined ? {} : { errors }),
  };
}

function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  detail: string,
  errors?: unknown,
) {
  return reply
    .code(status)
    .type('application/problem+json')
    .send(problem(request, status, code, detail, errors));
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function fingerprint(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(body ?? null))
    .digest('hex');
}

function secureEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function definitionDiff(
  before: unknown,
  after: unknown,
  path = '',
): Array<{ path: string; before: unknown; after: unknown }> {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) =>
      definitionDiff(left[key], right[key], `${path}/${key}`),
    );
  }
  return [{ path: path || '/', before, after }];
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number.parseInt(Buffer.from(cursor, 'base64url').toString(), 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function cursorPage<T>(items: T[], cursor: string | undefined, limit: number) {
  const offset = decodeCursor(cursor);
  const page = items.slice(offset, offset + limit);
  return {
    items: page,
    nextCursor:
      offset + limit < items.length
        ? Buffer.from(String(offset + limit)).toString('base64url')
        : null,
  };
}

export function openApiDocument() {
  const paths: Record<string, Record<string, Record<string, unknown>>> = {
    '/api/v1/session': { post: { operationId: 'createRuntimeSession' } },
    '/api/v1/version': { get: { operationId: 'getVersion' } },
    '/api/v1/capabilities': { get: { operationId: 'getCapabilities' } },
    '/api/v1/runtime': { get: { operationId: 'getRuntimeMetadata' } },
    '/api/v1/openapi.json': { get: { operationId: 'getOpenApiDocument' } },
    '/api/v1/trend-sources': {
      get: { operationId: 'listTrendSources' },
    },
    '/api/v1/trend-sources/bootstrap': { post: { operationId: 'bootstrapTrendSources' } },
    '/api/v1/trend-sources/run': { post: { operationId: 'runTrendSources' } },
    '/api/v1/trend-sources/{key}': { put: { operationId: 'updateTrendSource' } },
    '/api/v1/trend-sources/{key}/run': { post: { operationId: 'runTrendSource' } },
    '/api/v1/trends': { get: { operationId: 'listTrends' } },
    '/api/v1/preferences/profile': { get: { operationId: 'getPreferenceProfile' } },
    '/api/v1/preferences/signals': {
      get: { operationId: 'listPreferenceSignals' },
      post: { operationId: 'upsertPreferenceSignal' },
      delete: { operationId: 'clearPreferenceSignals' },
    },
    '/api/v1/preferences/signals/{id}': { delete: { operationId: 'deletePreferenceSignal' } },
    '/api/v1/preferences/import': { post: { operationId: 'importPreferenceContent' } },
    '/api/v1/tasks': {
      get: { operationId: 'listTasks' },
      post: { operationId: 'createTask' },
    },
    '/api/v1/tasks/{id}': {
      get: { operationId: 'getTask' },
      put: { operationId: 'updateTask' },
      delete: { operationId: 'deleteTask' },
    },
    '/api/v1/tasks/{id}/analyze': { post: { operationId: 'analyzeTask' } },
    '/api/v1/tasks/{id}/ai/extract': { post: { operationId: 'runAiExtractDemo' } },
    '/api/v1/tasks/{id}/browser-session/login': {
      post: { operationId: 'createTaskLoginSession' },
    },
    '/api/v1/tasks/{id}/credentials/{kind}': {
      post: { operationId: 'promptTaskCredential' },
      delete: { operationId: 'deleteTaskCredential' },
    },
    '/api/v1/tasks/{id}/rules': {
      get: { operationId: 'listRules' },
      post: { operationId: 'createRule' },
    },
    '/api/v1/tasks/{id}/rules/test': { post: { operationId: 'testRule' } },
    '/api/v1/tasks/{id}/rules/{ruleId}/versions': {
      post: { operationId: 'createRuleVersion' },
    },
    '/api/v1/tasks/{id}/rules/{ruleId}/diff': {
      get: { operationId: 'diffRuleVersions' },
    },
    '/api/v1/tasks/{id}/rules/{ruleId}/rollback': {
      post: { operationId: 'rollbackRuleVersion' },
    },
    '/api/v1/tasks/{id}/rules/{ruleId}/repair-proposals': {
      get: { operationId: 'listRuleRepairProposals' },
      post: { operationId: 'createRuleRepairProposal' },
    },
    '/api/v1/tasks/{id}/rules/{ruleId}/repair-proposals/{proposalId}/test': {
      post: { operationId: 'testRuleRepairProposal' },
    },
    '/api/v1/tasks/{id}/rules/{ruleId}/repair-proposals/{proposalId}/apply': {
      post: { operationId: 'applyRuleRepairProposal' },
    },
    '/api/v1/tasks/{id}/rules/{ruleId}/repair-proposals/{proposalId}/reject': {
      post: { operationId: 'rejectRuleRepairProposal' },
    },
    '/api/v1/tasks/{id}/run': { post: { operationId: 'createRun' } },
    '/api/v1/tasks/{id}/runs': { get: { operationId: 'listRuns' } },
    '/api/v1/tasks/{id}/dataset': { get: { operationId: 'listDatasetRecords' } },
    '/api/v1/tasks/{id}/dataset/changes': { get: { operationId: 'listDatasetChanges' } },
    '/api/v1/tasks/{id}/dataset/diff': { get: { operationId: 'diffDatasetRuns' } },
    '/api/v1/tasks/{id}/dataset/exports': { post: { operationId: 'createDatasetExport' } },
    '/api/v1/runs/{id}': { get: { operationId: 'getRun' } },
    '/api/v1/runs/{id}/cancel': { post: { operationId: 'cancelRun' } },
    '/api/v1/runs/{id}/retry': { post: { operationId: 'retryRun' } },
    '/api/v1/runs/{id}/explain-failure': { post: { operationId: 'explainRunFailure' } },
    '/api/v1/runs/{id}/logs': { get: { operationId: 'listRunLogs' } },
    '/api/v1/runs/{id}/requests': { get: { operationId: 'listRunRequests' } },
    '/api/v1/runs/{id}/records': { get: { operationId: 'listRunRecords' } },
    '/api/v1/runs/{id}/exports': { post: { operationId: 'createRunExport' } },
    '/api/v1/artifacts/{id}/save': { post: { operationId: 'saveArtifact' } },
    '/api/v1/artifacts/{id}/content': { get: { operationId: 'getArtifactContent' } },
    '/api/v1/events/domain': { get: { operationId: 'streamDomainEvents' } },
    '/api/v1/events/realtime': { get: { operationId: 'streamRealtimeEvents' } },
    '/api/v1/output-destinations': {
      get: { operationId: 'listOutputDestinations' },
      post: { operationId: 'createOutputDestination' },
    },
    '/api/v1/output-destinations/{id}': {
      put: { operationId: 'updateOutputDestination' },
      delete: { operationId: 'deleteOutputDestination' },
    },
    '/api/v1/output-destinations/{id}/test': {
      post: { operationId: 'testOutputDestination' },
    },
    '/api/v1/output-destinations/{id}/credential/prompt': {
      post: { operationId: 'promptOutputCredential' },
    },
    '/api/v1/delivery-attempts/{id}/retry': {
      post: { operationId: 'retryOutputDelivery' },
    },
    '/api/v1/delivery-attempts': { get: { operationId: 'listDeliveryAttempts' } },
    '/api/v1/api-tokens': {
      get: { operationId: 'listApiTokens' },
      post: { operationId: 'createApiToken' },
    },
    '/api/v1/api-tokens/{id}': { delete: { operationId: 'revokeApiToken' } },
    '/api/v1/data/tasks/{id}/records': { get: { operationId: 'queryDataApiRecords' } },
    '/api/v1/inspection-sessions': { post: { operationId: 'createInspectionSession' } },
    '/api/v1/inspection-sessions/{id}/screenshot': {
      get: { operationId: 'getInspectionScreenshot' },
    },
    '/api/v1/inspection-sessions/{id}/actions': { post: { operationId: 'interactWithInspection' } },
    '/api/v1/inspection-sessions/{id}/select': { post: { operationId: 'selectInspectionElement' } },
    '/api/v1/inspection-sessions/{id}': { delete: { operationId: 'closeInspectionSession' } },
    '/api/v1/desktop/diagnostics': { get: { operationId: 'getDesktopDiagnostics' } },
    '/api/v1/desktop/backup': { post: { operationId: 'backupDesktopDatabase' } },
    '/api/v1/desktop/restore': { post: { operationId: 'restoreDesktopDatabase' } },
    '/api/v1/runtime/summary': { get: { operationId: 'getRuntimeSummary' } },
    '/api/v1/scheduler/pause': { post: { operationId: 'pauseScheduler' } },
    '/api/v1/scheduler/resume': { post: { operationId: 'resumeScheduler' } },
  };
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const jsonResponse = (schema: Record<string, unknown>, description = 'Success') => ({
    description,
    content: { 'application/json': { schema } },
  });
  const problemResponse = jsonResponse(ref('ProblemDetails'), 'Problem Details');
  const responses = (schema: Record<string, unknown>, status = '200') => ({
    [status]: jsonResponse(schema),
    default: problemResponse,
  });
  const body = (schema: Record<string, unknown>) => ({
    required: true,
    content: { 'application/json': { schema } },
  });
  const page = (item: Record<string, unknown>, extras: Record<string, unknown> = {}) => ({
    type: 'object',
    required: ['items', 'nextCursor', ...Object.keys(extras)],
    properties: {
      items: { type: 'array', items: item },
      nextCursor: { type: ['string', 'null'] },
      ...extras,
    },
  });

  for (const [path, pathItem] of Object.entries(paths)) {
    const pathNames = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
    for (const operation of Object.values(pathItem)) {
      operation.security ??= [{ sessionBearer: [] }];
      operation.parameters ??= pathNames.map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: {
          type: 'string',
          format: ['id', 'ruleId', 'proposalId'].includes(name) ? 'uuid' : undefined,
        },
      }));
      operation.responses ??= {
        '200': { description: 'Success' },
        default: problemResponse,
      };
    }
  }

  Object.assign(paths['/api/v1/session']!.post!, {
    security: [],
    requestBody: body({
      type: 'object',
      properties: { nonce: { type: 'string' }, adminToken: { type: 'string' } },
    }),
    responses: responses({
      type: 'object',
      required: ['token', 'runtime', 'capabilities'],
      properties: {
        token: { type: 'string' },
        runtime: ref('RuntimeMetadata'),
        capabilities: ref('RuntimeCapabilities'),
      },
    }),
  });
  for (const publicPath of ['/api/v1/version', '/api/v1/runtime', '/api/v1/openapi.json']) {
    paths[publicPath]!.get!.security = [];
  }
  paths['/api/v1/runtime']!.get!.responses = responses(ref('RuntimeMetadata'));
  paths['/api/v1/capabilities']!.get!.responses = responses(ref('RuntimeCapabilities'));
  paths['/api/v1/trend-sources']!.get!.responses = responses({
    type: 'array',
    items: ref('TrendSource'),
  });
  paths['/api/v1/trend-sources/bootstrap']!.post!.responses = {
    '202': jsonResponse({
      type: 'object',
      required: ['sources', 'runs'],
      properties: {
        sources: { type: 'array', items: ref('TrendSource') },
        runs: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    }),
    default: problemResponse,
  };
  paths['/api/v1/trend-sources/run']!.post!.responses = {
    '202': jsonResponse({
      type: 'object',
      required: ['runs'],
      properties: {
        runs: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    }),
    default: problemResponse,
  };
  Object.assign(paths['/api/v1/trend-sources/{key}']!.put!, {
    requestBody: body(ref('TrendSourceUpdate')),
    responses: responses(ref('TrendSource')),
  });
  paths['/api/v1/trend-sources/{key}/run']!.post!.responses = {
    '200': jsonResponse({ type: 'object', additionalProperties: true }),
    '202': jsonResponse({ type: 'object', additionalProperties: true }),
    default: problemResponse,
  };
  Object.assign(paths['/api/v1/trends']!.get!, {
    parameters: [
      { name: 'platform', in: 'query', schema: { type: 'string' } },
      { name: 'contentType', in: 'query', schema: { type: 'string' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
    ],
    responses: responses(ref('TrendsResponse')),
  });
  paths['/api/v1/preferences/profile']!.get!.responses = responses(ref('PreferenceProfile'));
  Object.assign(paths['/api/v1/preferences/signals']!.get!, {
    parameters: [
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
    ],
    responses: responses(page(ref('PreferenceSignal'))),
  });
  Object.assign(paths['/api/v1/preferences/signals']!.post!, {
    requestBody: body(ref('PreferenceSignalInput')),
    responses: responses(ref('PreferenceSignal')),
  });
  paths['/api/v1/preferences/signals']!.delete!.responses = responses({
    type: 'object',
    required: ['deleted'],
    properties: { deleted: { type: 'integer' } },
  });
  paths['/api/v1/preferences/signals/{id}']!.delete!.responses = {
    '204': { description: 'Deleted' },
    default: problemResponse,
  };
  Object.assign(paths['/api/v1/preferences/import']!.post!, {
    requestBody: body(ref('PreferenceImport')),
    responses: responses(ref('PreferenceSignal'), '201'),
  });
  Object.assign(paths['/api/v1/tasks']!.get!, {
    parameters: [
      { name: 'cursor', in: 'query', schema: { type: 'string' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
    ],
    responses: responses(page(ref('TaskListItem'))),
  });
  Object.assign(paths['/api/v1/tasks']!.post!, {
    requestBody: body(ref('TaskCreate')),
    responses: responses(ref('TaskDetail'), '201'),
  });
  paths['/api/v1/tasks/{id}']!.get!.responses = responses(ref('TaskDetail'));
  Object.assign(paths['/api/v1/tasks/{id}']!.put!, {
    requestBody: body(ref('TaskUpdate')),
    responses: responses(ref('TaskDetail')),
  });
  paths['/api/v1/tasks/{id}']!.delete!.responses = {
    '204': { description: 'Deleted' },
    default: problemResponse,
  };
  Object.assign(paths['/api/v1/tasks/{id}/analyze']!.post!, {
    requestBody: body({
      type: 'object',
      required: ['useAi', 'forceBrowser'],
      properties: { useAi: { type: 'boolean' }, forceBrowser: { type: 'boolean' } },
    }),
    responses: responses(ref('AnalysisResult')),
  });
  paths['/api/v1/tasks/{id}/runs']!.get!.responses = responses(page(ref('CrawlRun')));
  paths['/api/v1/tasks/{id}/dataset']!.get!.responses = responses(
    page(ref('DatasetRecord'), { stats: ref('DatasetStats') }),
  );
  paths['/api/v1/tasks/{id}/dataset/changes']!.get!.responses = responses(
    page(ref('RecordChange')),
  );
  paths['/api/v1/tasks/{id}/run']!.post!.responses = responses(
    {
      type: 'object',
      required: ['runId', 'status'],
      properties: { runId: { type: 'string', format: 'uuid' }, status: { type: 'string' } },
    },
    '202',
  );
  paths['/api/v1/runs/{id}']!.get!.responses = responses(ref('CrawlRun'));
  paths['/api/v1/runs/{id}/records']!.get!.responses = responses(page(ref('ExtractedRecord')));
  paths['/api/v1/runs/{id}/logs']!.get!.responses = responses(page(ref('RunLogEntry')));
  paths['/api/v1/runs/{id}/requests']!.get!.responses = responses(page(ref('RunRequestEntry')));
  paths['/api/v1/tasks/{id}/dataset/diff']!.get!.responses = responses({
    type: 'object',
    required: ['items', 'nextCursor', 'stats'],
    properties: {
      items: { type: 'array', items: ref('DatasetDiffEntry') },
      nextCursor: { type: ['string', 'null'] },
      stats: ref('DatasetDiffStats'),
    },
  });
  paths['/api/v1/output-destinations']!.get!.responses = responses({
    type: 'array',
    items: ref('OutputDestination'),
  });
  paths['/api/v1/delivery-attempts']!.get!.responses = responses({
    type: 'array',
    items: ref('DeliveryAttempt'),
  });
  paths['/api/v1/api-tokens']!.get!.responses = responses({
    type: 'array',
    items: ref('ApiToken'),
  });
  paths['/api/v1/data/tasks/{id}/records']!.get!.security = [{ dataApiBearer: [] }];
  return {
    openapi: '3.1.0',
    info: { title: 'ZhiYun Runtime API', version: '1.0.0' },
    paths,
    components: {
      schemas: {
        TaskCreate: z.toJSONSchema(taskCreateSchema),
        TaskUpdate: z.toJSONSchema(taskUpdateSchema),
        TaskDetail: z.toJSONSchema(taskDetailSchema),
        TaskListItem: z.toJSONSchema(taskListItemSchema),
        CrawlPlanDefinition: z.toJSONSchema(crawlPlanDefinitionSchema),
        CrawlRun: z.toJSONSchema(crawlRunSchema),
        AnalysisResult: z.toJSONSchema(analysisResultSchema),
        RuleVersion: z.toJSONSchema(ruleVersionSchema),
        DatasetRecord: z.toJSONSchema(datasetRecordSchema),
        DatasetStats: z.toJSONSchema(datasetStatsSchema),
        DatasetDiffEntry: z.toJSONSchema(datasetDiffEntrySchema),
        DatasetDiffStats: z.toJSONSchema(datasetDiffStatsSchema),
        RecordChange: z.toJSONSchema(recordChangeSchema),
        ExtractedRecord: z.toJSONSchema(extractedRecordSchema),
        RunLogEntry: z.toJSONSchema(runLogEntrySchema),
        RunRequestEntry: z.toJSONSchema(runRequestEntrySchema),
        OutputDestination: z.toJSONSchema(outputDestinationSchema),
        DeliveryAttempt: z.toJSONSchema(deliveryAttemptSchema),
        ApiToken: z.toJSONSchema(apiTokenSchema),
        RuleRepairProposal: z.toJSONSchema(ruleRepairProposalSchema),
        PreferenceSignalInput: z.toJSONSchema(preferenceSignalInputSchema),
        PreferenceSignal: z.toJSONSchema(preferenceSignalSchema),
        PreferenceProfile: z.toJSONSchema(preferenceProfileSchema),
        PreferenceImport: z.toJSONSchema(preferenceImportSchema),
        TrendSource: z.toJSONSchema(trendSourceSchema),
        TrendSourceUpdate: z.toJSONSchema(trendSourceUpdateSchema),
        TrendItem: z.toJSONSchema(trendItemSchema),
        TrendTerm: z.toJSONSchema(trendTermSchema),
        TrendsResponse: z.toJSONSchema(trendsResponseSchema),
        ArtifactDescriptor: z.toJSONSchema(artifactDescriptorSchema),
        DomainEvent: z.toJSONSchema(domainEventSchema),
        RuntimeMetadata: z.toJSONSchema(runtimeMetadataSchema),
        RuntimeCapabilities: z.toJSONSchema(runtimeCapabilitiesSchema),
        ProblemDetails: z.toJSONSchema(problemDetailsSchema),
      },
      securitySchemes: {
        sessionBearer: { type: 'http', scheme: 'bearer' },
        dataApiBearer: { type: 'http', scheme: 'bearer' },
      },
    },
  };
}

export async function buildRuntime(
  dependencies: RuntimeDependencies,
  options: RuntimeOptions,
): Promise<ZhiYunRuntime> {
  const app = Fastify({
    logger: options.logger ?? false,
    genReqId: () => crypto.randomUUID(),
    trustProxy: options.trustProxy ?? false,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const exporter = new DefaultDataExporter();
  const inspections = new InspectionManager();
  const realtime = new EventEmitter();
  const sessionToken = randomBytes(32).toString('base64url');
  const validSessionNonces = new Set([options.sessionNonce]);
  const activeRuns = new Map<string, AbortController>();
  const activeDeliveries = new Map<string, AbortController>();
  const dataTokenWindows = new Map<string, { minute: number; count: number }>();
  let issuedToken: string | null = null;
  let issuedTokenExpiresAt = 0;
  let schedulingPaused = false;
  let trendBootstrapPromise: Promise<
    Array<{ key: string; status: 'failed'; error: string }>
  > | null = null;

  async function* runRecordData(runId: string): AsyncGenerator<Record<string, unknown>> {
    let cursor: string | undefined;
    do {
      const page = await dependencies.repository.listRecords(runId, cursor, 500);
      for (const record of page.items) yield record.data;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  async function* datasetRecordData(
    taskId: string,
    options: {
      includeRemoved: boolean;
      query?: string;
      filter?: Record<string, string | number | boolean | null>;
    },
  ): AsyncGenerator<Record<string, unknown>> {
    let cursor: string | undefined;
    do {
      const page = await dependencies.repository.listDatasetRecords(taskId, cursor, 500, options);
      for (const record of page.items) yield record.data;
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  const exportBodySchema = z.object({
    format: exportFormatSchema,
    fields: z.array(z.string().min(1)).max(500).optional(),
    bom: z.boolean().optional(),
    jsonMode: z.enum(['array', 'jsonl']).optional(),
  });

  async function createExportArtifact(input: {
    runId: string;
    filename: string;
    body: z.infer<typeof exportBodySchema>;
    records: AsyncIterable<Record<string, unknown>>;
    signal: AbortSignal;
  }) {
    const exported = await exporter.exportStream(input.records, {
      format: input.body.format as ExportFormat,
      filename: input.filename,
      ...(input.body.fields ? { fields: input.body.fields } : {}),
      ...(input.body.bom === undefined ? {} : { bom: input.body.bom }),
      ...(input.body.jsonMode ? { jsonMode: input.body.jsonMode } : {}),
      signal: input.signal,
    });
    const stored = await dependencies.artifactStore.writeStream(
      exported.filename,
      exported.data,
      input.signal,
    );
    const descriptor = await dependencies.repository.putArtifact({
      runId: input.runId,
      format: input.body.format,
      filename: exported.filename,
      contentType: exported.contentType,
      size: stored.size,
      storageKey: stored.storageKey,
    });
    return { artifactRef: descriptor.id, artifact: descriptor };
  }

  const isAllowedOrigin = (origin: string | undefined) =>
    origin === undefined || options.allowedOrigins.includes(origin);
  await app.register(cors, {
    origin(origin, callback) {
      callback(null, isAllowedOrigin(origin));
    },
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'idempotency-key',
      'if-match',
      'last-event-id',
    ],
    exposedHeaders: ['etag', 'x-trace-id', 'x-runtime-generation'],
  });

  app.addHook('onRequest', async (request, reply) => {
    app.log.info({ method: request.method, url: safeUrl(request.url) }, 'incoming request');
    reply.header('x-trace-id', request.id);
    reply.header('x-runtime-generation', String(dependencies.host.metadata.generation));
    const origin = headerValue(request.headers.origin);
    if (!isAllowedOrigin(origin)) {
      return sendProblem(request, reply, 403, 'FORBIDDEN', 'Origin is not allowed by this Runtime');
    }
    const publicPaths = new Set([
      '/health',
      '/api/v1/session',
      '/api/v1/version',
      '/api/v1/runtime',
      '/api/v1/openapi.json',
    ]);
    const path = request.url.split('?')[0]!;
    if (!path.startsWith('/api/v1') || publicPaths.has(path) || request.method === 'OPTIONS')
      return;
    const authorization = headerValue(request.headers.authorization);
    if (path.startsWith('/api/v1/data/')) {
      const raw = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
      const tokenHash = fingerprint(raw);
      const token = raw ? await dependencies.repository.findApiToken(tokenHash) : null;
      if (
        !token ||
        token.revokedAt ||
        (token.expiresAt && Date.parse(token.expiresAt) <= Date.now())
      ) {
        return sendProblem(
          request,
          reply,
          401,
          'UNAUTHORIZED',
          'A valid Data API token is required',
        );
      }
      const minute = Math.floor(Date.now() / 60_000);
      const window = dataTokenWindows.get(token.id);
      const next =
        window?.minute === minute ? { minute, count: window.count + 1 } : { minute, count: 1 };
      dataTokenWindows.set(token.id, next);
      if (next.count > token.rateLimitPerMinute)
        return sendProblem(request, reply, 429, 'FORBIDDEN', 'Data API rate limit exceeded');
      (request as FastifyRequest & { dataToken?: typeof token }).dataToken = token;
      return;
    }
    if (
      !issuedToken ||
      issuedTokenExpiresAt <= Date.now() ||
      authorization !== `Bearer ${issuedToken}`
    ) {
      return sendProblem(
        request,
        reply,
        401,
        'UNAUTHORIZED',
        'A valid Runtime session token is required',
      );
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    app.log.info(
      { method: request.method, url: safeUrl(request.url), statusCode: reply.statusCode },
      'request completed',
    );
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return sendProblem(
        request,
        reply,
        400,
        'VALIDATION_ERROR',
        'Invalid request',
        error.flatten(),
      );
    }
    if (error instanceof ZhiYunError) {
      return sendProblem(
        request,
        reply,
        statusForCode(error.code),
        error.code,
        error.message,
        error.details,
      );
    }
    const sqliteCode = (error as { code?: string }).code;
    if (sqliteCode?.startsWith('SQLITE_CONSTRAINT')) {
      return sendProblem(
        request,
        reply,
        409,
        'CONFLICT',
        'The requested operation conflicts with current Runtime state',
      );
    }
    app.log.error({ err: error }, 'unhandled Runtime request error');
    return sendProblem(
      request,
      reply,
      500,
      'INTERNAL_ERROR',
      error instanceof Error ? error.message : 'Unknown internal error',
    );
  });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(request, reply, 404, 'NOT_FOUND', 'Route not found'),
  );

  async function requireIdempotency<T>(
    request: FastifyRequest,
    reply: FastifyReply,
    scope: string,
    body: unknown,
    action: () => Promise<T>,
  ): Promise<T | undefined> {
    const key = headerValue(request.headers['idempotency-key']);
    if (!key) {
      sendProblem(
        request,
        reply,
        428,
        'PRECONDITION_REQUIRED',
        'Idempotency-Key header is required',
      );
      return undefined;
    }
    const digest = fingerprint(body);
    const existing = await dependencies.repository.getIdempotency(scope, key);
    if (existing) {
      if (existing.fingerprint !== digest) {
        sendProblem(
          request,
          reply,
          409,
          'IDEMPOTENCY_CONFLICT',
          'Idempotency-Key was already used with a different request',
        );
        return undefined;
      }
      return existing.response as T;
    }
    const response = await action();
    await dependencies.repository.putIdempotency(scope, key, digest, response);
    return response;
  }

  function emitRealtime(
    type: RealtimeEvent['type'],
    runId: string | undefined,
    payload: Record<string, unknown>,
  ) {
    const event: RealtimeEvent = {
      id: crypto.randomUUID(),
      type,
      ...(runId ? { runId } : {}),
      payload,
      createdAt: new Date().toISOString(),
    };
    realtime.emit('event', event);
  }

  async function resolveTaskSettings(
    task: NonNullable<Awaited<ReturnType<Repository['getTask']>>>,
  ) {
    const headers = { ...task.requestSettings.headers };
    let cookies = task.requestSettings.cookies;
    let proxy = task.requestSettings.proxy;
    let browserSettings: BrowserSettings = task.browserSettings;
    const bindings = task.credentialBindings;
    if (bindings.secretHeadersRef) {
      Object.assign(
        headers,
        await dependencies.credentialStore.resolve<Record<string, string>>(
          bindings.secretHeadersRef,
        ),
      );
    }
    if (bindings.cookiesRef) {
      cookies = await dependencies.credentialStore.resolve(bindings.cookiesRef);
    }
    if (bindings.proxyRef) proxy = await dependencies.credentialStore.resolve(bindings.proxyRef);
    if (bindings.browserStorageStateRef) {
      browserSettings = {
        ...browserSettings,
        storageState: await dependencies.credentialStore.resolve(bindings.browserStorageStateRef),
      };
    }
    return {
      requestSettings: { ...task.requestSettings, headers, cookies, ...(proxy ? { proxy } : {}) },
      browserSettings,
    };
  }

  async function protectTaskCredentials<T extends TaskCreate | TaskUpdate>(
    input: T,
    currentBindings: TaskCredentialBindings = {},
  ): Promise<T> {
    const bindings: TaskCredentialBindings = {
      ...currentBindings,
      ...input.credentialBindings,
    };
    const protectedInput: TaskCreate | TaskUpdate = { ...input };

    if (dependencies.host.metadata.mode === 'desktop') {
      const containsSensitiveHeader = Object.keys(input.requestSettings?.headers ?? {}).some(
        (name) => ['authorization', 'cookie', 'proxy-authorization'].includes(name.toLowerCase()),
      );
      if (
        containsSensitiveHeader ||
        (input.requestSettings?.cookies.length ?? 0) > 0 ||
        Boolean(input.requestSettings?.proxy) ||
        Boolean(input.browserSettings?.storageState)
      ) {
        throw new ZhiYunError(
          'CREDENTIAL_ERROR',
          'Desktop credentials must be entered in a Host-owned secure window',
        );
      }
    }

    if (input.requestSettings) {
      const secretHeaders: Record<string, string> = {};
      const publicHeaders = Object.fromEntries(
        Object.entries(input.requestSettings.headers).filter(([name, value]) => {
          const secret = ['authorization', 'cookie', 'proxy-authorization'].includes(
            name.toLowerCase(),
          );
          if (secret) secretHeaders[name] = value;
          return !secret;
        }),
      );
      if (Object.keys(secretHeaders).length > 0) {
        bindings.secretHeadersRef = await dependencies.credentialStore.put(
          'task-secret-headers',
          secretHeaders,
        );
      }
      if (input.requestSettings.cookies.length > 0) {
        bindings.cookiesRef = await dependencies.credentialStore.put(
          'task-cookies',
          input.requestSettings.cookies,
        );
      }
      if (input.requestSettings.proxy) {
        bindings.proxyRef = await dependencies.credentialStore.put(
          'task-proxy',
          input.requestSettings.proxy,
        );
      }
      const requestSettings = { ...input.requestSettings };
      delete requestSettings.proxy;
      protectedInput.requestSettings = {
        ...requestSettings,
        headers: publicHeaders,
        cookies: [],
      };
    }

    if (input.browserSettings?.storageState) {
      bindings.browserStorageStateRef = await dependencies.credentialStore.put(
        'browser-storage-state',
        input.browserSettings.storageState,
      );
      const browserSettings = { ...input.browserSettings };
      delete browserSettings.storageState;
      protectedInput.browserSettings = browserSettings;
    }

    protectedInput.credentialBindings = bindings;
    return protectedInput as T;
  }

  async function deleteCredentialRefs(
    bindings: TaskCredentialBindings,
    except: TaskCredentialBindings = {},
  ) {
    const retained = new Set(Object.values(except).filter(Boolean));
    await Promise.all(
      Object.values(bindings)
        .filter((reference): reference is string => Boolean(reference) && !retained.has(reference))
        .map((reference) => dependencies.credentialStore.delete(reference).catch(() => undefined)),
    );
  }

  function outputError(error: unknown, credential: unknown): string {
    let message = error instanceof Error ? error.message : 'Output delivery failed';
    const values =
      credential && typeof credential === 'object'
        ? Object.values(credential as Record<string, unknown>).filter(
            (value): value is string => typeof value === 'string' && value.length >= 4,
          )
        : [];
    for (const value of values) message = message.replaceAll(value, '[REDACTED]');
    return message.replaceAll(/(postgres(?:ql)?:\/\/)[^\s@]+@/gi, '$1[REDACTED]@').slice(0, 2_000);
  }

  async function waitForDelivery(milliseconds: number, signal: AbortSignal) {
    if (milliseconds <= 0) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, milliseconds);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(new ZhiYunError('CANCELED', 'Output delivery paused during shutdown'));
        },
        { once: true },
      );
    });
  }

  async function* outputRecords(
    runId: string,
  ): AsyncGenerator<{ sourceUrl: string; data: Record<string, unknown> }> {
    let cursor: string | undefined;
    do {
      const page = await dependencies.repository.listRecords(runId, cursor, 500);
      for (const record of page.items) {
        yield { sourceUrl: record.sourceUrl, data: record.data };
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  }

  async function refreshDeliveryStatus(runId: string) {
    const attempts = await dependencies.repository.listDeliveryAttempts(runId);
    const latest = new Map<string, (typeof attempts)[number]>();
    for (const attempt of attempts) {
      if (!latest.has(attempt.destinationId)) latest.set(attempt.destinationId, attempt);
    }
    const statuses = [...latest.values()].map((attempt) => attempt.status);
    await dependencies.repository.setRunDeliveryStatus(
      runId,
      statuses.length === 0
        ? 'idle'
        : statuses.some((status) => status === 'pending' || status === 'running')
          ? 'pending'
          : statuses.every((status) => status === 'succeeded')
            ? 'succeeded'
            : 'failed',
    );
  }

  async function runDelivery(
    attempt: Awaited<ReturnType<Repository['createDeliveryAttempt']>>,
    recordSource?: () =>
      | AsyncIterable<{ sourceUrl: string; data: Record<string, unknown> }>
      | Iterable<{ sourceUrl: string; data: Record<string, unknown> }>,
  ) {
    if (activeDeliveries.has(attempt.id)) return;
    const controller = new AbortController();
    activeDeliveries.set(attempt.id, controller);
    try {
      const [task, destination, run] = await Promise.all([
        dependencies.repository.getTask(attempt.taskId),
        dependencies.repository.getOutputDestination(attempt.destinationId),
        dependencies.repository.getRun(attempt.runId),
      ]);
      if (!task || !destination?.enabled || run?.status !== 'succeeded') {
        await dependencies.repository.updateDeliveryAttempt(attempt.id, {
          status: 'failed',
          error: 'Task, destination, or successful Run is unavailable',
          nextAttemptAt: null,
        });
        return;
      }
      const credential = destination.credentialRef
        ? await dependencies.credentialStore.resolve(destination.credentialRef)
        : null;
      if (destination.type === 'webhook') {
        await assertNetworkAllowed(
          String(destination.config.url ?? ''),
          process.env.NODE_ENV === 'production'
            ? task.networkPolicy
            : { ...task.networkPolicy, allowPrivateNetworks: true },
        );
      }
      const retryDelays = [0, 1_000, 5_000, 30_000, 120_000];
      let nextAttempt = attempt.nextAttemptAt ? attempt.attempt + 1 : attempt.attempt;
      if (attempt.nextAttemptAt) {
        await waitForDelivery(
          Math.max(0, Date.parse(attempt.nextAttemptAt) - Date.now()),
          controller.signal,
        );
      }
      while (nextAttempt <= retryDelays.length) {
        await dependencies.repository.updateDeliveryAttempt(attempt.id, {
          status: 'running',
          attempt: nextAttempt,
          nextAttemptAt: null,
        });
        try {
          const result = await outputAdapter(destination).deliver({
            destination,
            taskId: task.id,
            runId: attempt.runId,
            datasetSettings: task.datasetSettings,
            datasetStats: run.datasetStats,
            records: recordSource ? recordSource() : outputRecords(attempt.runId),
            credential,
            signal: controller.signal,
          });
          await dependencies.repository.updateDeliveryAttempt(attempt.id, {
            status: 'succeeded',
            attempt: nextAttempt,
            responseStatus: result.responseStatus,
            error: null,
            nextAttemptAt: null,
          });
          return;
        } catch (error) {
          if (controller.signal.aborted) {
            await dependencies.repository.updateDeliveryAttempt(attempt.id, {
              status: 'pending',
              attempt: nextAttempt,
              error: null,
              nextAttemptAt: new Date().toISOString(),
            });
            return;
          }
          const delay = retryDelays[nextAttempt];
          await dependencies.repository.updateDeliveryAttempt(attempt.id, {
            status: delay === undefined ? 'failed' : 'pending',
            attempt: nextAttempt,
            error: outputError(error, credential),
            nextAttemptAt: delay === undefined ? null : new Date(Date.now() + delay).toISOString(),
          });
          if (delay === undefined) return;
          await waitForDelivery(delay, controller.signal);
          nextAttempt += 1;
        }
      }
    } finally {
      activeDeliveries.delete(attempt.id);
      await refreshDeliveryStatus(attempt.runId);
    }
  }

  async function deliverOutputs(
    task: NonNullable<Awaited<ReturnType<Repository['getTask']>>>,
    runId: string,
    records: Array<{ sourceUrl: string; data: Record<string, unknown> }>,
  ) {
    const destinations = (
      await Promise.all(
        task.outputBindings.map((id) => dependencies.repository.getOutputDestination(id)),
      )
    ).filter((item) => item?.enabled);
    if (destinations.length === 0) {
      await dependencies.repository.setRunDeliveryStatus(runId, 'idle');
      return;
    }
    await dependencies.repository.setRunDeliveryStatus(runId, 'pending');
    await Promise.all(
      destinations.map(async (destination) => {
        if (!destination) return;
        const attempt = await dependencies.repository.createDeliveryAttempt({
          destinationId: destination.id,
          taskId: task.id,
          runId,
        });
        await runDelivery(attempt, task.outputSettings.persistRecords ? undefined : () => records);
      }),
    );
  }

  async function applyTaskRetention(
    task: NonNullable<Awaited<ReturnType<Repository['getTask']>>>,
    runId: string,
  ) {
    if (Object.values(task.retentionPolicy).every((value) => value === null)) return;
    try {
      const result = await dependencies.repository.applyRetention(task.id, task.retentionPolicy);
      await Promise.all(
        result.artifactStorageKeys.map((key) =>
          dependencies.artifactStore.delete(key).catch(() => undefined),
        ),
      );
      await dependencies.repository.appendRunLog({
        runId,
        level: result.retainedReferencedRuns > 0 ? 'warn' : 'info',
        phase: 'retention',
        message:
          result.retainedReferencedRuns > 0
            ? `${result.retainedReferencedRuns} Run(s) were retained because the current Dataset references them`
            : 'Retention policy applied',
        url: null,
        errorCode: null,
        metadata: result,
      });
    } catch (error) {
      await dependencies.repository.appendRunLog({
        runId,
        level: 'warn',
        phase: 'retention',
        message: `Retention cleanup failed: ${safeText(error instanceof Error ? error.message : String(error))}`,
        url: null,
        errorCode: 'STORAGE_ERROR',
        metadata: {},
      });
    }
  }

  async function processJob(job: RuntimeJob): Promise<void> {
    let runId = job.runId;
    let controller: AbortController | undefined;
    try {
      if (job.scheduled) await dependencies.repository.markScheduleTriggered(job.taskId);
      if (!runId) {
        const active = await dependencies.repository.getActiveRule(job.taskId);
        if (!active) return;
        runId = (await dependencies.repository.createRun(job.taskId)).id;
      }
      const started = await dependencies.repository.startRun(runId, job.taskId);
      if (!started) return;
      controller = new AbortController();
      activeRuns.set(runId, controller);
      await dependencies.repository.appendRunLog({
        runId,
        level: 'info',
        phase: 'starting',
        message: 'Run started',
        url: null,
        errorCode: null,
        metadata: {},
      });
      emitRealtime('run.progress', runId, { phase: 'started', progress: 0 });
      const task = await dependencies.repository.getTask(job.taskId);
      const active = await dependencies.repository.getActiveRule(job.taskId);
      if (!task || !active) throw new Error('Task has no active extraction rule');
      const settings = await resolveTaskSettings(task);
      const definition = active.version.definition;
      const result = await dependencies.crawler.crawl({
        url: task.startUrl,
        plan: {
          ...definition,
          pagination:
            definition.pagination.type === 'none' ? task.pagination : definition.pagination,
        },
        requestSettings: settings.requestSettings,
        browserSettings: settings.browserSettings,
        pagination: task.pagination,
        networkPolicy:
          process.env.NODE_ENV === 'production'
            ? task.networkPolicy
            : { ...task.networkPolicy, allowPrivateNetworks: true },
        signal: controller.signal,
        onProgress: async (event) => {
          const safeEvent = { ...event, ...(event.url ? { url: safeUrl(event.url) } : {}) };
          emitRealtime('run.progress', runId!, safeEvent);
          await dependencies.repository.appendRunLog({
            runId: runId!,
            level: 'info',
            phase: event.phase,
            message: `Run progress ${Math.round(event.progress * 100)}%`,
            url: event.url ? safeUrl(event.url) : null,
            errorCode: null,
            metadata: {
              progress: event.progress,
              requestCount: event.requestCount,
              recordCount: event.recordCount,
            },
          });
        },
        onRequest: async (event) => {
          await dependencies.repository.appendRunRequest({
            runId: runId!,
            ...event,
            url: safeUrl(event.url),
            error: event.error ? safeText(event.error) : null,
          });
        },
      });
      const current = await dependencies.repository.getRun(runId);
      if (current?.status === 'canceled' || controller.signal.aborted) return;
      const datasetStats = await dependencies.repository.commitRunSuccess(
        runId,
        job.taskId,
        task.datasetSettings,
        result.records,
        {
          requestCount: result.metadata.requestCount,
          recordCount: result.metadata.recordCount,
          browserUsed: result.metadata.browserUsed,
          aiUsed: result.metadata.aiUsed,
          metadata: safeMetadata(result.metadata) as Record<string, unknown>,
          records: task.outputSettings.persistRecords ? result.records : [],
        },
      );
      await applyTaskRetention(task, runId);
      void deliverOutputs(task, runId, result.records).catch((error) => {
        app.log.error({ runId, err: error }, 'output delivery failed');
        void dependencies.repository.setRunDeliveryStatus(runId!, 'failed');
      });
      emitRealtime('run.progress', runId, { phase: 'completed', progress: 1 });
      await dependencies.repository.appendRunLog({
        runId,
        level: 'info',
        phase: 'completed',
        message: `Run completed with ${result.metadata.recordCount} records`,
        url: null,
        errorCode: null,
        metadata: { datasetStats },
      });
      await dependencies.host.notify?.(
        'ZhiYun',
        `${task.name}: ${result.metadata.recordCount} records`,
      );
    } catch (error) {
      if (runId) {
        const code = error instanceof ZhiYunError ? error.code : 'CRAWLER_ERROR';
        if (code === 'CANCELED') {
          await dependencies.repository.cancelRun(runId);
          emitRealtime('run.progress', runId, { phase: 'canceled', progress: 1 });
        } else {
          await dependencies.repository.failRun(
            runId,
            job.taskId,
            error instanceof Error ? safeText(error.message) : 'Unknown crawl error',
            code,
          );
          emitRealtime('run.progress', runId, { phase: 'failed', progress: 1 });
        }
        await dependencies.repository.appendRunLog({
          runId,
          level: code === 'CANCELED' ? 'warn' : 'error',
          phase: code === 'CANCELED' ? 'canceled' : 'failed',
          message: error instanceof Error ? safeText(error.message) : 'Unknown crawl error',
          url: null,
          errorCode: code,
          metadata: {},
        });
      }
    } finally {
      if (runId) activeRuns.delete(runId);
    }
  }

  async function trendSourceViews() {
    const bindings = new Map(
      (await dependencies.repository.listTrendSourceBindings()).map((binding) => [
        binding.key,
        binding,
      ]),
    );
    return Promise.all(
      TREND_SOURCE_CATALOG.map(async (entry) => {
        const binding = bindings.get(entry.key);
        if (!entry.supported) {
          return trendSourceSchema.parse({
            key: entry.key,
            platform: entry.platform,
            name: entry.name,
            description: entry.description,
            supported: false,
            enabled: false,
            autoRefresh: false,
            scheduleLabel: entry.scheduleLabel,
            taskId: null,
            status: 'planned',
            lastRunId: null,
            lastSucceededAt: null,
            lastError: null,
          });
        }
        const task = binding?.taskId ? await dependencies.repository.getTask(binding.taskId) : null;
        const runs = task ? await dependencies.repository.listRuns(task.id) : [];
        const latest = runs[0] ?? null;
        const latestSucceeded = runs.find((run) => run.status === 'succeeded') ?? null;
        const status = latest?.status === 'canceled' ? 'idle' : (latest?.status ?? 'idle');
        return trendSourceSchema.parse({
          key: entry.key,
          platform: entry.platform,
          name: entry.name,
          description: entry.description,
          supported: true,
          enabled: binding?.enabled ?? true,
          autoRefresh: binding?.autoRefresh ?? true,
          scheduleLabel: entry.scheduleLabel,
          taskId: task?.id ?? null,
          status: task ? status : 'not-installed',
          lastRunId: latest?.id ?? null,
          lastSucceededAt: latestSucceeded?.finishedAt ?? null,
          lastError: latest?.status === 'failed' ? latest.error : null,
        });
      }),
    );
  }

  async function updateSourceTaskSchedule(
    taskId: string,
    enabled: boolean,
    autoRefresh: boolean,
    cron: string | null,
  ) {
    const task = await dependencies.repository.getTask(taskId);
    if (!task) return null;
    const schedule =
      enabled && autoRefresh && cron
        ? {
            mode: 'cron' as const,
            cron,
            timezone: 'Asia/Shanghai',
            misfirePolicy: 'skip' as const,
          }
        : {
            mode: 'manual' as const,
            timezone: 'Asia/Shanghai',
            misfirePolicy: 'skip' as const,
          };
    const scheduleUnchanged =
      task.schedule.mode === schedule.mode &&
      task.schedule.timezone === schedule.timezone &&
      task.schedule.misfirePolicy === schedule.misfirePolicy &&
      task.schedule.cron === schedule.cron;
    const updated = scheduleUnchanged
      ? task
      : await dependencies.repository.updateTask(task.id, { schedule }, task.revision);
    if (!updated) throw new ZhiYunError('CONFLICT', 'Trend source task was modified');
    if (!schedulingPaused && schedule.mode === 'cron' && schedule.cron) {
      await dependencies.scheduler.schedule(task.id, schedule.cron, schedule.timezone);
    } else {
      await dependencies.scheduler.unschedule(task.id);
    }
    return updated;
  }

  async function repairTrendSources() {
    const existingBindings = await dependencies.repository.listTrendSourceBindings();
    const boundTaskIds = new Set(
      existingBindings.flatMap((binding) => (binding.taskId ? [binding.taskId] : [])),
    );
    const tasks = await dependencies.repository.listTasks();
    const errors: Array<{ key: string; status: 'failed'; error: string }> = [];
    for (const entry of TREND_SOURCE_CATALOG.filter((candidate) => candidate.supported)) {
      if (!entry.task || !entry.plan) continue;
      try {
        const existingBinding = existingBindings.find((binding) => binding.key === entry.key);
        let task = existingBinding?.taskId
          ? await dependencies.repository.getTask(existingBinding.taskId)
          : null;
        if (!task) {
          const reusable = tasks.find(
            (candidate) =>
              !boundTaskIds.has(candidate.id) &&
              candidate.startUrl === entry.task!.startUrl &&
              (candidate.name === entry.task!.name ||
                (entry.platform === 'hongguo' && /红果|Hongguo/i.test(candidate.name))),
          );
          task = reusable ? await dependencies.repository.getTask(reusable.id) : null;
        }
        if (!task) {
          const created = await dependencies.repository.createTask(entry.task);
          task = await dependencies.repository.getTask(created.id);
        }
        if (!task) throw new Error('Trend source task could not be loaded');
        if (!task.activeRule) {
          await dependencies.repository.createRule(
            task.id,
            `${entry.name}规则`,
            entry.plan,
            'system',
          );
          task = await dependencies.repository.getTask(task.id);
        }
        if (!task) throw new Error('Trend source task could not be loaded');
        const binding = await dependencies.repository.upsertTrendSourceBinding({
          key: entry.key,
          platform: entry.platform,
          taskId: task.id,
          enabled: existingBinding?.enabled ?? true,
          autoRefresh: existingBinding?.autoRefresh ?? true,
        });
        boundTaskIds.add(task.id);
        await updateSourceTaskSchedule(task.id, binding.enabled, binding.autoRefresh, entry.cron);
      } catch (error) {
        errors.push({
          key: entry.key,
          status: 'failed',
          error: safeText(error instanceof Error ? error.message : String(error)),
        });
      }
    }
    return errors;
  }

  async function ensureTrendSources() {
    if (!trendBootstrapPromise) {
      trendBootstrapPromise = repairTrendSources().finally(() => {
        trendBootstrapPromise = null;
      });
    }
    return trendBootstrapPromise;
  }

  async function enqueueTrendSource(key: string, includeDisabled = false) {
    const entry = sourceCatalogEntry(key);
    if (!entry?.supported) {
      return { key, status: 'skipped' as const, reason: 'unsupported' };
    }
    const binding = await dependencies.repository.getTrendSourceBinding(key);
    if (!binding?.taskId) return { key, status: 'skipped' as const, reason: 'not-installed' };
    if (!includeDisabled && !binding.enabled) {
      return { key, status: 'skipped' as const, reason: 'disabled' };
    }
    const active = (await dependencies.repository.listRuns(binding.taskId)).find((run) =>
      ['queued', 'running'].includes(run.status),
    );
    if (active) {
      return {
        key,
        taskId: binding.taskId,
        runId: active.id,
        status: 'already-running' as const,
      };
    }
    if (!(await dependencies.repository.getActiveRule(binding.taskId))) {
      return { key, taskId: binding.taskId, status: 'skipped' as const, reason: 'no-active-rule' };
    }
    let run: Awaited<ReturnType<Repository['createRun']>>;
    try {
      run = await dependencies.repository.createRun(binding.taskId);
    } catch (error) {
      const concurrent = (await dependencies.repository.listRuns(binding.taskId)).find((item) =>
        ['queued', 'running'].includes(item.status),
      );
      if (concurrent) {
        return {
          key,
          taskId: binding.taskId,
          runId: concurrent.id,
          status: 'already-running' as const,
        };
      }
      throw error;
    }
    await dependencies.queue.enqueue(binding.taskId, run.id);
    return { key, taskId: binding.taskId, runId: run.id, status: 'queued' as const };
  }

  async function preferenceProfile() {
    const signals = (await dependencies.repository.listPreferenceSignals(undefined, 10_000)).items;
    return buildPreferenceProfile(signals);
  }

  async function currentTrendItems() {
    const bindings = await dependencies.repository.listTrendSourceBindings();
    const groups = await Promise.all(
      bindings
        .filter((binding) => binding.enabled && binding.taskId)
        .map(async (binding) => {
          const page = await dependencies.repository.listDatasetRecords(
            binding.taskId!,
            undefined,
            500,
            { includeRemoved: false },
          );
          return normalizeTrendRecords(binding.key, page.items);
        }),
    );
    const sourceOrder = new Map(TREND_SOURCE_CATALOG.map((source, index) => [source.key, index]));
    return groups
      .flat()
      .sort(
        (left, right) =>
          (sourceOrder.get(left.sourceKey) ?? 99) - (sourceOrder.get(right.sourceKey) ?? 99) ||
          (left.rank ?? 999) - (right.rank ?? 999) ||
          right.score - left.score,
      );
  }

  app.get('/health', async () => {
    await dependencies.repository.health();
    return { status: 'ok', services: { database: 'ok', queue: 'ok' } };
  });

  app.post('/api/v1/session', async (request, reply) => {
    const body = z
      .object({ nonce: z.string().min(1).optional(), adminToken: z.string().min(1).optional() })
      .parse(request.body);
    const validAdmin = secureEqual(body.adminToken, options.adminToken);
    const validNonce =
      !options.adminToken && body.nonce
        ? options.reusableSessionNonce
          ? body.nonce === options.sessionNonce
          : validSessionNonces.has(body.nonce)
        : false;
    if (!validAdmin && !validNonce) {
      return sendProblem(
        request,
        reply,
        401,
        'UNAUTHORIZED',
        'Runtime session nonce is invalid or expired',
      );
    }
    if (!options.reusableSessionNonce && body.nonce) validSessionNonces.delete(body.nonce);
    issuedToken = sessionToken;
    issuedTokenExpiresAt = Date.now() + 12 * 60 * 60_000;
    return {
      token: sessionToken,
      runtime: dependencies.host.metadata,
      capabilities: dependencies.host.capabilities,
    };
  });

  app.get('/api/v1/version', async () => ({
    apiVersion: 'v1',
    version: dependencies.host.metadata.version,
  }));
  app.get('/api/v1/runtime', async () => dependencies.host.metadata);
  app.get('/api/v1/capabilities', async () => dependencies.host.capabilities);
  app.get('/api/v1/openapi.json', async () => openApiDocument());

  app.get('/api/v1/runtime/summary', async () => {
    const tasks = await dependencies.repository.listTasks();
    return {
      running: tasks.filter((task) => task.status === 'running').length,
      failed: tasks.filter((task) => task.status === 'failed').length,
      tasks: tasks.length,
      schedulingPaused,
    };
  });

  app.post('/api/v1/scheduler/pause', async () => {
    for (const task of await dependencies.repository.listScheduledTasks()) {
      await dependencies.scheduler.unschedule(task.id);
    }
    await dependencies.repository.setSchedulingPaused(true);
    schedulingPaused = true;
    return { schedulingPaused };
  });

  app.post('/api/v1/scheduler/resume', async () => {
    for (const task of await dependencies.repository.listScheduledTasks()) {
      if (task.schedule.mode === 'cron' && task.schedule.cron) {
        await dependencies.scheduler.schedule(task.id, task.schedule.cron, task.schedule.timezone, {
          misfirePolicy: task.schedule.misfirePolicy,
          lastTriggeredAt: task.lastTriggeredAt,
        });
      }
    }
    await dependencies.repository.setSchedulingPaused(false);
    schedulingPaused = false;
    return { schedulingPaused };
  });

  app.get('/api/v1/trend-sources', async () => trendSourceViews());

  app.post('/api/v1/trend-sources/bootstrap', async (_request, reply) => {
    const errors = await ensureTrendSources();
    const bindings = await dependencies.repository.listTrendSourceBindings();
    const runs = await Promise.all(
      bindings
        .filter((binding) => binding.enabled)
        .map((binding) => enqueueTrendSource(binding.key)),
    );
    return reply.code(202).send({
      sources: await trendSourceViews(),
      runs: [...runs, ...errors],
    });
  });

  app.put('/api/v1/trend-sources/:key', async (request, reply) => {
    const { key } = sourceParams.parse(request.params);
    const input = trendSourceUpdateSchema.parse(request.body);
    const entry = sourceCatalogEntry(key);
    if (!entry) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Trend source not found');
    if (!entry.supported) {
      return sendProblem(request, reply, 409, 'CONFLICT', 'Trend source is not available yet');
    }
    const binding = await dependencies.repository.getTrendSourceBinding(key);
    if (!binding?.taskId) {
      return sendProblem(request, reply, 409, 'CONFLICT', 'Trend source is not installed');
    }
    const enabled = input.enabled ?? binding.enabled;
    const autoRefresh = input.autoRefresh ?? binding.autoRefresh;
    await updateSourceTaskSchedule(binding.taskId, enabled, autoRefresh, entry.cron);
    await dependencies.repository.updateTrendSourceBinding(key, { enabled, autoRefresh });
    const source = (await trendSourceViews()).find((candidate) => candidate.key === key);
    return source ?? sendProblem(request, reply, 404, 'NOT_FOUND', 'Trend source not found');
  });

  app.post('/api/v1/trend-sources/:key/run', async (request, reply) => {
    const { key } = sourceParams.parse(request.params);
    if (!sourceCatalogEntry(key)) {
      return sendProblem(request, reply, 404, 'NOT_FOUND', 'Trend source not found');
    }
    const result = await enqueueTrendSource(key);
    return reply.code(result.status === 'queued' ? 202 : 200).send(result);
  });

  app.post('/api/v1/trend-sources/run', async (_request, reply) => {
    const runs = await Promise.all(
      (await dependencies.repository.listTrendSourceBindings())
        .filter((binding) => binding.enabled)
        .map((binding) => enqueueTrendSource(binding.key)),
    );
    return reply.code(202).send({ runs });
  });

  app.get('/api/v1/trends', async (request) => {
    const query = z
      .object({
        platform: z.enum(['hongguo', 'fanqie', 'bilibili', 'douyin', 'manual']).optional(),
        contentType: z.enum(['short_drama', 'novel', 'video', 'topic']).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(request.query);
    const profile = await preferenceProfile();
    const filtered = matchPreferenceTags(
      (await currentTrendItems()).filter(
        (item) =>
          (!query.platform || item.platform === query.platform) &&
          (!query.contentType || item.contentType === query.contentType),
      ),
      profile,
    );
    return trendsResponseSchema.parse({
      items: filtered.slice(0, query.limit),
      terms: buildTrendTerms(filtered),
      generatedAt: new Date().toISOString(),
    });
  });

  app.get('/api/v1/preferences/profile', async () => preferenceProfile());

  app.get('/api/v1/preferences/signals', async (request) => {
    const query = z
      .object({
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(request.query);
    return dependencies.repository.listPreferenceSignals(query.cursor, query.limit);
  });

  app.post('/api/v1/preferences/signals', async (request) => {
    const input = preferenceSignalInputSchema.parse(request.body);
    return dependencies.repository.upsertPreferenceSignal({
      ...input,
      targetKey: preferenceTargetKey(input.content),
    });
  });

  app.delete('/api/v1/preferences/signals/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!(await dependencies.repository.deletePreferenceSignal(id))) {
      return sendProblem(request, reply, 404, 'NOT_FOUND', 'Preference signal not found');
    }
    return reply.code(204).send();
  });

  app.delete('/api/v1/preferences/signals', async () => ({
    deleted: await dependencies.repository.clearPreferenceSignals(),
  }));

  app.post('/api/v1/preferences/import', async (request, reply) => {
    const input = preferenceImportSchema.parse(request.body);
    const resolver = contentResolver(input.url);
    if (!resolver) {
      return sendProblem(
        request,
        reply,
        422,
        'NAVIGATION_ERROR',
        'Only public Hongguo, Fanqie, Bilibili, and b23.tv content links are supported',
      );
    }
    const result = await dependencies.crawler.crawl({
      url: input.url,
      plan: resolver.plan,
      requestSettings: {
        headers: {},
        cookies: [],
        timeoutMs: 20_000,
        retries: 0,
        retryBackoffMs: 1_000,
        concurrency: 1,
        delayMs: 1_500,
        maxRequests: 1,
        maxRuntimeMs: 30_000,
        domainRateLimitPerMinute: 40,
        respectRobotsTxt: true,
        maxResponseBytes: 5 * 1024 * 1024,
        redirectLimit: 5,
        userAgent: 'Mozilla/5.0 (compatible; ZhiYun/0.2; public-metadata-crawl)',
      },
      browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
      pagination: { type: 'none' },
      networkPolicy: { allowPrivateNetworks: false, allowedHosts: [], allowedCidrs: [] },
      previewLimit: 1,
    });
    const resolved = result.records[0];
    const finalResolver = resolved ? contentResolver(resolved.sourceUrl) : null;
    if (!resolved || !finalResolver || finalResolver.platform !== resolver.platform) {
      return sendProblem(
        request,
        reply,
        422,
        'NAVIGATION_ERROR',
        'The link did not resolve to supported public content metadata',
      );
    }
    const content = preferenceContentFromResolved(
      resolver.platform,
      resolved.data,
      resolved.sourceUrl,
    );
    if (!content) {
      return sendProblem(
        request,
        reply,
        422,
        'EXTRACTION_ERROR',
        'Public content metadata could not be extracted',
      );
    }
    const signal = await dependencies.repository.upsertPreferenceSignal({
      kind: input.kind,
      content,
      targetKey: preferenceTargetKey(content),
    });
    return reply.code(201).send(signal);
  });

  app.post('/api/v1/tasks', async (request, reply) => {
    const input = taskCreateSchema.parse(request.body);
    const result = await requireIdempotency(request, reply, 'task:create', input, async () => {
      const protectedInput = await protectTaskCredentials(input);
      const created = await dependencies.repository.createTask(protectedInput);
      if (
        !schedulingPaused &&
        protectedInput.schedule.mode === 'cron' &&
        protectedInput.schedule.cron
      ) {
        await dependencies.scheduler.schedule(
          created.id,
          protectedInput.schedule.cron,
          protectedInput.schedule.timezone,
        );
      }
      return created;
    });
    if (result === undefined || reply.sent) return;
    return reply.code(201).header('etag', `"${result.revision}"`).send(result);
  });

  app.get('/api/v1/tasks', async (request) => {
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        cursor: z.string().optional(),
      })
      .parse(request.query);
    return cursorPage(await dependencies.repository.listTasks(), query.cursor, query.limit);
  });

  app.get('/api/v1/tasks/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const task = await dependencies.repository.getTask(id);
    if (!task) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Task not found');
    return reply.header('etag', `"${task.revision}"`).send(task);
  });

  app.put('/api/v1/tasks/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const input = taskUpdateSchema.parse(request.body);
    const ifMatch = headerValue(request.headers['if-match']);
    if (!ifMatch) {
      return sendProblem(
        request,
        reply,
        428,
        'PRECONDITION_REQUIRED',
        'If-Match header is required',
      );
    }
    const expected = Number.parseInt(ifMatch.replaceAll('"', ''), 10);
    if (!Number.isInteger(expected)) {
      return sendProblem(
        request,
        reply,
        400,
        'VALIDATION_ERROR',
        'If-Match must contain a numeric task revision',
      );
    }
    const existing = await dependencies.repository.getTask(id);
    if (!existing) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Task not found');
    if (existing.revision !== expected) {
      return sendProblem(
        request,
        reply,
        412,
        'PRECONDITION_FAILED',
        'Task was modified by another client',
      );
    }
    if (input.schedule?.mode === 'cron' && input.schedule.cron) {
      if (input.schedule.cron.trim().split(/\s+/).length !== 5) {
        return sendProblem(
          request,
          reply,
          400,
          'VALIDATION_ERROR',
          'Cron must contain five fields',
        );
      }
    }
    const protectedInput = await protectTaskCredentials(input, existing.credentialBindings);
    const task = await dependencies.repository.updateTask(id, protectedInput, expected);
    if (!task) {
      return sendProblem(
        request,
        reply,
        412,
        'PRECONDITION_FAILED',
        'Task was modified by another client',
      );
    }
    await deleteCredentialRefs(existing.credentialBindings, task.credentialBindings);
    if (!schedulingPaused && input.schedule?.mode === 'cron' && input.schedule.cron) {
      await dependencies.scheduler.schedule(id, input.schedule.cron, input.schedule.timezone);
    } else if (input.schedule) {
      await dependencies.scheduler.unschedule(id);
    }
    return reply.header('etag', `"${task.revision}"`).send(task);
  });

  app.delete('/api/v1/tasks/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const existing = await dependencies.repository.getTask(id);
    await dependencies.scheduler.unschedule(id);
    const deleted = await dependencies.repository.deleteTask(id);
    if (!deleted) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Task not found');
    if (existing) await deleteCredentialRefs(existing.credentialBindings);
    return reply.code(204).send();
  });

  app.post('/api/v1/tasks/:id/analyze', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({ useAi: z.boolean().default(false), forceBrowser: z.boolean().default(false) })
      .parse(request.body ?? {});
    const task = await dependencies.repository.getTask(id);
    if (!task) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Task not found');
    const settings = await resolveTaskSettings(task);
    const result = await analyzePage(
      {
        taskId: id,
        url: task.startUrl,
        instruction: task.instruction,
        ...settings,
        useAi: body.useAi,
        forceBrowser: body.forceBrowser,
        networkPolicy:
          process.env.NODE_ENV === 'production'
            ? task.networkPolicy
            : { ...task.networkPolicy, allowPrivateNetworks: true },
      },
      dependencies.ai,
    );
    if (result.engine === 'browser' && !task.browserSettings.enabled) {
      await dependencies.repository.setTaskBrowserSettings(id, {
        ...task.browserSettings,
        enabled: true,
      });
    }
    return result;
  });

  app.post('/api/v1/tasks/:id/ai/extract', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({
        definition: crawlPlanDefinitionSchema.optional(),
        instruction: z.string().min(1).max(2_000).optional(),
      })
      .parse(request.body ?? {});
    const task = await dependencies.repository.getTask(id);
    if (!task) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Task not found');
    const active = body.definition ? null : await dependencies.repository.getActiveRule(id);
    const definition = body.definition ?? active?.version.definition;
    if (!definition) {
      return sendProblem(
        request,
        reply,
        409,
        'CONFLICT',
        'No candidate or active rule is available',
      );
    }
    const settings = await resolveTaskSettings(task);
    const source = await fetchPageSource(task.startUrl, {
      rootUrl: task.startUrl,
      requestSettings: settings.requestSettings,
      networkPolicy:
        process.env.NODE_ENV === 'production'
          ? task.networkPolicy
          : { ...task.networkPolicy, allowPrivateNetworks: true },
    });
    const records = await dependencies.ai.extract({
      html: source.text,
      instruction: body.instruction ?? task.instruction,
      schema: definition,
      context: { taskId: id },
    });
    return {
      records: records.slice(0, 10),
      sourceUrl: source.finalUrl,
      persisted: false,
    };
  });

  app.post('/api/v1/tasks/:id/browser-session/login', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ loginUrl: z.string().url().optional() }).parse(request.body ?? {});
    const task = await dependencies.repository.getTask(id);
    if (!task) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Task not found');
    if (!dependencies.host.createLoginSession) {
      return sendProblem(
        request,
        reply,
        409,
        'CONFLICT',
        'Controlled login is only available in Desktop',
      );
    }
    const loginUrl = body.loginUrl ?? task.startUrl;
    await assertNetworkAllowed(
      loginUrl,
      process.env.NODE_ENV === 'production'
        ? task.networkPolicy
        : { ...task.networkPolicy, allowPrivateNetworks: true },
    );
    const result = await dependencies.host.createLoginSession(loginUrl);
    if ('canceled' in result) return result;
    const updated = await dependencies.repository.updateTask(
      id,
      {
        credentialBindings: {
          ...task.credentialBindings,
          browserStorageStateRef: result.reference,
        },
        browserSettings: { ...task.browserSettings, enabled: true },
      },
      task.revision,
    );
    if (!updated) {
      await dependencies.credentialStore.delete(result.reference).catch(() => undefined);
      return sendProblem(request, reply, 412, 'PRECONDITION_FAILED', 'Task changed during login');
    }
    await deleteCredentialRefs(task.credentialBindings, updated.credentialBindings);
    return { canceled: false, reference: result.reference, task: updated };
  });

  const taskCredentialKindSchema = z.enum(['secretHeaders', 'cookies', 'proxy']);
  const taskCredentialBindingKey = {
    secretHeaders: 'secretHeadersRef',
    cookies: 'cookiesRef',
    proxy: 'proxyRef',
  } as const;
  const hostCredentialKind = {
    secretHeaders: 'task-secret-headers',
    cookies: 'task-cookies',
    proxy: 'task-proxy',
  } as const;

  app.post('/api/v1/tasks/:id/credentials/:kind', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const kind = taskCredentialKindSchema.parse((request.params as Record<string, unknown>).kind);
    const body = z.object({ revision: z.number().int().positive() }).parse(request.body);
    const task = await dependencies.repository.getTask(id);
    if (!task) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Task not found');
    if (task.revision !== body.revision)
      return sendProblem(request, reply, 412, 'PRECONDITION_FAILED', 'Task has changed');
    if (!dependencies.host.promptCredential) {
      return sendProblem(
        request,
        reply,
        409,
        'CONFLICT',
        'Host-owned credential input is only available in Desktop',
      );
    }
    const prompted = await dependencies.host.promptCredential(hostCredentialKind[kind]);
    if ('canceled' in prompted) return prompted;
    const bindings = {
      ...task.credentialBindings,
      [taskCredentialBindingKey[kind]]: prompted.reference,
    };
    const updated = await dependencies.repository.updateTask(
      id,
      { credentialBindings: bindings },
      task.revision,
    );
    if (!updated) {
      await dependencies.credentialStore.delete(prompted.reference).catch(() => undefined);
      return sendProblem(
        request,
        reply,
        412,
        'PRECONDITION_FAILED',
        'Task changed while entering credentials',
      );
    }
    await deleteCredentialRefs(task.credentialBindings, updated.credentialBindings);
    return { canceled: false, task: updated };
  });

  app.delete('/api/v1/tasks/:id/credentials/:kind', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const kind = taskCredentialKindSchema.parse((request.params as Record<string, unknown>).kind);
    const body = z.object({ revision: z.number().int().positive() }).parse(request.body);
    const task = await dependencies.repository.getTask(id);
    if (!task) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Task not found');
    if (task.revision !== body.revision)
      return sendProblem(request, reply, 412, 'PRECONDITION_FAILED', 'Task has changed');
    const bindings = { ...task.credentialBindings };
    const reference = bindings[taskCredentialBindingKey[kind]];
    delete bindings[taskCredentialBindingKey[kind]];
    const updated = await dependencies.repository.updateTask(
      id,
      { credentialBindings: bindings },
      task.revision,
    );
    if (!updated)
      return sendProblem(request, reply, 412, 'PRECONDITION_FAILED', 'Task has changed');
    if (reference) await dependencies.credentialStore.delete(reference).catch(() => undefined);
    return updated;
  });

  app.get('/api/v1/tasks/:id/rules', async (request) => {
    const { id } = idParams.parse(request.params);
    return dependencies.repository.listRules(id);
  });

  app.post('/api/v1/tasks/:id/rules/test', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({ definition: z.unknown(), limit: z.number().int().min(1).max(10).default(10) })
      .parse(request.body);
    const task = await dependencies.repository.getTask(id);
    if (!task) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Task not found');
    const settings = await resolveTaskSettings(task);
    return dependencies.crawler.crawl({
      url: task.startUrl,
      plan: validateCrawlPlan(body.definition),
      requestSettings: settings.requestSettings,
      browserSettings: settings.browserSettings,
      pagination: task.pagination,
      networkPolicy:
        process.env.NODE_ENV === 'production'
          ? task.networkPolicy
          : { ...task.networkPolicy, allowPrivateNetworks: true },
      previewLimit: body.limit,
    });
  });

  app.post('/api/v1/tasks/:id/rules', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({
        name: z.string().min(1).default('Default rule'),
        definition: z.unknown(),
        generatedBy: generatedBySchema.default('human'),
      })
      .parse(request.body);
    const normalized = { ...body, definition: validateCrawlPlan(body.definition) };
    const result = await requireIdempotency(
      request,
      reply,
      `task:${id}:rule:create`,
      normalized,
      () =>
        dependencies.repository.createRule(
          id,
          normalized.name,
          normalized.definition,
          normalized.generatedBy,
        ),
    );
    if (result === undefined || reply.sent) return;
    return reply.code(201).send(result);
  });

  app.post('/api/v1/tasks/:id/rules/:ruleId/versions', async (request, reply) => {
    const { id, ruleId } = ruleParams.parse(request.params);
    const body = z
      .object({ definition: z.unknown(), generatedBy: generatedBySchema.default('human') })
      .parse(request.body);
    const normalized = { ...body, definition: validateCrawlPlan(body.definition) };
    const result = await requireIdempotency(
      request,
      reply,
      `rule:${ruleId}:version:create`,
      normalized,
      () =>
        dependencies.repository.createRuleVersion(
          id,
          ruleId,
          normalized.definition,
          normalized.generatedBy,
        ),
    );
    if (result === undefined || reply.sent) return;
    if (!result) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Rule not found');
    return reply.code(201).send(result);
  });

  app.get('/api/v1/tasks/:id/rules/:ruleId/diff', async (request, reply) => {
    const { id, ruleId } = ruleParams.parse(request.params);
    const query = z
      .object({ from: z.coerce.number().int().positive(), to: z.coerce.number().int().positive() })
      .parse(request.query);
    const rule = (await dependencies.repository.listRules(id)).find((item) => item.id === ruleId);
    if (!rule) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Rule not found');
    const before = rule.versions.find((version) => version.version === query.from);
    const after = rule.versions.find((version) => version.version === query.to);
    if (!before || !after)
      return sendProblem(request, reply, 404, 'NOT_FOUND', 'Rule version not found');
    return {
      from: before,
      to: after,
      changes: definitionDiff(before.definition, after.definition),
    };
  });

  app.post('/api/v1/tasks/:id/rules/:ruleId/rollback', async (request, reply) => {
    const { id, ruleId } = ruleParams.parse(request.params);
    const body = z.object({ version: z.number().int().positive() }).parse(request.body);
    const rule = (await dependencies.repository.listRules(id)).find((item) => item.id === ruleId);
    const target = rule?.versions.find((version) => version.version === body.version);
    if (!target) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Rule version not found');
    const result = await requireIdempotency(request, reply, `rule:${ruleId}:rollback`, body, () =>
      dependencies.repository.createRuleVersion(id, ruleId, target.definition, 'human'),
    );
    if (result === undefined || reply.sent) return;
    return reply.code(201).send(result);
  });

  app.post('/api/v1/tasks/:id/rules/:ruleId/repair-proposals', async (request, reply) => {
    const { id, ruleId } = ruleParams.parse(request.params);
    const body = z
      .object({
        error: z.string().min(1).max(4_000),
        runId: z.string().uuid().nullable().default(null),
      })
      .parse(request.body);
    const task = await dependencies.repository.getTask(id);
    const rule = (await dependencies.repository.listRules(id)).find((item) => item.id === ruleId);
    const current = rule?.versions.find((version) => version.id === rule.activeVersionId);
    if (!task || !current)
      return sendProblem(request, reply, 404, 'NOT_FOUND', 'Task or rule not found');
    const settings = await resolveTaskSettings(task);
    const source = await fetchPageSource(task.startUrl, {
      requestSettings: settings.requestSettings,
      networkPolicy:
        process.env.NODE_ENV === 'production'
          ? task.networkPolicy
          : { ...task.networkPolicy, allowPrivateNetworks: true },
    });
    const suggestion = await dependencies.ai.suggestRepair({
      html: source.text.slice(0, 200_000),
      instruction: task.instruction,
      current: current.definition,
      error: body.error,
      context: {
        taskId: id,
        ...(body.runId ? { runId: body.runId } : {}),
      },
    });
    const proposal = await dependencies.repository.createRuleRepairProposal({
      taskId: id,
      ruleId,
      runId: body.runId,
      definition: suggestion.definition,
      explanation: suggestion.explanation,
    });
    return reply.code(201).send({
      ...proposal,
      baseVersion: current.version,
      diff: definitionDiff(current.definition, suggestion.definition),
    });
  });

  app.get('/api/v1/tasks/:id/rules/:ruleId/repair-proposals', async (request, reply) => {
    const { id, ruleId } = ruleParams.parse(request.params);
    const rule = (await dependencies.repository.listRules(id)).find((item) => item.id === ruleId);
    if (!rule) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Rule not found');
    return dependencies.repository.listRuleRepairProposals(ruleId);
  });

  app.post(
    '/api/v1/tasks/:id/rules/:ruleId/repair-proposals/:proposalId/test',
    async (request, reply) => {
      const parameters = z
        .object({ id: z.string().uuid(), ruleId: z.string().uuid(), proposalId: z.string().uuid() })
        .parse(request.params);
      const proposal = (
        await dependencies.repository.listRuleRepairProposals(parameters.ruleId)
      ).find((item) => item.id === parameters.proposalId && item.taskId === parameters.id);
      const task = await dependencies.repository.getTask(parameters.id);
      if (!proposal || !task)
        return sendProblem(request, reply, 404, 'NOT_FOUND', 'Repair proposal not found');
      if (proposal.status !== 'pending')
        return sendProblem(request, reply, 409, 'CONFLICT', 'Repair proposal was already reviewed');
      const settings = await resolveTaskSettings(task);
      const result = await dependencies.crawler.crawl({
        url: task.startUrl,
        plan: proposal.definition,
        requestSettings: settings.requestSettings,
        browserSettings: settings.browserSettings,
        pagination: task.pagination,
        networkPolicy:
          process.env.NODE_ENV === 'production'
            ? task.networkPolicy
            : { ...task.networkPolicy, allowPrivateNetworks: true },
        previewLimit: 10,
      });
      const tested = await dependencies.repository.markRuleRepairProposalTested(proposal.id);
      return { ...result, proposal: tested };
    },
  );

  app.post(
    '/api/v1/tasks/:id/rules/:ruleId/repair-proposals/:proposalId/apply',
    async (request, reply) => {
      const parameters = z
        .object({ id: z.string().uuid(), ruleId: z.string().uuid(), proposalId: z.string().uuid() })
        .parse(request.params);
      const proposal = (
        await dependencies.repository.listRuleRepairProposals(parameters.ruleId)
      ).find((item) => item.id === parameters.proposalId);
      if (!proposal || proposal.taskId !== parameters.id) {
        return sendProblem(request, reply, 404, 'NOT_FOUND', 'Repair proposal not found');
      }
      if (proposal.status !== 'pending') {
        return sendProblem(request, reply, 409, 'CONFLICT', 'Repair proposal was already reviewed');
      }
      if (!proposal.testedAt) {
        return sendProblem(
          request,
          reply,
          409,
          'CONFLICT',
          'Repair proposal must be tested before it can be applied',
        );
      }
      const result = await requireIdempotency(
        request,
        reply,
        `repair:${proposal.id}:apply`,
        {},
        async () => {
          const version = await dependencies.repository.createRuleVersion(
            parameters.id,
            parameters.ruleId,
            proposal.definition,
            'ai',
          );
          await dependencies.repository.updateRuleRepairProposal(proposal.id, 'applied');
          return version;
        },
      );
      if (result === undefined || reply.sent) return;
      return reply.code(201).send(result);
    },
  );

  app.post(
    '/api/v1/tasks/:id/rules/:ruleId/repair-proposals/:proposalId/reject',
    async (request, reply) => {
      const parameters = z
        .object({ id: z.string().uuid(), ruleId: z.string().uuid(), proposalId: z.string().uuid() })
        .parse(request.params);
      const proposal = (
        await dependencies.repository.listRuleRepairProposals(parameters.ruleId)
      ).find((item) => item.id === parameters.proposalId && item.taskId === parameters.id);
      if (!proposal)
        return sendProblem(request, reply, 404, 'NOT_FOUND', 'Repair proposal not found');
      return dependencies.repository.updateRuleRepairProposal(proposal.id, 'rejected');
    },
  );

  app.post('/api/v1/tasks/:id/run', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const result = await requireIdempotency(request, reply, `task:${id}:run`, {}, async () => {
      if (!(await dependencies.repository.getActiveRule(id))) {
        throw new ZhiYunError('CONFLICT', 'Task has no active rule');
      }
      const run = await dependencies.repository.createRun(id);
      await dependencies.queue.enqueue(id, run.id);
      return { runId: run.id, status: run.status };
    });
    if (result === undefined || reply.sent) return;
    return reply.code(202).send(result);
  });

  app.get('/api/v1/tasks/:id/runs', async (request) => {
    const { id } = idParams.parse(request.params);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        cursor: z.string().optional(),
      })
      .parse(request.query);
    return cursorPage(await dependencies.repository.listRuns(id), query.cursor, query.limit);
  });

  app.get('/api/v1/tasks/:id/dataset', async (request) => {
    const { id } = idParams.parse(request.params);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        cursor: z.string().optional(),
        includeRemoved: z.coerce.boolean().default(false),
        query: z.string().max(500).optional(),
        filter: datasetFilterQuerySchema.optional(),
      })
      .parse(request.query);
    return dependencies.repository.listDatasetRecords(id, query.cursor, query.limit, {
      includeRemoved: query.includeRemoved,
      ...(query.query ? { query: query.query } : {}),
      ...(query.filter ? { filter: query.filter } : {}),
    });
  });

  app.get('/api/v1/tasks/:id/dataset/changes', async (request) => {
    const { id } = idParams.parse(request.params);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        cursor: z.string().optional(),
        runId: z.string().uuid().optional(),
      })
      .parse(request.query);
    return dependencies.repository.listRecordChanges(id, query.cursor, query.limit, query.runId);
  });

  app.get('/api/v1/tasks/:id/dataset/diff', async (request) => {
    const { id } = idParams.parse(request.params);
    const query = z
      .object({
        from: z.string().uuid(),
        to: z.string().uuid(),
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(request.query);
    const [fromRun, toRun] = await Promise.all([
      dependencies.repository.getRun(query.from),
      dependencies.repository.getRun(query.to),
    ]);
    if (!fromRun || !toRun || fromRun.taskId !== id || toRun.taskId !== id) {
      throw new ZhiYunError('NOT_FOUND', 'Both Runs must belong to this task');
    }
    if (fromRun.status !== 'succeeded' || toRun.status !== 'succeeded') {
      throw new ZhiYunError('CONFLICT', 'Dataset Diff requires two successful Runs');
    }
    return dependencies.repository.diffRunRecords(
      id,
      query.from,
      query.to,
      query.cursor,
      query.limit,
    );
  });

  app.post('/api/v1/tasks/:id/dataset/exports', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = exportBodySchema
      .extend({
        includeRemoved: z.boolean().default(false),
        query: z.string().max(500).optional(),
        filter: datasetFilterSchema.optional(),
      })
      .parse(request.body);
    const result = await requireIdempotency(
      request,
      reply,
      `task:${id}:dataset-export`,
      body,
      async () => {
        const task = await dependencies.repository.getTask(id);
        if (!task) throw new ZhiYunError('NOT_FOUND', 'Task not found');
        const latestRun = (await dependencies.repository.listRuns(id)).find(
          (run) => run.status === 'succeeded',
        );
        if (!latestRun) throw new ZhiYunError('CONFLICT', 'Dataset has no successful Run');
        const controller = new AbortController();
        request.raw.once('aborted', () => controller.abort());
        return createExportArtifact({
          runId: latestRun.id,
          filename: `zhiyun-dataset-${id}`,
          body,
          records: datasetRecordData(id, {
            includeRemoved: body.includeRemoved,
            ...(body.query ? { query: body.query } : {}),
            ...(body.filter ? { filter: body.filter } : {}),
          }),
          signal: controller.signal,
        });
      },
    );
    if (result === undefined || reply.sent) return;
    return reply.code(201).send(result);
  });

  app.get('/api/v1/runs/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const run = await dependencies.repository.getRun(id);
    return run ?? sendProblem(request, reply, 404, 'NOT_FOUND', 'Run not found');
  });

  app.post('/api/v1/runs/:id/explain-failure', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const run = await dependencies.repository.getRun(id);
    if (!run) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Run not found');
    if (run.status !== 'failed') {
      return sendProblem(request, reply, 409, 'CONFLICT', 'Only a failed Run can be explained');
    }
    const explanation = await dependencies.ai.explainFailure({
      error: run.error ?? 'Unknown crawl failure',
      failureContext: {
        errorCode: run.errorCode,
        phase: run.phase,
        requestCount: run.requestCount,
        recordCount: run.recordCount,
        browserUsed: run.browserUsed,
        aiUsed: run.aiUsed,
      },
      context: { taskId: run.taskId, runId: run.id },
    });
    return { explanation, persisted: false };
  });

  app.post('/api/v1/runs/:id/cancel', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const requested = await dependencies.repository.requestRunCancellation(id);
    if (!requested) return sendProblem(request, reply, 409, 'CONFLICT', 'Run cannot be canceled');
    activeRuns.get(id)?.abort();
    await dependencies.queue.cancel(id).catch(() => false);
    const run =
      (await dependencies.repository.cancelRun(id)) ?? (await dependencies.repository.getRun(id));
    if (!run || run.status !== 'canceled') {
      return sendProblem(request, reply, 409, 'CONFLICT', 'Run cannot be canceled');
    }
    return run;
  });

  app.post('/api/v1/runs/:id/retry', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const original = await dependencies.repository.getRun(id);
    if (!original) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Run not found');
    const result = await requireIdempotency(request, reply, `run:${id}:retry`, {}, async () => {
      const run = await dependencies.repository.createRun(original.taskId);
      await dependencies.queue.enqueue(original.taskId, run.id);
      return { runId: run.id, status: run.status };
    });
    if (result === undefined || reply.sent) return;
    return reply.code(202).send(result);
  });

  app.get('/api/v1/runs/:id/logs', async (request) => {
    const { id } = idParams.parse(request.params);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        cursor: z.string().optional(),
      })
      .parse(request.query);
    return dependencies.repository.listRunLogs(id, query.cursor, query.limit);
  });

  app.get('/api/v1/runs/:id/requests', async (request) => {
    const { id } = idParams.parse(request.params);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        cursor: z.string().optional(),
      })
      .parse(request.query);
    return dependencies.repository.listRunRequests(id, query.cursor, query.limit);
  });

  app.get('/api/v1/runs/:id/records', async (request) => {
    const { id } = idParams.parse(request.params);
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        cursor: z.string().optional(),
      })
      .parse(request.query);
    return dependencies.repository.listRecords(id, query.cursor, query.limit);
  });

  app.post('/api/v1/runs/:id/exports', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = exportBodySchema.parse(request.body);
    const result = await requireIdempotency(request, reply, `run:${id}:export`, body, async () => {
      const run = await dependencies.repository.getRun(id);
      if (!run) throw new ZhiYunError('NOT_FOUND', 'Run not found');
      const controller = new AbortController();
      request.raw.once('aborted', () => controller.abort());
      return createExportArtifact({
        runId: id,
        filename: `zhiyun-run-${id}`,
        body,
        records: runRecordData(id),
        signal: controller.signal,
      });
    });
    if (result === undefined || reply.sent) return;
    return reply.code(201).send(result);
  });

  app.post('/api/v1/artifacts/:id/save', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const artifact = await dependencies.repository.getArtifact(id);
    if (!artifact) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Artifact not found');
    if (!dependencies.host.saveArtifact) {
      return sendProblem(request, reply, 409, 'CONFLICT', 'Host save capability is unavailable');
    }
    const descriptor = {
      id: artifact.id,
      runId: artifact.runId,
      format: artifact.format,
      filename: artifact.filename,
      contentType: artifact.contentType,
      size: artifact.size,
      createdAt: artifact.createdAt,
    };
    return dependencies.host.saveArtifact(descriptor, { storageKey: artifact.storageKey });
  });

  app.get('/api/v1/artifacts/:id/content', async (request, reply) => {
    if (dependencies.host.metadata.mode === 'desktop') {
      return sendProblem(
        request,
        reply,
        403,
        'FORBIDDEN',
        'Desktop Renderer cannot read artifact content',
      );
    }
    const { id } = idParams.parse(request.params);
    const artifact = await dependencies.repository.getArtifact(id);
    if (!artifact) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Artifact not found');
    return reply
      .type(artifact.contentType)
      .header('content-disposition', `attachment; filename="${artifact.filename}"`)
      .send(Readable.from(dependencies.artifactStore.readStream(artifact.storageKey)));
  });

  app.get('/api/v1/output-destinations', async () =>
    dependencies.repository.listOutputDestinations(),
  );

  app.post('/api/v1/output-destinations', async (request, reply) => {
    const body = z
      .object({
        name: z.string().min(1).max(200),
        type: z.enum(['webhook', 'postgres']),
        config: z.record(z.string(), z.unknown()).default({}),
        credential: z.unknown().optional(),
        enabled: z.boolean().default(true),
      })
      .parse(request.body);
    if (dependencies.host.metadata.mode === 'desktop' && body.credential !== undefined) {
      throw new ZhiYunError(
        'CREDENTIAL_ERROR',
        'Desktop output credentials must be entered in a Host-owned secure window',
      );
    }
    const result = await requireIdempotency(request, reply, 'output:create', body, async () => {
      const credentialRef = body.credential
        ? await dependencies.credentialStore.put(`output-${body.type}`, body.credential)
        : null;
      return dependencies.repository.createOutputDestination({
        name: body.name,
        type: body.type,
        config: body.config,
        credentialRef,
        enabled: body.enabled,
      });
    });
    if (result === undefined || reply.sent) return;
    return reply.code(201).send(result);
  });

  app.put('/api/v1/output-destinations/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({
        name: z.string().min(1).max(200).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        credential: z.unknown().optional(),
        enabled: z.boolean().optional(),
      })
      .parse(request.body);
    if (dependencies.host.metadata.mode === 'desktop' && body.credential !== undefined) {
      throw new ZhiYunError(
        'CREDENTIAL_ERROR',
        'Desktop output credentials must be entered in a Host-owned secure window',
      );
    }
    const current = await dependencies.repository.getOutputDestination(id);
    if (!current)
      return sendProblem(request, reply, 404, 'NOT_FOUND', 'Output destination not found');
    const credentialRef = body.credential
      ? await dependencies.credentialStore.put(`output-${current.type}`, body.credential)
      : undefined;
    const updated = await dependencies.repository.updateOutputDestination(id, {
      ...(body.name ? { name: body.name } : {}),
      ...(body.config ? { config: body.config } : {}),
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      ...(credentialRef ? { credentialRef } : {}),
    });
    if (!updated && credentialRef) {
      await dependencies.credentialStore.delete(credentialRef).catch(() => undefined);
    }
    if (updated && credentialRef && current.credentialRef !== credentialRef) {
      if (current.credentialRef)
        await dependencies.credentialStore.delete(current.credentialRef).catch(() => undefined);
    }
    return updated;
  });

  app.delete('/api/v1/output-destinations/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const destination = await dependencies.repository.getOutputDestination(id);
    if (!destination)
      return sendProblem(request, reply, 404, 'NOT_FOUND', 'Output destination not found');
    const deleted = await dependencies.repository.deleteOutputDestination(id);
    if (deleted && destination.credentialRef) {
      await dependencies.credentialStore.delete(destination.credentialRef).catch(() => undefined);
    }
    return reply.code(204).send();
  });

  app.post('/api/v1/output-destinations/:id/test', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const destination = await dependencies.repository.getOutputDestination(id);
    if (!destination)
      return sendProblem(request, reply, 404, 'NOT_FOUND', 'Output destination not found');
    const credential = destination.credentialRef
      ? await dependencies.credentialStore.resolve(destination.credentialRef)
      : null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      if (destination.type === 'webhook') {
        await assertNetworkAllowed(
          String(destination.config.url ?? ''),
          process.env.NODE_ENV === 'production'
            ? {
                allowPrivateNetworks: false,
                allowedHosts: [],
                allowedCidrs: [],
              }
            : { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
        );
      }
      await outputAdapter(destination).test({
        destination,
        credential,
        signal: controller.signal,
      });
      return { ok: true };
    } catch (error) {
      throw new ZhiYunError('EXPORT_ERROR', outputError(error, credential));
    } finally {
      clearTimeout(timer);
    }
  });

  app.post('/api/v1/output-destinations/:id/credential/prompt', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const destination = await dependencies.repository.getOutputDestination(id);
    if (!destination)
      return sendProblem(request, reply, 404, 'NOT_FOUND', 'Output destination not found');
    if (!dependencies.host.promptCredential) {
      return sendProblem(
        request,
        reply,
        409,
        'CONFLICT',
        'Host-owned credential input is only available in Desktop',
      );
    }
    const prompted = await dependencies.host.promptCredential(
      destination.type === 'webhook' ? 'output-webhook' : 'output-postgres',
    );
    if ('canceled' in prompted) return prompted;
    const updated = await dependencies.repository.updateOutputDestination(id, {
      credentialRef: prompted.reference,
    });
    if (!updated) {
      await dependencies.credentialStore.delete(prompted.reference).catch(() => undefined);
      return sendProblem(request, reply, 404, 'NOT_FOUND', 'Output destination not found');
    }
    if (destination.credentialRef && destination.credentialRef !== prompted.reference) {
      await dependencies.credentialStore.delete(destination.credentialRef).catch(() => undefined);
    }
    return updated;
  });

  app.get('/api/v1/delivery-attempts', async (request) => {
    const query = z.object({ runId: z.string().uuid().optional() }).parse(request.query);
    return dependencies.repository.listDeliveryAttempts(query.runId);
  });

  app.post('/api/v1/delivery-attempts/:id/retry', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const previous = (await dependencies.repository.listDeliveryAttempts()).find(
      (attempt) => attempt.id === id,
    );
    if (!previous)
      return sendProblem(request, reply, 404, 'NOT_FOUND', 'Delivery attempt not found');
    const result = await requireIdempotency(
      request,
      reply,
      `delivery:${id}:retry`,
      {},
      async () => {
        const attempt = await dependencies.repository.createDeliveryAttempt({
          destinationId: previous.destinationId,
          taskId: previous.taskId,
          runId: previous.runId,
        });
        void runDelivery(attempt).catch((error) => {
          app.log.error({ attemptId: attempt.id, err: error }, 'delivery retry failed');
        });
        return attempt;
      },
    );
    if (result === undefined || reply.sent) return;
    return reply.code(202).send(result);
  });

  app.get('/api/v1/api-tokens', async () => dependencies.repository.listApiTokens());

  app.post('/api/v1/api-tokens', async (request, reply) => {
    const body = z
      .object({
        name: z.string().min(1).max(200),
        taskIds: z.array(z.string().uuid()).default([]),
        rateLimitPerMinute: z.number().int().min(1).max(10_000).default(60),
        expiresAt: z.string().datetime().nullable().default(null),
      })
      .parse(request.body);
    const raw = randomBytes(32).toString('base64url');
    const created = await dependencies.repository.createApiToken({
      ...body,
      tokenHash: fingerprint(raw),
    });
    return reply.code(201).send({ ...created, token: raw });
  });

  app.delete('/api/v1/api-tokens/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!(await dependencies.repository.revokeApiToken(id))) {
      return sendProblem(request, reply, 404, 'NOT_FOUND', 'API token not found');
    }
    return reply.code(204).send();
  });

  app.get('/api/v1/data/tasks/:id/records', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const token = (request as FastifyRequest & { dataToken?: { taskIds: string[] } }).dataToken;
    if (!token || (token.taskIds.length > 0 && !token.taskIds.includes(id))) {
      return sendProblem(request, reply, 403, 'FORBIDDEN', 'Token is not scoped to this task');
    }
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(100),
        cursor: z.string().optional(),
        query: z.string().max(500).optional(),
        fields: z.string().optional(),
        filter: datasetFilterQuerySchema.optional(),
        includeRemoved: z.coerce.boolean().default(false),
      })
      .parse(request.query);
    const page = await dependencies.repository.listDatasetRecords(id, query.cursor, query.limit, {
      includeRemoved: query.includeRemoved,
      ...(query.query ? { query: query.query } : {}),
      ...(query.filter ? { filter: query.filter } : {}),
    });
    const fields = query.fields?.split(',').filter(Boolean);
    return fields?.length
      ? {
          ...page,
          items: page.items.map((item) => ({
            ...item,
            data: Object.fromEntries(fields.map((field) => [field, item.data[field]])),
          })),
        }
      : page;
  });

  app.post('/api/v1/inspection-sessions', async (request, reply) => {
    const body = z.object({ taskId: z.string().uuid() }).parse(request.body);
    const task = await dependencies.repository.getTask(body.taskId);
    if (!task) return sendProblem(request, reply, 404, 'NOT_FOUND', 'Task not found');
    const settings = await resolveTaskSettings(task);
    return reply.code(201).send(
      await inspections.create({
        url: task.startUrl,
        ...settings,
        networkPolicy:
          process.env.NODE_ENV === 'production'
            ? task.networkPolicy
            : { ...task.networkPolicy, allowPrivateNetworks: true },
      }),
    );
  });

  app.get('/api/v1/inspection-sessions/:id/screenshot', async (request) => {
    const { id } = idParams.parse(request.params);
    return inspections.screenshot(id);
  });

  app.post('/api/v1/inspection-sessions/:id/actions', async (request) => {
    const { id } = idParams.parse(request.params);
    const action = z
      .object({
        type: z.enum(['click', 'scroll', 'refresh']),
        x: z.number().nonnegative().optional(),
        y: z.number().nonnegative().optional(),
        deltaY: z.number().optional(),
      })
      .parse(request.body);
    return inspections.action(id, {
      type: action.type,
      ...(action.x === undefined ? {} : { x: action.x }),
      ...(action.y === undefined ? {} : { y: action.y }),
      ...(action.deltaY === undefined ? {} : { deltaY: action.deltaY }),
    });
  });

  app.post('/api/v1/inspection-sessions/:id/select', async (request) => {
    const { id } = idParams.parse(request.params);
    const point = z
      .object({ x: z.number().nonnegative(), y: z.number().nonnegative() })
      .parse(request.body);
    return inspections.select(id, point.x, point.y);
  });

  app.delete('/api/v1/inspection-sessions/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (!(await inspections.close(id)))
      return sendProblem(request, reply, 404, 'NOT_FOUND', 'Inspection session not found');
    return reply.code(204).send();
  });

  app.get('/api/v1/desktop/diagnostics', async (request, reply) => {
    if (dependencies.host.metadata.mode !== 'desktop') {
      return sendProblem(request, reply, 409, 'CONFLICT', 'Desktop diagnostics are unavailable');
    }
    return {
      runtime: dependencies.host.metadata,
      capabilities: dependencies.host.capabilities,
      browserResources: process.env.PLAYWRIGHT_BROWSERS_PATH ?? null,
      database: (await dependencies.repository.diagnostics?.()) ?? { engine: 'unknown' },
    };
  });

  app.post('/api/v1/desktop/backup', async (request, reply) => {
    if (!dependencies.repository.createBackup || !dependencies.host.saveBackup) {
      return sendProblem(request, reply, 409, 'CONFLICT', 'Desktop backup is unavailable');
    }
    const data = await dependencies.repository.createBackup();
    return dependencies.host.saveBackup(
      `zhiyun-backup-${new Date().toISOString().slice(0, 10)}.sqlite3`,
      data,
    );
  });

  app.post('/api/v1/desktop/restore', async (request, reply) => {
    if (
      !dependencies.repository.stageRestore ||
      !dependencies.host.selectRestoreBackup ||
      !dependencies.host.restartRuntime
    ) {
      return sendProblem(request, reply, 409, 'CONFLICT', 'Desktop restore is unavailable');
    }
    const selected = await dependencies.host.selectRestoreBackup();
    if ('canceled' in selected) return selected;
    await dependencies.repository.stageRestore(selected.data);
    await dependencies.host.restartRuntime();
    return { canceled: false, restarting: true };
  });

  app.get('/api/v1/events/domain', async (request, reply) => {
    const query = z
      .object({ after: z.coerce.number().int().nonnegative().default(0) })
      .parse(request.query);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let cursor = query.after;
    const flush = async () => {
      const page = await dependencies.repository.listEvents(cursor, 100);
      for (const event of page.items) {
        cursor = event.cursor;
        reply.raw.write(
          `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      }
    };
    await flush();
    const timer = setInterval(() => void flush(), 500);
    request.raw.once('close', () => clearInterval(timer));
  });

  app.get('/api/v1/events/realtime', async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    const listener = (event: RealtimeEvent) => {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    realtime.on('event', listener);
    request.raw.once('close', () => realtime.off('event', listener));
  });

  app.addHook('onReady', async () => {
    await dependencies.repository.migrate();
    await dependencies.repository.recoverInterruptedRuns();
    schedulingPaused = await dependencies.repository.getSchedulingPaused();
    await dependencies.queue.start(async (job) => {
      if (dependencies.queue.withTaskLock) {
        await dependencies.queue.withTaskLock(job.taskId, () => processJob(job));
      } else {
        await processJob(job);
      }
    });
    if (!schedulingPaused) {
      for (const task of await dependencies.repository.listScheduledTasks()) {
        if (task.schedule.mode === 'cron' && task.schedule.cron) {
          await dependencies.scheduler.schedule(
            task.id,
            task.schedule.cron,
            task.schedule.timezone,
            {
              misfirePolicy: task.schedule.misfirePolicy,
              lastTriggeredAt: task.lastTriggeredAt,
            },
          );
        }
      }
    }
    const latestPending = new Map<
      string,
      Awaited<ReturnType<Repository['listDeliveryAttempts']>>[number]
    >();
    for (const attempt of await dependencies.repository.listDeliveryAttempts()) {
      const key = `${attempt.runId}:${attempt.destinationId}`;
      if (!latestPending.has(key) && ['pending', 'running'].includes(attempt.status)) {
        latestPending.set(key, attempt);
      }
    }
    for (const attempt of latestPending.values()) {
      void runDelivery(attempt).catch((error) => {
        app.log.error({ attemptId: attempt.id, err: error }, 'recovered delivery failed');
      });
    }
  });

  app.addHook('onClose', async () => {
    await inspections.closeAll();
    for (const controller of activeDeliveries.values()) controller.abort();
    const deliveryDeadline = Date.now() + 5_000;
    while (activeDeliveries.size > 0 && Date.now() < deliveryDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await dependencies.scheduler.close();
    if ((dependencies.scheduler as unknown) !== dependencies.queue)
      await dependencies.queue.close();
    await dependencies.repository.close();
  });

  return {
    app,
    get token() {
      return issuedToken;
    },
    async listen(listenOptions = {}) {
      return app.listen({
        host: listenOptions.host ?? '127.0.0.1',
        port: listenOptions.port ?? 0,
      });
    },
    async close() {
      await app.close();
    },
    issueSessionNonce(nonce: string) {
      validSessionNonces.add(nonce);
    },
  };
}

export { analyzePage } from './analyzer.js';
