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
});
