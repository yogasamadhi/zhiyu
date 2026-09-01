import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { JobHandlerRegistry } from '@zhiyun/platform-core';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { LEGACY_BULLMQ_QUEUES, RedisPlatformJobQueue, resetLegacyRedis } from '../src/index.js';

const redisUrl = process.env.REDIS_URL?.replace(/\/\d+$/, '/15') ?? 'redis://localhost:46379/15';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  const redis = new IORedis(redisUrl);
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', '*', 'COUNT', 500);
    cursor = nextCursor;
    if (keys.length > 0) await redis.unlink(...keys);
  } while (cursor !== '0');
  await redis.quit();
});

describe('Redis platform JobQueue', () => {
  it('signals a durable platform job and executes the typed handler', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-redis-queue-'));
    const repository = await openSqlitePlatformRepository({
      dataDirectory,
      filePath: join(dataDirectory, 'zhiyun.sqlite3'),
      graphRevision: 'redis-queue-test',
    });
    const handlers = new JobHandlerRegistry();
    handlers.register({
      type: 'fixture.redis',
      ownerPluginId: 'fixture',
      resourceClass: 'io',
      async handler(context) {
        await context.progress(0.8, 'redis-running');
      },
    });
    const queue = new RedisPlatformJobQueue(repository, redisUrl, handlers, {
      workerId: 'redis-test-worker',
      capacities: { io: 1 },
    });
    cleanups.push(async () => {
      await queue.close();
      await repository.close();
      await rm(dataDirectory, { recursive: true, force: true });
    });
    queue.start();
    await expect(queue.readiness()).resolves.toMatchObject({
      redis: { status: 'ok' },
      queue: { status: 'ok', started: true },
    });
    const job = await queue.enqueue({
      ownerPluginId: 'fixture',
      type: 'fixture.redis',
      payload: {},
      resourceClass: 'io',
      maxAttempts: 2,
    });
    await expect
      .poll(() => queue.get(job.id), { timeout: 5_000 })
      .toMatchObject({
        state: 'succeeded',
      });
  });

  it('recovers a lease that expires after restart and re-signals the durable job', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-redis-recovery-'));
    const repository = await openSqlitePlatformRepository({
      dataDirectory,
      filePath: join(dataDirectory, 'zhiyun.sqlite3'),
      graphRevision: 'redis-recovery-test',
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
    const claimed = await repository.claimJob({
      workerId: 'crashed-worker',
      resourceClasses: ['io'],
      leaseMs: 150,
      jobId: crashed.id,
    });
    expect(claimed).not.toBeNull();
    expect(await repository.startJob(crashed.id, 'crashed-worker', 150)).not.toBeNull();

    const queue = new RedisPlatformJobQueue(repository, redisUrl, handlers, {
      workerId: 'recovery-worker',
      capacities: { io: 1 },
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

  it('removes only known legacy queues and the ZhiYun prefix', async () => {
    const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    await redis.set('customer:key', 'keep');
    await redis.set('zhiyun:task-lock:legacy', 'remove');
    const legacyQueue = new Queue(LEGACY_BULLMQ_QUEUES[0]!, { connection: redis });
    await legacyQueue.add('legacy', { value: 1 });
    await legacyQueue.close();

    const result = await resetLegacyRedis(redisUrl);
    expect(result).toMatchObject({ queues: 1, keys: 1 });
    expect(await redis.get('customer:key')).toBe('keep');
    expect(await redis.get('zhiyun:task-lock:legacy')).toBeNull();
    await redis.quit();
  });
});
