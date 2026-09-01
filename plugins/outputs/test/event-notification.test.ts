import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobExecutionContext, PlatformJob, PlatformJobQueue } from '@zhiyun/platform-core';
import type {
  EventNotificationAttempt,
  OutputDestination,
  OutputRepository,
} from '../src/index.js';
import {
  createEventNotificationJobHandler,
  enqueueOutputEventNotifications,
} from '../src/index.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function webhook(config: Record<string, unknown>): OutputDestination {
  const timestamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: 'Event webhook',
    type: 'webhook',
    config,
    credentialRef: 'webhook-secret',
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function attempt(destinationId: string): EventNotificationAttempt {
  const timestamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    destinationId,
    eventId: crypto.randomUUID(),
    type: 'quality.issue.detected',
    occurredAt: timestamp,
    taskId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
    severity: 'warning',
    payload: { issues: [{ code: 'empty-results' }] },
    status: 'pending',
    attempt: 1,
    responseStatus: null,
    error: null,
    nextAttemptAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function job(attemptId: string): PlatformJob {
  const timestamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerPluginId: 'outputs',
    type: 'outputs.event-notification.execute',
    payload: { attemptId },
    resourceClass: 'delivery',
    state: 'running',
    progress: 0,
    phase: 'running',
    attempt: 1,
    maxAttempts: 3,
    availableAt: timestamp,
    leaseOwner: 'fixture',
    leaseExpiresAt: timestamp,
    cancelRequestedAt: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe('Output event notifications', () => {
  it('filters bound Webhooks by events[] before creating and enqueueing attempts', async () => {
    const subscribed = webhook({ url: 'https://example.com/subscribed', events: ['run.failed'] });
    const ignored = webhook({ url: 'https://example.com/ignored', events: ['run.succeeded'] });
    const taskId = crypto.randomUUID();
    const event = {
      eventId: crypto.randomUUID(),
      type: 'run.failed' as const,
      occurredAt: new Date().toISOString(),
      taskId,
      runId: crypto.randomUUID(),
      severity: 'error' as const,
      payload: { errorCode: 'CRAWL_FAILED' },
    };
    const created: EventNotificationAttempt[] = [];
    const enqueued: Array<Record<string, unknown>> = [];
    const repository = {
      listTaskBindings: async () => [subscribed.id, ignored.id],
      listDestinations: async () => [subscribed, ignored],
      createEventNotificationAttempt: async (input: typeof event & { destinationId: string }) => {
        const value = { ...attempt(input.destinationId), ...input };
        created.push(value);
        return value;
      },
    } as unknown as OutputRepository;
    const queue = {
      get: async () => null,
      enqueue: async (input: Record<string, unknown>) => {
        enqueued.push(input);
        return { ...job(String((input.payload as { attemptId: string }).attemptId)), ...input };
      },
    } as unknown as PlatformJobQueue;
    const results = await enqueueOutputEventNotifications({ repository, jobs: queue }, event);
    expect(results).toHaveLength(1);
    expect(created[0]).toMatchObject({ destinationId: subscribed.id, eventId: event.eventId });
    expect(enqueued[0]).toMatchObject({
      type: 'outputs.event-notification.execute',
      payload: { attemptId: created[0]?.id },
    });
  });

  it('delivers the unified envelope and persists terminal attempt state', async () => {
    let received: { body: unknown; idempotencyKey: string } | undefined;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        received = {
          body: JSON.parse(Buffer.concat(chunks).toString()),
          idempotencyKey: String(request.headers['x-zhiyun-idempotency-key']),
        };
        response.writeHead(202).end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const destination = webhook({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`,
      events: ['quality.issue.detected'],
    });
    let current = attempt(destination.id);
    const repository = {
      getEventNotificationAttempt: async () => current,
      getDestination: async () => destination,
      updateEventNotificationAttempt: async (
        _id: string,
        input: Partial<EventNotificationAttempt>,
      ) => {
        current = { ...current, ...input, updatedAt: new Date().toISOString() };
        return current;
      },
    } as unknown as OutputRepository;
    const handler = createEventNotificationJobHandler({
      repository,
      credentials: { resolve: async <T>() => ({ secret: 'fixture-secret' }) as T },
    });
    await handler({
      job: job(current.id),
      signal: new AbortController().signal,
      progress: async () => undefined,
      persisting: async () => undefined,
    } satisfies JobExecutionContext);
    expect(current).toMatchObject({ status: 'succeeded', responseStatus: 202, error: null });
    expect(received?.idempotencyKey).toBe(current.eventId);
    expect(received?.body).toEqual({
      schemaVersion: 1,
      eventId: current.eventId,
      type: current.type,
      occurredAt: current.occurredAt,
      taskId: current.taskId,
      runId: current.runId,
      severity: current.severity,
      payload: current.payload,
    });
  });
});
