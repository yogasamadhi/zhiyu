import type {
  AnalysisResult,
  ApiToken,
  ArtifactDescriptor,
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
  TrendSource,
  TrendSourceUpdate,
  TrendsResponse,
} from '@zhiyun/shared';
export * from './generated.js';
export type {
  components as OpenApiComponents,
  operations as OpenApiOperations,
  paths as OpenApiPaths,
} from './openapi.generated.js';

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

export interface DatasetPageResult {
  items: DatasetRecord[];
  nextCursor: string | null;
  stats: DatasetStats;
}

export interface DesktopDiagnostics {
  runtime: { version: string; generation: number; runtimeId: string; startedAt: string };
  browserResources: string | null;
  database: Record<string, unknown>;
}

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
    apiVersion: 'v1',
  };
}

export class ZhiYunClient {
  private bootstrap: RuntimeBootstrap = defaultBootstrap();
  private token: string | undefined;
  private connectPromise: Promise<void> | undefined;
  private controller = new AbortController();
  private readonly etags = new Map<string, string>();
  private readonly connectionListeners = new Set<ConnectionListener>();
  private readonly domainListeners = new Set<DomainEventListener>();
  private eventLoop: Promise<void> | undefined;
  private eventCursor = 0;
  private mode: RuntimeMetadata['mode'] = 'headless';
  private adminToken: string | undefined;

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

  setAdminToken(token: string): void {
    this.adminToken = token;
    this.token = undefined;
    this.connectPromise = undefined;
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
    this.controller.abort('Runtime generation changed');
    this.controller = new AbortController();
    this.bootstrap = bootstrap;
    this.token = undefined;
    this.connectPromise = undefined;
    this.etags.clear();
    this.eventLoop = undefined;
    this.emitConnection({ status: 'reconnecting', attempt: 1 });
    if (this.domainListeners.size > 0) void this.startDomainEvents();
  }

