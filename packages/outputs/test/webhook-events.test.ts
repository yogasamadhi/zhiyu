import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  sendWebhookEventNotification,
  webhookSubscribes,
  type OutputDestinationLike,
} from '../src/index.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

function destination(url: string, events: string[]): OutputDestinationLike {
  const timestamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: 'Notification fixture',
    type: 'webhook',
    config: { url, events },
    credentialRef: null,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe('Webhook event notifications', () => {
  it('sends the unified envelope with stable event idempotency and HMAC headers', async () => {
    let received:
      { body: string; idempotencyKey: string; timestamp: string; signature: string } | undefined;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        received = {
          body: Buffer.concat(chunks).toString(),
          idempotencyKey: String(request.headers['x-zhiyun-idempotency-key']),
          timestamp: String(request.headers['x-zhiyun-timestamp']),
          signature: String(request.headers['x-zhiyun-signature']),
        };
        response.writeHead(202).end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const eventId = crypto.randomUUID();
    const envelope = {
      schemaVersion: 1 as const,
      eventId,
      type: 'run.failed' as const,
      occurredAt: new Date().toISOString(),
      taskId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      severity: 'error' as const,
      payload: { errorCode: 'CRAWL_FAILED' },
    };
    const result = await sendWebhookEventNotification({
      destination: destination(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`,
        ['run.failed'],
      ),
      envelope,
      credential: { secret: 'fixture-secret' },
    });
    expect(result).toEqual({ responseStatus: 202 });
    expect(JSON.parse(received!.body)).toEqual(envelope);
    expect(received!.idempotencyKey).toBe(eventId);
    expect(received!.signature).toBe(
      `sha256=${createHmac('sha256', 'fixture-secret')
        .update(`${received!.timestamp}.${received!.body}`)
        .digest('hex')}`,
    );
  });

  it('filters events[] and supports the legacy single event setting', async () => {
    expect(webhookSubscribes({ events: ['run.failed'] }, 'run.failed')).toBe(true);
    expect(webhookSubscribes({ events: ['run.failed'] }, 'run.succeeded')).toBe(false);
    expect(webhookSubscribes({ event: 'dataset.changed' }, 'dataset.changed')).toBe(true);
    expect(webhookSubscribes({}, 'run.succeeded')).toBe(true);
    await expect(
      sendWebhookEventNotification({
        destination: destination('https://example.com/hook', ['run.succeeded']),
        envelope: {
          schemaVersion: 1,
          eventId: crypto.randomUUID(),
          type: 'quality.issue.detected',
          occurredAt: new Date().toISOString(),
          taskId: crypto.randomUUID(),
          runId: null,
          severity: 'warning',
          payload: {},
        },
        credential: null,
      }),
    ).rejects.toThrow('does not subscribe');
  });

  it('redacts credentials from structured and diagnostic event payloads', async () => {
    let received = '';
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        received = Buffer.concat(chunks).toString();
        response.writeHead(202).end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    await sendWebhookEventNotification({
      destination: destination(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`,
        ['run.failed'],
      ),
      envelope: {
        schemaVersion: 1,
        eventId: crypto.randomUUID(),
        type: 'run.failed',
        occurredAt: new Date().toISOString(),
        taskId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        severity: 'error',
        payload: {
          authorization: 'Bearer structured-secret',
          error:
            'GET https://user:pass@example.com/items?token=query-secret failed; Authorization: Bearer header-secret; Cookie=session-secret',
        },
      },
      credential: { secret: 'signing-secret' },
    });

    expect(received).not.toContain('structured-secret');
    expect(received).not.toContain('query-secret');
    expect(received).not.toContain('header-secret');
    expect(received).not.toContain('session-secret');
    expect(received).not.toContain('user:pass');
    expect(received).toContain('[REDACTED]');
  });
});
