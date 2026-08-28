import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobExecutionContext, PlatformJob } from '@zhiyun/platform-core';
import type { DeliveryAttempt, OutputDestination, OutputRepository } from '../src/index.js';
import { createOutputDeliveryJobHandler } from '../src/index.js';

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all(
    [...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  servers.clear();
});

describe('Output delivery handler', () => {
  it('streams run records through the configured adapter and persists success', async () => {
    const payloads: unknown[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        payloads.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.writeHead(204).end();
      });
    });
    servers.add(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/events`;
    const now = new Date().toISOString();
    let attempt: DeliveryAttempt = {
      id: crypto.randomUUID(),
      destinationId: crypto.randomUUID(),
      taskId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
      status: 'pending',
      attempt: 1,
      responseStatus: null,
      error: null,
      nextAttemptAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const destination: OutputDestination = {
      id: attempt.destinationId,
      name: 'Fixture webhook',
      type: 'webhook',
      config: { url: endpoint },
      credentialRef: null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    const repository = {
      listDeliveryAttempts: async () => [attempt],
      getDestination: async () => destination,
      updateDeliveryAttempt: async (_id: string, input: Partial<DeliveryAttempt>) => {
        attempt = { ...attempt, ...input, updatedAt: new Date().toISOString() };
        return attempt;
      },
    } as unknown as OutputRepository;
    const handler = createOutputDeliveryJobHandler({
      repository,
      tasks: {
        getTask: async () => ({
          id: attempt.taskId,
          datasetSettings: { mode: 'snapshot', keyFields: [], detectRemoved: true },
        }),
        getRun: async () => ({
          id: attempt.runId,
          taskId: attempt.taskId,
          datasetStats: { added: 1, updated: 0, removed: 0, unchanged: 0, current: 1 },
        }),
      },
      datasets: {
        listRunRecords: async () => ({
          items: [{ sourceUrl: 'https://example.com/1', data: { id: 1, title: 'Fixture' } }],
          nextCursor: null,
        }),
      },
      credentials: { resolve: async <T>() => ({}) as T },
    });
    const job: PlatformJob = {
      id: crypto.randomUUID(),
      ownerPluginId: 'outputs',
      type: 'outputs.delivery.execute',
      payload: { attemptId: attempt.id },
      resourceClass: 'delivery',
      state: 'running',
      progress: 0,
      phase: 'running',
      attempt: 1,
      maxAttempts: 2,
      availableAt: now,
      leaseOwner: 'fixture',
      leaseExpiresAt: now,
      cancelRequestedAt: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    await handler({
      job,
      signal: new AbortController().signal,
      progress: async () => undefined,
      persisting: async () => undefined,
    } satisfies JobExecutionContext);

    expect(attempt).toMatchObject({ status: 'succeeded', responseStatus: 204, error: null });
    expect(payloads).toEqual([
      expect.objectContaining({
        event: 'run.succeeded',
        taskId: attempt.taskId,
        runId: attempt.runId,
        records: [{ sourceUrl: 'https://example.com/1', data: { id: 1, title: 'Fixture' } }],
      }),
    ]);
  });
});
