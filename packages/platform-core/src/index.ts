export const PRODUCT_SCHEMA_VERSION = '1.0.0' as const;

export type JobResourceClass = 'browser-heavy' | 'python-heavy' | 'io' | 'delivery';
export type PlatformJobState =
  | 'queued'
  | 'claimed'
  | 'running'
  | 'persisting'
  | 'canceling'
  | 'canceled'
  | 'interrupted'
  | 'succeeded'
  | 'failed';

export interface PlatformJob {
  id: string;
  ownerPluginId: string;
  type: string;
  payload: Record<string, unknown>;
  resourceClass: JobResourceClass;
  state: PlatformJobState;
  progress: number;
  phase: string;
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  cancelRequestedAt: string | null;
  error: PlatformJobError | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformJobError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface EnqueueJobInput {
  id?: string;
  ownerPluginId: string;
  type: string;
  payload: Record<string, unknown>;
  resourceClass: JobResourceClass;
  maxAttempts?: number;
  availableAt?: string;
}

export interface ClaimJobInput {
  workerId: string;
  resourceClasses: readonly JobResourceClass[];
  leaseMs: number;
  jobId?: string;
}

export interface PlatformEvent {
  id: string;
  cursor: number;
  type: string;
  schemaVersion: number;
  producerPluginId: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}

export interface AppendEventInput {
  id?: string;
  type: string;
  schemaVersion?: number;
  producerPluginId: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  occurredAt?: string;
}

export interface PlatformArtifact {
  id: string;
  ownerPluginId: string;
  kind: string;
  filename: string;
  contentType: string;
  size: number;
  checksum: string;
  storageKey: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface CreateArtifactInput extends Omit<PlatformArtifact, 'id' | 'createdAt'> {
  id?: string;
  createdAt?: string;
}

export type IdempotencyReservation =
  | { state: 'reserved' }
  | { state: 'pending' }
  | { state: 'conflict' }
  | { state: 'completed'; responseStatus: number; responseBody: unknown };

export interface StoredArtifactFile {
  storageKey: string;
  size: number;
  checksum: string;
}

export interface JobWorkspace {
  readonly jobId: string;
  readonly rootPath: string;
  resolve(relativePath: string): Promise<string>;
}

export interface ArtifactStore {
  initialize(): Promise<void>;
  openWorkspace(jobId: string): Promise<JobWorkspace>;
  commitWorkspaceFile(
    jobId: string,
    relativeSource: string,
    storageKey: string,
  ): Promise<StoredArtifactFile>;
  resolveArtifact(storageKey: string): Promise<string>;
  removeWorkspace(jobId: string): Promise<void>;
  close(): Promise<void>;
}

export interface MigrationRecord {
  pluginId: string;
  migrationId: string;
  pluginVersion: string;
  checksum: string;
  executedAt: string;
  durationMs: number;
  result: 'succeeded' | 'failed';
}

export interface PlatformRepository {
  initialize(graphRevision: string): Promise<void>;
  close(): Promise<void>;

  enqueueJob(input: EnqueueJobInput): Promise<PlatformJob>;
  getJob(id: string): Promise<PlatformJob | null>;
  listJobs(options?: {
    ownerPluginId?: string;
    states?: readonly PlatformJobState[];
    limit?: number;
  }): Promise<PlatformJob[]>;
  claimJob(input: ClaimJobInput): Promise<PlatformJob | null>;
  startJob(id: string, workerId: string, leaseMs: number): Promise<PlatformJob | null>;
  heartbeatJob(
    id: string,
    workerId: string,
    leaseMs: number,
  ): Promise<{ cancelRequested: boolean } | null>;
  updateJobProgress(
    id: string,
    workerId: string,
    progress: number,
    phase: string,
  ): Promise<PlatformJob | null>;
  markJobPersisting(id: string, workerId: string): Promise<PlatformJob | null>;
  completeJob(id: string, workerId: string): Promise<PlatformJob | null>;
  failJob(id: string, workerId: string, error: PlatformJobError): Promise<PlatformJob | null>;
  requestJobCancel(id: string): Promise<PlatformJob | null>;
  markJobCanceled(id: string, workerId?: string): Promise<PlatformJob | null>;
  recoverExpiredJobs(now?: string): Promise<number>;

  appendEvent(input: AppendEventInput): Promise<PlatformEvent>;
  listEvents(afterCursor: number, limit: number): Promise<PlatformEvent[]>;
  getConsumerCheckpoint(consumerId: string): Promise<number>;
  saveConsumerCheckpoint(consumerId: string, cursor: number): Promise<void>;
  recordDeadLetter(input: {
    consumerId: string;
    event: PlatformEvent;
    error: string;
  }): Promise<number>;

  createArtifact(input: CreateArtifactInput): Promise<PlatformArtifact>;
  getArtifact(id: string): Promise<PlatformArtifact | null>;

