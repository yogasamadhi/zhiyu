import type { CollectionDraft } from '@zhiyun/shared';
import type {
  BrowserSettings,
  BrowserActionCacheSummary,
  CrawlPlanDefinition,
  CrawlRun,
  CrawlTask,
  DatasetSettings,
  DatasetStats,
  GeneratedBy,
  RuleDefinitionInput,
  RuleRepairProposal,
  RunLogEntry,
  RunRequestEntry,
  Schedule,
  TaskCreate,
  TaskOrigin,
  TaskUpdate,
  CrawlCheckpoint,
  CrawlRequestCheckpoint,
  CrawlRequestSeed,
  CrawlRequestStage,
  CrawlBrowserPagination,
  CrawlSitemapNode,
  CrawlSitemapBatch,
  CrawlSitemapEntry,
  CrawlSitemapState,
} from '@zhiyun/shared';

export type CollectionTask = Omit<CrawlTask, 'outputBindings'>;
export type CollectionTaskCreate = Omit<TaskCreate, 'outputBindings'>;
export type CollectionTaskUpdate = Omit<TaskUpdate, 'outputBindings'>;

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

export interface CollectionTaskDetail extends CollectionTask {
  activeRule: ActiveRuleRecord | null;
}

export interface RunCompletionInput {
  requestCount: number;
  recordCount: number;
  browserUsed: boolean;
  aiUsed: boolean;
  metadata: Record<string, unknown>;
  datasetId: string;
  datasetSnapshotId: string;
  datasetStats: DatasetStats;
}

export interface StoredCrawlBatch {
  id: string;
  ordinal: number;
  requestId: string;
  sequence: number;
  storageKey: string;
  checksum: string;
  rowCount: number;
}

export interface SavedCrawlResult {
  recordCount: number;
  requestCount: number;
  browserUsed: boolean;
  aiUsed: boolean;
  actionCache?: BrowserActionCacheSummary;
  durationMs: number | null;
  warnings: string[];
  warningTotal?: number;
  urls: string[];
}

export interface CrawlCleanupIntent {
  runId: string;
  taskId: string;
  reason: 'canceled' | 'deleted' | 'terminal';
  availableAt: string;
  attempts: number;
  errorCode: string | null;
}

