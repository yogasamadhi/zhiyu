import type { ArtifactStore, PlatformJob, PlatformJobQueue } from '@zhiyun/platform-core';
import type {
  CollectionRepository,
  CrawlCleanupIntent,
  DatasetIngestionPort,
} from '../contracts/index.js';
import { cleanupCollectionBatches } from './batch-writer.js';

const terminalStates = new Set(['succeeded', 'failed', 'canceled']);

/** Recovers cleanup after cancellation, deletion, or a terminal handler crash. */
export class CollectionBatchCleanup {
  private timer: ReturnType<typeof setInterval> | undefined;
  private operations: Promise<void> = Promise.resolve();
  private pendingSweep: Promise<void> | undefined;
  private lastErrorCode: string | null = null;

  constructor(
    private readonly dependencies: {
      repository: CollectionRepository;
      datasets: DatasetIngestionPort;
      jobs: PlatformJobQueue;
      artifacts: ArtifactStore;
    },
    private readonly intervalMs = 1_000,
  ) {}

  async start(): Promise<void> {
    if (this.timer) return;
    await this.sweep();
    this.timer = setInterval(() => {
      void this.sweep().catch(() => {
        this.lastErrorCode = 'COLLECTION_CLEANUP_SCAN_FAILED';
      });
    }, this.intervalMs);
    this.timer.unref();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.operations;
  }

  diagnostics(): { errorCode: string | null } {
    return { errorCode: this.lastErrorCode };
  }

  sweep(): Promise<void> {
    if (this.pendingSweep) return this.pendingSweep;
    this.pendingSweep = this.serialize(async () => {
      await this.discoverTerminalSessions();
      await this.processIntents();
      this.lastErrorCode = null;
    }).finally(() => {
      this.pendingSweep = undefined;
    });
    return this.pendingSweep;
  }

  reconcileRun(runId: string): Promise<void> {
    return this.serialize(async () => {
      const intent = await this.dependencies.repository.getCrawlCleanup(runId);
      if (intent && intent.availableAt <= new Date().toISOString())
        await this.processIntent(intent);
    });
  }

  reconcileTask(taskId: string): Promise<void> {
    return this.serialize(() => this.processIntents(taskId));
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.operations.then(operation);
    this.operations = next.catch(() => undefined);
    return next;
  }

  private owns(job: PlatformJob, runId: string, taskId: string): boolean {
    return (
      job.id === runId &&
      job.ownerPluginId === 'collection' &&
      job.type === 'collection.crawl.execute' &&
      job.payload.runId === runId &&
      job.payload.taskId === taskId
    );
  }

  private executing(runId: string): boolean {
    return (
      this.dependencies.jobs.diagnostics?.().running.some(({ jobId }) => jobId === runId) ?? false
    );
  }

  private async discoverTerminalSessions(): Promise<void> {
    const { repository, jobs } = this.dependencies;
    let cursor = '';
    for (;;) {
      const sessions = await repository.listCrawlSessionOwners(cursor);
      if (!sessions.length) return;
      for (const session of sessions) {
        cursor = session.runId;
        if (await repository.getCrawlCleanup(session.runId)) continue;
        const run = await repository.getRun(session.runId);
        const job = await jobs.get(session.runId);
        if (!run || this.executing(session.runId)) continue;
        if (
          job &&
          (!this.owns(job, session.runId, session.taskId) ||
            !terminalStates.has(job.state) ||
            job.leaseOwner ||
            job.leaseExpiresAt)
        )
          continue;
        if (!terminalStates.has(run.status)) {
          if (!job) continue;
          if (job.state === 'canceled') await repository.cancelRun(session.runId);
          else if (await repository.getCrawlResult(session.runId, session.fingerprint)) {
            if (job.state === 'failed') {
              const recovered = await jobs.retryCompletion?.(job);
              if (recovered)
                await repository.failRun(
                  session.runId,
                  session.taskId,
                  'Recovering the completed collection result',
                  'COLLECTION_COMPLETION_RECOVERY',
                  false,
                  true,
                );
            }
            continue;
          } else
            await repository.failRun(
              session.runId,
              session.taskId,
              'Collection Job ended before its Run completed',
              'COLLECTION_JOB_TERMINATED',
              true,
            );
        }
        await repository.requestCrawlCleanup(session.runId, session.taskId, 'terminal');
      }
    }
  }

  private async processIntents(taskId?: string): Promise<void> {
    const { repository } = this.dependencies;
    const dueAt = new Date().toISOString();
    let cursor = '';
    for (;;) {
      const intents = await repository.listCrawlCleanup(cursor, dueAt);
      if (!intents.length) return;
      for (const intent of intents) {
        cursor = intent.runId;
        if (!taskId || intent.taskId === taskId) await this.processIntent(intent);
      }
    }
  }

  private async processIntent(intent: CrawlCleanupIntent): Promise<void> {
    const { repository, datasets, jobs, artifacts } = this.dependencies;
    try {
      const run = await repository.getRun(intent.runId);
      if (run && run.taskId !== intent.taskId) return;
      let job = await jobs.get(intent.runId);
      if (job && !this.owns(job, intent.runId, intent.taskId)) return;
      if (run?.status === 'succeeded' && intent.reason === 'terminal' && job?.state === 'failed') {
        if (!this.executing(intent.runId)) await jobs.retryCompletion?.(job);
        return;
      }
      if (job && intent.reason !== 'terminal' && !terminalStates.has(job.state))
        job = await jobs.cancel(job.id);
      if (
        this.executing(intent.runId) ||
        (job && (!terminalStates.has(job.state) || job.leaseOwner || job.leaseExpiresAt))
      )
        return;
      if (run && !terminalStates.has(run.status)) {
        if (intent.reason === 'terminal') return;
        if (!job && run.status === 'running') return;
        await repository.cancelRun(intent.runId);
      }
      await cleanupCollectionBatches(repository, datasets, artifacts, intent.runId);
      await repository.acknowledgeCrawlCleanup(intent.runId);
    } catch {
      // Persist only a fixed code. Transient IO failure is retried on a later
      // sweep or application start, even after the Task/Run cascade.
      await repository.retryCrawlCleanup(intent.runId);
    }
  }
}
