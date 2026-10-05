import type {
  AssistantDetail,
  AiCostBudget,
  AssistantConversation,
  AssistantContext,
  AssistantAction,
  AssistantCapabilities,
  AssistantLesson,
} from '@zhiyun/shared';
export type {
  AssistantDetail,
  AssistantConversation,
  AssistantContext,
  AssistantAction,
  AssistantCapabilities,
  AssistantLesson,
  AssistantMessageBlock,
} from '@zhiyun/shared';
import type {
  CollectionDraft,
  CollectionDraftPatch,
  CollectionPreviewRecord,
  RunDiagnostics,
  RecordQuery,
  DatasetSchemaDescription,
} from '@zhiyun/shared';
import type {
  AnalysisResult as RuleAnalysisResult,
  ApiToken,
  ArtifactDescriptor,
  BrowserAction,
  ConnectionState,
  CrawlPlanDefinition,
  CrawlRun,
  DatasetDiffEntry,
  DatasetDiffStats,
  DatasetRecord,
  DatasetStats,
  DeliveryAttempt,
  DomainEvent,
  GeneratedBy,
  InspectionElementSelection,
  InspectionStepResult,
  OutputDestination,
  ProblemDetails,
  RecordChange,
  RecordPage,
  RuleRecord,
  RuleRepairProposal,
  RuleVersionRecord,
  RunLogEntry,
  RunRequestEntry,
  RuntimeBootstrap,
  RuntimeCapabilities,
  RuntimeMetadata,
  RealtimeEvent,
  Schedule,
  QualityEvaluation,
  QualityPolicy,
  MonitoringAlert,
  MonitoringAlertRunPage,
  MonitoringAlertPage,
  TaskHealth,
  TaskTemplate,
  TaskCreate,
  TaskDetail,
  TaskListItem,
  TaskUpdate,
} from '@zhiyun/contracts';
import type {
  PreferenceContentType,
  PreferenceImport,
  PreferencePlatform,
  PreferenceProfile,
  PreferenceSignal,
  PreferenceSignalInput,
  RecruitmentFileInput,
  RecruitmentImportJob,
  RecruitmentImportMapping,
  RecruitmentImportMappingInput,
  RecruitmentImportPreview,
  RecruitmentJobCluster,
  RecruitmentSearchProfile,
  RecruitmentSearchProfileInput,
  RecruitmentSource,
  RecruitmentSourceKey,
  RecruitmentSyncResult,
  RecruitmentWorkflowState,
  RecruitmentWorkflowUpdate,
  TrendSource,
  TrendSourceUpdate,
  TrendsResponse,
} from '@zhiyun/shared';
import type { components } from './openapi.generated.js';
export * from './generated.js';
export type {
  components as OpenApiComponents,
  operations as OpenApiOperations,
  paths as OpenApiPaths,
} from './openapi.generated.js';

type ApiSchemas = components['schemas'];
export type AnalysisMethodDescriptor = ApiSchemas['AnalysisMethodDescriptor'];
export type AnalysisRecipeInput = ApiSchemas['AnalysisRecipeInput'];
export type AnalysisRecipe = ApiSchemas['AnalysisRecipe'];
export type AnalysisJobInput = ApiSchemas['AnalysisJobInput'];
export type AnalysisJob = ApiSchemas['AnalysisJob'];
export type AnalyticsResult = ApiSchemas['AnalysisResult'];
export type AnalysisResultPage = ApiSchemas['AnalysisResultPage'];
export type AnalysisResultComparison = ApiSchemas['AnalysisResultComparison'];
export type CorpusInput = ApiSchemas['CorpusInput'];
export type Corpus = ApiSchemas['Corpus'];
export type CorpusRecipeInput = ApiSchemas['CorpusRecipeInput'];
export type CorpusRecipe = ApiSchemas['CorpusRecipe'];
export type CorpusBuild = ApiSchemas['CorpusBuild'];
export type CorpusVersion = ApiSchemas['CorpusVersion'];
export type DatasetCleaningRecipe = ApiSchemas['CleaningRecipe'];
export type DatasetCleaningRecipeVersion = ApiSchemas['CleaningRecipeVersion'];
export type DatasetCleaningSession = ApiSchemas['CleaningSession'];
export type DatasetCleaningSessionDetail = ApiSchemas['CleaningSessionDetail'];

export interface RuntimeBridge {
  getBootstrap(): Promise<RuntimeBootstrap>;
  onBootstrapChanged(listener: (bootstrap: RuntimeBootstrap) => void): () => void;
}

declare global {
  interface Window {
    zhiyunRuntime?: RuntimeBridge;
  }
}

export class ApiError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.detail);
    this.name = 'ApiError';
  }

  get status(): number {
    return this.problem.status;
  }
}

type ConnectionListener = (state: ConnectionState) => void;
type DomainEventListener = (event: DomainEvent) => void;
type RealtimeEventListener = (event: RealtimeEvent) => void;
type RuntimeResetListener = () => void;

export interface RuntimeGraph {
  profileId: string;
  graphRevision: string;
  plugins: Array<{ id: string; version: string; dependencies: string[] }>;
  routes: Array<{
    operationId: string;
    method: string;
    path: string;
    ownerPluginId: string;
    requiredPermission: string | null;
  }>;
  uiContributions: Array<{
    id: string;
    kind: 'route' | 'navigation' | 'panel' | 'command';
    ownerPluginId: string;
  }>;
}

export interface DatasetPageResult {
  items: DatasetRecord[];
  nextCursor: string | null;
  stats: DatasetStats;
}

export interface RecruitmentSourceView extends RecruitmentSource {
  searchUrl: string;
}

export interface RecruitmentClusterPage {
  items: RecruitmentJobCluster[];
  nextCursor: string | null;
}

