export {
  MockAiProvider,
  OpenAiCompatibleProvider,
  ScriptedChatProvider,
  createAiProvider,
  sanitizeHtmlForAi,
} from '@zhiyun/ai-runtime';
import type {
  AiCostBudget,
  AiTurnAccounting,
  CrawlPlanDefinition,
  Pagination,
  Schedule,
  TaskCreate,
} from '@zhiyun/contracts';

export const aiConversationStatuses = [
  'active',
  'awaiting_site_confirmation',
  'draft_ready',
  'testing',
  'awaiting_confirmation',
  'committing',
  'committed',
  'failed',
  'archived',
] as const;
export type AiConversationStatus = (typeof aiConversationStatuses)[number];
export type AiMessageRole = 'user' | 'assistant' | 'system';
export type AiTurnStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
export type AiToolStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface SiteCandidate {
  title: string;
  url: string;
  summary: string;
  source: 'bing' | 'duckduckgo';
}

/** Only these safe task fields can be authored from a conversation. */
export interface AiTaskDraft {
  collectionDraftId?: string;
  collectionRevision?: number;
  name: string;
  startUrl: string | null;
  instruction: string;
  schedule: Schedule;
  pagination: Pagination;
  browserEnabled: boolean;
  datasetMode: TaskCreate['datasetSettings']['mode'];
  keyFields: string[];
  siteCandidates: SiteCandidate[];
  selectedSiteUrl: string | null;
  loginRequired: boolean;
  rule: CrawlPlanDefinition | null;
  preview: Array<{ sourceUrl: string; data: Record<string, unknown> }>;
  testMetadata: Record<string, unknown> | null;
  confirmationPresentedAt: string | null;
}

export interface AiConversation {
  id: string;
  title: string;
  status: AiConversationStatus;
  latestDraftRevision: number;
  committedTaskId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface AiMessage {
  id: string;
  conversationId: string;
  turnId: string | null;
  role: AiMessageRole;
  content: string;
  sequence: number;
  createdAt: string;
}

export interface AiTurn {
  id: string;
  conversationId: string;
  status: AiTurnStatus;
  attempt: number;
  modelRounds: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  costBudget?: AiCostBudget | null;
  accounting?: AiTurnAccounting | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AiDraftVersion {
  conversationId: string;
  revision: number;
  draft: AiTaskDraft;
  createdAt: string;
}

export interface AiToolInvocation {
  id: string;
  conversationId: string;
  turnId: string;
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  result: Record<string, unknown> | null;
  status: AiToolStatus;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface AiProviderSettings {
  baseUrl: string | null;
  model: string | null;
  apiKeyRef: string | null;
  testedAt: string | null;
  revision: number;
  updatedAt: string;
}

export function emptyAiTaskDraft(): AiTaskDraft {
  return {
    name: '',
    startUrl: null,
    instruction: '',
    schedule: { mode: 'manual', timezone: 'Asia/Shanghai', misfirePolicy: 'skip' },
    pagination: { type: 'none' },
    browserEnabled: false,
    datasetMode: 'snapshot',
    keyFields: [],
    siteCandidates: [],
    selectedSiteUrl: null,
    loginRequired: false,
    rule: null,
    preview: [],
    testMetadata: null,
    confirmationPresentedAt: null,
  };
}

export function toSafeTaskCreate(draft: AiTaskDraft): TaskCreate {
  if (!draft.startUrl) throw new Error('Draft does not have a confirmed URL');
  return {
    name: draft.name.trim() || new URL(draft.startUrl).hostname,
    startUrl: draft.startUrl,
    instruction: draft.instruction.trim(),
    schedule: draft.schedule,
    requestSettings: {
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
    },
    browserSettings: {
      enabled: draft.browserEnabled,
      waitUntil: 'domcontentloaded',
      actions: [],
    },
    pagination: draft.pagination,
    outputSettings: { persistRecords: true },
    credentialBindings: {},
    datasetSettings: {
      mode: draft.datasetMode,
      keyFields: draft.keyFields,
      detectRemoved: true,
    },
    retentionPolicy: { runDays: null, maxRuns: null, artifactDays: null, logDays: null },
    networkPolicy: { allowPrivateNetworks: false, allowedHosts: [], allowedCidrs: [] },
    outputBindings: [],
  };
}

export function redactAiSensitiveText(value: string): string {
  return value
    .replaceAll(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replaceAll(
      /((?:authorization|cookie|api[-_ ]?key|password|token)\s*[:=：]\s*)[^\s,;]+/gi,
      '$1[REDACTED]',
    )
    .replaceAll(/(?:[A-Za-z]:\\|\/(?:Users|home|var|tmp)\/)[^\s"']+/g, '[LOCAL_PATH]');
}
