import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobExecutionContext, PlatformJob } from '@zhiyun/platform-core';
import { LocalArtifactStore } from '@zhiyun/artifact-store';
import type { DeliveryAttempt, OutputDestination, OutputRepository } from '../src/index.js';
import { createOutputDeliveryJobHandler, PlatformOutputArtifactStore } from '../src/index.js';
import { FileOutputArtifactStore } from '@zhiyun/outputs';

const servers = new Set<ReturnType<typeof createServer>>();
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    [...servers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  servers.clear();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function pendingAttempt(now = new Date().toISOString()): DeliveryAttempt {
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
  };
}

function deliveryJob(attemptId: string, now = new Date().toISOString()): PlatformJob {
  return {
    id: crypto.randomUUID(),
    ownerPluginId: 'outputs',
    type: 'outputs.delivery.execute',
    payload: { attemptId },
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
}

function executionContext(job: PlatformJob): JobExecutionContext {
  return {
    job,
    signal: new AbortController().signal,
    progress: async () => undefined,
    persisting: async () => undefined,
  };
}

describe('Output delivery handler', () => {
  it('isolates archives and latest files when one destination is bound to two tasks', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'zhiyun-delivery-task-isolation-'));
    const artifactRoot = await mkdtemp(join(tmpdir(), 'zhiyun-delivery-task-artifacts-'));
    directories.push(outputRoot, artifactRoot);
    const now = new Date().toISOString();
    const destinationId = '10000000-0000-4000-a000-000000000000';
    const taskA = { id: 'aaaaaaaa-0000-4000-a000-000000000000', name: 'Alpha Products' };
    const taskB = { id: 'bbbbbbbb-0000-4000-a000-000000000000', name: 'Beta Products' };
    let attempts = [
      {
        ...pendingAttempt(now),
        destinationId,
        taskId: taskA.id,
        runId: '11111111-0000-4000-a000-000000000000',
      },
      {
        ...pendingAttempt(now),
        destinationId,
        taskId: taskB.id,
        runId: '22222222-0000-4000-a000-000000000000',
      },
    ];
    const destination: OutputDestination = {
      id: destinationId,
      name: 'Shared local destination',
      type: 'local-directory',
      config: {
        format: 'jsonl',
        pathTemplate: '{taskSlug}/{yyyy}/{mm}/{runId}.{ext}',
        updateLatest: true,
      },
      credentialRef: 'shared-local-directory',
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    const repository = {
      listDeliveryAttempts: async () => attempts,
      getDestination: async () => destination,
      updateDeliveryAttempt: async (id: string, input: Partial<DeliveryAttempt>) => {
        attempts = attempts.map((attempt) =>
          attempt.id === id
            ? { ...attempt, ...input, updatedAt: new Date().toISOString() }
            : attempt,
        );
        return attempts.find((attempt) => attempt.id === id) ?? null;
      },
    } as unknown as OutputRepository;
    const handler = createOutputDeliveryJobHandler({
      repository,
      tasks: {
        getTask: async (id) => {
          const task = id === taskA.id ? taskA : id === taskB.id ? taskB : null;
          return task
            ? {
                ...task,
                datasetSettings: { mode: 'snapshot' as const, keyFields: [], detectRemoved: true },
              }
            : null;
        },
        getRun: async (id) => {
          const attempt = attempts.find((candidate) => candidate.runId === id);
          return attempt
            ? {
                id,
                taskId: attempt.taskId,
                datasetStats: { added: 1, updated: 0, removed: 0, unchanged: 0, current: 1 },
              }
            : null;
        },
      },
      datasets: {
        listRunRecords: async (runId) => ({
          items: [{ sourceUrl: 'https://example.com', data: { runId } }],
          nextCursor: null,
        }),
      },
      credentials: { resolve: async <T>() => ({ directoryPath: outputRoot }) as T },
      artifacts: new FileOutputArtifactStore(artifactRoot),
    });

    for (const attempt of attempts) {
      await handler(executionContext(deliveryJob(attempt.id, now)));
    }

    const alphaLatest = await readFile(join(outputRoot, 'Alpha-Products-aaaaaaaa', 'latest.jsonl'));
    const betaLatest = await readFile(join(outputRoot, 'Beta-Products-bbbbbbbb', 'latest.jsonl'));
    expect(alphaLatest.toString()).toContain(attempts[0]!.runId);
    expect(betaLatest.toString()).toContain(attempts[1]!.runId);
    expect(attempts.every((attempt) => attempt.status === 'succeeded')).toBe(true);
  });

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
    let attempt = pendingAttempt(now);
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
    await handler(executionContext(deliveryJob(attempt.id, now)));

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

  it('reuses one CSV/JSONL artifact when a failed delivery is retried', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'zhiyun-delivery-output-'));
    const artifactRoot = await mkdtemp(join(tmpdir(), 'zhiyun-delivery-artifact-'));
    directories.push(outputRoot, artifactRoot);
    const now = new Date().toISOString();
    let attempt = pendingAttempt(now);
    const archive = join(outputRoot, 'products', `${attempt.runId}.jsonl`);
    const destination: OutputDestination = {
      id: attempt.destinationId,
      name: 'Local fixture',
      type: 'local-directory',
      config: {
        format: 'jsonl',
        taskSlug: 'products',
        pathTemplate: 'products/{runId}.{ext}',
        updateLatest: false,
      },
      credentialRef: 'local-directory-fixture',
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
    let datasetReads = 0;
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
          datasetStats: { added: 2, updated: 0, removed: 0, unchanged: 0, current: 2 },
        }),
      },
      datasets: {
        listRunRecords: async () => {
          datasetReads += 1;
          return {
            items: [
              { sourceUrl: 'https://example.com/1', data: { id: 1, title: 'One' } },
              { sourceUrl: 'https://example.com/2', data: { id: 2, title: 'Two' } },
            ],
            nextCursor: null,
          };
        },
      },
      credentials: { resolve: async <T>() => ({ directoryPath: outputRoot }) as T },
      artifacts: new FileOutputArtifactStore(artifactRoot),
    });

    await mkdir(dirname(archive), { recursive: true });
    await writeFile(archive, 'conflicting immutable content');
    await expect(handler(executionContext(deliveryJob(attempt.id, now)))).rejects.toThrow(
      'different content',
    );
    expect(datasetReads).toBe(2);
    expect(attempt).toMatchObject({
      status: 'failed',
      format: 'jsonl',
      deliveredRecordCount: 2,
    });
    expect(attempt.artifactId).toMatch(/^[a-f0-9]{64}$/);
    expect(attempt.sha256).toMatch(/^[a-f0-9]{64}$/);

    await rm(archive);
    attempt = {
      ...attempt,
      status: 'pending',
      attempt: 2,
      error: null,
      nextAttemptAt: null,
    };
    await handler(executionContext(deliveryJob(attempt.id, now)));

    expect(datasetReads).toBe(2);
    expect(attempt).toMatchObject({
      status: 'succeeded',
      responseStatus: null,
      format: 'jsonl',
      finalLocation: archive,
      deliveredRecordCount: 2,
    });
    expect(await readFile(archive, 'utf8')).toContain('"title":"One"');
  });

  it('records an explicit non-retryable Parquet failure when the Worker is unavailable', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'zhiyun-delivery-output-'));
    const dataRoot = await mkdtemp(join(tmpdir(), 'zhiyun-delivery-artifact-'));
    directories.push(outputRoot, dataRoot);
    const platformArtifacts = new LocalArtifactStore(dataRoot);
    await platformArtifacts.initialize();
    const now = new Date().toISOString();
    let attempt = pendingAttempt(now);
    const destination: OutputDestination = {
      id: attempt.destinationId,
      name: 'Parquet fixture',
      type: 'local-directory',
      config: {
        format: 'parquet',
        fields: ['id'],
        taskSlug: 'products',
        pathTemplate: 'products/{runId}.{ext}',
        updateLatest: false,
      },
      credentialRef: 'local-directory-fixture',
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
    let datasetReads = 0;
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
        listRunRecords: async () => {
          datasetReads += 1;
          return {
            items: [{ sourceUrl: 'https://example.com/1', data: { id: 1 } }],
            nextCursor: null,
          };
        },
      },
      credentials: { resolve: async <T>() => ({ directoryPath: outputRoot }) as T },
      artifacts: new PlatformOutputArtifactStore(platformArtifacts),
    });

    await expect(handler(executionContext(deliveryJob(attempt.id, now)))).rejects.toMatchObject({
      code: 'OUTPUT_DELIVERY_FAILED',
      retryable: false,
      message: expect.stringContaining('ANALYTICS_UNAVAILABLE'),
    });
    expect(datasetReads).toBe(0);
    expect(attempt).toMatchObject({
      status: 'failed',
      nextAttemptAt: null,
      error: expect.stringContaining('ANALYTICS_UNAVAILABLE'),
    });
    await platformArtifacts.close();
  });
});
