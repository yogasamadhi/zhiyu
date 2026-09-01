import type {
  CollectionRepository,
  CollectionServiceContract,
  CollectionTaskDetail,
  DatasetIngestionPort,
} from '../contracts/index.js';
import { Cron } from 'croner';
import {
  PlatformJobExecutionError,
  type JobExecutionContext,
  type PlatformJobQueue,
  type PlatformRepository,
} from '@zhiyun/platform-core';
import {
  redactSensitiveText,
  scheduleSchema,
  type BrowserSettings,
  type CrawlerService,
  type CredentialStore,
  type Schedule,
  type TaskCredentialBindings,
} from '@zhiyun/contracts';

export class CollectionService implements CollectionServiceContract {
  constructor(
    private readonly repository: CollectionRepository,
    private readonly datasets: DatasetIngestionPort,
  ) {}

  getTask(id: string): Promise<CollectionTaskDetail | null> {
    return this.repository.getTask(id);
  }

  async persistRun(input: {
    runId: string;
    taskId: string;
    records: Array<{ sourceUrl: string; data: Record<string, unknown> }>;
    requestCount: number;
    browserUsed: boolean;
    aiUsed: boolean;
    metadata: Record<string, unknown>;
  }) {
    const task = await this.repository.getTask(input.taskId);
    if (!task) throw new Error(`Collection task ${input.taskId} was not found`);
    const run = await this.repository.getRun(input.runId);
    if (!run || run.taskId !== input.taskId) {
      throw new Error(`Collection run ${input.runId} was not found`);
    }
    if (run.status === 'succeeded') return run;
    if (run.status !== 'running') {
      throw new Error(`Collection run ${input.runId} is not persistable from ${run.status}`);
    }
    const marked = await this.repository.markRunPersisting(input.runId, input.taskId);
    if (!marked) throw new Error(`Collection run ${input.runId} could not enter persisting`);
    const projected = await this.datasets.commitRunRecords({
      sourceTaskId: input.taskId,
      sourceRunId: input.runId,
      settings: task.datasetSettings,
      records: input.records,
    });
    const completed = await this.repository.completeRun(input.runId, input.taskId, {
      requestCount: input.requestCount,
      recordCount: input.records.length,
      browserUsed: input.browserUsed,
      aiUsed: input.aiUsed,
      metadata: { ...input.metadata, datasetProjectionReused: projected.reused },
      datasetId: projected.dataset.id,
      datasetSnapshotId: projected.snapshot.id,
      datasetStats: projected.stats,
    });
    if (!completed) throw new Error(`Collection run ${input.runId} could not be completed`);
    return completed;
  }
}

export interface CollectionJobHandlerDependencies {
  repository: CollectionRepository;
  service: CollectionService;
  crawler: CrawlerService;
  credentialStore: CredentialStore;
  afterSucceeded?(input: {
    task: CollectionTaskDetail;
    run: NonNullable<Awaited<ReturnType<CollectionRepository['getRun']>>>;
  }): Promise<void>;
  afterFailed?(input: {
    task: CollectionTaskDetail;
    run: NonNullable<Awaited<ReturnType<CollectionRepository['getRun']>>>;
  }): Promise<void>;
}

