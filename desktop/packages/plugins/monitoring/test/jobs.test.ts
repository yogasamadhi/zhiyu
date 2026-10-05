import { describe, expect, it } from 'vitest';
import type {
  JobExecutionContext,
  PlatformEvent,
  PlatformJob,
  PlatformJobQueue,
  PlatformRepository,
} from '@zhiyun/platform-core';
import type { MonitoringService } from '../src/application/index.js';
import {
  createMonitoringEvaluationJobHandler,
  monitoringEvaluationJobId,
  MonitoringEvaluationOutbox,
} from '../src/application/jobs.js';

describe('monitoring quality jobs', () => {
  it('reconstructs one deterministic job from the durable collection event', async () => {
    const taskId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const event = platformEvent({
      type: 'collection.run.succeeded',
      aggregateId: runId,
      payload: { taskId, runId },
    });
    let checkpoint = 0;
    const platform = {
      getConsumerCheckpoint: async () => checkpoint,
      listEvents: async (after: number) => (after < event.cursor ? [event] : []),
      saveConsumerCheckpoint: async (_consumerId: string, cursor: number) => {
        checkpoint = cursor;
      },
      recordDeadLetter: async () => 1,
    } as unknown as PlatformRepository;
    const enqueued = new Map<string, PlatformJob>();
    const queue = {
      get: async (id: string) => enqueued.get(id) ?? null,
      enqueue: async (input: Record<string, unknown>) => {
        const value = job(input as unknown as Partial<PlatformJob>);
        enqueued.set(value.id, value);
        return value;
      },
    } as unknown as PlatformJobQueue;
    const outbox = new MonitoringEvaluationOutbox(platform, queue);

    await outbox.dispatch();
    await outbox.dispatch();

    expect(checkpoint).toBe(event.cursor);
    expect([...enqueued.values()]).toEqual([
      expect.objectContaining({
        id: monitoringEvaluationJobId(runId),
        ownerPluginId: 'monitoring',
        type: 'monitoring.quality.evaluate',
        resourceClass: 'io',
        payload: { taskId, runId, outcome: 'succeeded' },
        maxAttempts: 5,
      }),
    ]);
  });

  it('ignores retryable collection failures and reconstructs only the transactional final failure', async () => {
    const taskId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const events = [
      platformEvent({
        cursor: 1,
        type: 'collection.run.failed',
        aggregateId: runId,
        payload: { taskId, finalFailure: false },
      }),
      platformEvent({
        cursor: 2,
        type: 'collection.run.failed',
        aggregateId: runId,
        payload: { taskId, finalFailure: true },
      }),
    ];
    let checkpoint = 0;
    const platform = {
      getConsumerCheckpoint: async () => checkpoint,
      listEvents: async (after: number) => events.filter((event) => event.cursor > after),
      saveConsumerCheckpoint: async (_consumerId: string, cursor: number) => {
        checkpoint = cursor;
      },
      recordDeadLetter: async () => 1,
    } as unknown as PlatformRepository;
    const enqueued: PlatformJob[] = [];
    const queue = {
      get: async (id: string) => enqueued.find((candidate) => candidate.id === id) ?? null,
      enqueue: async (input: Record<string, unknown>) => {
        const value = job(input as unknown as Partial<PlatformJob>);
        enqueued.push(value);
        return value;
      },
    } as unknown as PlatformJobQueue;

    await new MonitoringEvaluationOutbox(platform, queue).dispatch();

    expect(checkpoint).toBe(2);
    expect(enqueued).toEqual([
      expect.objectContaining({
        id: monitoringEvaluationJobId(runId),
        payload: { taskId, runId, outcome: 'failed' },
      }),
    ]);
  });

  it('streams successful run records inside the independent job handler', async () => {
    const taskId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const observed: Array<Record<string, unknown>> = [];
    const service = {
      async evaluateSucceeded(input: {
        taskId: string;
        runId: string;
        records: AsyncIterable<{ data: Record<string, unknown> }>;
      }) {
        expect(input).toMatchObject({ taskId, runId });
        for await (const record of input.records) observed.push(record.data);
      },
    } as unknown as MonitoringService;
    const handler = createMonitoringEvaluationJobHandler({
      service,
      collection: {
        getRun: async () => ({
          id: runId,
          taskId,
          status: 'succeeded',
          error: null,
          datasetStats: { added: 2, updated: 0, removed: 0, unchanged: 0, current: 2 },
        }),
      },
      datasets: {
        listRunRecords: async (_runId, cursor) =>
          cursor
            ? { items: [{ data: { id: 2 } }], nextCursor: null }
            : { items: [{ data: { id: 1 } }], nextCursor: 'page-2' },
      },
    });
    const phases: string[] = [];

    await handler({
      job: job({
        id: monitoringEvaluationJobId(runId),
        payload: { taskId, runId, outcome: 'succeeded' },
      }),
      signal: new AbortController().signal,
      progress: async (_progress, phase) => {
        phases.push(phase);
      },
      persisting: async () => undefined,
    } satisfies JobExecutionContext);

    expect(observed).toEqual([{ id: 1 }, { id: 2 }]);
    expect(phases).toEqual(['loading-run', 'completed']);
  });
});

function platformEvent(input: Partial<PlatformEvent>): PlatformEvent {
  return {
    id: crypto.randomUUID(),
    cursor: 1,
    type: 'collection.run.succeeded',
    schemaVersion: 1,
    producerPluginId: 'collection',
    aggregateType: 'run',
    aggregateId: crypto.randomUUID(),
    payload: {},
    occurredAt: new Date().toISOString(),
    ...input,
  };
}

function job(input: Partial<PlatformJob>): PlatformJob {
  const timestamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerPluginId: 'monitoring',
    type: 'monitoring.quality.evaluate',
    payload: {},
    resourceClass: 'io',
    state: 'running',
    progress: 0,
    phase: 'running',
    attempt: 1,
    maxAttempts: 5,
    availableAt: timestamp,
    leaseOwner: 'fixture',
    leaseExpiresAt: timestamp,
    cancelRequestedAt: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...input,
  };
}
