import { executeProductExample } from '../domain/example.js';
export { CollectionBatchCleanup } from './batch-cleanup.js';
import { createHash } from 'node:crypto';
import {
  CollectionBatchWriter,
  cleanupCollectionBatches,
  type CollectionBatchWriterOptions,
} from './batch-writer.js';
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
  type ArtifactStore,
} from '@zhiyun/platform-core';
import {
  redactSensitiveText,
  createWarningBuffer,
  appendWarnings,
  warningTotal,
  browserActionCacheSummarySchema,
  emitDiagnosticStep,
  observeDiagnosticOperation,
  classifyDiagnosticError,
  type DiagnosticObserver,
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

  createBatchWriter(options: CollectionBatchWriterOptions): CollectionBatchWriter {
    return new CollectionBatchWriter(this.repository, this.datasets, options);
  }

  cleanupBatches(runId: string, artifacts: ArtifactStore): Promise<void> {
    return cleanupCollectionBatches(this.repository, this.datasets, artifacts, runId);
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
    return this.persistProjection({ ...input, recordCount: input.records.length }, (task) =>
      this.datasets.commitRunRecords({
        sourceTaskId: input.taskId,
        sourceRunId: input.runId,
        settings: task.datasetSettings,
        records: input.records,
      }),
    );
  }

  async persistStagedRun(input: {
    runId: string;
    taskId: string;
    fingerprint: string;
    recordCount: number;
    requestCount: number;
    browserUsed: boolean;
    aiUsed: boolean;
    metadata: Record<string, unknown>;
  }) {
    return this.persistProjection(input, () =>
      this.datasets.commitIngestion(input.runId, input.fingerprint),
    );
  }

  private async persistProjection(
    input: {
      runId: string;
      taskId: string;
      recordCount: number;
      requestCount: number;
      browserUsed: boolean;
      aiUsed: boolean;
      metadata: Record<string, unknown>;
    },
    project: (task: CollectionTaskDetail) => ReturnType<DatasetIngestionPort['commitRunRecords']>,
  ) {
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
    const projected = await project(task);
    const completed = await this.repository.completeRun(input.runId, input.taskId, {
      requestCount: input.requestCount,
      recordCount: input.recordCount,
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
  artifacts: ArtifactStore;
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
      // Task deletion cascades the Collection run/session, but its transient
      // Dataset ingestion and Artifact tree are owned by separate capabilities.
      // A mismatched payload must never remove another existing run's data.
      if (!run || run.taskId === taskId)
        await dependencies.service.cleanupBatches(runId, dependencies.artifacts);
      throw new PlatformJobExecutionError(
        'COLLECTION_JOB_CONFLICT',
        'Collection Task, Rule, or Run is unavailable',
        false,
      );
    }
    if (run.status === 'succeeded') {
      await dependencies.service.cleanupBatches(runId, dependencies.artifacts);
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
      metadata: {
        jobId: context.job.id,
        attempt: context.job.attempt,
        ruleVersionId: activeRule.version.id,
      },
    });
    const persistDiagnostic: DiagnosticObserver = async (step) => {
      await dependencies.repository.appendRunLog({
        runId,
        level: 'info',
        phase: 'diagnostic',
        message: step.kind,
        url: null,
        errorCode: step.errorCode ?? null,
        metadata: { diagnostic: step, ruleVersionId: activeRule.version.id },
      });
    };
    const onDiagnostic: DiagnosticObserver = (step) => emitDiagnosticStep(persistDiagnostic, step);
    let recoveryFingerprint: string | undefined;
    try {
      if (
        (typeof run.metadata.expectedTaskRevision === 'number' &&
          run.metadata.expectedTaskRevision !== task.revision) ||
        (typeof run.metadata.expectedRuleVersionId === 'string' &&
          run.metadata.expectedRuleVersionId !== activeRule.version.id)
      )
        throw new Error(
          'VALIDATION: Task or rule changed after this run was confirmed. Prepare a new run.',
        );
      const resolved = await resolveCollectionTaskSettings(
        task.requestSettings,
        task.browserSettings,
        task.credentialBindings,
        dependencies.credentialStore,
      );
      const pagination =
        activeRule.version.definition.pagination.type === 'none'
          ? task.pagination
          : activeRule.version.definition.pagination;
      const fingerprint = createHash('sha256')
        .update(
          canonicalFingerprint({
            version: activeRule.version.definition.discovery
              ? 'collection-sitemap-v1'
              : ['loadMore', 'infinite'].includes(pagination.type)
                ? 'collection-browser-rounds-v1'
                : 'collection-batches-v3',
            taskId: task.id,
            revision: task.revision,
            ruleVersionId: activeRule.version.id,
            definition: activeRule.version.definition,
            url: task.startUrl,
            origin: task.origin,
            pagination: task.pagination,
            networkPolicy: task.networkPolicy,
            datasetSettings: task.datasetSettings,
            ...resolved,
          }),
        )
        .digest('hex');
      recoveryFingerprint = fingerprint;
      const writer = dependencies.service.createBatchWriter({
        artifacts: dependencies.artifacts,
        taskId,
        runId,
        fingerprint,
        settings: task.datasetSettings,
        dedupe: activeRule.version.definition.dedupe,
        maxRecords: activeRule.version.definition.limits.maxRecords,
        signal: context.signal,
        onDiagnostic,
      });
      const initial = await writer.begin();
      let collected = await dependencies.repository.getCrawlResult(runId, fingerprint);
      if (collected) {
        if (initial.acceptedCount !== collected.recordCount)
          throw new Error('VALIDATION: Durable result does not match staged records');
      } else {
        if (initial.committed)
          throw new Error('VALIDATION: Committed ingestion has no durable result');
        const origin = task.origin;
        const result =
          origin.kind === 'example'
            ? await observeDiagnosticOperation(
                onDiagnostic,
                { kind: 'extraction', target: 'list' },
                () => executeProductExample(origin.exampleId, activeRule.version.definition),
                (value) => ({ recordCount: value.records.length }),
                context.signal,
              )
            : await dependencies.crawler.crawl({
                url: task.startUrl,
                plan: activeRule.version.definition,
                cacheBinding: {
                  scope: `task:${task.id}`,
                  ruleVersion: activeRule.version.id,
                  taskVersion: task.revision,
                  configuration: task.datasetSettings,
                },
                requestSettings: resolved.requestSettings,
                browserSettings: resolved.browserSettings,
                pagination: task.pagination,
                networkPolicy: task.networkPolicy,
                signal: context.signal,
                onDiagnostic,
                onBatch: (batch) => writer.write(batch),
                listSpool: writer.listSpool,
                detailCache: writer.detailCache,
                initialRecordCount: initial.acceptedCount,
                checkpoint: writer.checkpoint,
                browserPagination: writer.browserPagination,
                ...(activeRule.version.definition.discovery
                  ? { sitemapSpool: writer.sitemapSpool }
                  : {}),
                onProgress: async (event) => {
                  await context.progress(event.progress, event.phase);
                },
                onRequest: async (event) => {
                  await dependencies.repository.appendRunRequest({ ...event, runId });
                },
              });
        let recordCount =
          'recordCount' in result.metadata ? result.metadata.recordCount : result.records.length;
        if (origin.kind === 'example') {
          const requestId = createHash('sha256')
            .update(`example/${origin.exampleId}`)
            .digest('hex');
          recordCount = initial.acceptedCount;
          for (let offset = 0; offset < result.records.length; offset += 250) {
            const committed = await writer.write({
              requestId,
              sequence: offset / 250,
              records: result.records.slice(offset, offset + 250),
            });
            recordCount = committed.totalCount;
          }
        } else if (result.records.length)
          throw new Error('VALIDATION: Streaming crawler returned an aggregate result');
        const warnings = createWarningBuffer();
        appendWarnings(warnings, result.metadata.warnings ?? [], redactSensitiveText);
        collected = {
          recordCount,
          requestCount: result.metadata.requestCount,
          browserUsed: result.metadata.browserUsed,
          aiUsed: result.metadata.aiUsed,
          ...('actionCache' in result.metadata && result.metadata.actionCache
            ? { actionCache: browserActionCacheSummarySchema.parse(result.metadata.actionCache) }
            : {}),
          durationMs: result.metadata.durationMs ?? null,
          warnings,
          warningTotal:
            'warningTotal' in result.metadata && typeof result.metadata.warningTotal === 'number'
              ? result.metadata.warningTotal
              : warningTotal(warnings),
          urls: result.metadata.urls ?? [],
        };
        await dependencies.repository.saveCrawlResult(runId, fingerprint, collected);
      }
      const finished = collected;
      if (context.signal.aborted) throw new Error('CANCELED: Collection Job was canceled');
      await context.persisting();
      const completed = await observeDiagnosticOperation(
        onDiagnostic,
        { kind: 'write', target: 'dataset', writePhase: 'projection' },
        () =>
          dependencies.service.persistStagedRun({
            runId,
            taskId,
            fingerprint,
            recordCount: finished.recordCount,
            requestCount: finished.requestCount,
            browserUsed: finished.browserUsed,
            aiUsed: finished.aiUsed,
            metadata: {
              durationMs: finished.durationMs,
              warnings: finished.warnings,
              warningTotal: finished.warningTotal ?? finished.warnings.length,
              urls: finished.urls,
              ...(finished.actionCache ? { actionCache: finished.actionCache } : {}),
            },
          }),
        (value) => ({
          writtenCount:
            value.datasetStats.added + value.datasetStats.updated + value.datasetStats.unchanged,
        }),
        context.signal,
      );
      await dependencies.repository.appendRunLog({
        runId,
        level: 'info',
        phase: 'completed',
        message: `Collection Job completed with ${finished.recordCount} records`,
        url: null,
        errorCode: null,
        metadata: {},
      });
      await writer.cleanup();
      await dependencies.afterSucceeded?.({ task, run: completed });
    } catch (error) {
      if (context.signal.aborted) {
        await dependencies.repository.cancelRun(runId);
        await dependencies.service.cleanupBatches(runId, dependencies.artifacts);
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
      const retryable = collectionFailureRetryable(error);
      const completedInput =
        retryable &&
        recoveryFingerprint &&
        (await dependencies.repository.getRun(runId))?.status !== 'succeeded'
          ? await dependencies.repository.getCrawlResult(runId, recoveryFingerprint)
          : null;
      const finalFailure =
        !retryable || (!completedInput && context.job.attempt >= context.job.maxAttempts);
      const failed = await dependencies.repository.failRun(
        runId,
        taskId,
        message.slice(0, 2_000),
        retryable ? 'CRAWLER_ERROR' : 'VALIDATION_ERROR',
        finalFailure,
        !finalFailure,
      );
      if (finalFailure) await dependencies.service.cleanupBatches(runId, dependencies.artifacts);
      await dependencies.repository.appendRunLog({
        runId,
        level: 'error',
        phase: finalFailure ? 'failed' : 'retrying',
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

function canonicalFingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalFingerprint).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalFingerprint(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function collectionFailureRetryable(error: unknown): boolean {
  if (
    ['RESOURCE_LIMIT', 'NETWORK_POLICY_ERROR', 'CANCELED', 'ACTION_STATE_INVALID'].includes(
      classifyDiagnosticError(error),
    )
  )
    return false;
  let current = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const code = 'code' in current && typeof current.code === 'string' ? current.code : '';
    if (/VALIDATION|RULE|NETWORK_POLICY|RESOURCE_LIMIT/.test(`${code} ${current.message}`))
      return false;
    current = current.cause ?? ('details' in current ? current.details : undefined);
  }
  return true;
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

export { CollectionScheduler } from './scheduler.js';

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