export function createCollectionJobHandler(dependencies: CollectionJobHandlerDependencies) {
  return async (context: JobExecutionContext): Promise<void> => {
    const taskId = stringPayload(context.job.payload.taskId, 'taskId');
    const runId = stringPayload(context.job.payload.runId, 'runId');
    const [task, activeRule, run] = await Promise.all([
      dependencies.repository.getTask(taskId),
      dependencies.repository.getActiveRule(taskId),
      dependencies.repository.getRun(runId),
    ]);
    if (!task || !activeRule || !run || run.taskId !== taskId) {
      throw new PlatformJobExecutionError(
        'COLLECTION_JOB_CONFLICT',
        'Collection Task, Rule, or Run is unavailable',
        false,
      );
    }
    if (run.status === 'succeeded') {
      await dependencies.afterSucceeded?.({ task, run });
      return;
    }
    if (!(await dependencies.repository.startRun(runId, taskId, context.job.attempt > 1))) {
      throw new PlatformJobExecutionError(
        'COLLECTION_JOB_CONFLICT',
        `Collection Run cannot start from ${run.status}`,
        false,
      );
    }
    await dependencies.repository.appendRunLog({
      runId,
      level: 'info',
      phase: 'starting',
      message: 'Collection Job started',
      url: task.startUrl,
      errorCode: null,
      metadata: { jobId: context.job.id, attempt: context.job.attempt },
    });
    try {
      const resolved = await resolveCollectionTaskSettings(
        task.requestSettings,
        task.browserSettings,
        task.credentialBindings,
        dependencies.credentialStore,
      );
      const result = await dependencies.crawler.crawl({
        url: task.startUrl,
        plan: activeRule.version.definition,
        requestSettings: resolved.requestSettings,
        browserSettings: resolved.browserSettings,
        pagination: task.pagination,
        networkPolicy: task.networkPolicy,
        signal: context.signal,
        onProgress: async (event) => {
          await context.progress(event.progress, event.phase);
        },
        onRequest: async (event) => {
          await dependencies.repository.appendRunRequest({ ...event, runId });
        },
      });
      await context.persisting();
      const completed = await dependencies.service.persistRun({
        runId,
        taskId,
        records: result.records,
        requestCount: result.metadata.requestCount,
        browserUsed: result.metadata.browserUsed,
        aiUsed: result.metadata.aiUsed,
        metadata: {
          durationMs: result.metadata.durationMs,
          warnings: result.metadata.warnings ?? [],
          urls: result.metadata.urls ?? [],
        },
      });
      await dependencies.repository.appendRunLog({
        runId,
        level: 'info',
        phase: 'completed',
        message: `Collection Job completed with ${result.records.length} records`,
        url: null,
        errorCode: null,
        metadata: {},
      });
      await dependencies.afterSucceeded?.({ task, run: completed });
    } catch (error) {
      if (context.signal.aborted) {
        await dependencies.repository.cancelRun(runId);
        await dependencies.repository.appendRunLog({
          runId,
          level: 'warn',
          phase: 'canceled',
          message: 'Collection Job was canceled',
          url: null,
          errorCode: 'CANCELED',
          metadata: {},
        });
        throw new PlatformJobExecutionError('CANCELED', 'Collection Job was canceled', false);
      }
      const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
      const retryable = !/VALIDATION|RULE|NETWORK_POLICY|RESOURCE_LIMIT/.test(message);
      const finalFailure = !retryable || context.job.attempt >= context.job.maxAttempts;
      const failed = await dependencies.repository.failRun(
        runId,
        taskId,
        message.slice(0, 2_000),
        retryable ? 'CRAWLER_ERROR' : 'VALIDATION_ERROR',
        finalFailure,
      );
      await dependencies.repository.appendRunLog({
        runId,
        level: 'error',
        phase: 'failed',
        message: message.slice(0, 2_000),
        url: null,
        errorCode: retryable ? 'CRAWLER_ERROR' : 'VALIDATION_ERROR',
        metadata: {},
      });
      if (failed && finalFailure) await dependencies.afterFailed?.({ task, run: failed });
      throw new PlatformJobExecutionError(
        retryable ? 'CRAWLER_ERROR' : 'VALIDATION_ERROR',
        message,
        retryable,
      );
    }
  };
}

export async function resolveCollectionTaskSettings(
  requestSettings: CollectionTaskDetail['requestSettings'],
  originalBrowserSettings: BrowserSettings,
  bindings: TaskCredentialBindings,
  credentials: CredentialStore,
) {
  const headers = { ...requestSettings.headers };
  let cookies = requestSettings.cookies;
  let proxy = requestSettings.proxy;
  let browserSettings = originalBrowserSettings;
  if (bindings.secretHeadersRef) {
    Object.assign(
      headers,
      await credentials.resolve<Record<string, string>>(bindings.secretHeadersRef),
    );
  }
  if (bindings.cookiesRef) cookies = await credentials.resolve(bindings.cookiesRef);
  if (bindings.proxyRef) proxy = await credentials.resolve(bindings.proxyRef);
  if (bindings.browserStorageStateRef) {
    browserSettings = {
      ...browserSettings,
      storageState: await credentials.resolve(bindings.browserStorageStateRef),
    };
  }
  return {
    requestSettings: { ...requestSettings, headers, cookies, ...(proxy ? { proxy } : {}) },
    browserSettings,
  };
}

