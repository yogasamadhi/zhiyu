import type {
  AiProvider,
  AnalysisResult,
  BrowserSettings,
  CrawlPlanDefinition,
  CrawlRun,
  CrawlerService,
  DatasetSettings,
  NetworkPolicy,
  Pagination,
  RequestSettings,
  RuleRepairProposal,
  RuleVersionRecord,
} from '@zhiyun/contracts';

export interface AnalyzeTaskRuleInput {
  taskId?: string;
  url: string;
  instruction: string;
  requestSettings: RequestSettings;
  browserSettings: BrowserSettings;
  useAi: boolean;
  forceBrowser: boolean;
  networkPolicy?: NetworkPolicy;
}

export interface CollectionTaskForAi {
  id: string;
  startUrl: string;
  instruction: string;
  requestSettings: RequestSettings;
  browserSettings: BrowserSettings;
  networkPolicy: NetworkPolicy;
  datasetSettings: DatasetSettings;
  pagination: Pagination;
}

export interface CollectionForAiPort {
  getTask(id: string): Promise<CollectionTaskForAi | null>;
  getRun(id: string): Promise<CrawlRun | null>;
  getRule(
    taskId: string,
    ruleId: string,
  ): Promise<{
    id: string;
    activeVersionId: string | null;
    versions: RuleVersionRecord[];
  } | null>;
  getActiveRule(
    taskId: string,
  ): Promise<{ activeVersionId: string | null; versions: RuleVersionRecord[] } | null>;
  createRuleVersion(
    taskId: string,
    ruleId: string,
    definition: CrawlPlanDefinition,
  ): Promise<RuleVersionRecord | null>;
  createRepairProposal(input: {
    taskId: string;
    ruleId: string;
    runId: string | null;
    definition: CrawlPlanDefinition;
    explanation: string;
  }): Promise<RuleRepairProposal>;
  listRepairProposals(ruleId: string): Promise<RuleRepairProposal[]>;
  markRepairProposalTested(id: string): Promise<RuleRepairProposal | null>;
  updateRepairProposal(
    id: string,
    status: RuleRepairProposal['status'],
  ): Promise<RuleRepairProposal | null>;
}

export interface AiAssistanceServiceContract {
  analyzeTaskRule(
    taskId: string,
    options: { useAi: boolean; forceBrowser: boolean },
  ): Promise<AnalysisResult>;
  explainRunFailure(runId: string): Promise<string>;
  extractTask(
    taskId: string,
    options: { definition?: CrawlPlanDefinition; instruction?: string },
  ): Promise<{ records: Array<Record<string, unknown>>; sourceUrl: string; persisted: false }>;
  createRepairProposal(
    taskId: string,
    ruleId: string,
    input: { error: string; runId: string | null },
  ): Promise<RuleRepairProposal & { diff: DefinitionChange[] }>;
  testRepairProposal(
    taskId: string,
    ruleId: string,
    proposalId: string,
  ): Promise<{ records: unknown[]; proposal: RuleRepairProposal | null }>;
  applyRepairProposal(
    taskId: string,
    ruleId: string,
    proposalId: string,
  ): Promise<RuleVersionRecord>;
  rejectRepairProposal(
    taskId: string,
    ruleId: string,
    proposalId: string,
  ): Promise<RuleRepairProposal>;
}

export type AiProviderPort = AiProvider;
export type CrawlerPort = CrawlerService;

export interface DefinitionChange {
  path: string;
  before: unknown;
  after: unknown;
}
