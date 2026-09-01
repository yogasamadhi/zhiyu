import type {
  AiProvider,
  AnalysisResult,
  BrowserSettings,
  CrawlPlanDefinition,
  CrawlRun,
  CrawlerService,
  DatasetSettings,
  GeneratedBy,
  NetworkPolicy,
  Pagination,
  RequestSettings,
  RuleRepairProposal,
  RuleVersionRecord,
  TaskCreate,
  TaskOrigin,
} from '@zhiyun/contracts';
import type {
  AiConversation,
  AiConversationStatus,
  AiDraftVersion,
  AiMessage,
  AiProviderSettings,
  AiTaskDraft,
  AiToolInvocation,
  AiToolStatus,
  AiTurn,
  SiteCandidate,
} from '../domain/index.js';

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
  createTaskWithInitialRule(input: {
    taskId: string;
    ruleId: string;
    versionId: string;
    task: TaskCreate;
    ruleName: string;
    definition: CrawlPlanDefinition;
    generatedBy?: GeneratedBy;
    origin?: TaskOrigin;
  }): Promise<{ taskId: string; ruleId: string; versionId: string }>;
}

export interface AiConversationRepository {
  migrate(): Promise<void>;
  close(): Promise<void>;
  createConversation(input?: { id?: string; title?: string }): Promise<AiConversation>;
  listConversations(
    cursor?: string,
    limit?: number,
  ): Promise<{
    items: AiConversation[];
    nextCursor: string | null;
  }>;
  getConversation(id: string): Promise<AiConversation | null>;
  updateConversation(
    id: string,
    input: Partial<
      Pick<AiConversation, 'title' | 'committedTaskId' | 'lastError' | 'archivedAt'> & {
        status: AiConversationStatus;
      }
    >,
  ): Promise<AiConversation | null>;
  deleteConversation(id: string): Promise<boolean>;
  appendMessage(input: {
    id?: string;
    conversationId: string;
    turnId?: string | null;
    role: AiMessage['role'];
    content: string;
  }): Promise<AiMessage>;
  listMessages(conversationId: string, limit?: number): Promise<AiMessage[]>;
  createTurn(input: { id?: string; conversationId: string; attempt?: number }): Promise<AiTurn>;
  getTurn(id: string): Promise<AiTurn | null>;
  updateTurn(
    id: string,
    input: Partial<
      Pick<
        AiTurn,
        | 'status'
        | 'modelRounds'
        | 'toolCalls'
        | 'inputTokens'
        | 'outputTokens'
        | 'error'
        | 'startedAt'
        | 'finishedAt'
      >
    >,
  ): Promise<AiTurn | null>;
  createDraft(conversationId: string, draft: AiTaskDraft): Promise<AiDraftVersion>;
  getLatestDraft(conversationId: string): Promise<AiDraftVersion | null>;
  createToolInvocation(input: {
    id?: string;
    conversationId: string;
    turnId: string;
    toolCallId: string;
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<AiToolInvocation>;
  updateToolInvocation(
    id: string,
    input: {
      status: AiToolStatus;
      result?: Record<string, unknown> | null;
      error?: string | null;
    },
  ): Promise<AiToolInvocation | null>;
  listToolInvocations(turnId: string): Promise<AiToolInvocation[]>;
  getProviderSettings(): Promise<AiProviderSettings>;
  updateProviderSettings(
    input: Pick<AiProviderSettings, 'baseUrl' | 'model' | 'apiKeyRef' | 'testedAt'>,
    expectedRevision: number,
  ): Promise<AiProviderSettings | null>;
  failInterruptedTurns(): Promise<number>;
  cleanupInactive(before: string): Promise<number>;
}

export interface AgentRuntimeTool {
  name:
    | 'search_sites'
    | 'inspect_page'
    | 'update_task_draft'
    | 'generate_rule'
    | 'test_rule'
    | 'present_draft';
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>>;
}

export interface AgentRuntimePort {
  runTurn(input: {
    conversationId: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    facts: Array<{ name: AgentRuntimeTool['name']; result: Record<string, unknown> }>;
    draft: AiTaskDraft;
    tools: AgentRuntimeTool[];
    signal: AbortSignal;
    onEvent(event: AgentRuntimeEvent): Promise<void> | void;
  }): Promise<{
    content: string;
    modelRounds: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
  }>;
}

export type AgentRuntimeEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-start'; toolCallId: string; name: string; arguments: Record<string, unknown> }
  | {
      type: 'tool-end';
      toolCallId: string;
      name: string;
      result: Record<string, unknown>;
      isError: boolean;
    };

export interface WebSearchPort {
  search(query: string, signal: AbortSignal): Promise<SiteCandidate[]>;
}

export interface MutableAiProviderPort extends AiProviderPort {
  configured(): boolean;
  current(): AiProviderPort;
  replace(provider: AiProviderPort): void;
}

export interface AiAssistanceServiceContract {
  analyzeDraftTaskRule(
    task: TaskCreate,
    options: { useAi: boolean; forceBrowser: boolean },
  ): Promise<AnalysisResult>;
  analyzeTaskRule(
    taskId: string,
    options: { useAi: boolean; forceBrowser: boolean },
  ): Promise<AnalysisResult>;
  explainRunFailure(runId: string): Promise<string>;
  extractTask(
    taskId: string,
    options: { definition?: CrawlPlanDefinition; instruction?: string },
  ): Promise<{ records: Array<Record<string, unknown>>; sourceUrl: string; persisted: false }>;
  extractDraftTask(
    task: TaskCreate,
    options: { definition: CrawlPlanDefinition; instruction?: string },
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
