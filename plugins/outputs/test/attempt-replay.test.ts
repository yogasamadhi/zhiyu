import { describe, expect, it, vi } from 'vitest';
import type { PlatformJob, PlatformJobQueue } from '@zhiyun/platform-core';
import type {
  DeliveryAttempt,
  EventNotificationAttempt,
  OutputRepository,
} from '../src/contracts/index.js';
import { OutputAttemptReplay } from '../src/application/attempt-replay.js';

const now = '2026-08-31T01:00:00.000Z';

describe('OutputAttemptReplay', () => {
  it('replays pending attempts and starts a new job for due retryable failures', async () => {
    const pendingDelivery = deliveryAttempt({ status: 'pending' });
    let failedNotification = notificationAttempt({
      status: 'failed',
      nextAttemptAt: '2026-08-31T00:59:00.000Z',
    });
    const repository = {
      listDeliveryAttempts: async () => [pendingDelivery],
      listEventNotificationAttempts: async () => [failedNotification],
      updateDeliveryAttempt: async () => pendingDelivery,
      updateEventNotificationAttempt: async (_id: string, input: object) => {
        failedNotification = { ...failedNotification, ...input };
        return failedNotification;
      },
    } as unknown as OutputRepository;
    const enqueued: Array<{ id?: string; payload: Record<string, unknown> }> = [];
    const queue = {
      get: async () => null,
      enqueue: async (input: { id?: string; payload: Record<string, unknown> }) => {
        enqueued.push(input);
        return { id: input.id } as PlatformJob;
      },
    } as unknown as PlatformJobQueue;

    await new OutputAttemptReplay(repository, queue, {
      now: () => Date.parse(now),
    }).sweep();

    expect(enqueued.map(({ payload }) => payload)).toEqual(
      expect.arrayContaining([
        { attemptId: pendingDelivery.id },
        { attemptId: failedNotification.id },
      ]),
    );
    expect(failedNotification).toMatchObject({
      status: 'pending',
      attempt: 2,
      error: null,
      nextAttemptAt: null,
    });
  });

  it('does not replay terminal or not-yet-due failures', async () => {
    const repository = {
      listDeliveryAttempts: async () => [
        deliveryAttempt({ status: 'succeeded' }),
        deliveryAttempt({
          status: 'failed',
          nextAttemptAt: '2026-08-31T01:01:00.000Z',
        }),
      ],
      listEventNotificationAttempts: async () => [
        notificationAttempt({ status: 'failed', nextAttemptAt: null }),
      ],
    } as unknown as OutputRepository;
    const enqueue = vi.fn();
    const queue = { get: async () => null, enqueue } as unknown as PlatformJobQueue;

    await new OutputAttemptReplay(repository, queue, {
      now: () => Date.parse(now),
    }).sweep();

    expect(enqueue).not.toHaveBeenCalled();
  });
});

function deliveryAttempt(input: Partial<DeliveryAttempt>): DeliveryAttempt {
  return {
    id: crypto.randomUUID(),
    destinationId: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    status: 'pending',
    attempt: 1,
    responseStatus: null,
    error: null,
    nextAttemptAt: null,
    format: null,
    artifactId: null,
    finalLocation: null,
    sha256: null,
    deliveredRecordCount: null,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}

function notificationAttempt(input: Partial<EventNotificationAttempt>): EventNotificationAttempt {
  return {
    id: crypto.randomUUID(),
    destinationId: crypto.randomUUID(),
    eventId: crypto.randomUUID(),
    type: 'run.failed',
    occurredAt: now,
    taskId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    severity: 'error',
    payload: {},
    status: 'pending',
    attempt: 1,
    responseStatus: null,
    error: null,
    nextAttemptAt: null,
    createdAt: now,
    updatedAt: now,
    ...input,
  };
}