  async connect(): Promise<void> {
    if (this.token) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = (async () => {
      this.emitConnection({ status: 'connecting' });
      if (this.bridge) this.bootstrap = await this.bridge.getBootstrap();
      let response = await fetch(`${this.bootstrap.baseUrl}/api/v1/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
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
          response = await fetch(`${this.bootstrap.baseUrl}/api/v1/session`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ adminToken: entered }),
            signal: this.controller.signal,
          });
        }
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
    headers.set('authorization', `Bearer ${this.token!}`);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    if (
      method === 'POST' &&
      (/\/api\/v1\/tasks$/.test(path) ||
        /\/rules(?:\/[^/]+\/versions)?$/.test(path) ||
        /\/run$/.test(path) ||
        /\/exports$/.test(path) ||
        /\/output-destinations$/.test(path) ||
        /\/retry$/.test(path) ||
        /\/rollback$/.test(path) ||
        /\/repair-proposals(?:\/[^/]+\/apply)?$/.test(path))
    ) {
      headers.set('idempotency-key', crypto.randomUUID());
    }
    if (method === 'PUT') {
      const taskPath = path.match(/\/api\/v1\/tasks\/([^/?]+)/)?.[0];
      const etag = taskPath ? this.etags.get(taskPath) : undefined;
      if (etag) headers.set('if-match', etag);
    }
    const response = await fetch(`${this.bootstrap.baseUrl}${path}`, {
      ...init,
      method,
      headers,
      cache: 'no-store',
      signal: init.signal
        ? AbortSignal.any([this.controller.signal, init.signal])
        : this.controller.signal,
    });
    if (!response.ok) throw await this.toError(response);
    const etag = response.headers.get('etag');
    if (etag) this.etags.set(path.split('?')[0]!, etag);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  listTasks(limit = 100, cursor?: string) {
    return this.request<{ items: TaskListItem[]; nextCursor: string | null }>(
      `/api/v1/tasks${search({ limit, cursor })}`,
    );
  }

  createTask(input: TaskCreate) {
    return this.request<TaskDetail>('/api/v1/tasks', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  getTask(id: string) {
    return this.request<TaskDetail>(`/api/v1/tasks/${id}`);
  }

  updateTask(id: string, input: TaskUpdate) {
    return this.request<TaskDetail>(`/api/v1/tasks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  deleteTask(id: string) {
    return this.request<void>(`/api/v1/tasks/${id}`, { method: 'DELETE' });
  }

  listTrendSources() {
    return this.request<TrendSource[]>('/api/v1/trend-sources');
  }

  bootstrapTrendSources() {
    return this.request<{
      sources: TrendSource[];
      runs: Array<Record<string, unknown>>;
    }>('/api/v1/trend-sources/bootstrap', { method: 'POST' });
  }

  updateTrendSource(key: string, input: TrendSourceUpdate) {
    return this.request<TrendSource>(`/api/v1/trend-sources/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  runTrendSource(key: string) {
    return this.request<Record<string, unknown>>(
      `/api/v1/trend-sources/${encodeURIComponent(key)}/run`,
      { method: 'POST' },
    );
  }

  runTrendSources() {
    return this.request<{ runs: Array<Record<string, unknown>> }>('/api/v1/trend-sources/run', {
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
    return this.request<TrendsResponse>(`/api/v1/trends${search(options)}`);
  }

  getPreferenceProfile() {
    return this.request<PreferenceProfile>('/api/v1/preferences/profile');
  }

  listPreferenceSignals(limit = 100, cursor?: string) {
    return this.request<{ items: PreferenceSignal[]; nextCursor: string | null }>(
      `/api/v1/preferences/signals${search({ limit, cursor })}`,
    );
  }

  upsertPreferenceSignal(input: PreferenceSignalInput) {
    return this.request<PreferenceSignal>('/api/v1/preferences/signals', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  deletePreferenceSignal(id: string) {
    return this.request<void>(`/api/v1/preferences/signals/${id}`, { method: 'DELETE' });
  }

  clearPreferenceSignals() {
    return this.request<{ deleted: number }>('/api/v1/preferences/signals', {
      method: 'DELETE',
    });
  }

  importPreferenceContent(input: PreferenceImport) {
    return this.request<PreferenceSignal>('/api/v1/preferences/import', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  analyzeTask(id: string, input: { useAi: boolean; forceBrowser: boolean }) {
    return this.request<AnalysisResult>(`/api/v1/tasks/${id}/analyze`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  runAiExtractDemo(id: string, definition?: CrawlPlanDefinition) {
    return this.request<{
      records: Array<Record<string, unknown>>;
      sourceUrl: string;
      persisted: false;
    }>(`/api/v1/tasks/${id}/ai/extract`, {
      method: 'POST',
      body: JSON.stringify(definition ? { definition } : {}),
    });
  }

  runTask(id: string) {
    return this.request<{ runId: string; status: CrawlRun['status'] }>(`/api/v1/tasks/${id}/run`, {
      method: 'POST',
    });
  }

  listTaskRuns(id: string, limit = 100, cursor?: string) {
    return this.request<{ items: CrawlRun[]; nextCursor: string | null }>(
      `/api/v1/tasks/${id}/runs${search({ limit, cursor })}`,
    );
  }

  listRules(id: string) {
    return this.request<Array<RuleRecord & { versions: RuleVersionRecord[] }>>(
      `/api/v1/tasks/${id}/rules`,
    );
  }

  testRule(id: string, definition: CrawlPlanDefinition, limit = 10) {
    return this.request<{ records: Array<{ data: Record<string, unknown>; sourceUrl: string }> }>(
      `/api/v1/tasks/${id}/rules/test`,
      { method: 'POST', body: JSON.stringify({ definition, limit }) },
    );
  }

  createRule(
    taskId: string,
    input: { name: string; definition: CrawlPlanDefinition; generatedBy: GeneratedBy },
  ) {
    return this.request<{ rule: RuleRecord; version: RuleVersionRecord }>(
      `/api/v1/tasks/${taskId}/rules`,
      { method: 'POST', body: JSON.stringify(input) },
    );
  }

  createRuleVersion(
    taskId: string,
    ruleId: string,
    input: { definition: CrawlPlanDefinition; generatedBy: GeneratedBy },
  ) {
    return this.request<RuleVersionRecord>(`/api/v1/tasks/${taskId}/rules/${ruleId}/versions`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  diffRuleVersions(taskId: string, ruleId: string, from: number, to: number) {
    return this.request<{ changes: Array<{ path: string; before: unknown; after: unknown }> }>(
      `/api/v1/tasks/${taskId}/rules/${ruleId}/diff${search({ from, to })}`,
    );
  }

  rollbackRule(taskId: string, ruleId: string, version: number) {
    return this.request<RuleVersionRecord>(`/api/v1/tasks/${taskId}/rules/${ruleId}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ version }),
    });
  }

  listRepairProposals(taskId: string, ruleId: string) {
    return this.request<RuleRepairProposal[]>(
      `/api/v1/tasks/${taskId}/rules/${ruleId}/repair-proposals`,
    );
  }

  createRepairProposal(taskId: string, ruleId: string, error: string, runId: string | null = null) {
    return this.request<
      RuleRepairProposal & {
        diff: Array<{ path: string; before: unknown; after: unknown }>;
      }
    >(`/api/v1/tasks/${taskId}/rules/${ruleId}/repair-proposals`, {
      method: 'POST',
      body: JSON.stringify({ error, runId }),
    });
  }

  testRepairProposal(taskId: string, ruleId: string, proposalId: string) {
    return this.request<{
      records: Array<{ data: Record<string, unknown>; sourceUrl: string }>;
      proposal: RuleRepairProposal;
    }>(`/api/v1/tasks/${taskId}/rules/${ruleId}/repair-proposals/${proposalId}/test`, {
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
      `/api/v1/tasks/${taskId}/rules/${ruleId}/repair-proposals/${proposalId}/${action}`,
      { method: 'POST' },
    );
  }

  startLoginSession(taskId: string, loginUrl?: string) {
    return this.request<{ canceled: boolean; reference?: string; task?: TaskDetail }>(
      `/api/v1/tasks/${taskId}/browser-session/login`,
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
      `/api/v1/tasks/${taskId}/credentials/${kind}`,
      { method: 'POST', body: JSON.stringify({ revision }) },
    );
  }

  deleteTaskCredential(
    taskId: string,
    kind: 'secretHeaders' | 'cookies' | 'proxy',
    revision: number,
  ) {
    return this.request<TaskDetail>(`/api/v1/tasks/${taskId}/credentials/${kind}`, {
      method: 'DELETE',
      body: JSON.stringify({ revision }),
    });
  }

  getDataset(
    taskId: string,
    options: {
      limit?: number;
      cursor?: string;
      query?: string;
      filter?: string;
      includeRemoved?: boolean;
    } = {},
  ) {
    return this.request<DatasetPageResult>(
      `/api/v1/tasks/${taskId}/dataset${search({ limit: options.limit ?? 100, ...options })}`,
    );
  }

  getDatasetChanges(taskId: string, limit = 20, cursor?: string, runId?: string) {
    return this.request<{ items: RecordChange[]; nextCursor: string | null }>(
      `/api/v1/tasks/${taskId}/dataset/changes${search({ limit, cursor, runId })}`,
    );
  }

  diffDatasetRuns(taskId: string, from: string, to: string, limit = 100, cursor?: string) {
    return this.request<{
      items: DatasetDiffEntry[];
      nextCursor: string | null;
      stats: DatasetDiffStats;
    }>(`/api/v1/tasks/${taskId}/dataset/diff${search({ from, to, limit, cursor })}`);
  }

  getRun(id: string) {
    return this.request<CrawlRun>(`/api/v1/runs/${id}`);
  }

  cancelRun(id: string) {
    return this.request<CrawlRun>(`/api/v1/runs/${id}/cancel`, { method: 'POST' });
  }

  retryRun(id: string) {
    return this.request<{ runId: string; status: CrawlRun['status'] }>(`/api/v1/runs/${id}/retry`, {
      method: 'POST',
    });
  }

  explainRunFailure(id: string) {
    return this.request<{ explanation: string; persisted: false }>(
      `/api/v1/runs/${id}/explain-failure`,
      { method: 'POST' },
    );
  }

  getRunRecords(id: string, limit = 100, cursor?: string) {
    return this.request<RecordPage>(`/api/v1/runs/${id}/records${search({ limit, cursor })}`);
  }

  getRunLogs(id: string, limit = 100, cursor?: string) {
    return this.request<{ items: RunLogEntry[]; nextCursor: string | null }>(
      `/api/v1/runs/${id}/logs${search({ limit, cursor })}`,
    );
  }

  getRunRequests(id: string, limit = 100, cursor?: string) {
    return this.request<{ items: RunRequestEntry[]; nextCursor: string | null }>(
      `/api/v1/runs/${id}/requests${search({ limit, cursor })}`,
    );
  }

  listOutputDestinations() {
    return this.request<OutputDestination[]>('/api/v1/output-destinations');
  }

  createOutputDestination(input: {
    name: string;
    type: OutputDestination['type'];
    config: Record<string, unknown>;
    credential?: unknown;
    enabled?: boolean;
  }) {
    return this.request<OutputDestination>('/api/v1/output-destinations', {
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
    return this.request<OutputDestination>(`/api/v1/output-destinations/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  deleteOutputDestination(id: string) {
    return this.request<void>(`/api/v1/output-destinations/${id}`, { method: 'DELETE' });
  }

  testOutputDestination(id: string) {
    return this.request<{ ok: boolean }>(`/api/v1/output-destinations/${id}/test`, {
      method: 'POST',
    });
  }

  promptOutputCredential(id: string) {
    return this.request<OutputDestination & { canceled?: boolean }>(
      `/api/v1/output-destinations/${id}/credential/prompt`,
      { method: 'POST' },
    );
  }

  listDeliveryAttempts(runId?: string) {
    return this.request<DeliveryAttempt[]>(`/api/v1/delivery-attempts${search({ runId })}`);
  }

  retryDeliveryAttempt(id: string) {
    return this.request<DeliveryAttempt>(`/api/v1/delivery-attempts/${id}/retry`, {
      method: 'POST',
    });
  }

  listApiTokens() {
    return this.request<ApiToken[]>('/api/v1/api-tokens');
  }

  createApiToken(input: {
    name: string;
    taskIds: string[];
    rateLimitPerMinute: number;
    expiresAt: string | null;
  }) {
    return this.request<ApiToken & { token: string }>('/api/v1/api-tokens', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  revokeApiToken(id: string) {
    return this.request<void>(`/api/v1/api-tokens/${id}`, { method: 'DELETE' });
  }

  createInspectionSession(taskId: string) {
    return this.request<{ id: string }>('/api/v1/inspection-sessions', {
      method: 'POST',
      body: JSON.stringify({ taskId }),
    });
  }

  getInspectionScreenshot(id: string) {
    return this.request<{ image: string }>(`/api/v1/inspection-sessions/${id}/screenshot`);
  }

  selectInspectionElement(id: string, point: { x: number; y: number }) {
    return this.request<{ selector: string }>(`/api/v1/inspection-sessions/${id}/select`, {
      method: 'POST',
      body: JSON.stringify(point),
    });
  }

  closeInspectionSession(id: string) {
    return this.request<void>(`/api/v1/inspection-sessions/${id}`, { method: 'DELETE' });
  }

  getDesktopDiagnostics() {
    return this.request<DesktopDiagnostics>('/api/v1/desktop/diagnostics');
  }

  createDesktopBackup() {
    return this.request<{ saved: boolean }>('/api/v1/desktop/backup', { method: 'POST' });
  }

  restoreDesktopBackup() {
    return this.request<{ canceled: boolean }>('/api/v1/desktop/restore', { method: 'POST' });
  }

  async exportRun(
    runId: string,
    format: ArtifactDescriptor['format'],
    options: {
      fields?: string[];
      bom?: boolean;
      jsonMode?: 'array' | 'jsonl';
      signal?: AbortSignal;
    } = {},
  ): Promise<ArtifactDescriptor> {
    const { signal, ...body } = options;
    const result = await this.request<{ artifactRef: string; artifact: ArtifactDescriptor }>(
      `/api/v1/runs/${runId}/exports`,
      { method: 'POST', body: JSON.stringify({ format, ...body }), ...(signal ? { signal } : {}) },
    );
    await this.saveOrDownloadArtifact(result.artifactRef, result.artifact);
    return result.artifact;
  }

  async exportDataset(
    taskId: string,
    format: ArtifactDescriptor['format'],
    options: {
      fields?: string[];
      bom?: boolean;
      jsonMode?: 'array' | 'jsonl';
      includeRemoved?: boolean;
      query?: string;
      filter?: Record<string, string | number | boolean | null>;
      signal?: AbortSignal;
    } = {},
  ): Promise<ArtifactDescriptor> {
    const { signal, ...body } = options;
    const result = await this.request<{ artifactRef: string; artifact: ArtifactDescriptor }>(
      `/api/v1/tasks/${taskId}/dataset/exports`,
      { method: 'POST', body: JSON.stringify({ format, ...body }), ...(signal ? { signal } : {}) },
    );
    await this.saveOrDownloadArtifact(result.artifactRef, result.artifact);
    return result.artifact;
  }

  private async saveOrDownloadArtifact(
    artifactRef: string,
    artifact: ArtifactDescriptor,
  ): Promise<void> {
    if (this.mode === 'desktop') {
      await this.request(`/api/v1/artifacts/${artifactRef}/save`, { method: 'POST' });
    } else {
      await this.downloadArtifact(artifact);
    }
  }

  private async downloadArtifact(artifact: ArtifactDescriptor): Promise<void> {
    const response = await fetch(
      `${this.bootstrap.baseUrl}/api/v1/artifacts/${artifact.id}/content`,
      {
        headers: { authorization: `Bearer ${this.token!}` },
        signal: this.controller.signal,
      },
    );
    if (!response.ok) throw await this.toError(response);
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

  private async startDomainEvents(): Promise<void> {
    if (this.eventLoop) return this.eventLoop;
    this.eventLoop = (async () => {
      let attempt = 0;
      while (this.domainListeners.size > 0 && !this.controller.signal.aborted) {
        try {
          await this.connect();
          const response = await fetch(
            `${this.bootstrap.baseUrl}/api/v1/events/domain?after=${this.eventCursor}`,
            {
              headers: { authorization: `Bearer ${this.token!}` },
              signal: this.controller.signal,
            },
          );
          if (!response.ok || !response.body) throw await this.toError(response);
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
}

export const runtimeClient = new ZhiYunClient();
