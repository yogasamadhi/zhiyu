import type {
  BrowserSettings,
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

export interface CollectionRepository {
  migrate(): Promise<void>;
  close(): Promise<void>;
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
  ): Promise<{
    items: CollectionTask[];
    nextCursor: string | null;
  }>;
  getTask(id: string): Promise<CollectionTaskDetail | null>;
  updateTask(
    id: string,
    input: CollectionTaskUpdate,
    expectedRevision: number,
  ): Promise<CollectionTask | null>;
  deleteTask(id: string): Promise<boolean>;
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
  startRun(runId: string, taskId: string, allowRecovery?: boolean): Promise<boolean>;
  markRunPersisting(runId: string, taskId: string): Promise<boolean>;
  completeRun(runId: string, taskId: string, input: RunCompletionInput): Promise<CrawlRun | null>;
  failRun(
    runId: string,
    taskId: string,
    error: string,
    code: string,
    finalFailure?: boolean,
  ): Promise<CrawlRun | null>;
  requestRunCancellation(runId: string): Promise<CrawlRun | null>;
  cancelRun(runId: string): Promise<CrawlRun | null>;
  appendRunLog(entry: Omit<RunLogEntry, 'id' | 'sequence' | 'createdAt'>): Promise<RunLogEntry>;
  listRunLogs(runId: string, afterSequence?: number, limit?: number): Promise<RunLogEntry[]>;
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
  markRuleRepairProposalTested(id: string): Promise<RuleRepairProposal | null>;
}

export interface DatasetIngestionPort {
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
