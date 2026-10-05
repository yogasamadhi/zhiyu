import {
  DurableEventDispatcher,
  PlatformJobExecutionError,
  type JobExecutionContext,
  type PlatformEvent,
  type PlatformJobQueue,
  type PlatformRepository,
} from '@zhiyun/platform-core';
import type { DatasetStats, RecordChange } from '@zhiyun/shared';
import type { MonitoringService } from './index.js';

export type MonitoringEvaluationOutcome = 'succeeded' | 'failed';

export interface MonitoringEvaluationJobInput extends Record<string, unknown> {
  taskId: string;
  runId: string;
  outcome: MonitoringEvaluationOutcome;
}

export function monitoringEvaluationJobId(runId: string): string {
  return `monitoring:quality:${runId}`;
}

export async function enqueueMonitoringEvaluation(
  queue: PlatformJobQueue,
  input: MonitoringEvaluationJobInput,
): Promise<void> {
  const id = monitoringEvaluationJobId(input.runId);
  if (await queue.get(id)) return;
  await queue.enqueue({
    id,
    ownerPluginId: 'monitoring',
    type: 'monitoring.quality.evaluate',
    resourceClass: 'io',
    payload: input,
    maxAttempts: 5,
  });
}

export interface MonitoringEvaluationJobDependencies {
  service: MonitoringService;
  collection: {
    getRun(id: string): Promise<{
      id: string;
      taskId: string;
      status: string;
      error: string | null;
      datasetStats: DatasetStats;
    } | null>;
  };
  datasets: {
    getDatasetBySourceTask?(taskId: string): Promise<{ id: string } | null>;
    listChanges?(
      datasetId: string,
      cursor?: string,
      limit?: number,
      runId?: string,
    ): Promise<{ items: RecordChange[]; nextCursor: string | null }>;
    listRunRecords(
      runId: string,
      cursor?: string,
      limit?: number,
    ): Promise<{
      items: Array<{ data: Record<string, unknown> }>;
      nextCursor: string | null;
    }>;
  };
}

export function createMonitoringEvaluationJobHandler(
  dependencies: MonitoringEvaluationJobDependencies,
) {
  return async (context: JobExecutionContext): Promise<void> => {
    const input = jobInput(context);
    const run = await dependencies.collection.getRun(input.runId);
    if (!run || run.taskId !== input.taskId) {
      throw new PlatformJobExecutionError(
        'MONITORING_RUN_CONFLICT',
        'The Collection Run for quality evaluation is unavailable',
        false,
      );
    }
    await context.progress(0.05, 'loading-run');
    if (input.outcome === 'failed') {
      if (run.status !== 'failed') {
        throw new PlatformJobExecutionError(
          'MONITORING_RUN_CONFLICT',
          `A failed quality evaluation cannot run from ${run.status}`,
          false,
        );
      }
      await dependencies.service.recordFailed({
        taskId: input.taskId,
        runId: input.runId,
        error: run.error,
      });
    } else {
      if (run.status !== 'succeeded') {
        throw new PlatformJobExecutionError(
          'MONITORING_RUN_CONFLICT',
          `A successful quality evaluation cannot run from ${run.status}`,
          false,
        );
      }
      await dependencies.service.evaluateSucceeded({
        taskId: input.taskId,
        runId: input.runId,
        datasetStats: run.datasetStats,
        records: runRecords(dependencies.datasets, input.runId),
        changes: runChanges(dependencies.datasets, input.taskId, input.runId),
      });
    }
    await context.progress(1, 'completed');
  };
}

async function* runChanges(
  datasets: MonitoringEvaluationJobDependencies['datasets'],
  taskId: string,
  runId: string,
): AsyncGenerator<RecordChange> {
  if (!datasets.getDatasetBySourceTask || !datasets.listChanges)
    throw new Error('Committed Run changes are unavailable');
  const dataset = await datasets.getDatasetBySourceTask(taskId);
  if (!dataset) throw new Error('The Run Dataset is unavailable');
  let cursor: string | undefined;
  do {
    const page = await datasets.listChanges(dataset.id, cursor, 500, runId);
    for (const change of page.items) {
      if (change.runId !== runId || change.datasetId !== dataset.id)
        throw new Error('Run changes do not match the evaluation input');
      yield change;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}

/** Reconstructs deterministic quality jobs from the durable run event stream. */
export class MonitoringEvaluationOutbox {
  private readonly dispatcher: DurableEventDispatcher;
  private timer: ReturnType<typeof setInterval> | undefined;
  private dispatching = false;

  constructor(
    platform: PlatformRepository,
    queue: PlatformJobQueue,
    private readonly intervalMs = 5_000,
  ) {
    this.dispatcher = new DurableEventDispatcher(platform, [
      {
        consumerId: 'monitoring.quality-jobs.v1',
        eventTypes: ['collection.run.succeeded', 'collection.run.failed', 'run.failed'],
        async handle(event) {
          const input = eventInput(event);
          if (input) await enqueueMonitoringEvaluation(queue, input);
        },
      },
    ]);
  }

  async start(): Promise<void> {
    await this.dispatch();
    this.timer = setInterval(() => void this.dispatch(), Math.max(1_000, this.intervalMs));
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async dispatch(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      await this.dispatcher.dispatchOnce(1_000);
    } finally {
      this.dispatching = false;
    }
  }
}

function jobInput(context: JobExecutionContext): MonitoringEvaluationJobInput {
  const taskId = context.job.payload.taskId;
  const runId = context.job.payload.runId;
  const outcome = context.job.payload.outcome;
  if (
    typeof taskId !== 'string' ||
    !taskId ||
    typeof runId !== 'string' ||
    !runId ||
    (outcome !== 'succeeded' && outcome !== 'failed')
  ) {
    throw new PlatformJobExecutionError(
      'MONITORING_JOB_INVALID',
      'The quality evaluation job payload is invalid',
      false,
    );
  }
  return { taskId, runId, outcome };
}

function eventInput(event: PlatformEvent): MonitoringEvaluationJobInput | null {
  if (event.type === 'collection.run.failed' && event.payload.finalFailure !== true) return null;
  const taskId = event.payload.taskId;
  const runId = event.payload.runId ?? event.aggregateId;
  if (typeof taskId !== 'string' || !taskId || typeof runId !== 'string' || !runId) return null;
  return {
    taskId,
    runId,
    outcome: event.type.endsWith('run.failed') ? 'failed' : 'succeeded',
  };
}

async function* runRecords(
  datasets: MonitoringEvaluationJobDependencies['datasets'],
  runId: string,
): AsyncGenerator<{ data: Record<string, unknown> }> {
  let cursor: string | undefined;
  do {
    const page = await datasets.listRunRecords(runId, cursor, 500);
    yield* page.items;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}
