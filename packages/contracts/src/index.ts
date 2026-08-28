export * from '@zhiyun/shared';

import type {
  AnalysisResult,
  ApiToken,
  ArtifactDescriptor,
  BrowserSettings,
  CrawlPlanDefinition,
  CrawlRun,
  CrawlTask,
  DatasetDiffEntry,
  DatasetDiffStats,
  DatasetRecord,
  DatasetSettings,
  DatasetStats,
  DeliveryAttempt,
  DomainEvent,
  ExtractedRecord,
  GeneratedBy,
  Pagination,
  NetworkPolicy,
  OutputDestination,
  PreferencePlatform,
  PreferenceSignal,
  PreferenceSignalInput,
  RecordChange,
  RequestSettings,
  RetentionPolicy,
  RuleDefinitionInput,
  RuleRepairProposal,
  RunLogEntry,
  RunRequestEntry,
  RuntimeCapabilities,
  RuntimeMetadata,
  Schedule,
  TaskCreate,
  TaskUpdate,
} from '@zhiyun/shared';

export interface RuleVersionRecord {
  id: string;
  ruleId: string;
  version: number;
  definition: CrawlPlanDefinition;
  generatedBy: GeneratedBy;
  createdAt: string;
}

export interface RuleRecord {
  id: string;
  taskId: string;
  name: string;
  activeVersionId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ActiveRuleRecord {
  rule: RuleRecord;
  version: RuleVersionRecord;
}

export interface TaskListItem extends CrawlTask {
  latestRun: CrawlRun | null;
}

export interface TaskDetail extends CrawlTask {
  activeRule: ActiveRuleRecord | null;
}

export interface RecordPage {
  items: ExtractedRecord[];
  nextCursor: string | null;
}

export interface DatasetRecordPage {
  items: DatasetRecord[];
  nextCursor: string | null;
  stats: DatasetStats;
}

export interface RecordChangePage {
  items: RecordChange[];
  nextCursor: string | null;
}

export interface DatasetDiffPage {
  items: DatasetDiffEntry[];
  nextCursor: string | null;
  stats: DatasetDiffStats;
}

export interface RunLogPage {
  items: RunLogEntry[];
  nextCursor: string | null;
}

export interface RunRequestPage {
  items: RunRequestEntry[];
  nextCursor: string | null;
}

export interface TaskPage {
  items: TaskListItem[];
  nextCursor: string | null;
}

export interface RunPage {
  items: CrawlRun[];
  nextCursor: string | null;
}

export interface DomainEventPage {
  items: DomainEvent[];
  nextCursor: number;
}

export interface PreferenceSignalPage {
  items: PreferenceSignal[];
  nextCursor: string | null;
}

export interface TrendSourceBinding {
  key: string;
  platform: PreferencePlatform;
  taskId: string | null;
  enabled: boolean;
  autoRefresh: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactContent {
  descriptor: ArtifactDescriptor;
  data: Buffer;
}

export interface RunSuccessOutcome {
  requestCount: number;
  recordCount: number;
  browserUsed: boolean;
  aiUsed: boolean;
  metadata: Record<string, unknown>;
  records: Array<{ sourceUrl: string; data: Record<string, unknown> }>;
}

export interface RepositoryTransaction {
  appendEvent(event: Omit<DomainEvent, 'id' | 'cursor' | 'createdAt'>): Promise<DomainEvent>;
}

export interface Repository {
  health(): Promise<void>;
  migrate(): Promise<void>;
  close(): Promise<void>;
  recoverInterruptedRuns(): Promise<number>;
  createTask(input: TaskCreate): Promise<CrawlTask>;
  listTasks(cursor?: string, limit?: number): Promise<TaskListItem[]>;
  getTask(id: string): Promise<TaskDetail | null>;
  updateTask(id: string, input: TaskUpdate, expectedRevision: number): Promise<CrawlTask | null>;
  deleteTask(id: string): Promise<boolean>;
  listTrendSourceBindings(): Promise<TrendSourceBinding[]>;
  getTrendSourceBinding(key: string): Promise<TrendSourceBinding | null>;
  upsertTrendSourceBinding(
    input: Pick<TrendSourceBinding, 'key' | 'platform' | 'taskId' | 'enabled' | 'autoRefresh'>,
  ): Promise<TrendSourceBinding>;
  updateTrendSourceBinding(
    key: string,
    input: Partial<Pick<TrendSourceBinding, 'taskId' | 'enabled' | 'autoRefresh'>>,
  ): Promise<TrendSourceBinding | null>;
  listPreferenceSignals(cursor?: string, limit?: number): Promise<PreferenceSignalPage>;
  upsertPreferenceSignal(
    input: PreferenceSignalInput & { targetKey: string },
  ): Promise<PreferenceSignal>;
  deletePreferenceSignal(id: string): Promise<boolean>;
  clearPreferenceSignals(): Promise<number>;
  listScheduledTasks(): Promise<
    Array<{
      id: string;
      schedule: Schedule;
      lastTriggeredAt: string | null;
      updatedAt: string;
    }>
  >;
  markScheduleTriggered(taskId: string, triggeredAt?: string): Promise<void>;
  getSchedulingPaused(): Promise<boolean>;
  setSchedulingPaused(paused: boolean): Promise<void>;
  setTaskBrowserSettings(id: string, settings: BrowserSettings): Promise<void>;
  listRules(taskId: string): Promise<Array<RuleRecord & { versions: RuleVersionRecord[] }>>;
  createRule(
    taskId: string,
    name: string,
    definition: RuleDefinitionInput,
    generatedBy: GeneratedBy,
  ): Promise<{ rule: RuleRecord; version: RuleVersionRecord }>;
  createRuleVersion(
    taskId: string,
    ruleId: string,
    definition: RuleDefinitionInput,
    generatedBy: GeneratedBy,
  ): Promise<RuleVersionRecord | null>;
  getActiveRule(taskId: string): Promise<ActiveRuleRecord | null>;
  createRun(taskId: string): Promise<CrawlRun>;
  listRuns(taskId: string): Promise<CrawlRun[]>;
  getRun(id: string): Promise<CrawlRun | null>;
  startRun(runId: string, taskId: string): Promise<boolean>;
  completeRun(runId: string, taskId: string, outcome: RunSuccessOutcome): Promise<void>;
  commitRunSuccess(
    runId: string,
    taskId: string,
    settings: DatasetSettings,
    datasetRecords: Array<{ sourceUrl: string; data: Record<string, unknown> }>,
    outcome: RunSuccessOutcome,
  ): Promise<DatasetStats>;
  failRun(runId: string, taskId: string, error: string, code?: string): Promise<void>;
  cancelRun(runId: string): Promise<CrawlRun | null>;
  requestRunCancellation(runId: string): Promise<CrawlRun | null>;
  setRunDeliveryStatus(runId: string, status: CrawlRun['deliveryStatus']): Promise<void>;
  listRecords(runId: string, cursor: string | undefined, limit: number): Promise<RecordPage>;
  recordData(runId: string): Promise<Array<Record<string, unknown>>>;
  projectDataset(
    taskId: string,
    runId: string,
    settings: DatasetSettings,
    records: Array<{ sourceUrl: string; data: Record<string, unknown> }>,
  ): Promise<DatasetStats>;
  applyRetention(
    taskId: string,
    policy: RetentionPolicy,
  ): Promise<{
    deletedRuns: number;
    deletedLogs: number;
    deletedArtifacts: number;
    retainedReferencedRuns: number;
    artifactStorageKeys: string[];
  }>;
  listDatasetRecords(
    taskId: string,
    cursor: string | undefined,
    limit: number,
    options?: {
      includeRemoved?: boolean;
      query?: string;
      filter?: Record<string, string | number | boolean | null>;
    },
  ): Promise<DatasetRecordPage>;
  listRecordChanges(
    taskId: string,
    cursor: string | undefined,
    limit: number,
    runId?: string,
  ): Promise<RecordChangePage>;
  diffRunRecords(
    taskId: string,
    fromRunId: string,
    toRunId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<DatasetDiffPage>;
  appendRunLog(entry: Omit<RunLogEntry, 'id' | 'sequence' | 'createdAt'>): Promise<RunLogEntry>;
  listRunLogs(runId: string, cursor: string | undefined, limit: number): Promise<RunLogPage>;
  appendRunRequest(entry: Omit<RunRequestEntry, 'id' | 'createdAt'>): Promise<RunRequestEntry>;
  listRunRequests(
    runId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<RunRequestPage>;
  createOutputDestination(
    input: Pick<OutputDestination, 'name' | 'type' | 'config' | 'credentialRef' | 'enabled'>,
  ): Promise<OutputDestination>;
  listOutputDestinations(): Promise<OutputDestination[]>;
  getOutputDestination(id: string): Promise<OutputDestination | null>;
  updateOutputDestination(
    id: string,
    input: Partial<Pick<OutputDestination, 'name' | 'config' | 'credentialRef' | 'enabled'>>,
  ): Promise<OutputDestination | null>;
  deleteOutputDestination(id: string): Promise<boolean>;
  createDeliveryAttempt(
    input: Pick<DeliveryAttempt, 'destinationId' | 'taskId' | 'runId'>,
  ): Promise<DeliveryAttempt>;
  updateDeliveryAttempt(
    id: string,
    input: Partial<
      Pick<DeliveryAttempt, 'status' | 'attempt' | 'responseStatus' | 'error' | 'nextAttemptAt'>
    >,
  ): Promise<DeliveryAttempt | null>;
  listDeliveryAttempts(runId?: string): Promise<DeliveryAttempt[]>;
  createApiToken(
    input: Pick<ApiToken, 'name' | 'taskIds' | 'rateLimitPerMinute' | 'expiresAt'> & {
      tokenHash: string;
    },
  ): Promise<ApiToken>;
  listApiTokens(): Promise<ApiToken[]>;
  findApiToken(tokenHash: string): Promise<ApiToken | null>;
  revokeApiToken(id: string): Promise<boolean>;
  createRuleRepairProposal(
    input: Pick<RuleRepairProposal, 'taskId' | 'ruleId' | 'runId' | 'definition' | 'explanation'>,
  ): Promise<RuleRepairProposal>;
  listRuleRepairProposals(ruleId: string): Promise<RuleRepairProposal[]>;
  updateRuleRepairProposal(
    id: string,
    status: RuleRepairProposal['status'],
  ): Promise<RuleRepairProposal | null>;
  markRuleRepairProposalTested(id: string): Promise<RuleRepairProposal | null>;
  appendEvent(event: Omit<DomainEvent, 'id' | 'cursor' | 'createdAt'>): Promise<DomainEvent>;
  listEvents(after: number, limit: number): Promise<DomainEventPage>;
  getIdempotency(
    scope: string,
    key: string,
  ): Promise<{ fingerprint: string; response: unknown } | null>;
  putIdempotency(scope: string, key: string, fingerprint: string, response: unknown): Promise<void>;
  putArtifact(
    descriptor: Omit<ArtifactDescriptor, 'id' | 'createdAt'> & { storageKey: string },
  ): Promise<ArtifactDescriptor>;
  getArtifact(id: string): Promise<(ArtifactDescriptor & { storageKey: string }) | null>;
  enqueueRuntimeJob(job: RuntimeJob): Promise<void>;
  claimRuntimeJob(): Promise<RuntimeJob | null>;
  finishRuntimeJob(id: string): Promise<void>;
  cancelRuntimeJob(runId: string): Promise<boolean>;
  diagnostics?(): Promise<Record<string, unknown>>;
  createBackup?(): Promise<Buffer>;
  stageRestore?(data: Buffer): Promise<void>;
}

export interface RuntimeJob {
  id: string;
  taskId: string;
  runId?: string;
  scheduled?: boolean;
}

export interface QueueAdapter {
  start(handler: (job: RuntimeJob) => Promise<void>): Promise<void>;
  enqueue(taskId: string, runId: string): Promise<void>;
  cancel(runId: string): Promise<boolean>;
  withTaskLock?(taskId: string, action: () => Promise<void>): Promise<boolean>;
  close(): Promise<void>;
}

export interface SchedulerAdapter {
  schedule(
    taskId: string,
    cron: string,
    timezone: string,
    recovery?: { misfirePolicy: Schedule['misfirePolicy']; lastTriggeredAt: string | null },
  ): Promise<void>;
  unschedule(taskId: string): Promise<void>;
  close(): Promise<void>;
}

export interface CredentialStore {
  put(kind: string, value: unknown): Promise<string>;
  resolve<T = unknown>(reference: string): Promise<T>;
  delete(reference: string): Promise<void>;
}

export interface ArtifactStore {
  write(filename: string, data: Buffer): Promise<{ storageKey: string; size: number }>;
  writeStream(
    filename: string,
    data: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<{ storageKey: string; size: number }>;
  read(storageKey: string): Promise<Buffer>;
  readStream(storageKey: string): AsyncIterable<Uint8Array>;
  delete(storageKey: string): Promise<void>;
}

export interface HostCapabilities {
  metadata: RuntimeMetadata;
  capabilities: RuntimeCapabilities;
  saveArtifact?(
    artifact: ArtifactDescriptor,
    source: { storageKey: string } | { data: Buffer },
  ): Promise<{ saved: boolean }>;
  openExternal?(url: string): Promise<void>;
  notify?(title: string, body: string): Promise<void>;
  promptCredential?(
    kind:
      'task-secret-headers' | 'task-cookies' | 'task-proxy' | 'output-webhook' | 'output-postgres',
  ): Promise<{ reference: string } | { canceled: true }>;
  createLoginSession?(url: string): Promise<{ reference: string } | { canceled: true }>;
  saveBackup?(filename: string, data: Buffer): Promise<{ saved: boolean }>;
  selectRestoreBackup?(): Promise<{ canceled: true } | { data: Buffer }>;
  restartRuntime?(): Promise<void>;
}

export interface CrawlerService {
  crawl(input: {
    url: string;
    plan: CrawlPlanDefinition;
    requestSettings: RequestSettings;
    browserSettings: BrowserSettings;
    pagination: Pagination;
    networkPolicy?: NetworkPolicy;
    previewLimit?: number;
    signal?: AbortSignal;
    onProgress?: (event: {
      phase: string;
      progress: number;
      url?: string;
      requestCount?: number;
      recordCount?: number;
    }) => void | Promise<void>;
    onRequest?: (
      event: Omit<RunRequestEntry, 'id' | 'runId' | 'createdAt'>,
    ) => void | Promise<void>;
  }): Promise<{
    records: Array<{ sourceUrl: string; data: Record<string, unknown> }>;
    metadata: {
      requestCount: number;
      recordCount: number;
      browserUsed: boolean;
      aiUsed: boolean;
      durationMs?: number;
      warnings?: string[];
      urls?: string[];
    };
  }>;
}

export interface AiProvider {
  readonly name?: string;

  generateSchema(input: {
    instruction: string;
    sample?: string;
    context?: AiRequestContext;
  }): Promise<Array<{ name: string; type: 'string' | 'url' | 'number' | 'date' }>>;
  generateRule(input: {
    html: string;
    instruction: string;
    schema: CrawlPlanDefinition;
    context?: AiRequestContext;
  }): Promise<CrawlPlanDefinition>;
  extract(input: {
    html: string;
    instruction: string;
    schema: CrawlPlanDefinition;
    context?: AiRequestContext;
  }): Promise<Array<Record<string, unknown>>>;
  suggestRepair(input: {
    html: string;
    instruction: string;
    current: CrawlPlanDefinition;
    error: string;
    context?: AiRequestContext;
  }): Promise<{ definition: CrawlPlanDefinition; explanation: string }>;
  explainFailure(input: {
    error: string;
    failureContext?: Record<string, unknown>;
    context?: AiRequestContext;
  }): Promise<string>;
}

export interface AiRequestContext {
  taskId?: string;
  runId?: string;
}

export interface PageAnalyzer {
  analyze(input: {
    url: string;
    instruction: string;
    requestSettings: RequestSettings;
    browserSettings: BrowserSettings;
    useAi: boolean;
    forceBrowser: boolean;
  }): Promise<AnalysisResult>;
}