export interface CrawlerAssistantConversation {
  id: string;
  title: string;
  status:
    | 'active'
    | 'awaiting_site_confirmation'
    | 'draft_ready'
    | 'testing'
    | 'awaiting_confirmation'
    | 'committing'
    | 'committed'
    | 'failed'
    | 'archived';
  latestDraftRevision: number;
  committedTaskId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface CrawlerAssistantMessage {
  id: string;
  conversationId: string;
  turnId: string | null;
  role: 'user' | 'assistant' | 'system';
  content: string;
  sequence: number;
  createdAt: string;
}

export interface CrawlerAssistantDraft {
  conversationId: string;
  revision: number;
  draft: {
    collectionDraftId?: string;
    collectionRevision?: number;
    name: string;
    startUrl: string | null;
    instruction: string;
    schedule: Record<string, unknown>;
    pagination: Record<string, unknown>;
    browserEnabled: boolean;
    datasetMode: 'snapshot' | 'upsert' | 'append';
    keyFields: string[];
    siteCandidates: Array<{
      title: string;
      url: string;
      summary: string;
      source: 'bing' | 'duckduckgo';
    }>;
    selectedSiteUrl: string | null;
    loginRequired: boolean;
    rule: CrawlPlanDefinition | null;
    preview: Array<{ sourceUrl: string; data: Record<string, unknown> }>;
    testMetadata: Record<string, unknown> | null;
    confirmationPresentedAt: string | null;
  };
  createdAt: string;
}

export interface AiProviderSettingsView {
  providerId: string | null;
  baseUrl: string | null;
  model: string | null;
  catalog: AiProviderCatalogEntry[];
  catalogUpdatedAt: string;
  apiKeyConfigured: boolean;
  testedAt: string | null;
  revision: number;
  updatedAt: string;
  configured: boolean;
  writable: boolean;
  source: 'headless-environment' | 'desktop-persisted' | 'desktop-bootstrap' | 'mock';
}

export interface AiProviderCatalogEntry {
  id: string;
  name: string;
  baseUrl: string;
  documentationUrl: string;
  defaultModel: string;
  models: Array<{
    id: string;
    name: string;
    status: 'stable' | 'preview';
  }>;
}

export interface DatasetResource {
  name?: string | null;
  qualityStatus?: string;
  id: string;
  sourceTaskId: string;
  settings: {
    mode: 'snapshot' | 'upsert' | 'append';
    keyFields: string[];
    detectRemoved: boolean;
  };
  schemaVersion: number;
  currentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DatasetSnapshotResource {
  id: string;
  datasetId: string;
  sourceRunId: string | null;
  fingerprint: string;
  schemaVersion: number;
  status: 'projected' | 'preparing' | 'ready' | 'failed';
  rowCount: number;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DesktopDiagnostics {
  runtime: { version: string; generation: number; runtimeId: string; startedAt: string };
  browserResources: string | null;
  database: Record<string, unknown>;
}

export interface RuntimeReadiness {
  status: 'ready' | 'not-ready';
  checks: {
    database: Record<string, unknown> & { status: string };
    queue: Record<string, unknown> & { status: string };
    browser: Record<string, unknown> & { status: string };
    analyticsWorker: Record<string, unknown> & { status: string };
  };
}

export interface RuntimeSummary {
  schedulingPaused: boolean;
  startedAt: string;
  uptimeSeconds: number;
  queueBacklog: number;
  jobsByState: Record<string, number>;
  jobs: Array<{ id: string; type: string; state: string; updatedAt: string }>;
  analyticsWorkerStatus: string;
}

export type IdentityRole = 'admin' | 'editor' | 'viewer';

export type IdentityPermission =
  | 'workspace.read'
  | 'workspace.manage'
  | 'task.write'
  | 'run.execute'
  | 'analysis.write'
  | 'output.bind'
  | 'output.manage'
  | 'member.manage'
  | 'audit.read';

export interface IdentityUser {
  id: string;
  email: string;
  displayName: string;
  role: IdentityRole;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IdentityInvitation {
  id: string;
  email: string;
  role: IdentityRole;
  expiresAt: string;
  createdBy: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface IdentityAuditEvent {
  id: string;
  actorUserId: string | null;
  operationId: string;
  resourceType: string;
  resourceId: string | null;
  result: 'succeeded' | 'failed' | 'denied';
  traceId: string | null;
  networkHash: string | null;
  details: unknown;
  occurredAt: string;
}

export interface AuthSession {
  user: IdentityUser;
  csrfToken: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

export type ClientAuthenticationMode = 'runtime-token' | 'workspace-cookie';

function search(parameters: Record<string, string | number | boolean | undefined>): string {
  const value = new URLSearchParams();
  for (const [key, item] of Object.entries(parameters)) {
    if (item !== undefined) value.set(key, String(item));
  }
  const encoded = value.toString();
  return encoded ? `?${encoded}` : '';
}

function defaultBootstrap(): RuntimeBootstrap {
  return {
    baseUrl: '',
    sessionNonce: 'headless-development-session',
    runtimeId: '00000000-0000-4000-8000-000000000000',
    generation: 0,
    apiVersion: 'v2',
  };
}

function isMutation(method: string): boolean {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
}

export class ZhiYunClient {
  private bootstrap: RuntimeBootstrap = defaultBootstrap();
  private token: string | undefined;
  private connectPromise: Promise<void> | undefined;
  private controller = new AbortController();
  private readonly etags = new Map<string, string>();
  private readonly connectionListeners = new Set<ConnectionListener>();
  private readonly domainListeners = new Set<DomainEventListener>();
  private readonly realtimeListeners = new Set<RealtimeEventListener>();
  private readonly runtimeResetListeners = new Set<RuntimeResetListener>();
  private eventLoop: Promise<void> | undefined;
  private realtimeLoop: Promise<void> | undefined;
  private eventCursor = 0;
  private mode: RuntimeMetadata['mode'] = 'headless';
  private adminToken: string | undefined;
  private authenticationMode: ClientAuthenticationMode | undefined;
  private csrfToken: string | undefined;

  constructor(private readonly bridge = globalThis.window?.zhiyunRuntime) {
    if (bridge) {
      bridge.onBootstrapChanged((bootstrap) => this.setBootstrap(bootstrap));
    }
  }

  onConnectionState(listener: ConnectionListener): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }

  onDomainEvent(listener: DomainEventListener): () => void {
    this.domainListeners.add(listener);
    void this.startDomainEvents();
    return () => this.domainListeners.delete(listener);
  }

  onRealtimeEvent(listener: RealtimeEventListener): () => void {
    this.realtimeListeners.add(listener);
    void this.startRealtimeEvents();
    return () => this.realtimeListeners.delete(listener);
  }

  onRuntimeReset(listener: RuntimeResetListener): () => void {
    this.runtimeResetListeners.add(listener);
    return () => this.runtimeResetListeners.delete(listener);
  }

  setAdminToken(token: string): void {
    this.adminToken = token;
    this.token = undefined;
    this.authenticationMode = undefined;
    this.csrfToken = undefined;
    this.connectPromise = undefined;
  }

  getAuthenticationMode(): ClientAuthenticationMode | undefined {
    return this.authenticationMode;
  }

  private emitConnection(state: ConnectionState): void {
    for (const listener of this.connectionListeners) listener(state);
  }

  private setBootstrap(bootstrap: RuntimeBootstrap): void {
    if (
      bootstrap.generation === this.bootstrap.generation &&
      bootstrap.baseUrl === this.bootstrap.baseUrl
    )
      return;
    if (!this.bootstrap.baseUrl) {
      // The Desktop Main process can publish its first bootstrap while getBootstrap() is still
      // resolving. This is initial connection establishment, not a Runtime reset: aborting and
      // clearing the active Graph Query here would strand its observer in a pending state.
      this.bootstrap = bootstrap;
      return;
    }
    this.controller.abort('Runtime generation changed');
    this.controller = new AbortController();
    this.bootstrap = bootstrap;
    this.token = undefined;
    this.authenticationMode = undefined;
    this.csrfToken = undefined;
    this.connectPromise = undefined;
    this.etags.clear();
    this.eventLoop = undefined;
    this.realtimeLoop = undefined;
    this.eventCursor = 0;
    for (const listener of this.runtimeResetListeners) listener();
    this.emitConnection({ status: 'reconnecting', attempt: 1 });
    if (this.domainListeners.size > 0) void this.startDomainEvents();
    if (this.realtimeListeners.size > 0) void this.startRealtimeEvents();
  }

  async connect(): Promise<void> {
    if (this.token || this.authenticationMode === 'workspace-cookie') return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = (async () => {
      this.emitConnection({ status: 'connecting' });
      if (this.bridge) this.bootstrap = await this.bridge.getBootstrap();
      const sessionCredentials: RequestCredentials = this.bridge ? 'omit' : 'include';
      let response = await fetch(`${this.bootstrap.baseUrl}/api/v2/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: sessionCredentials,
        body: JSON.stringify(
          this.adminToken
            ? { adminToken: this.adminToken }
            : { nonce: this.bootstrap.sessionNonce },
        ),
        signal: this.controller.signal,
      });
      if (response.status === 401 && !this.bridge && typeof window !== 'undefined') {
        const entered = window.prompt('请输入 ZhiYun 管理员 Token');
        if (entered) {
          this.adminToken = entered;
          response = await fetch(`${this.bootstrap.baseUrl}/api/v2/session`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: sessionCredentials,
            body: JSON.stringify({ adminToken: entered }),
            signal: this.controller.signal,
          });
        }
      }
      if (response.status === 410) {
        const error = await this.toError(response);
        if (error instanceof ApiError && error.problem.code === 'IDENTITY_AUTH_REQUIRED') {
          this.authenticationMode = 'workspace-cookie';
          this.token = undefined;
          return;
        }
        throw error;
      }
      if (!response.ok) throw await this.toError(response);
      const result = (await response.json()) as {
        token: string;
        runtime: RuntimeMetadata;
        capabilities: RuntimeCapabilities;
      };
      if (result.runtime.generation !== this.bootstrap.generation) {
        throw new Error('Runtime generation changed during session negotiation');
      }
      this.token = result.token;
      this.authenticationMode = 'runtime-token';
      this.mode = result.runtime.mode;
      this.emitConnection({ status: 'connected', metadata: result.runtime });
    })().catch((error) => {
      this.connectPromise = undefined;
      this.emitConnection({
        status: 'degraded',
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
    return this.connectPromise;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    await this.connect();
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    if (this.authenticationMode === 'runtime-token') {
      headers.set('authorization', `Bearer ${this.token!}`);
    } else {
      headers.delete('authorization');
      if (this.csrfToken && isMutation(method)) headers.set('x-csrf-token', this.csrfToken);
    }
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    if (isMutation(method) && !headers.has('idempotency-key')) {
      headers.set('idempotency-key', crypto.randomUUID());
    }
    if (method === 'PUT' || method === 'DELETE') {
      const resourcePath = path.split('?')[0]!;
      const taskPath = path.match(/\/api\/v2\/tasks\/([^/?]+)/)?.[0];
      const etag =
        this.etags.get(resourcePath) ?? (taskPath ? this.etags.get(taskPath) : undefined);
      if (etag && !headers.has('if-match')) headers.set('if-match', etag);
    }
    const response = await fetch(`${this.bootstrap.baseUrl}${path}`, {
      ...init,
      method,
      headers,
      credentials: this.requestCredentials(),
      cache: 'no-store',
      signal: init.signal
        ? AbortSignal.any([this.controller.signal, init.signal])
        : this.controller.signal,
    });
    if (!response.ok) {
      this.clearWorkspaceSessionIfUnauthorized(response);
      throw await this.toError(response);
    }
    const etag = response.headers.get('etag');
    if (etag) this.etags.set(path.split('?')[0]!, etag);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  getAuthStatus() {
    return this.request<{ initialized: boolean }>('/api/v2/auth/status');
  }

  setupAuth(input: {
    bootstrapToken: string;
    email: string;
    displayName: string;
    password: string;
  }) {
    return this.request<IdentityUser>('/api/v2/auth/setup', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async login(input: { email: string; password: string }): Promise<AuthSession> {
    const session = await this.request<AuthSession>('/api/v2/auth/login', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    this.csrfToken = session.csrfToken;
    return session;
  }

  async logout(): Promise<void> {
    await this.request<void>('/api/v2/auth/logout', { method: 'POST' });
    this.csrfToken = undefined;
  }

  async getCurrentUser() {
    const session = await this.request<{
      user: IdentityUser;
      permissions: IdentityPermission[];
      csrfToken: string;
      idleExpiresAt: string;
      absoluteExpiresAt: string;
    }>('/api/v2/auth/me');
    this.csrfToken = session.csrfToken;
    return session;
  }

  async changePassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
    await this.request<void>('/api/v2/auth/password', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    // The server revokes every session only after the password has actually changed.
    this.csrfToken = undefined;
  }

  resetPassword(input: { resetToken: string; newPassword: string }) {
    return this.request<void>('/api/v2/auth/password', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  listMembers() {
    return this.request<{ items: IdentityUser[] }>('/api/v2/members');
  }

  updateMember(
    memberId: string,
    input: { role?: IdentityRole; disabled?: boolean; displayName?: string },
  ) {
    return this.request<IdentityUser>(`/api/v2/members/${encodeURIComponent(memberId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }

  createMemberPasswordReset(memberId: string) {
    return this.request<{ token: string; expiresAt: string }>(
      `/api/v2/members/${encodeURIComponent(memberId)}/password-reset`,
      { method: 'POST' },
    );
  }

  listInvitations() {
    return this.request<{ items: IdentityInvitation[] }>('/api/v2/invitations');
  }

  createInvitation(input: { email: string; role: IdentityRole }) {
    return this.request<{ invitation: IdentityInvitation; token: string }>('/api/v2/invitations', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  revokeInvitation(invitationId: string) {
    return this.request<void>(`/api/v2/invitations/${encodeURIComponent(invitationId)}`, {
      method: 'DELETE',
    });
  }

  acceptInvitation(input: { token: string; displayName: string; password: string }) {
    return this.request<IdentityUser>('/api/v2/invitations/accept', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  listAuditEvents(limit = 100, cursor?: string) {
    return this.request<{ items: IdentityAuditEvent[]; nextCursor: string | null }>(
      `/api/v2/audit-events${search({ limit, cursor })}`,
    );
  }

  listCollectionDrafts() {
    return this.request<{ items: CollectionDraft[]; nextCursor: string | null }>(
      '/api/v2/collection-drafts',
    );
  }
  createCollectionDraft(
    input: { taskId?: string; mode?: 'manual' | 'ai' | 'template' } = {},
    key: string = crypto.randomUUID(),
  ) {
    return this.request<CollectionDraft>('/api/v2/collection-drafts', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify(input),
    });
  }
  createExampleDraft(key: string = crypto.randomUUID()) {
    return this.request<CollectionDraft>('/api/v2/examples/products/drafts', {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: '{}',
    });
  }
  getCollectionDraft(id: string) {
    return this.request<CollectionDraft>(`/api/v2/collection-drafts/${encodeURIComponent(id)}`);
  }
  updateCollectionDraft(
    id: string,
    revision: number,
    patch: CollectionDraftPatch & { actor?: 'manual' | 'ai' },
  ) {
    return this.request<CollectionDraft>(`/api/v2/collection-drafts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'If-Match': `"${revision}"` },
      body: JSON.stringify(patch),
    });
  }
  previewCollectionDraft(id: string, revision: number) {
    return this.request<CollectionDraft>(
      `/api/v2/collection-drafts/${encodeURIComponent(id)}/preview`,
      {
        method: 'POST',
        headers: { 'If-Match': `"${revision}"`, 'Idempotency-Key': `preview-${id}-${revision}` },
      },
    );
  }
  commitCollectionDraft(id: string, revision: number, run = true) {
    return this.request<CollectionDraft>(
      `/api/v2/collection-drafts/${encodeURIComponent(id)}/commit`,
      {
        method: 'POST',
        headers: { 'If-Match': `"${revision}"`, 'Idempotency-Key': `commit-${id}` },
        body: JSON.stringify({ run }),
      },
    );
  }
  deleteCollectionDraft(id: string, revision: number) {
    return this.request<void>(`/api/v2/collection-drafts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'If-Match': `"${revision}"` },
    });
  }
  getDatasetFields(datasetId: string, snapshotId?: string) {
    return this.request<DatasetSchemaDescription>(
      `/api/v2/datasets/${encodeURIComponent(datasetId)}/fields${search({ snapshotId })}`,
    );
  }

  listTasks(
    limit = 100,
    cursor?: string,
    options: {
      query?: string;
      status?: string;
      sort?: 'name' | 'updatedAt' | 'createdAt';
      direction?: 'asc' | 'desc';
      includeManaged?: boolean;
    } = {},
  ) {
    return this.request<{ items: TaskListItem[]; nextCursor: string | null; totalCount?: number }>(
      `/api/v2/tasks${search({ limit, cursor, ...options })}`,
    );
  }

  createTask(input: TaskCreate) {
    return this.request<TaskDetail>('/api/v2/tasks', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  previewInitialRule(input: {
    task: TaskCreate;
    definition: CrawlPlanDefinition;
    ruleName?: string;
    limit?: number;
  }) {
    const previewKey = crypto.randomUUID();
    return this.request<{
      records: CollectionPreviewRecord[];
      previewKey: string;
    }>('/api/v2/rules/preview', {
      method: 'POST',
      headers: { 'Idempotency-Key': previewKey },
      body: JSON.stringify(input),
    });
  }

  createTaskWithInitialRule(input: {
    task: TaskCreate;
    definition: CrawlPlanDefinition;
    previewKey?: string;
    ruleName?: string;
    limit?: number;
    runAfterCreate?: boolean;
    saveAsDraft?: boolean;
  }) {
    return this.request<{ task: TaskDetail; run: CrawlRun | null }>('/api/v2/tasks/initialize', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  getTask(id: string) {
    return this.request<TaskDetail>(`/api/v2/tasks/${id}`);
  }

  updateTask(id: string, input: TaskUpdate) {
    return this.request<TaskDetail>(`/api/v2/tasks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  deleteTask(id: string) {
    return this.request<void>(`/api/v2/tasks/${id}`, { method: 'DELETE' });
  }

  previewSchedule(schedule: Schedule) {
    return this.request<{ nextRuns: string[] }>('/api/v2/schedules/preview', {
      method: 'POST',
      body: JSON.stringify(schedule),
    });
  }

  getTaskQualityPolicy(taskId: string) {
    return this.request<QualityPolicy>(`/api/v2/tasks/${taskId}/quality-policy`);
  }

  updateTaskQualityPolicy(taskId: string, policy: QualityPolicy) {
    return this.request<QualityPolicy>(`/api/v2/tasks/${taskId}/quality-policy`, {
      method: 'PUT',
      body: JSON.stringify(policy),
    });
  }

  getTaskHealth(taskId: string) {
    return this.request<TaskHealth>(`/api/v2/tasks/${taskId}/health`);
  }

  listTaskHealth(taskIds: string[]) {
    return this.request<TaskHealth[]>(
      `/api/v2/task-health${search({ taskIds: taskIds.join(',') })}`,
    );
  }

  listTaskQualityEvaluations(taskId: string, limit = 50) {
    return this.request<QualityEvaluation[]>(
      `/api/v2/tasks/${taskId}/quality-evaluations${search({ limit })}`,
    );
  }

  listTaskMonitoringAlerts(taskId: string, options: { cursor?: string; limit?: number } = {}) {
    return this.request<MonitoringAlertPage>(
      `/api/v2/tasks/${taskId}/monitoring-alerts${search(options)}`,
    );
  }

  listTaskMonitoringAlertRuns(
    taskId: string,
    alertId: string,
    options: { cursor?: string; limit?: number } = {},
  ) {
    return this.request<MonitoringAlertRunPage>(
      `/api/v2/tasks/${taskId}/monitoring-alerts/${alertId}/runs${search(options)}`,
    );
  }

  dismissTaskMonitoringAlert(taskId: string, alertId: string) {
    return this.request<MonitoringAlert>(`/api/v2/tasks/${taskId}/monitoring-alerts/${alertId}`, {
      method: 'DELETE',
    });
  }

  listTaskTemplates() {
    return this.request<TaskTemplate[]>('/api/v2/task-templates');
  }

  getTaskTemplate(templateId: string) {
    return this.request<TaskTemplate>(`/api/v2/task-templates/${encodeURIComponent(templateId)}`);
  }

  instantiateTaskTemplate(
    templateId: string,
    input: {
      name?: string;
      startUrl?: string;
      instruction?: string;
      parameters: Record<string, string>;
      schedule?: Schedule;
      task?: TaskCreate;
      definition?: CrawlPlanDefinition;
      previewKey?: string;
      limit?: number;
      saveAsDraft?: boolean;
    },
  ) {
    return this.request<TaskDetail>(
      `/api/v2/task-templates/${encodeURIComponent(templateId)}/instantiate`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  }

  getRuntimeMetadata() {
    return this.request<RuntimeMetadata>('/api/v2/runtime');
  }

  getRuntimeGraph() {
    return this.request<RuntimeGraph>('/api/v2/runtime/graph');
  }

  listTrendSources() {
    return this.request<TrendSource[]>('/api/v2/trend-sources');
  }

  bootstrapTrendSources() {
    return this.request<{
      sources: TrendSource[];
      runs: Array<Record<string, unknown>>;
    }>('/api/v2/trend-sources/bootstrap', { method: 'POST' });
  }

  updateTrendSource(key: string, input: TrendSourceUpdate) {
    return this.request<TrendSource>(`/api/v2/trend-sources/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  runTrendSource(key: string) {
    return this.request<Record<string, unknown>>(
      `/api/v2/trend-sources/${encodeURIComponent(key)}/run`,
      { method: 'POST' },
    );
  }

  runTrendSources() {
    return this.request<{ runs: Array<Record<string, unknown>> }>('/api/v2/trend-sources/run', {
      method: 'POST',
    });
  }

  getTrends(
    options: {
      platform?: PreferencePlatform;
      contentType?: PreferenceContentType;
      limit?: number;
    } = {},
  ) {
    return this.request<TrendsResponse>(`/api/v2/trends${search(options)}`);
  }

  getPreferenceProfile() {
    return this.request<PreferenceProfile>('/api/v2/preferences/profile');
  }

  listRecruitmentSources(profileId?: string) {
    return this.request<RecruitmentSourceView[]>(
      `/api/v2/recruitment/sources${search({ profileId })}`,
    );
  }

  getRecruitmentSource(sourceKey: RecruitmentSourceKey, profileId?: string) {
    return this.request<RecruitmentSourceView>(
      `/api/v2/recruitment/sources/${encodeURIComponent(sourceKey)}${search({ profileId })}`,
    );
  }

  syncRecruitmentSource(sourceKey: RecruitmentSourceKey) {
    return this.request<RecruitmentSyncResult>(
      `/api/v2/recruitment/sources/${encodeURIComponent(sourceKey)}/sync`,
      { method: 'POST' },
    );
  }

  listRecruitmentSearchProfiles() {
    return this.request<RecruitmentSearchProfile[]>('/api/v2/recruitment/search-profiles');
  }

  getRecruitmentSearchProfile(id: string) {
    return this.request<RecruitmentSearchProfile>(
      `/api/v2/recruitment/search-profiles/${encodeURIComponent(id)}`,
    );
  }

  createRecruitmentSearchProfile(input: RecruitmentSearchProfileInput) {
    return this.request<RecruitmentSearchProfile>('/api/v2/recruitment/search-profiles', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  updateRecruitmentSearchProfile(
    id: string,
    revision: number,
    profile: RecruitmentSearchProfileInput,
  ) {
    return this.request<RecruitmentSearchProfile>(
      `/api/v2/recruitment/search-profiles/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify({ revision, profile }) },
    );
  }

  deleteRecruitmentSearchProfile(id: string) {
    return this.request<void>(`/api/v2/recruitment/search-profiles/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  previewRecruitmentImport(input: RecruitmentFileInput) {
    return this.request<RecruitmentImportPreview>('/api/v2/recruitment/imports/preview', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  createRecruitmentImport(input: RecruitmentFileInput) {
    return this.request<RecruitmentImportJob>('/api/v2/recruitment/imports', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  getRecruitmentImport(id: string) {
    return this.request<RecruitmentImportJob>(
      `/api/v2/recruitment/imports/${encodeURIComponent(id)}`,
    );
  }

  getRecruitmentImportErrors(id: string) {
    return this.request<{
      items: Array<{ row: number; message: string; data?: unknown }>;
      artifactId: string | null;
    }>(`/api/v2/recruitment/imports/${encodeURIComponent(id)}/errors`);
  }

  listRecruitmentImportMappings(sourceKey?: RecruitmentSourceKey) {
    return this.request<RecruitmentImportMapping[]>(
      `/api/v2/recruitment/import-mappings${search({ sourceKey })}`,
    );
  }

  createRecruitmentImportMapping(input: RecruitmentImportMappingInput) {
    return this.request<RecruitmentImportMapping>('/api/v2/recruitment/import-mappings', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  updateRecruitmentImportMapping(
    id: string,
    revision: number,
    mapping: RecruitmentImportMappingInput,
  ) {
    return this.request<RecruitmentImportMapping>(
      `/api/v2/recruitment/import-mappings/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify({ revision, mapping }) },
    );
  }

  deleteRecruitmentImportMapping(id: string) {
    return this.request<void>(`/api/v2/recruitment/import-mappings/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  listRecruitmentJobClusters(
    options: {
      cursor?: string;
      limit?: number;
      profileId?: string;
      sourceKey?: RecruitmentSourceKey;
      workflowState?: RecruitmentWorkflowState;
      city?: string;
      keyword?: string;
      salaryMin?: number;
      salaryMax?: number;
      publishedAfter?: string;
      publishedBefore?: string;
      includeArchived?: boolean;
    } = {},
  ) {
    return this.request<RecruitmentClusterPage>(
      `/api/v2/recruitment/job-clusters${search(options)}`,
    );
  }

  getRecruitmentJobCluster(id: string, profileId?: string) {
    return this.request<RecruitmentJobCluster>(
      `/api/v2/recruitment/job-clusters/${encodeURIComponent(id)}${search({ profileId })}`,
    );
  }

  updateRecruitmentWorkflowState(id: string, input: RecruitmentWorkflowUpdate) {
    return this.request<RecruitmentJobCluster>(
      `/api/v2/recruitment/job-clusters/${encodeURIComponent(id)}/state`,
      { method: 'PUT', body: JSON.stringify(input) },
    );
  }

  mergeRecruitmentJobClusters(targetClusterId: string, sourceClusterIds: string[]) {
    return this.request<RecruitmentJobCluster>('/api/v2/recruitment/job-clusters/merge', {
      method: 'POST',
      body: JSON.stringify({ targetClusterId, sourceClusterIds }),
    });
  }

  splitRecruitmentJobCluster(clusterId: string, postingIds: string[]) {
    return this.request<RecruitmentJobCluster>(
      `/api/v2/recruitment/job-clusters/${encodeURIComponent(clusterId)}/split`,
      { method: 'POST', body: JSON.stringify({ postingIds }) },
    );
  }

  listPreferenceSignals(limit = 100, cursor?: string) {
    return this.request<{ items: PreferenceSignal[]; nextCursor: string | null }>(
      `/api/v2/preferences/signals${search({ limit, cursor })}`,
    );
  }

  upsertPreferenceSignal(input: PreferenceSignalInput) {
    return this.request<PreferenceSignal>('/api/v2/preferences/signals', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  deletePreferenceSignal(id: string) {
    return this.request<void>(`/api/v2/preferences/signals/${id}`, { method: 'DELETE' });
  }

  clearPreferenceSignals() {
    return this.request<{ deleted: number }>('/api/v2/preferences/signals', {
      method: 'DELETE',
    });
  }

  importPreferenceContent(input: PreferenceImport) {
    return this.request<PreferenceSignal>('/api/v2/preferences/import', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  analyzeTask(id: string, input: { useAi: boolean; forceBrowser: boolean }) {
    return this.request<RuleAnalysisResult>(`/api/v2/tasks/${id}/rule-analysis`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  analyzeDraftTask(
    task: TaskCreate,
    input: { useAi: boolean; forceBrowser: boolean; cacheScope?: string },
  ) {
    return this.request<RuleAnalysisResult>('/api/v2/rules/analyze', {
      method: 'POST',
      body: JSON.stringify({ task, ...input }),
    });
  }

  clearRuleCache(input: { taskId?: string; cacheScope?: string }) {
    return this.request<{ status: 'cleared'; deleted: number }>('/api/v2/rules/cache/clear', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  runDraftAiExtractDemo(task: TaskCreate, definition: CrawlPlanDefinition) {
    return this.request<{
      records: Array<Record<string, unknown>>;
      sourceUrl: string;
      persisted: false;
    }>('/api/v2/rules/ai-extract', {
      method: 'POST',
      body: JSON.stringify({ task, definition }),
    });
  }

  getAssistantCapabilities() {
    return this.request<AssistantCapabilities>('/api/v2/assistant/capabilities');
  }
  listAssistantConversations(cursor?: string) {
    return this.request<{ items: AssistantConversation[]; nextCursor: string | null }>(
      `/api/v2/assistant/conversations${search({ cursor })}`,
    );
  }
  createAssistantConversation(
    input: {
      title?: string;
      mode?: AssistantConversation['mode'];
      language?: 'zh' | 'en';
      context?: AssistantContext;
    } = {},
    key?: string,
  ) {
    return this.request<AssistantDetail>('/api/v2/assistant/conversations', {
      method: 'POST',
      body: JSON.stringify(input),
      ...(key ? { headers: { 'Idempotency-Key': key } } : {}),
    });
  }
  getAssistantConversation(id: string) {
    return this.request<AssistantDetail>(
      `/api/v2/assistant/conversations/${encodeURIComponent(id)}`,
    );
  }
  listAssistantMessages(id: string, before: string) {
    return this.request<AssistantDetail>(
      `/api/v2/assistant/conversations/${encodeURIComponent(id)}/messages${search({ before })}`,
    );
  }
  updateAssistantConversation(
    id: string,
    revision: number,
    input: Partial<Pick<AssistantConversation, 'title' | 'mode' | 'language' | 'lifecycle'>>,
  ) {
    return this.request<AssistantDetail>(
      `/api/v2/assistant/conversations/${encodeURIComponent(id)}`,
      { method: 'PATCH', headers: { 'If-Match': `"${revision}"` }, body: JSON.stringify(input) },
    );
  }
  deleteAssistantConversation(id: string, revision: number) {
    return this.request<{ deleted: boolean }>(
      `/api/v2/assistant/conversations/${encodeURIComponent(id)}`,
      { method: 'DELETE', headers: { 'If-Match': `"${revision}"` } },
    );
  }
  updateAssistantContext(id: string, revision: number, context: AssistantContext) {
    return this.request<AssistantDetail>(
      `/api/v2/assistant/conversations/${encodeURIComponent(id)}/context`,
      { method: 'PUT', headers: { 'If-Match': `"${revision}"` }, body: JSON.stringify(context) },
    );
  }
  postAssistantMessage(id: string, content: string, key?: string, costBudget?: AiCostBudget) {
    return this.request<{ turn: NonNullable<AssistantDetail['turn']> }>(
      `/api/v2/assistant/conversations/${encodeURIComponent(id)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ content, ...(costBudget ? { costBudget } : {}) }),
        ...(key ? { headers: { 'Idempotency-Key': key } } : {}),
      },
    );
  }
  cancelAssistantTurn(id: string) {
    return this.request<{ canceled: boolean }>(
      `/api/v2/assistant/turns/${encodeURIComponent(id)}/cancel`,
      { method: 'POST', body: '{}' },
    );
  }
  retryAssistantTurn(id: string) {
    return this.request<{ turn: NonNullable<AssistantDetail['turn']> }>(
      `/api/v2/assistant/turns/${encodeURIComponent(id)}/retry`,
      { method: 'POST', body: '{}' },
    );
  }
  prepareAssistantAction(
    id: string,
    kind: AssistantAction['kind'],
    parameters: Record<string, unknown> = {},
  ) {
    return this.request<AssistantAction>(
      `/api/v2/assistant/conversations/${encodeURIComponent(id)}/actions`,
      { method: 'POST', body: JSON.stringify({ kind, parameters }) },
    );
  }
  executeAssistantAction(id: string, revision: number) {
    return this.request<AssistantAction>(
      `/api/v2/assistant/actions/${encodeURIComponent(id)}/execute`,
      { method: 'POST', headers: { 'If-Match': `"${revision}"` }, body: '{}' },
    );
  }
  listAssistantLessons(language: 'zh' | 'en') {
    return this.request<AssistantLesson[]>(`/api/v2/assistant/lessons${search({ language })}`);
  }
  updateAssistantLesson(
    id: string,
    revision: number,
    input: {
      lessonId: string;
      event:
        'start' | 'pause' | 'resume' | 'skip' | 'restart' | 'verify' | 'take_over' | 'load_more';
      selection?: 'card' | 'price' | 'name';
      pages?: number;
      reference?: string;
    },
  ) {
    return this.request<AssistantDetail>(
      `/api/v2/assistant/conversations/${encodeURIComponent(id)}/lesson-progress`,
      { method: 'POST', headers: { 'If-Match': `"${revision}"` }, body: JSON.stringify(input) },
    );
  }
  startDraftLoginSession(id: string, revision: number, loginUrl?: string) {
    return this.request<{ canceled: boolean; draft?: CollectionDraft }>(
      `/api/v2/collection-drafts/${encodeURIComponent(id)}/browser-session/login`,
      {
        method: 'POST',
        headers: { 'If-Match': `"${revision}"` },
        body: JSON.stringify(loginUrl ? { loginUrl } : {}),
      },
    );
  }

  listCrawlerAssistantConversations(limit = 50, cursor?: string) {
    return this.request<{
      items: CrawlerAssistantConversation[];
      nextCursor: string | null;
    }>(`/api/v2/crawler-assistant/conversations${search({ limit, cursor })}`);
  }

  createCrawlerAssistantConversation(title?: string, collectionDraftId?: string) {
    return this.request<{
      conversation: CrawlerAssistantConversation;
      draft: CrawlerAssistantDraft;
    }>('/api/v2/crawler-assistant/conversations', {
      method: 'POST',
      body: JSON.stringify({
        ...(title ? { title } : {}),
        ...(collectionDraftId ? { collectionDraftId } : {}),
      }),
      ...(collectionDraftId
        ? { headers: { 'Idempotency-Key': `ai-draft-${collectionDraftId}` } }
        : {}),
    });
  }

  getCrawlerAssistantConversation(id: string) {
    return this.request<{
      conversation: CrawlerAssistantConversation;
      messages: CrawlerAssistantMessage[];
      draft: CrawlerAssistantDraft | null;
      providerConfigured: boolean;
    }>(`/api/v2/crawler-assistant/conversations/${encodeURIComponent(id)}`);
  }

  archiveCrawlerAssistantConversation(id: string) {
    return this.request<CrawlerAssistantConversation>(
      `/api/v2/crawler-assistant/conversations/${encodeURIComponent(id)}?archive=true`,
      { method: 'DELETE' },
    );
  }

  deleteCrawlerAssistantConversation(id: string) {
    return this.request<{ deleted: boolean }>(
      `/api/v2/crawler-assistant/conversations/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
  }

  postCrawlerAssistantMessage(id: string, content: string) {
    return this.request<{ message: CrawlerAssistantMessage; turn: { id: string; status: string } }>(
      `/api/v2/crawler-assistant/conversations/${encodeURIComponent(id)}/messages`,
      { method: 'POST', body: JSON.stringify({ content }) },
    );
  }

  selectCrawlerAssistantSite(id: string, url: string, revision: number) {
    return this.request<{ draft: CrawlerAssistantDraft; turn: { id: string; status: string } }>(
      `/api/v2/crawler-assistant/conversations/${encodeURIComponent(id)}/site-selection`,
      {
        method: 'POST',
        headers: { 'if-match': `"${revision}"` },
        body: JSON.stringify({ url }),
      },
    );
  }

  testCrawlerAssistantDraft(id: string, revision: number) {
    return this.request<CrawlerAssistantDraft>(
      `/api/v2/crawler-assistant/conversations/${encodeURIComponent(id)}/draft/test`,
      {
        method: 'POST',
        headers: { 'if-match': `"${revision}"` },
      },
    );
  }

  commitCrawlerAssistantDraft(id: string, revision: number) {
    return this.request<{ taskId: string; ruleId?: string; versionId?: string; replayed: boolean }>(
      `/api/v2/crawler-assistant/conversations/${encodeURIComponent(id)}/commit`,
      { method: 'POST', headers: { 'if-match': `"${revision}"` } },
    );
  }

  cancelCrawlerAssistantTurn(id: string) {
    return this.request(`/api/v2/crawler-assistant/turns/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    });
  }

  retryCrawlerAssistantTurn(id: string) {
    return this.request(`/api/v2/crawler-assistant/turns/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
    });
  }

  getAiProviderSettings() {
    return this.request<AiProviderSettingsView>('/api/v2/ai/provider');
  }

  promptAiProviderCredential(revision: number) {
    return this.request<{ canceled: boolean; apiKeyConfigured?: boolean; revision?: number }>(
      '/api/v2/ai/provider/credential/prompt',
      { method: 'POST', headers: { 'if-match': `"${revision}"` } },
    );
  }

  testAiProvider(input: { providerId: string; model: string }) {
    return this.request<{
      ok: true;
      providerId: string;
      baseUrl: string;
      model: string;
      testedAt: string;
    }>('/api/v2/ai/provider/test', { method: 'POST', body: JSON.stringify(input) });
  }

  updateAiProvider(input: { providerId: string; model: string }, revision: number) {
    return this.request<AiProviderSettingsView>('/api/v2/ai/provider', {
      method: 'PUT',
      headers: { 'if-match': `"${revision}"` },
      body: JSON.stringify(input),
    });
  }

  deleteAiProviderCredential(revision: number) {
    return this.request<AiProviderSettingsView>('/api/v2/ai/provider/credential', {
      method: 'DELETE',
      headers: { 'if-match': `"${revision}"` },
    });
  }

  listAnalysisMethods() {
    return this.request<AnalysisMethodDescriptor[]>('/api/v2/analytics/methods');
  }

  listAnalysisRecipes(limit = 100, cursor?: string) {
    return this.request<{ items: AnalysisRecipe[]; nextCursor: string | null }>(
      `/api/v2/analytics/recipes${search({ limit, cursor })}`,
    );
  }

  createAnalysisRecipe(input: AnalysisRecipeInput) {
    return this.request<AnalysisRecipe>('/api/v2/analytics/recipes', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  getAnalysisRecipe(id: string) {
    return this.request<AnalysisRecipe>(`/api/v2/analytics/recipes/${encodeURIComponent(id)}`);
  }

  updateAnalysisRecipe(id: string, input: AnalysisRecipeInput) {
    return this.request<AnalysisRecipe>(`/api/v2/analytics/recipes/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  deleteAnalysisRecipe(id: string) {
    return this.request<{ deleted: boolean }>(
      `/api/v2/analytics/recipes/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
  }

  listAnalysisJobs() {
    return this.request<AnalysisJob[]>('/api/v2/analytics/jobs');
  }

  createAnalysisJob(input: AnalysisJobInput) {
    return this.request<AnalysisJob>('/api/v2/analytics/jobs', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  getAnalysisJob(id: string) {
    return this.request<AnalysisJob>(`/api/v2/analytics/jobs/${encodeURIComponent(id)}`);
  }

  cancelAnalysisJob(id: string) {
    return this.request<AnalysisJob>(`/api/v2/analytics/jobs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    });
  }

  retryAnalysisJob(id: string) {
    return this.request<AnalysisJob>(`/api/v2/analytics/jobs/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
    });
  }

  getAnalysisResult(id: string) {
    return this.request<AnalyticsResult>(`/api/v2/analytics/results/${encodeURIComponent(id)}`);
  }

  getAnalysisResultPage(
    id: string,
    section: 'table' | 'series',
    collectionId: string,
    limit = 50,
    cursor?: string,
  ) {
    return this.request<AnalysisResultPage>(
      `/api/v2/analytics/results/${encodeURIComponent(id)}/collections/${section}/${encodeURIComponent(collectionId)}${search({ limit, cursor })}`,
    );
  }

  branchAnalysisResult(id: string, parameters: Record<string, unknown>) {
    return this.request<AnalysisJob>(
      `/api/v2/analytics/results/${encodeURIComponent(id)}/branches`,
      { method: 'POST', body: JSON.stringify({ parameters }) },
    );
  }

  compareAnalysisResults(leftId: string, rightId: string) {
    return this.request<AnalysisResultComparison>(
      `/api/v2/analytics/results/${encodeURIComponent(leftId)}/compare/${encodeURIComponent(rightId)}`,
    );
  }

  async exportAnalysisResult(id: string) {
    const result = await this.request<AnalyticsResult>(
      `/api/v2/analytics/results/${encodeURIComponent(id)}/exports`,
      { method: 'POST' },
    );
    const artifact = result.artifacts.find((entry) => entry.kind === 'analysis.export');
    if (artifact && typeof artifact.id === 'string' && typeof artifact.filename === 'string')
      await this.saveArtifact({ id: artifact.id, filename: artifact.filename });
    return result;
  }

  saveArtifact(artifact: { id: string; filename: string }) {
    return this.saveOrDownloadArtifact(artifact.id, artifact);
  }

  listCorpora(limit = 100, cursor?: string) {
    return this.request<{ items: Corpus[]; nextCursor: string | null }>(
      `/api/v2/corpora${search({ limit, cursor })}`,
    );
  }

  createCorpus(input: CorpusInput) {
    return this.request<Corpus>('/api/v2/corpora', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  getCorpus(id: string) {
    return this.request<Corpus>(`/api/v2/corpora/${encodeURIComponent(id)}`);
  }

  updateCorpus(id: string, input: CorpusInput) {
    return this.request<Corpus>(`/api/v2/corpora/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  deleteCorpus(id: string) {
    return this.request<{ deleted: boolean }>(`/api/v2/corpora/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  listCorpusRecipes(corpusId: string) {
    return this.request<CorpusRecipe[]>(`/api/v2/corpora/${encodeURIComponent(corpusId)}/recipes`);
  }

  createCorpusRecipe(corpusId: string, input: CorpusRecipeInput, key?: string) {
    return this.request<CorpusRecipe>(`/api/v2/corpora/${encodeURIComponent(corpusId)}/recipes`, {
      method: 'POST',
      ...(key ? { headers: { 'Idempotency-Key': key } } : {}),
      body: JSON.stringify(input),
    });
  }

  updateCorpusRecipe(corpusId: string, recipeId: string, input: CorpusRecipeInput) {
    return this.request<CorpusRecipe>(
      `/api/v2/corpora/${encodeURIComponent(corpusId)}/recipes/${encodeURIComponent(recipeId)}`,
      { method: 'PUT', body: JSON.stringify(input) },
    );
  }

  deleteCorpusRecipe(corpusId: string, recipeId: string) {
    return this.request<{ deleted: boolean }>(
      `/api/v2/corpora/${encodeURIComponent(corpusId)}/recipes/${encodeURIComponent(recipeId)}`,
      { method: 'DELETE' },
    );
  }

  createCorpusBuild(
    corpusId: string,
    input: { recipeId: string; snapshotId: string },
    key?: string,
  ) {
    return this.request<CorpusBuild>(`/api/v2/corpora/${encodeURIComponent(corpusId)}/builds`, {
      method: 'POST',
      ...(key ? { headers: { 'Idempotency-Key': key } } : {}),
      body: JSON.stringify(input),
    });
  }

  listCorpusBuilds(corpusId?: string, limit = 100) {
    return this.request<CorpusBuild[]>(`/api/v2/corpus-builds${search({ corpusId, limit })}`);
  }

  getCorpusBuild(id: string) {
    return this.request<CorpusBuild>(`/api/v2/corpus-builds/${encodeURIComponent(id)}`);
  }

  cancelCorpusBuild(id: string) {
    return this.request<CorpusBuild>(`/api/v2/corpus-builds/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    });
  }

  retryCorpusBuild(id: string) {
    return this.request<CorpusBuild>(`/api/v2/corpus-builds/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
    });
  }

  listCorpusVersions(corpusId: string, limit = 100) {
    return this.request<CorpusVersion[]>(
      `/api/v2/corpora/${encodeURIComponent(corpusId)}/versions${search({ limit })}`,
    );
  }

  getCorpusVersion(corpusId: string, versionId: string) {
    return this.request<CorpusVersion>(
      `/api/v2/corpora/${encodeURIComponent(corpusId)}/versions/${encodeURIComponent(versionId)}`,
    );
  }

  exportCorpusVersion(corpusId: string, versionId: string) {
    return this.request<{ versionId: string; artifacts: CorpusVersion['artifacts'] }>(
      `/api/v2/corpora/${encodeURIComponent(corpusId)}/versions/${encodeURIComponent(versionId)}/exports`,
      { method: 'POST' },
    );
  }

  runAiExtractDemo(id: string, definition?: CrawlPlanDefinition) {
    return this.request<{
      records: Array<Record<string, unknown>>;
      sourceUrl: string;
      persisted: false;
    }>(`/api/v2/tasks/${id}/ai/extract`, {
      method: 'POST',
      body: JSON.stringify(definition ? { definition } : {}),
    });
  }

  runTask(id: string) {
    return this.request<{ runId: string; status: CrawlRun['status'] }>(`/api/v2/tasks/${id}/runs`, {
      method: 'POST',
    });
  }

  listTaskRuns(id: string, limit = 100, cursor?: string) {
    return this.request<{ items: CrawlRun[]; nextCursor: string | null }>(
      `/api/v2/tasks/${id}/runs${search({ limit, cursor })}`,
    );
  }

  listRules(id: string) {
    return this.request<Array<RuleRecord & { versions: RuleVersionRecord[] }>>(
      `/api/v2/tasks/${id}/rules`,
    );
  }

  testRule(id: string, definition: CrawlPlanDefinition, limit = 10) {
    return this.request<{ records: CollectionPreviewRecord[] }>(`/api/v2/tasks/${id}/rules/test`, {
      method: 'POST',
      body: JSON.stringify({ definition, limit }),
    });
  }

  createRule(
    taskId: string,
    input: { name: string; definition: CrawlPlanDefinition; generatedBy: GeneratedBy },
  ) {
    return this.request<{ rule: RuleRecord; version: RuleVersionRecord }>(
      `/api/v2/tasks/${taskId}/rules`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  }

  createRuleVersion(
    taskId: string,
    ruleId: string,
    input: { definition: CrawlPlanDefinition; generatedBy: GeneratedBy },
  ) {
    return this.request<RuleVersionRecord>(`/api/v2/tasks/${taskId}/rules/${ruleId}/versions`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  diffRuleVersions(taskId: string, ruleId: string, from: number, to: number) {
    return this.request<{ changes: Array<{ path: string; before: unknown; after: unknown }> }>(
      `/api/v2/tasks/${taskId}/rules/${ruleId}/diff${search({ from, to })}`,
    );
  }

  rollbackRule(taskId: string, ruleId: string, version: number) {
    return this.request<RuleVersionRecord>(`/api/v2/tasks/${taskId}/rules/${ruleId}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ version }),
    });
  }

  listRepairProposals(taskId: string, ruleId: string) {
    return this.request<RuleRepairProposal[]>(
      `/api/v2/tasks/${taskId}/rules/${ruleId}/repair-proposals`,
    );
  }

  createRepairProposal(taskId: string, ruleId: string, error: string, runId: string | null = null) {
    return this.request<
      RuleRepairProposal & {
        diff: Array<{ path: string; before: unknown; after: unknown }>;
      }
    >(`/api/v2/tasks/${taskId}/rules/${ruleId}/repair-proposals`, {
      method: 'POST',
      body: JSON.stringify({ error, runId }),
    });
  }

  testRepairProposal(taskId: string, ruleId: string, proposalId: string) {
    return this.request<{
      records: CollectionPreviewRecord[];
      proposal: RuleRepairProposal;
    }>(`/api/v2/tasks/${taskId}/rules/${ruleId}/repair-proposals/${proposalId}/test`, {
      method: 'POST',
    });
  }

  reviewRepairProposal(
    taskId: string,
    ruleId: string,
    proposalId: string,
    action: 'apply' | 'reject',
  ) {
    return this.request<RuleVersionRecord | RuleRepairProposal>(
      `/api/v2/tasks/${taskId}/rules/${ruleId}/repair-proposals/${proposalId}/${action}`,
      { method: 'POST' },
    );
  }

  startLoginSession(taskId: string, loginUrl?: string) {
    return this.request<{ canceled: boolean; reference?: string; task?: TaskDetail }>(
      `/api/v2/tasks/${taskId}/browser-session/login`,
      {
        method: 'POST',
        body: JSON.stringify(loginUrl ? { loginUrl } : {}),
      },
    );
  }

  promptTaskCredential(
    taskId: string,
    kind: 'secretHeaders' | 'cookies' | 'proxy',
    revision: number,
  ) {
    return this.request<{ canceled?: boolean; task?: TaskDetail }>(
      `/api/v2/tasks/${taskId}/credentials/${kind}`,
      { method: 'POST', body: JSON.stringify({ revision }) },
    );
  }

  deleteTaskCredential(
    taskId: string,
    kind: 'secretHeaders' | 'cookies' | 'proxy',
    revision: number,
  ) {
    return this.request<TaskDetail>(`/api/v2/tasks/${taskId}/credentials/${kind}`, {
      method: 'DELETE',
      body: JSON.stringify({ revision }),
    });
  }

  listDatasets(
    limit = 100,
    cursor?: string,
    sourceTaskId?: string,
    options: {
      query?: string;
      sort?: 'updatedAt' | 'currentCount';
      direction?: 'asc' | 'desc';
    } = {},
  ) {
    return this.request<{
      items: DatasetResource[];
      nextCursor: string | null;
      totalCount?: number;
    }>(`/api/v2/datasets${search({ limit, cursor, sourceTaskId, ...options })}`);
  }

  getDatasetResource(datasetId: string) {
    return this.request<DatasetResource>(`/api/v2/datasets/${encodeURIComponent(datasetId)}`);
  }

  listDatasetSnapshots(datasetId: string) {
    return this.request<DatasetSnapshotResource[]>(
      `/api/v2/datasets/${encodeURIComponent(datasetId)}/snapshots`,
    );
  }

  previewDatasetCleaning(
    datasetId: string,
    input: ApiSchemas['CleaningPreviewInput'],
    signal?: AbortSignal,
  ) {
    return this.request<ApiSchemas['CleaningResult']>(
      `/api/v2/datasets/${encodeURIComponent(datasetId)}/cleaning/preview`,
      { method: 'POST', body: JSON.stringify(input), ...(signal ? { signal } : {}) },
    );
  }

  saveDatasetCleaningRecipe(datasetId: string, input: ApiSchemas['CleaningRecipeInput']) {
    return this.request<{ recipe: DatasetCleaningRecipe; version: DatasetCleaningRecipeVersion }>(
      `/api/v2/datasets/${encodeURIComponent(datasetId)}/cleaning/recipes`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  }

  listDatasetCleaningRecipes(datasetId: string) {
    return this.request<DatasetCleaningRecipe[]>(
      `/api/v2/datasets/${encodeURIComponent(datasetId)}/cleaning/recipes`,
    );
  }

  getDatasetCleaningRecipe(datasetId: string, recipeId: string, versionId?: string) {
    return this.request<{ recipe: DatasetCleaningRecipe; version: DatasetCleaningRecipeVersion }>(
      `/api/v2/datasets/${encodeURIComponent(datasetId)}/cleaning/recipes/${encodeURIComponent(recipeId)}${search({ versionId })}`,
    );
  }

  applyDatasetCleaning(
    datasetId: string,
    input: ApiSchemas['CleaningApplyInput'],
    signal?: AbortSignal,
  ) {
    return this.request<DatasetCleaningSessionDetail>(
      `/api/v2/datasets/${encodeURIComponent(datasetId)}/cleaning/sessions`,
      { method: 'POST', body: JSON.stringify(input), ...(signal ? { signal } : {}) },
    );
  }

  listDatasetCleaningSessions(datasetId: string) {
    return this.request<DatasetCleaningSession[]>(
      `/api/v2/datasets/${encodeURIComponent(datasetId)}/cleaning/sessions`,
    );
  }

  getDatasetCleaningSession(datasetId: string, sessionId: string) {
    return this.request<DatasetCleaningSessionDetail>(
      `/api/v2/datasets/${encodeURIComponent(datasetId)}/cleaning/sessions/${encodeURIComponent(sessionId)}`,
    );
  }

  selectDatasetCleaningStep(
    datasetId: string,
    sessionId: string,
    selectedStep: number,
    expectedRevision: number,
  ) {
    return this.request<DatasetCleaningSessionDetail>(
      `/api/v2/datasets/${encodeURIComponent(datasetId)}/cleaning/sessions/${encodeURIComponent(sessionId)}/selection`,
      { method: 'POST', body: JSON.stringify({ selectedStep, expectedRevision }) },
    );
  }

  createDatasetSnapshot(datasetId: string) {
    return this.request<DatasetSnapshotResource>(
      `/api/v2/datasets/${encodeURIComponent(datasetId)}/snapshots`,
      { method: 'POST' },
    );
  }

  getDatasetSnapshot(datasetId: string, snapshotId: string) {
    return this.request<DatasetSnapshotResource>(
      `/api/v2/datasets/${encodeURIComponent(datasetId)}/snapshots/${encodeURIComponent(snapshotId)}`,
    );
  }

  async findDatasetForTask(taskId: string) {
    const page = await this.listDatasets(1, undefined, taskId);
    return page.items[0] ?? null;
  }

  getDataset(
    datasetId: string,
    options: {
      limit?: number;
      cursor?: string;
      query?: string;
      filter?: string;
      filters?: RecordQuery['filters'];
      sort?: RecordQuery['sort'];
      includeRemoved?: boolean;
    } = {},
  ) {
    return this.request<DatasetPageResult>(
      `/api/v2/datasets/${encodeURIComponent(datasetId)}/records${search({ limit: options.limit ?? 100, ...options, filters: options.filters ? JSON.stringify(options.filters) : undefined, sort: options.sort ? JSON.stringify(options.sort) : undefined })}`,
    );
  }

  getDatasetChanges(datasetId: string, limit = 20, cursor?: string, runId?: string) {
    return this.request<{ items: RecordChange[]; nextCursor: string | null }>(
      `/api/v2/datasets/${encodeURIComponent(datasetId)}/changes${search({ limit, cursor, sourceRunId: runId })}`,
    );
  }

  diffDatasetRuns(datasetId: string, from: string, to: string, limit = 100, cursor?: string) {
    return this.request<{
      items: DatasetDiffEntry[];
      nextCursor: string | null;
      stats: DatasetDiffStats;
    }>(
      `/api/v2/datasets/${encodeURIComponent(datasetId)}/diff${search({ from, to, limit, cursor })}`,
    );
  }

  getRun(id: string) {
    return this.request<CrawlRun>(`/api/v2/runs/${id}`);
  }

  getRunDiagnostics(id: string) {
    return this.request<RunDiagnostics>(`/api/v2/runs/${encodeURIComponent(id)}/diagnostics`);
  }

  clearRunDiagnostics(id: string) {
    return this.request<{ runId: string; deletedSteps: number }>(
      `/api/v2/runs/${encodeURIComponent(id)}/diagnostics`,
      { method: 'DELETE' },
    );
  }

  cancelRun(id: string) {
    return this.request<CrawlRun>(`/api/v2/runs/${id}/cancel`, { method: 'POST' });
  }

  retryRun(id: string) {
    return this.request<{ runId: string; status: CrawlRun['status'] }>(`/api/v2/runs/${id}/retry`, {
      method: 'POST',
    });
  }

  explainRunFailure(id: string) {
    return this.request<{ explanation: string; persisted: false }>(
      `/api/v2/runs/${id}/explain-failure`,
      { method: 'POST' },
    );
  }

  getRunRecords(id: string, limit = 100, cursor?: string) {
    return this.request<RecordPage>(`/api/v2/runs/${id}/records${search({ limit, cursor })}`);
  }

  getRunLogs(id: string, limit = 100, cursor?: string) {
    return this.request<{ items: RunLogEntry[]; nextCursor: string | null }>(
      `/api/v2/runs/${id}/logs${search({ limit, cursor })}`,
    );
  }

  getRunRequests(id: string, limit = 100, cursor?: string) {
    return this.request<{ items: RunRequestEntry[]; nextCursor: string | null }>(
      `/api/v2/runs/${id}/requests${search({ limit, cursor })}`,
    );
  }

  listOutputDestinations() {
    return this.request<OutputDestination[]>('/api/v2/output-destinations');
  }

  createOutputDestination(input: {
    name: string;
    type: OutputDestination['type'];
    config: Record<string, unknown>;
    credential?: unknown;
    enabled?: boolean;
  }) {
    return this.request<OutputDestination>('/api/v2/output-destinations', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  updateOutputDestination(
    id: string,
    input: Partial<Pick<OutputDestination, 'name' | 'config' | 'enabled'>> & {
      credential?: unknown;
    },
  ) {
    return this.request<OutputDestination>(`/api/v2/output-destinations/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  deleteOutputDestination(id: string) {
    return this.request<void>(`/api/v2/output-destinations/${id}`, { method: 'DELETE' });
  }

  testOutputDestination(id: string) {
    return this.request<{ ok: boolean }>(`/api/v2/output-destinations/${id}/test`, {
      method: 'POST',
    });
  }

  promptOutputCredential(id: string) {
    return this.request<OutputDestination & { canceled?: boolean }>(
      `/api/v2/output-destinations/${id}/credential/prompt`,
      { method: 'POST' },
    );
  }

  listDeliveryAttempts(runId?: string) {
    return this.request<DeliveryAttempt[]>(`/api/v2/delivery-attempts${search({ runId })}`);
  }

  retryDeliveryAttempt(id: string) {
    return this.request<DeliveryAttempt>(`/api/v2/delivery-attempts/${id}/retry`, {
      method: 'POST',
    });
  }

  listApiTokens() {
    return this.request<ApiToken[]>('/api/v2/api-tokens');
  }

  createApiToken(input: {
    name: string;
    taskIds: string[];
    rateLimitPerMinute: number;
    expiresAt: string | null;
  }) {
    return this.request<ApiToken & { token: string }>('/api/v2/api-tokens', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  revokeApiToken(id: string) {
    return this.request<void>(`/api/v2/api-tokens/${id}`, { method: 'DELETE' });
  }

  createInspectionSession(taskId: string) {
    return this.request<{ id: string; url: string; expiresAt: string }>(
      '/api/v2/inspection-sessions',
      {
        method: 'POST',
        body: JSON.stringify({ taskId }),
      },
    );
  }

  createDraftInspectionSession(draftId: string) {
    return this.request<{ id: string; url: string; expiresAt: string }>(
      '/api/v2/inspection-sessions',
      { method: 'POST', body: JSON.stringify({ draftId }) },
    );
  }

  interactWithInspection(
    id: string,
    action: { type: 'click' | 'scroll' | 'refresh'; x?: number; y?: number; deltaY?: number },
  ) {
    return this.request<{ url: string }>(`/api/v2/inspection-sessions/${id}/actions`, {
      method: 'POST',
      body: JSON.stringify(action),
    });
  }

  executeInspectionStep(id: string, stepIndex: number, action: BrowserAction) {
    return this.request<InspectionStepResult>(`/api/v2/inspection-sessions/${id}/actions`, {
      method: 'POST',
      body: JSON.stringify({ stepIndex, action }),
    });
  }

  getInspectionScreenshot(id: string) {
    return this.request<{ url: string; image: string; width: number; height: number }>(
      `/api/v2/inspection-sessions/${id}/screenshot`,
    );
  }

  selectInspectionElement(id: string, point: { x: number; y: number }) {
    return this.request<InspectionElementSelection>(`/api/v2/inspection-sessions/${id}/select`, {
      method: 'POST',
      body: JSON.stringify(point),
    });
  }

  closeInspectionSession(id: string) {
    return this.request<void>(`/api/v2/inspection-sessions/${id}`, { method: 'DELETE' });
  }

  getDesktopDiagnostics() {
    return this.request<DesktopDiagnostics>('/api/v2/desktop/diagnostics');
  }

  getReadiness() {
    return this.request<RuntimeReadiness>('/ready');
  }

  getRuntimeSummary() {
    return this.request<RuntimeSummary>('/api/v2/runtime/summary');
  }

  async exportRun(
    runId: string,
    format: ArtifactDescriptor['format'],
    options: {
      fields?: string[];
      bom?: boolean;
      jsonMode?: 'array' | 'jsonl';
      filters?: RecordQuery['filters'];
      sort?: RecordQuery['sort'];
      signal?: AbortSignal;
    } = {},
  ): Promise<ArtifactDescriptor> {
    const { signal, ...body } = options;
    const result = await this.request<{ artifactRef: string; artifact: ArtifactDescriptor }>(
      `/api/v2/runs/${runId}/exports`,
      { method: 'POST', body: JSON.stringify({ format, ...body }), ...(signal ? { signal } : {}) },
    );
    await this.saveOrDownloadArtifact(result.artifactRef, result.artifact);
    return result.artifact;
  }

  async exportDataset(
    datasetId: string,
    format: ArtifactDescriptor['format'],
    options: {
      fields?: string[];
      bom?: boolean;
      jsonMode?: 'array' | 'jsonl';
      includeRemoved?: boolean;
      query?: string;
      filter?: Record<string, string | number | boolean | null>;
      filters?: RecordQuery['filters'];
      sort?: RecordQuery['sort'];
      signal?: AbortSignal;
    } = {},
  ): Promise<ArtifactDescriptor> {
    const { signal, ...body } = options;
    const artifact = await this.request<ArtifactDescriptor>(
      `/api/v2/datasets/${encodeURIComponent(datasetId)}/exports`,
      { method: 'POST', body: JSON.stringify({ format, ...body }), ...(signal ? { signal } : {}) },
    );
    await this.saveOrDownloadArtifact(artifact.id, artifact);
    return artifact;
  }

  private async saveOrDownloadArtifact(
    artifactRef: string,
    artifact: Pick<ArtifactDescriptor, 'id' | 'filename'>,
  ): Promise<void> {
    if (this.mode === 'desktop') {
      await this.request(`/api/v2/artifacts/${artifactRef}/save`, { method: 'POST' });
    } else {
      await this.downloadArtifact(artifact);
    }
  }

  private async downloadArtifact(
    artifact: Pick<ArtifactDescriptor, 'id' | 'filename'>,
  ): Promise<void> {
    await this.connect();
    const response = await fetch(
      `${this.bootstrap.baseUrl}/api/v2/artifacts/${artifact.id}/content`,
      {
        headers: this.authenticationHeaders(),
        credentials: this.requestCredentials(),
        signal: this.controller.signal,
      },
    );
    if (!response.ok) {
      this.clearWorkspaceSessionIfUnauthorized(response);
      throw await this.toError(response);
    }
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = artifact.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private async toError(response: Response): Promise<Error> {
    const body = (await response.json().catch(() => null)) as ProblemDetails | null;
    if (body?.type && body.traceId) return new ApiError(body);
    return new Error(`HTTP ${response.status}`);
  }

  private authenticationHeaders(): Headers {
    const headers = new Headers();
    if (this.authenticationMode === 'runtime-token') {
      headers.set('authorization', `Bearer ${this.token!}`);
    }
    return headers;
  }

  private requestCredentials(): RequestCredentials {
    return this.authenticationMode === 'workspace-cookie' ? 'include' : 'omit';
  }

  private clearWorkspaceSessionIfUnauthorized(response: Response): void {
    if (response.status === 401 && this.authenticationMode === 'workspace-cookie') {
      this.csrfToken = undefined;
    }
  }

  private async startDomainEvents(): Promise<void> {
    if (this.eventLoop) return this.eventLoop;
    this.eventLoop = (async () => {
      let attempt = 0;
      while (this.domainListeners.size > 0 && !this.controller.signal.aborted) {
        try {
          await this.connect();
          const response = await fetch(
            `${this.bootstrap.baseUrl}/api/v2/events/domain?after=${this.eventCursor}`,
            {
              headers: this.authenticationHeaders(),
              credentials: this.requestCredentials(),
              signal: this.controller.signal,
            },
          );
          if (!response.ok || !response.body) {
            this.clearWorkspaceSessionIfUnauthorized(response);
            throw await this.toError(response);
          }
          attempt = 0;
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const data = frame
                .split('\n')
                .find((line) => line.startsWith('data: '))
                ?.slice(6);
              if (data) {
                const event = JSON.parse(data) as DomainEvent;
                this.eventCursor = Math.max(this.eventCursor, event.cursor);
                for (const listener of this.domainListeners) listener(event);
              }
              boundary = buffer.indexOf('\n\n');
            }
          }
        } catch {
          if (this.controller.signal.aborted) break;
          attempt += 1;
          this.emitConnection({ status: 'reconnecting', attempt });
          await new Promise((resolve) => setTimeout(resolve, Math.min(8_000, 500 * 2 ** attempt)));
        }
      }
      this.eventLoop = undefined;
    })();
    return this.eventLoop;
  }

  private async startRealtimeEvents(): Promise<void> {
    if (this.realtimeLoop) return this.realtimeLoop;
    this.realtimeLoop = (async () => {
      let attempt = 0;
      while (this.realtimeListeners.size > 0 && !this.controller.signal.aborted) {
        try {
          await this.connect();
          const response = await fetch(`${this.bootstrap.baseUrl}/api/v2/events/realtime`, {
            headers: this.authenticationHeaders(),
            credentials: this.requestCredentials(),
            signal: this.controller.signal,
          });
          if (!response.ok || !response.body) {
            this.clearWorkspaceSessionIfUnauthorized(response);
            throw await this.toError(response);
          }
          attempt = 0;
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = '';
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += value;
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const data = frame
                .split('\n')
                .find((line) => line.startsWith('data: '))
                ?.slice(6);
              if (data) {
                const event = JSON.parse(data) as RealtimeEvent;
                for (const listener of this.realtimeListeners) listener(event);
              }
              boundary = buffer.indexOf('\n\n');
            }
          }
        } catch {
          if (this.controller.signal.aborted) break;
          attempt += 1;
          await new Promise((resolve) => setTimeout(resolve, Math.min(8_000, 500 * 2 ** attempt)));
        }
      }
      this.realtimeLoop = undefined;
    })();
    return this.realtimeLoop;
  }
}

export const runtimeClient = new ZhiYunClient();
