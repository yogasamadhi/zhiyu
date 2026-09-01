import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JobHandlerRegistry } from '@zhiyun/platform-core';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { LocalPlatformJobQueue } from '../src/index.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('local platform JobQueue', () => {
  it('executes a registered typed handler through the durable repository', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-queue-'));
    const repository = await openSqlitePlatformRepository({
      dataDirectory,
      filePath: join(dataDirectory, 'zhiyun.sqlite3'),
      graphRevision: 'queue-test',
    });
    const handlers = new JobHandlerRegistry();
    handlers.register({
      type: 'fixture.execute',
      ownerPluginId: 'fixture',
      resourceClass: 'io',
      async handler(context) {
        await context.progress(0.5, 'fixture-running');
        await context.persisting();
      },
    });
    const queue = new LocalPlatformJobQueue(repository, handlers, { workerId: 'test-worker' });
    cleanups.push(async () => {
      await queue.close();
      await repository.close();
      await rm(dataDirectory, { recursive: true, force: true });
    });
    const job = await queue.enqueue({
      ownerPluginId: 'fixture',
      type: 'fixture.execute',
      payload: { value: 1 },
      resourceClass: 'io',
    });
    await queue.dispatchOnce();
    expect(await queue.get(job.id)).toMatchObject({
      state: 'succeeded',
      phase: 'completed',
      progress: 1,
    });
    expect(queue.diagnostics().running).toHaveLength(0);
  });

  it('periodically recovers a lease that expires after the process restarts', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-queue-recovery-'));
    const repository = await openSqlitePlatformRepository({
      dataDirectory,
      filePath: join(dataDirectory, 'zhiyun.sqlite3'),
      graphRevision: 'queue-recovery-test',
    });
    const handlers = new JobHandlerRegistry();
    handlers.register({
      type: 'fixture.recovered',
      ownerPluginId: 'fixture',
      resourceClass: 'io',
      async handler() {},
    });
    const crashed = await repository.enqueueJob({
      ownerPluginId: 'fixture',
      type: 'fixture.recovered',
      payload: {},
      resourceClass: 'io',
      maxAttempts: 2,
    });
    await repository.claimJob({
      workerId: 'crashed-worker',
      resourceClasses: ['io'],
      leaseMs: 150,
      jobId: crashed.id,
    });
    await repository.startJob(crashed.id, 'crashed-worker', 150);
    const queue = new LocalPlatformJobQueue(repository, handlers, {
      workerId: 'recovery-worker',
      pollIntervalMs: 10,
      recoveryIntervalMs: 20,
    });
    cleanups.push(async () => {
      await queue.close();
      await repository.close();
      await rm(dataDirectory, { recursive: true, force: true });
    });
    queue.start();
    expect(await queue.get(crashed.id)).toMatchObject({ state: 'running', attempt: 1 });
    await expect
      .poll(() => queue.get(crashed.id), { timeout: 5_000 })
      .toMatchObject({ state: 'succeeded', attempt: 2 });
  });
});
