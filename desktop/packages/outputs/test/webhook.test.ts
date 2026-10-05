import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { outputAdapter, WebhookOutputAdapter } from '../src/index.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('Webhook output integration', () => {
  it('signs, batches and identifies deliveries', async () => {
    let received: { body: string; timestamp: string; signature: string; key: string } | undefined;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        received = {
          body: Buffer.concat(chunks).toString(),
          timestamp: String(request.headers['x-zhiyun-timestamp']),
          signature: String(request.headers['x-zhiyun-signature']),
          key: String(request.headers['x-zhiyun-idempotency-key']),
        };
        response.writeHead(202).end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
    const result = await new WebhookOutputAdapter().deliver({
      destination: {
        id: crypto.randomUUID(),
        name: 'fixture',
        type: 'webhook',
        config: { url: `http://127.0.0.1:${address.port}/delivery` },
        credentialRef: null,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      taskId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      datasetSettings: { mode: 'upsert', keyFields: ['id'], detectRemoved: false },
      records: [{ sourceUrl: 'https://example.com/1', data: { id: 1, name: '织云' } }],
      credential: { secret: 'test-secret' },
    });
    expect(result.delivered).toBe(1);
    expect(received?.key).toMatch(/:1$/);
    expect(received?.signature).toBe(
      `sha256=${createHmac('sha256', 'test-secret').update(`${received!.timestamp}.${received!.body}`).digest('hex')}`,
    );
  });

  it('streams records and splits Webhook payloads before the 1 MB limit', async () => {
    const keys: string[] = [];
    const sizes: number[] = [];
    const events: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        keys.push(String(request.headers['x-zhiyun-idempotency-key']));
        const body = Buffer.concat(chunks);
        sizes.push(body.byteLength);
        events.push(String((JSON.parse(body.toString()) as { event: string }).event));
        response.writeHead(202).end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
    const runId = crypto.randomUUID();
    async function* records() {
      for (let index = 0; index < 3; index += 1) {
        yield {
          sourceUrl: `https://example.com/${index}`,
          data: { id: index, content: 'x'.repeat(600_000) },
        };
      }
    }
    const result = await new WebhookOutputAdapter().deliver({
      destination: {
        id: crypto.randomUUID(),
        name: 'stream fixture',
        type: 'webhook',
        config: {
          url: `http://127.0.0.1:${address.port}/delivery`,
          event: 'dataset.changed',
        },
        credentialRef: null,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      taskId: crypto.randomUUID(),
      runId,
      datasetSettings: { mode: 'upsert', keyFields: ['id'], detectRemoved: false },
      datasetStats: { added: 3, updated: 0, removed: 0, unchanged: 0, current: 3 },
      records: records(),
      credential: null,
    });
    expect(result.delivered).toBe(3);
    expect(keys).toEqual([`${runId}:dataset:1`, `${runId}:dataset:2`, `${runId}:dataset:3`]);
    expect(events).toEqual(['dataset.changed', 'dataset.changed', 'dataset.changed']);
    expect(sizes.every((size) => size <= 1024 * 1024)).toBe(true);
  });

  it('accepts the events[] subscription shape while preserving legacy event behavior', async () => {
    const events: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        events.push(
          String((JSON.parse(Buffer.concat(chunks).toString()) as { event: string }).event),
        );
        response.writeHead(204).end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
    const now = new Date().toISOString();
    const destination = {
      id: crypto.randomUUID(),
      name: 'events fixture',
      type: 'webhook' as const,
      config: {
        url: `http://127.0.0.1:${address.port}/delivery`,
        events: ['dataset.changed' as const, 'run.failed' as const],
      },
      credentialRef: null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    await new WebhookOutputAdapter().deliver({
      destination,
      taskId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      datasetSettings: { mode: 'snapshot', keyFields: [], detectRemoved: true },
      datasetStats: { added: 1, updated: 0, removed: 0, unchanged: 0, current: 1 },
      records: [{ sourceUrl: 'https://example.com', data: { id: 1 } }],
      credential: null,
    });
    expect(events).toEqual(['dataset.changed']);

    await expect(
      new WebhookOutputAdapter().deliver({
        destination: { ...destination, config: { ...destination.config, events: ['run.failed'] } },
        taskId: crypto.randomUUID(),
        runId: crypto.randomUUID(),
        datasetSettings: { mode: 'snapshot', keyFields: [], detectRemoved: true },
        records: [],
        credential: null,
      }),
    ).rejects.toThrow('does not subscribe to successful run deliveries');
  });
});

describe('removed database output compatibility', () => {
  it('rejects legacy database destinations before opening a connection', () => {
    expect(() =>
      outputAdapter({
        id: crypto.randomUUID(),
        name: 'Legacy database destination',
        type: 'postgres',
        config: {},
        enabled: false,
        credentialRef: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ).toThrow('PostgreSQL output has been removed');
  });
});