  reserveIdempotency(input: {
    scope: string;
    key: string;
    requestHash: string;
    expiresAt: string;
  }): Promise<IdempotencyReservation>;
  completeIdempotency(input: {
    scope: string;
    key: string;
    requestHash: string;
    responseStatus: number;
    responseBody: unknown;
  }): Promise<void>;
  releaseIdempotency(input: { scope: string; key: string; requestHash: string }): Promise<boolean>;

  getRuntimeSetting<T = unknown>(key: string): Promise<T | null>;
  setRuntimeSetting(key: string, value: unknown): Promise<void>;

  listMigrations(): Promise<MigrationRecord[]>;
}

export interface PlatformJobQueue {
  enqueue(input: EnqueueJobInput): Promise<PlatformJob>;
  get(id: string): Promise<PlatformJob | null>;
  list(options?: {
    ownerPluginId?: string;
    states?: readonly PlatformJobState[];
    limit?: number;
  }): Promise<PlatformJob[]>;
  cancel(id: string): Promise<PlatformJob | null>;
  start(): void;
  close(): Promise<void>;
}

export interface JobExecutionContext {
  readonly job: PlatformJob;
  readonly signal: AbortSignal;
  progress(progress: number, phase: string): Promise<void>;
  persisting(): Promise<void>;
}

export type PlatformJobHandler = (context: JobExecutionContext) => Promise<void>;

export class PlatformJobExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class JobHandlerRegistry {
  private readonly handlers = new Map<
    string,
    { ownerPluginId: string; resourceClass: JobResourceClass; handler: PlatformJobHandler }
  >();

  register(input: {
    type: string;
    ownerPluginId: string;
    resourceClass: JobResourceClass;
    handler: PlatformJobHandler;
  }): () => void {
    if (this.handlers.has(input.type)) throw new Error(`Duplicate job handler ${input.type}`);
    this.handlers.set(input.type, input);
    return () => this.handlers.delete(input.type);
  }

  get(type: string) {
    return this.handlers.get(type);
  }

  resourceClasses(): JobResourceClass[] {
    return [...new Set([...this.handlers.values()].map(({ resourceClass }) => resourceClass))];
  }
}

export interface DurableJobDispatcherOptions {
  workerId?: string;
  pollIntervalMs?: number;
  leaseMs?: number;
  recoveryIntervalMs?: number;
  capacities?: Partial<Record<JobResourceClass, number>>;
}

export interface JobDispatcherDiagnostics {
  workerId: string;
  stopping: boolean;
  running: readonly { jobId: string; resourceClass: JobResourceClass }[];
  capacities: Readonly<Record<JobResourceClass, number>>;
}

export class DurableJobDispatcher {
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly leaseMs: number;
  private readonly recoveryIntervalMs: number;
  private readonly capacities: Record<JobResourceClass, number>;
  private readonly running = new Map<
    string,
    { resourceClass: JobResourceClass; controller: AbortController; promise: Promise<void> }
  >();
  private stopping = false;
  private loopPromise: Promise<void> | undefined;
  private loopController: AbortController | undefined;
  private lastRecoveryAt = 0;

  constructor(
    private readonly repository: PlatformRepository,
    private readonly handlers: JobHandlerRegistry,
    options: DurableJobDispatcherOptions = {},
  ) {
    this.workerId = options.workerId ?? crypto.randomUUID();
    this.pollIntervalMs = options.pollIntervalMs ?? 200;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.recoveryIntervalMs = Math.max(10, options.recoveryIntervalMs ?? 5_000);
    this.capacities = {
      'browser-heavy': options.capacities?.['browser-heavy'] ?? 1,
      'python-heavy': options.capacities?.['python-heavy'] ?? 1,
      io: options.capacities?.io ?? 2,
      delivery: options.capacities?.delivery ?? 2,
    };
  }

  start(): void {
    if (this.loopPromise) return;
    this.stopping = false;
    this.loopController = new AbortController();
    this.loopPromise = this.loop(this.loopController.signal);
  }

  private async loop(signal: AbortSignal): Promise<void> {
    while (!this.stopping) {
      await this.tick();
      await delay(this.pollIntervalMs, signal);
    }
  }

  async tick(jobId?: string): Promise<void> {
    await this.recoverExpiredJobsIfDue();
    const available = this.handlers.resourceClasses().filter((resourceClass) => {
      const count = [...this.running.values()].filter(
        (entry) => entry.resourceClass === resourceClass,
      ).length;
      return count < this.capacities[resourceClass];
    });
    if (available.length === 0) return;
    const job = await this.repository.claimJob({
      workerId: this.workerId,
      resourceClasses: available,
      leaseMs: this.leaseMs,
      ...(jobId ? { jobId } : {}),
    });
    if (!job) return;
    const registration = this.handlers.get(job.type);
    if (!registration || registration.ownerPluginId !== job.ownerPluginId) {
      await this.repository.failJob(job.id, this.workerId, {
        code: 'JOB_HANDLER_MISSING',
        message: `No handler is registered for ${job.ownerPluginId}:${job.type}`,
        retryable: false,
      });
      return;
    }
    const controller = new AbortController();
    const promise = this.execute(job, registration.handler, controller).finally(() => {
      this.running.delete(job.id);
    });
    this.running.set(job.id, { resourceClass: job.resourceClass, controller, promise });
  }

