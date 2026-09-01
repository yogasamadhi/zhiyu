import type {
  DeliveryAttempt,
  OutputRepository,
  OutputsServiceContract,
  OutputDestination,
} from '../contracts/index.js';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  FileOutputArtifactStore,
  outputAdapter,
  outputArtifactId,
  outputArtifactSpec,
  parseFields,
  sendWebhookEventNotification,
  type OutputArtifactStore,
  webhookSubscribes,
} from '@zhiyun/outputs';
import {
  PlatformJobExecutionError,
  type ArtifactStore,
  type JobExecutionContext,
  type PlatformJobQueue,
} from '@zhiyun/platform-core';
import type { CrawlPlanDefinition, DatasetSettings, DatasetStats } from '@zhiyun/shared';
import type { EventNotificationAttempt, EventNotificationInput } from '../contracts/index.js';
import {
  WorkerParquetOutputMaterializer,
  type OutputParquetWorker,
  type ParquetOutputMaterializerOptions,
} from './parquet-output-artifacts.js';

export * from './parquet-output-artifacts.js';

export class OutputsService implements OutputsServiceContract {
  constructor(private readonly repository: OutputRepository) {}

  listDestinations(): Promise<OutputDestination[]> {
    return this.repository.listDestinations();
  }

  getDestination(id: string): Promise<OutputDestination | null> {
    return this.repository.getDestination(id);
  }

  bindTask(taskId: string, destinationIds: readonly string[]): Promise<void> {
    return this.repository.replaceTaskBindings(taskId, [...new Set(destinationIds)]);
  }

  clearCollectionTask(taskId: string): Promise<number> {
    return this.repository.clearTaskBindings(taskId);
  }
}

export interface OutputDeliveryDependencies {
  repository: OutputRepository;
  tasks: {
    getTask(id: string): Promise<{
      id: string;
      name?: string;
      datasetSettings: DatasetSettings;
      activeRule?: { version: { definition: CrawlPlanDefinition } } | null;
    } | null>;
    getRun(id: string): Promise<{ id: string; taskId: string; datasetStats: DatasetStats } | null>;
  };
  datasets: {
    listRunRecords(
      runId: string,
      cursor?: string,
      limit?: number,
    ): Promise<{
      items: Array<{ sourceUrl: string; data: Record<string, unknown> }>;
      nextCursor: string | null;
    }>;
  };
  credentials: { resolve<T = unknown>(reference: string): Promise<T> };
  artifacts?: OutputArtifactStore;
}

/** Stores reusable output materializations in the runtime's controlled ArtifactStore. */
export class PlatformOutputArtifactStore implements OutputArtifactStore {
  private readonly parquet: WorkerParquetOutputMaterializer;

  constructor(
    private readonly artifacts: ArtifactStore,
    options: ParquetOutputMaterializerOptions & {
      parquetWorker?: OutputParquetWorker;
    } = {},
  ) {
    this.parquet = new WorkerParquetOutputMaterializer(artifacts, options.parquetWorker, options);
  }

  async get(id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Output artifact ID is invalid');
    let metadataPath: string;
    try {
      metadataPath = await this.artifacts.resolveArtifact(`outputs/${id}.json`);
    } catch {
      return null;
    }
    return new FileOutputArtifactStore(dirname(metadataPath)).get(id);
  }

  async materialize(
    input: Parameters<OutputArtifactStore['materialize']>[0],
  ): ReturnType<OutputArtifactStore['materialize']> {
    const dataKey = `outputs/${input.id}.${input.spec.format}`;
    const metadataKey = `outputs/${input.id}.json`;
    let metadataPath: string | null = null;
    try {
      metadataPath = await this.artifacts.resolveArtifact(metadataKey);
    } catch {
      // A missing sidecar means the materialization was never atomically completed.
    }
    if (metadataPath) {
      return new FileOutputArtifactStore(dirname(metadataPath)).materialize(input);
    }

    if (input.spec.format === 'parquet') {
      return this.parquet.materialize(input);
    }

    const workspaceId = `output-${randomUUID()}`;
    const workspace = await this.artifacts.openWorkspace(workspaceId);
    try {
      const materialized = await new FileOutputArtifactStore(workspace.rootPath).materialize(input);
      await this.artifacts.commitWorkspaceFile(workspaceId, basename(materialized.path), dataKey);
      await this.artifacts.commitWorkspaceFile(workspaceId, `${input.id}.json`, metadataKey);
      return {
        ...materialized,
        path: await this.artifacts.resolveArtifact(dataKey),
      };
    } finally {
      await this.artifacts.removeWorkspace(workspaceId);
    }
  }
}

