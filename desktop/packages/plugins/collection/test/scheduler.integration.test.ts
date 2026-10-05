import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { taskCreateSchema, type SchedulingEnvironment } from '@zhiyun/contracts';
import { JobHandlerRegistry } from '@zhiyun/platform-core';
import { LocalPlatformJobQueue } from '@zhiyun/queue-local-v1';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { CollectionScheduler, SqliteCollectionRepository } from '../src/index.js';

const awake = { suspended: false, online: true };
async function fixture(initial: SchedulingEnvironment = awake) {
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-scheduler-'));
  const cleanup: Array<() => Promise<void>> = [
    () => rm(directory, { recursive: true, force: true }),
  ];
  const dispose = async () => {
    for (const close of cleanup) await close();
  };
  try {
    const filePath = join(directory, 'zhiyun.sqlite3');
    const platform = await openSqlitePlatformRepository({
      dataDirectory: directory,
      filePath,
      graphRevision: 'scheduler-test',
    });
    cleanup.unshift(() => platform.close());
    const repository = new SqliteCollectionRepository(filePath);
    cleanup.unshift(() => repository.close());
    await repository.migrate();
    const handlers = new JobHandlerRegistry();
    handlers.register({
      type: 'collection.crawl.execute',
      ownerPluginId: 'collection',
      resourceClass: 'browser-heavy',
      handler: async () => undefined,
    });
    const jobs = new LocalPlatformJobQueue(platform, handlers, { pollIntervalMs: 60000 });
    cleanup.unshift(() => jobs.close());
    const scheduler = new CollectionScheduler(repository, platform, jobs, 5000, initial);
    cleanup.unshift(() => scheduler.close());
    const tasks = [];
    for (const misfirePolicy of ['skip', 'run-once'] as const) {
      const task = await repository.createTask(
        taskCreateSchema.parse({
          name: `Schedule ${misfirePolicy}`,
          startUrl: 'http://127.0.0.1/fixture',
          instruction: 'Local fixture',
          schedule: { mode: 'cron', cron: '*/5 * * * *', timezone: 'UTC', misfirePolicy },
        }),
      );
      await repository.createRule(
        task.id,
        'Fixture rule',
        {
          type: 'json',
          container: '$.items',
          fields: { id: { path: '$.id', dataType: 'string' } },
        },
        'human',
      );
      await repository.markScheduleTriggered(task.id);
      tasks.push(task);
    }
    return {
      platform,
      repository,
      jobs,
      scheduler,
      tasks,
      close: dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
afterEach(() => vi.useRealTimers());
describe('existing scheduler misfire policies on local persistent Runs', () => {
  it.each(['sleep', 'offline', 'clock-gap'] as const)(
    '%s skips or runs once and duplicate resume cannot schedule again after completion',
    async (reason) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
      const f = await fixture();
      try {
        await f.scheduler.start();
        if (reason !== 'clock-gap')
          await f.scheduler.setEnvironment(
            reason === 'sleep'
              ? { suspended: true, online: true }
              : { suspended: false, online: false },
          );
        vi.setSystemTime(new Date('2026-01-01T00:16:00Z'));
        if (reason !== 'clock-gap') {
          await f.scheduler.setEnvironment({ suspended: true, online: false });
          expect(await f.repository.listRuns(f.tasks[1]!.id)).toEqual([]);
        }
        await Promise.all([
          f.scheduler.setEnvironment(awake),
          f.scheduler.setEnvironment(awake),
          f.scheduler.setEnvironment(awake),
        ]);
        expect(await f.repository.listRuns(f.tasks[0]!.id)).toEqual([]);
        let runs = await f.repository.listRuns(f.tasks[1]!.id);
        expect(runs).toHaveLength(1);
        expect(runs[0]!.metadata).toMatchObject({ scheduled: true, misfire: true });
        expect(await f.jobs.get(runs[0]!.id)).toMatchObject({
          type: 'collection.crawl.execute',
          state: 'queued',
          attempt: 0,
        });
        await f.repository.cancelRun(runs[0]!.id);
        await Promise.all([f.scheduler.setEnvironment(awake), f.scheduler.setEnvironment(awake)]);
        expect(await f.repository.listRuns(f.tasks[1]!.id)).toHaveLength(1);
        await f.scheduler.setEnvironment({ suspended: false, online: false });
        vi.setSystemTime(new Date('2026-01-01T00:21:00Z'));
        await f.scheduler.setEnvironment(awake);
        runs = await f.repository.listRuns(f.tasks[1]!.id);
        expect(runs).toHaveLength(2);
        expect(new Set(runs.map((run) => run.id)).size).toBe(2);
        expect(await f.repository.listRuns(f.tasks[0]!.id)).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it('recovers startup misses at the exact boundary, respects initial offline state and does not rerun on restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
    const f = await fixture({ suspended: false, online: false });
    try {
      vi.setSystemTime(new Date('2026-01-01T00:15:00Z'));
      await f.scheduler.start();
      expect(await f.repository.listRuns(f.tasks[1]!.id)).toEqual([]);
      await f.scheduler.setEnvironment(awake);
      const run = (await f.repository.listRuns(f.tasks[1]!.id))[0]!;
      expect(run.metadata).toMatchObject({ misfire: true });
      expect(await f.repository.listRuns(f.tasks[0]!.id)).toEqual([]);
      await f.repository.cancelRun(run.id);
      await f.scheduler.close();
      const restarted = new CollectionScheduler(f.repository, f.platform, f.jobs);
      try {
        await restarted.start();
        expect(await f.repository.listRuns(f.tasks[1]!.id)).toHaveLength(1);
      } finally {
        await restarted.close();
      }
    } finally {
      await f.close();
    }
  });

  it('keeps ordinary cron ticks for both policies and closes every owned timer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
    const f = await fixture();
    try {
      await f.scheduler.start();
      await vi.advanceTimersByTimeAsync(4 * 60_000);
      for (const task of f.tasks) {
        const runs = await f.repository.listRuns(task.id);
        expect(runs).toHaveLength(1);
        expect(runs[0]!.metadata).toMatchObject({ scheduled: true, misfire: false });
        expect(await f.jobs.get(runs[0]!.id)).toMatchObject({ state: 'queued', attempt: 0 });
      }
    } finally {
      await f.close();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels only its unqueued Run after an enqueue failure, allowing later scheduled recovery', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'));
    const f = await fixture();
    try {
      await f.scheduler.start();
      await f.scheduler.setEnvironment({ suspended: false, online: false });
      vi.setSystemTime(new Date('2026-01-01T00:16:00Z'));
      const enqueue = vi
        .spyOn(f.jobs, 'enqueue')
        .mockRejectedValueOnce(new Error('Owned queue failure'));
      await f.scheduler.setEnvironment(awake);
      const failedAttempt = (await f.repository.listRuns(f.tasks[1]!.id))[0]!;
      expect(failedAttempt.status).toBe('canceled');
      expect(await f.jobs.get(failedAttempt.id)).toBeNull();
      enqueue.mockRestore();
      await f.scheduler.setEnvironment({ suspended: false, online: false });
      vi.setSystemTime(new Date('2026-01-01T00:21:00Z'));
      await f.scheduler.setEnvironment(awake);
      const runs = await f.repository.listRuns(f.tasks[1]!.id);
      expect(runs).toHaveLength(2);
      expect(runs.map((run) => run.status).sort()).toEqual(['canceled', 'queued']);
      expect(await f.repository.listRuns(f.tasks[0]!.id)).toEqual([]);
    } finally {
      await f.close();
    }
  });
});