  private async recoverExpiredJobsIfDue(): Promise<void> {
    const current = Date.now();
    if (current - this.lastRecoveryAt < this.recoveryIntervalMs) return;
    this.lastRecoveryAt = current;
    await this.repository.recoverExpiredJobs(new Date(current).toISOString());
  }

  diagnostics(): JobDispatcherDiagnostics {
    return {
      workerId: this.workerId,
      stopping: this.stopping,
      running: [...this.running].map(([jobId, value]) => ({
        jobId,
        resourceClass: value.resourceClass,
      })),
      capacities: { ...this.capacities },
    };
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.running.values()].map(({ promise }) => promise));
  }

  private async execute(
    claimed: PlatformJob,
    handler: PlatformJobHandler,
    controller: AbortController,
  ): Promise<void> {
    const started = await this.repository.startJob(claimed.id, this.workerId, this.leaseMs);
    if (!started) return;
    const heartbeat = setInterval(
      () => {
        void this.repository
          .heartbeatJob(started.id, this.workerId, this.leaseMs)
          .then((status) => {
            if (status?.cancelRequested) controller.abort('Job cancellation requested');
          })
          .catch(() => controller.abort('Job lease heartbeat failed'));
      },
      Math.max(250, Math.floor(this.leaseMs / 3)),
    );
    try {
      await handler({
        job: started,
        signal: controller.signal,
        progress: async (progress, phase) => {
          await this.repository.updateJobProgress(started.id, this.workerId, progress, phase);
        },
        persisting: async () => {
          await this.repository.markJobPersisting(started.id, this.workerId);
        },
      });
      if (controller.signal.aborted) {
        await this.repository.markJobCanceled(started.id, this.workerId);
      } else {
        await this.repository.completeJob(started.id, this.workerId);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        await this.repository.markJobCanceled(started.id, this.workerId);
      } else {
        const failure =
          error instanceof PlatformJobExecutionError
            ? { code: error.code, message: error.message, retryable: error.retryable }
            : { code: 'JOB_HANDLER_FAILED', message: safeError(error), retryable: true };
        await this.repository.failJob(started.id, this.workerId, {
          ...failure,
        });
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  async close(): Promise<void> {
    this.stopping = true;
    this.loopController?.abort();
    for (const { controller } of this.running.values()) controller.abort('Dispatcher stopping');
    await Promise.allSettled([...this.running.values()].map(({ promise }) => promise));
    await this.loopPromise;
    this.loopPromise = undefined;
    this.loopController = undefined;
  }
}

export interface DomainEventHandler {
  readonly consumerId: string;
  readonly eventTypes: readonly string[];
  handle(event: PlatformEvent): Promise<void>;
}

export class DurableEventDispatcher {
  constructor(
    private readonly repository: PlatformRepository,
    private readonly handlers: readonly DomainEventHandler[],
    private readonly maxAttempts = 3,
  ) {}

  async dispatchOnce(limit = 100): Promise<number> {
    let handled = 0;
    for (const handler of this.handlers) {
      let checkpoint = await this.repository.getConsumerCheckpoint(handler.consumerId);
      const events = await this.repository.listEvents(checkpoint, limit);
      for (const event of events) {
        if (!handler.eventTypes.includes(event.type)) {
          checkpoint = event.cursor;
          await this.repository.saveConsumerCheckpoint(handler.consumerId, checkpoint);
          continue;
        }
        try {
          await handler.handle(event);
          handled += 1;
          checkpoint = event.cursor;
          await this.repository.saveConsumerCheckpoint(handler.consumerId, checkpoint);
        } catch (error) {
          const attempts = await this.repository.recordDeadLetter({
            consumerId: handler.consumerId,
            event,
            error: safeError(error),
          });
          if (attempts < this.maxAttempts) break;
          checkpoint = event.cursor;
          await this.repository.saveConsumerCheckpoint(handler.consumerId, checkpoint);
        }
      }
    }
    return handled;
  }
}

export const LEGACY_TABLES = Object.freeze([
  'api_tokens',
  'artifacts',
  'dataset_records',
  'datasets',
  'delivery_attempts',
  'domain_events',
  'idempotency_keys',
  'output_destinations',
  'preference_signals',
  'record_changes',
  'records',
  'rule_repair_proposals',
  'rule_versions',
  'rules',
  'run_logs',
  'run_requests',
  'runs',
  'runtime_jobs',
  'runtime_settings',
  'task_output_bindings',
  'task_schedules',
  'tasks',
  'trend_sources',
]);

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}