export interface CollectionRepository {
  migrate(): Promise<void>;
  close(): Promise<void>;
  createDraft(draft: CollectionDraft): Promise<CollectionDraft>;
  getDraft(id: string): Promise<CollectionDraft | null>;
  listDrafts(): Promise<CollectionDraft[]>;
  updateDraft(draft: CollectionDraft, expectedRevision: number): Promise<CollectionDraft | null>;
  deleteDraft(id: string, expectedRevision: number): Promise<boolean>;
  createTask(input: CollectionTaskCreate): Promise<CollectionTask>;
  createTaskWithInitialRule(input: {
    taskId: string;
    ruleId: string;
    versionId: string;
    task: TaskCreate;
    ruleName: string;
    definition: CrawlPlanDefinition;
    generatedBy?: GeneratedBy;
    origin?: TaskOrigin;
    status?: 'draft' | 'ready';
  }): Promise<{ taskId: string; ruleId: string; versionId: string }>;
  listTasks(
    cursor?: string,
    limit?: number,
    options?: {
      query?: string;
      status?: string;
      sort?: 'name' | 'updatedAt' | 'createdAt';
      direction?: 'asc' | 'desc';
      includeManaged?: boolean;
    },
  ): Promise<{
    totalCount?: number;
    items: CollectionTask[];
    nextCursor: string | null;
  }>;
  taskSummaries(
    query?: string,
    ids?: readonly string[],
  ): Promise<Array<{ id: string; name: string }>>;
  getTask(id: string): Promise<CollectionTaskDetail | null>;
  updateTask(
    id: string,
    input: CollectionTaskUpdate,
    expectedRevision: number,
  ): Promise<CollectionTask | null>;
  deleteTask(id: string, expectedRevision?: number): Promise<boolean>;
  setTaskBrowserSettings(id: string, settings: BrowserSettings): Promise<void>;
  listRules(taskId: string): Promise<Array<RuleRecord & { versions: RuleVersionRecord[] }>>;
  createRule(
    taskId: string,
    name: string,
    definition: RuleDefinitionInput,
    generatedBy: GeneratedBy,
    identity?: { ruleId: string; versionId: string },
  ): Promise<{ rule: RuleRecord; version: RuleVersionRecord }>;
  createRuleVersion(
    taskId: string,
    ruleId: string,
    definition: RuleDefinitionInput,
    generatedBy: GeneratedBy,
    versionId?: string,
    expectedActiveVersionId?: string,
  ): Promise<RuleVersionRecord | null>;
  getActiveRule(taskId: string): Promise<ActiveRuleRecord | null>;
  createRun(taskId: string, runId?: string, metadata?: Record<string, unknown>): Promise<CrawlRun>;
  listRuns(taskId: string): Promise<CrawlRun[]>;
  getRun(id: string): Promise<CrawlRun | null>;
  startRun(runId: string, taskId: string, allowRecovery?: boolean): Promise<boolean>;
  markRunPersisting(runId: string, taskId: string): Promise<boolean>;
  completeRun(runId: string, taskId: string, input: RunCompletionInput): Promise<CrawlRun | null>;
  failRun(
    runId: string,
    taskId: string,
    error: string,
    code: string,
    finalFailure?: boolean,
    retryPending?: boolean,
  ): Promise<CrawlRun | null>;
  requestRunCancellation(runId: string): Promise<CrawlRun | null>;
  cancelRun(runId: string): Promise<CrawlRun | null>;
  appendRunLog(entry: Omit<RunLogEntry, 'id' | 'sequence' | 'createdAt'>): Promise<RunLogEntry>;
  listRunLogs(runId: string, afterSequence?: number, limit?: number): Promise<RunLogEntry[]>;
  getRunDiagnosticLogs(runId: string): Promise<{ items: RunLogEntry[]; stepCount: number }>;
  clearRunDiagnostics(runId: string): Promise<number>;
  beginCrawlSession(runId: string, fingerprint: string): Promise<void>;
  saveCrawlBatch(
    runId: string,
    fingerprint: string,
    batch: Omit<StoredCrawlBatch, 'ordinal'>,
  ): Promise<void>;
  listCrawlBatches(
    runId: string,
    fingerprint: string,
    afterOrdinal?: number,
    requestId?: string,
  ): Promise<StoredCrawlBatch[]>;
  clearCrawlSession(runId: string): Promise<void>;
  requestCrawlCleanup(
    runId: string,
    taskId: string,
    reason: CrawlCleanupIntent['reason'],
  ): Promise<void>;
  getCrawlCleanup(runId: string): Promise<CrawlCleanupIntent | null>;
  listCrawlCleanup(afterRunId?: string, dueAt?: string): Promise<CrawlCleanupIntent[]>;
  retryCrawlCleanup(runId: string): Promise<void>;
  acknowledgeCrawlCleanup(runId: string): Promise<void>;
  listCrawlSessionOwners(
    afterRunId?: string,
  ): Promise<Array<{ runId: string; taskId: string; fingerprint: string }>>;
  listCrawlRequests(
    runId: string,
    fingerprint: string,
    stage?: CrawlRequestStage,
    afterOrdinal?: number,
  ): Promise<CrawlRequestCheckpoint[]>;
  ensureCrawlRequest(
    runId: string,
    fingerprint: string,
    seed: CrawlRequestSeed,
    maxRequests: number,
  ): Promise<CrawlRequestCheckpoint | null>;
  reserveCrawlRecords(
    runId: string,
    fingerprint: string,
    requestId: string,
    available: number,
    maxRecords: number,
  ): Promise<number>;
  completeCrawlRequest(
    runId: string,
    fingerprint: string,
    requestId: string,
    result: Parameters<CrawlCheckpoint['complete']>[1],
    maxRequests: number,
  ): Promise<CrawlRequestCheckpoint>;
  getCrawlSummary(runId: string, fingerprint: string): ReturnType<CrawlCheckpoint['summary']>;
  beginBrowserRound(
    runId: string,
    fingerprint: string,
    input: Parameters<CrawlBrowserPagination['begin']>[0],
  ): ReturnType<CrawlBrowserPagination['begin']>;
  listBrowserSelected(
    runId: string,
    fingerprint: string,
    requestId: string,
    round: number,
    afterPosition?: number,
  ): Promise<number[]>;
  completeBrowserRound(
    runId: string,
    fingerprint: string,
    requestId: string,
    round: number,
    state: Parameters<CrawlBrowserPagination['complete']>[2],
  ): Promise<void>;
  getCrawlResult(runId: string, fingerprint: string): Promise<SavedCrawlResult | null>;
  saveCrawlResult(runId: string, fingerprint: string, result: SavedCrawlResult): Promise<void>;
  enqueueSitemapRoot(
    runId: string,
    fingerprint: string,
    node: Omit<CrawlSitemapNode, 'ordinal'>,
    maxSitemaps: number,
  ): Promise<void>;
  listSitemapNodes(
    runId: string,
    fingerprint: string,
    afterOrdinal?: number,
  ): Promise<CrawlSitemapNode[]>;
  stageSitemapBatch(
    runId: string,
    fingerprint: string,
    input: {
      batch: CrawlSitemapBatch;
      id: string;
      checksum: string;
      storageKey: string;
      maxSitemaps: number;
      maxUrls: number;
    },
  ): Promise<void>;
  getSitemapState(runId: string, fingerprint: string): Promise<CrawlSitemapState>;
  listSitemapBatches(
    runId: string,
    fingerprint: string,
    afterOrdinal?: number,
  ): Promise<StoredCrawlBatch[]>;
  listSitemapEntries(
    runId: string,
    fingerprint: string,
    sorted: boolean,
    cursor?: { ordinal: number; modified: number },
  ): Promise<Array<CrawlSitemapEntry & { ordinal: number; modified: number }>>;
  appendRunRequest(entry: Omit<RunRequestEntry, 'id' | 'createdAt'>): Promise<RunRequestEntry>;
  listRunRequests(
    runId: string,
    cursor?: string,
    limit?: number,
  ): Promise<{
    items: RunRequestEntry[];
    nextCursor: string | null;
  }>;
  listScheduledTasks(): Promise<
    Array<{
      id: string;
      schedule: Schedule;
      lastTriggeredAt: string | null;
      updatedAt: string;
    }>
  >;
  markScheduleTriggered(taskId: string, triggeredAt?: string): Promise<void>;
  createRuleRepairProposal(
    input: Pick<RuleRepairProposal, 'taskId' | 'ruleId' | 'runId' | 'definition' | 'explanation'>,
  ): Promise<RuleRepairProposal>;
  listRuleRepairProposals(ruleId: string): Promise<RuleRepairProposal[]>;
  updateRuleRepairProposal(
    id: string,
    status: RuleRepairProposal['status'],
  ): Promise<RuleRepairProposal | null>;
  markRuleRepairProposalTested(id: string, tested?: boolean): Promise<RuleRepairProposal | null>;
}