export function outputDeliveryJobId(attemptId: string, attempt: number): string {
  const hex = createHash('sha256').update(`outputs:${attemptId}:${attempt}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function eventNotificationJobId(attemptId: string, attempt: number): string {
  const hex = createHash('sha256')
    .update(`outputs:event-notification:${attemptId}:${attempt}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function enqueueOutputDelivery(
  queue: PlatformJobQueue,
  attempt: DeliveryAttempt,
): Promise<void> {
  const id = outputDeliveryJobId(attempt.id, attempt.attempt);
  if (await queue.get(id)) return;
  await queue.enqueue({
    id,
    ownerPluginId: 'outputs',
    type: 'outputs.delivery.execute',
    resourceClass: 'delivery',
    payload: { attemptId: attempt.id },
    maxAttempts: 2,
  });
}

export async function enqueueEventNotification(
  queue: PlatformJobQueue,
  attempt: EventNotificationAttempt,
): Promise<void> {
  const id = eventNotificationJobId(attempt.id, attempt.attempt);
  if (await queue.get(id)) return;
  await queue.enqueue({
    id,
    ownerPluginId: 'outputs',
    type: 'outputs.event-notification.execute',
    resourceClass: 'delivery',
    payload: { attemptId: attempt.id },
    maxAttempts: 3,
  });
}

export async function enqueueOutputEventNotifications(
  dependencies: { repository: OutputRepository; jobs: PlatformJobQueue },
  event: EventNotificationInput,
): Promise<EventNotificationAttempt[]> {
  const [destinationIds, destinations] = await Promise.all([
    dependencies.repository.listTaskBindings(event.taskId),
    dependencies.repository.listDestinations(),
  ]);
  const bound = new Set(destinationIds);
  const attempts: EventNotificationAttempt[] = [];
  for (const destination of destinations) {
    if (
      !bound.has(destination.id) ||
      !destination.enabled ||
      destination.type !== 'webhook' ||
      !webhookSubscribes(destination.config, event.type)
    ) {
      continue;
    }
    const attempt = await dependencies.repository.createEventNotificationAttempt({
      destinationId: destination.id,
      ...event,
    });
    attempts.push(attempt);
    if (attempt.status !== 'succeeded') await enqueueEventNotification(dependencies.jobs, attempt);
  }
  return attempts;
}

export function destinationReceivesRunData(destination: OutputDestination | null): boolean {
  if (!destination?.enabled) return false;
  if (destination.type !== 'webhook') return true;
  return (
    webhookSubscribes(destination.config, 'run.succeeded') ||
    webhookSubscribes(destination.config, 'dataset.changed')
  );
}

export function createOutputDeliveryJobHandler(dependencies: OutputDeliveryDependencies) {
  const artifacts =
    dependencies.artifacts ??
    new FileOutputArtifactStore(
      process.env.ZHIYUN_DATA_DIR
        ? join(process.env.ZHIYUN_DATA_DIR, 'output-artifacts')
        : join(tmpdir(), 'zhiyun-output-artifacts'),
    );
  return async (context: JobExecutionContext): Promise<void> => {
    const attemptId = context.job.payload.attemptId;
    if (typeof attemptId !== 'string') {
      throw new PlatformJobExecutionError(
        'OUTPUT_DELIVERY_CONFLICT',
        'Delivery attempt ID is missing',
        false,
      );
    }
    const attempt = (await dependencies.repository.listDeliveryAttempts()).find(
      (candidate) => candidate.id === attemptId,
    );
    if (!attempt) {
      throw new PlatformJobExecutionError(
        'OUTPUT_DELIVERY_CONFLICT',
        'Delivery attempt was not found',
        false,
      );
    }
    if (attempt.status === 'succeeded') return;
    const [destination, task, run] = await Promise.all([
      dependencies.repository.getDestination(attempt.destinationId),
      dependencies.tasks.getTask(attempt.taskId),
      dependencies.tasks.getRun(attempt.runId),
    ]);
    if (!destination || !destination.enabled || !task || !run || run.taskId !== task.id) {
      throw new PlatformJobExecutionError(
        'OUTPUT_DELIVERY_CONFLICT',
        'Delivery destination, task, or run is unavailable',
        false,
      );
    }
    await dependencies.repository.updateDeliveryAttempt(attempt.id, {
      status: 'running',
      error: null,
      nextAttemptAt: null,
    });
    try {
      const credential = destination.credentialRef
        ? await dependencies.credentials.resolve(destination.credentialRef)
        : {};
      let artifact = attempt.artifactId ? await artifacts.get(attempt.artifactId) : null;
      let resolvedDestination = resolveOutputDestinationTask(destination, task);
      if (!artifact) {
        resolvedDestination = await resolveOutputDestinationFields(
          resolvedDestination,
          task,
          dependencies.datasets,
          run.id,
        );
      }
      const artifactSpec = artifact ? null : outputArtifactSpec(resolvedDestination);
      artifact ??= artifactSpec
        ? await artifacts.materialize({
            id: outputArtifactId(run.id, artifactSpec),
            spec: artifactSpec,
            records: runRecords(dependencies.datasets, run.id),
            ...(context.signal ? { signal: context.signal } : {}),
          })
        : null;
      if (artifact) {
        await dependencies.repository.updateDeliveryAttempt(attempt.id, {
          format: artifact.format,
          artifactId: artifact.id,
          sha256: artifact.sha256,
          deliveredRecordCount: artifact.delivered,
        });
      }
      const result = await outputAdapter(resolvedDestination).deliver({
        destination: resolvedDestination,
        taskId: task.id,
        runId: run.id,
        datasetSettings: task.datasetSettings,
        datasetStats: run.datasetStats,
        records: artifact ? [] : runRecords(dependencies.datasets, run.id),
        credential,
        ...(artifact ? { artifact } : {}),
        signal: context.signal,
      });
      await dependencies.repository.updateDeliveryAttempt(attempt.id, {
        status: 'succeeded',
        responseStatus: result.responseStatus,
        error: null,
        nextAttemptAt: null,
        format: result.format ?? artifact?.format ?? attempt.format,
        artifactId: result.artifactId ?? artifact?.id ?? attempt.artifactId,
        finalLocation:
          result.finalLocation === undefined ? attempt.finalLocation : result.finalLocation,
        sha256: result.sha256 ?? artifact?.sha256 ?? attempt.sha256,
        deliveredRecordCount:
          result.deliveredRecordCount ?? artifact?.delivered ?? result.delivered,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        !context.signal.aborted && !/HTTP 4(?!08|29)\d|Invalid|requires|required/i.test(message);
      await dependencies.repository.updateDeliveryAttempt(attempt.id, {
        status: 'failed',
        error: message.slice(0, 2_000),
        nextAttemptAt: retryable
          ? new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** attempt.attempt)).toISOString()
          : null,
      });
      throw new PlatformJobExecutionError('OUTPUT_DELIVERY_FAILED', message, retryable);
    }
  };
}

export function createEventNotificationJobHandler(
  dependencies: Pick<OutputDeliveryDependencies, 'repository' | 'credentials'>,
) {
  return async (context: JobExecutionContext): Promise<void> => {
    const attemptId = context.job.payload.attemptId;
    if (typeof attemptId !== 'string') {
      throw new PlatformJobExecutionError(
        'OUTPUT_EVENT_NOTIFICATION_CONFLICT',
        'Event notification attempt ID is missing',
        false,
      );
    }
    const attempt = await dependencies.repository.getEventNotificationAttempt(attemptId);
    if (!attempt) {
      throw new PlatformJobExecutionError(
        'OUTPUT_EVENT_NOTIFICATION_CONFLICT',
        'Event notification attempt was not found',
        false,
      );
    }
    if (attempt.status === 'succeeded') return;
    const destination = await dependencies.repository.getDestination(attempt.destinationId);
    if (!destination || !destination.enabled || destination.type !== 'webhook') {
      throw new PlatformJobExecutionError(
        'OUTPUT_EVENT_NOTIFICATION_CONFLICT',
        'Webhook destination is unavailable',
        false,
      );
    }
    if (!webhookSubscribes(destination.config, attempt.type)) {
      await dependencies.repository.updateEventNotificationAttempt(attempt.id, {
        status: 'succeeded',
        responseStatus: null,
        error: null,
        nextAttemptAt: null,
      });
      return;
    }
    await dependencies.repository.updateEventNotificationAttempt(attempt.id, {
      status: 'running',
      error: null,
      nextAttemptAt: null,
    });
    try {
      const credential = destination.credentialRef
        ? await dependencies.credentials.resolve(destination.credentialRef)
        : {};
      const result = await sendWebhookEventNotification({
        destination,
        envelope: {
          schemaVersion: 1,
          eventId: attempt.eventId,
          type: attempt.type,
          occurredAt: attempt.occurredAt,
          taskId: attempt.taskId,
          runId: attempt.runId,
          severity: attempt.severity,
          payload: attempt.payload,
        },
        credential,
        signal: context.signal,
      });
      await dependencies.repository.updateEventNotificationAttempt(attempt.id, {
        status: 'succeeded',
        responseStatus: result.responseStatus,
        error: null,
        nextAttemptAt: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable =
        !context.signal.aborted &&
        !/HTTP 4(?!08|29)\d|Invalid|requires|required|subscribe/i.test(message);
      await dependencies.repository.updateEventNotificationAttempt(attempt.id, {
        status: 'failed',
        error: message.slice(0, 2_000),
        nextAttemptAt: retryable
          ? new Date(Date.now() + Math.min(60_000, 1_000 * 2 ** attempt.attempt)).toISOString()
          : null,
      });
      throw new PlatformJobExecutionError('OUTPUT_EVENT_NOTIFICATION_FAILED', message, retryable);
    }
  };
}

async function* runRecords(
  datasets: OutputDeliveryDependencies['datasets'],
  runId: string,
): AsyncGenerator<{ sourceUrl: string; data: Record<string, unknown> }> {
  let cursor: string | undefined;
  do {
    const page = await datasets.listRunRecords(runId, cursor, 500);
    yield* page.items;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}

export async function resolveOutputDestinationFields<T extends OutputDestination>(
  destination: T,
  task: {
    activeRule?: { version: { definition: CrawlPlanDefinition } } | null;
  },
  datasets: OutputDeliveryDependencies['datasets'],
  runId: string,
): Promise<T> {
  if (
    destination.type !== 'local-directory' &&
    destination.type !== 's3' &&
    destination.type !== 'google-sheets'
  ) {
    return destination;
  }
  const configured = parseFields(destination.config.fields ?? destination.config.columns);
  if (configured.length > 0) return destination;

  const ruleFields = activeRuleOutputFields(task.activeRule?.version.definition);
  const fields = ruleFields.length > 0 ? ruleFields : await scanRunFields(datasets, runId);
  if (fields.length === 0) return destination;
  return {
    ...destination,
    config: { ...destination.config, fields },
  } as T;
}

export function outputTaskSlug(task: { id: string; name?: string }): string {
  const normalized = (task.name ?? 'task')
    .normalize('NFKC')
    .replaceAll(/[^\p{L}\p{N}._-]+/gu, '-')
    .replaceAll(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .slice(0, 96);
  const idSuffix = task.id.replaceAll(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'unknown';
  return `${normalized || 'task'}-${idSuffix}`;
}

export function resolveOutputDestinationTask(
  destination: OutputDestination,
  task: { id: string; name?: string },
): OutputDestination {
  if (destination.type !== 'local-directory' && destination.type !== 's3') return destination;
  return {
    ...destination,
    config: { ...destination.config, taskSlug: outputTaskSlug(task) },
  } as OutputDestination;
}

export function activeRuleOutputFields(definition: CrawlPlanDefinition | undefined): string[] {
  if (!definition) return [];
  const fields: string[] = [];
  const seen = new Set<string>();
  const append = (value: Record<string, unknown>) => {
    for (const field of Object.keys(value)) {
      if (!seen.has(field)) {
        seen.add(field);
        fields.push(field);
      }
    }
  };
  append(definition.list.rule.fields);
  if (definition.detail) append(definition.detail.rule.fields);
  return fields;
}

async function scanRunFields(
  datasets: OutputDeliveryDependencies['datasets'],
  runId: string,
): Promise<string[]> {
  const fields = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await datasets.listRunRecords(runId, cursor, 500);
    for (const record of page.items) {
      for (const field of Object.keys(record.data)) {
        if (field) fields.add(field);
      }
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return [...fields].sort();
}
