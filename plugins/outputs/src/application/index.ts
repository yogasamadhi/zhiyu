import type {
  DeliveryAttempt,
  OutputRepository,
  OutputsServiceContract,
  OutputDestination,
} from '../contracts/index.js';
import { createHash } from 'node:crypto';
import { outputAdapter } from '@zhiyun/outputs';
import {
  PlatformJobExecutionError,
  type JobExecutionContext,
  type PlatformJobQueue,
} from '@zhiyun/platform-core';
import type { DatasetSettings, DatasetStats } from '@zhiyun/shared';

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
    getTask(id: string): Promise<{ id: string; datasetSettings: DatasetSettings } | null>;
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
}

export function outputDeliveryJobId(attemptId: string, attempt: number): string {
  const hex = createHash('sha256').update(`outputs:${attemptId}:${attempt}`).digest('hex');
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

export function createOutputDeliveryJobHandler(dependencies: OutputDeliveryDependencies) {
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
      const result = await outputAdapter(destination).deliver({
        destination,
        taskId: task.id,
        runId: run.id,
        datasetSettings: task.datasetSettings,
        datasetStats: run.datasetStats,
        records: runRecords(dependencies.datasets, run.id),
        credential,
        signal: context.signal,
      });
      await dependencies.repository.updateDeliveryAttempt(attempt.id, {
        status: 'succeeded',
        responseStatus: result.responseStatus,
        error: null,
        nextAttemptAt: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = !context.signal.aborted && !/Invalid|requires|required/i.test(message);
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