function stringPayload(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) {
    throw new PlatformJobExecutionError('COLLECTION_JOB_CONFLICT', `Missing ${name}`, false);
  }
  return value;
}

export class CollectionScheduler {
  private readonly schedules = new Map<string, { signature: string; cron: Cron }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private syncing = false;

  constructor(
    private readonly repository: CollectionRepository,
    private readonly platform: PlatformRepository,
    private readonly jobs: PlatformJobQueue,
    private readonly syncIntervalMs = 5_000,
  ) {}

  async start(): Promise<void> {
    if (this.timer) return;
    await this.sync();
    this.timer = setInterval(() => void this.sync(), this.syncIntervalMs);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const entry of this.schedules.values()) entry.cron.stop();
    this.schedules.clear();
  }

  private async sync(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const tasks = await this.repository.listScheduledTasks();
      const active = new Set(tasks.map(({ id }) => id));
      for (const [taskId, entry] of this.schedules) {
        if (!active.has(taskId)) {
          entry.cron.stop();
          this.schedules.delete(taskId);
        }
      }
      for (const task of tasks) {
        if (task.schedule.mode !== 'cron' || !task.schedule.cron) continue;
        const signature = `${task.schedule.cron}\0${task.schedule.timezone}`;
        if (this.schedules.get(task.id)?.signature === signature) continue;
        this.schedules.get(task.id)?.cron.stop();
        const cron = new Cron(
          task.schedule.cron,
          { timezone: task.schedule.timezone },
          () => void this.trigger(task.id),
        );
        this.schedules.set(task.id, { signature, cron });
        if (
          task.schedule.misfirePolicy === 'run-once' &&
          task.lastTriggeredAt &&
          missedRun(task.schedule.cron, task.schedule.timezone, task.lastTriggeredAt)
        ) {
          void this.trigger(task.id);
        }
      }
    } finally {
      this.syncing = false;
    }
  }

  private async trigger(taskId: string): Promise<void> {
    if ((await this.platform.getRuntimeSetting<boolean>('scheduling.paused')) === true) return;
    if (!(await this.repository.getActiveRule(taskId))) return;
    try {
      const run = await this.repository.createRun(taskId);
      await this.jobs.enqueue({
        id: run.id,
        ownerPluginId: 'collection',
        type: 'collection.crawl.execute',
        resourceClass: 'browser-heavy',
        payload: { taskId, runId: run.id, scheduled: true },
        maxAttempts: 2,
      });
      await this.repository.markScheduleTriggered(taskId);
    } catch {
      // An active Run may already exist; the next cron tick remains authoritative.
    }
  }
}

function missedRun(pattern: string, timezone: string, lastTriggeredAt: string): boolean {
  const calculator = new Cron(pattern, { timezone, paused: true });
  try {
    const next = calculator.nextRun(new Date(lastTriggeredAt));
    return Boolean(next && next.getTime() < Date.now());
  } finally {
    calculator.stop();
  }
}

export function previewSchedule(schedule: Schedule, count = 5, from = new Date()): string[] {
  const parsed = scheduleSchema.parse(schedule);
  if (parsed.mode === 'manual') return [];
  if (!parsed.cron) throw new Error('A cron expression is required');
  const calculator = new Cron(parsed.cron, { timezone: parsed.timezone, paused: true });
  try {
    const result: string[] = [];
    let cursor = from;
    for (let index = 0; index < Math.min(Math.max(count, 1), 20); index += 1) {
      const next = calculator.nextRun(cursor);
      if (!next) break;
      result.push(next.toISOString());
      cursor = new Date(next.getTime() + 1);
    }
    return result;
  } finally {
    calculator.stop();
  }
}
