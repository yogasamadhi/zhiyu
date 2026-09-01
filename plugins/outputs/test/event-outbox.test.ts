import { describe, expect, it } from 'vitest';
import type {
  PlatformEvent,
  PlatformJob,
  PlatformJobQueue,
  PlatformRepository,
} from '@zhiyun/platform-core';
import type {
  EventNotificationAttempt,
  OutputDestination,
  OutputRepository,
} from '../src/contracts/index.js';
import { OutputEventNotificationOutbox } from '../src/application/event-outbox.js';

describe('OutputEventNotificationOutbox', () => {
  it('reconstructs a missed notification attempt from the durable event stream', async () => {
    const taskId = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const event = platformEvent({
      type: 'run.failed',
      payload: {
        taskId,
        runId,
        error: 'https://user:pass@example.com/?token=do-not-leak',
      },
    });
    let checkpoint = 0;
    const platform = {
      getConsumerCheckpoint: async () => checkpoint,
      listEvents: async (after: number) => (after < event.cursor ? [event] : []),
      saveConsumerCheckpoint: async (_consumer: string, cursor: number) => {
        checkpoint = cursor;
      },
      recordDeadLetter: async () => 1,
    } as unknown as PlatformRepository;
    const timestamp = new Date().toISOString();
    const destination: OutputDestination = {
      id: crypto.randomUUID(),
      name: 'Failure notifications',
      type: 'webhook',
      config: { url: 'https://example.com/hook', events: ['run.failed'] },
      credentialRef: null,
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const created: Array<Record<string, unknown>> = [];
    const repository = {
      listTaskBindings: async () => [destination.id],
      listDestinations: async () => [destination],
      createEventNotificationAttempt: async (input: Record<string, unknown>) => {
        created.push(input);
        return {
          ...input,
          id: crypto.randomUUID(),
          status: 'pending',
          attempt: 1,
          responseStatus: null,
          error: null,
          nextAttemptAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        } as EventNotificationAttempt;
      },
    } as unknown as OutputRepository;
    const jobs = {
      get: async () => null,
      enqueue: async (input: { id?: string }) => ({ id: input.id }) as PlatformJob,
    } as unknown as PlatformJobQueue;

    await new OutputEventNotificationOutbox(platform, repository, jobs).dispatch();

    expect(checkpoint).toBe(event.cursor);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      eventId: event.id,
      type: 'run.failed',
      taskId,
      runId,
      severity: 'error',
    });
    expect(JSON.stringify(created[0])).not.toContain('do-not-leak');
    expect(JSON.stringify(created[0])).not.toContain('user:pass');
  });
});

function platformEvent(input: Partial<PlatformEvent>): PlatformEvent {
  return {
    id: crypto.randomUUID(),
    cursor: 1,
    type: 'run.succeeded',
    schemaVersion: 1,
    producerPluginId: 'collection',
    aggregateType: 'run',
    aggregateId: crypto.randomUUID(),
    payload: {},
    occurredAt: new Date().toISOString(),
    ...input,
  };
}