export interface DatasetIngestionPort {
  beginIngestion(input: {
    sourceTaskId: string;
    sourceRunId: string;
    fingerprint: string;
    settings: DatasetSettings;
    dedupe: CrawlPlanDefinition['dedupe'];
  }): Promise<{ acceptedCount: number; committed: boolean }>;
  stageBatch(input: {
    sourceRunId: string;
    fingerprint: string;
    batchKey: string;
    checksum: string;
    artifactKey: string;
    records: Array<{ sourceUrl: string; data: Record<string, unknown> }>;
    maxRecords: number;
  }): Promise<{ acceptedCount: number; totalCount: number; reused: boolean }>;
  commitIngestion(
    sourceRunId: string,
    fingerprint: string,
  ): ReturnType<DatasetIngestionPort['commitRunRecords']>;
  discardIngestion(sourceRunId: string): Promise<void>;
  commitRunRecords(input: {
    sourceTaskId: string;
    sourceRunId: string;
    settings: DatasetSettings;
    records: Array<{ sourceUrl: string; data: Record<string, unknown> }>;
  }): Promise<{
    dataset: { id: string };
    snapshot: { id: string };
    stats: DatasetStats;
    reused: boolean;
  }>;
}

export interface CollectionServiceContract {
  getTask(id: string): Promise<CollectionTaskDetail | null>;
  persistRun(input: {
    runId: string;
    taskId: string;
    records: Array<{ sourceUrl: string; data: Record<string, unknown> }>;
    requestCount: number;
    browserUsed: boolean;
    aiUsed: boolean;
    metadata: Record<string, unknown>;
  }): Promise<CrawlRun>;
}
