import { afterEach, describe, expect, it } from 'vitest';
import { taskCreateSchema } from '@zhiyun/contracts';
import { SqliteRepository } from '@zhiyun/sqlite-storage';
import { LocalQueue, LocalScheduler } from '../src/index.js';

const resources: Array<{
  scheduler: LocalScheduler;
  queue: LocalQueue;
  repository: SqliteRepository;
}> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.scheduler.close();
    await resource.queue.close();
    await resource.repository.close();
  }
});

async function fixture(policy: 'skip' | 'run-once') {
  const repository = new SqliteRepository(':memory:');
  await repository.migrate();
  const task = await repository.createTask(
    taskCreateSchema.parse({
      name: `${policy} fixture`,
      startUrl: 'https://example.com/products',
      instruction: 'Get products',
      schedule: {
        mode: 'cron',
        cron: '* * * * *',
        timezone: 'Asia/Shanghai',
        misfirePolicy: policy,
      },
    }),
  );
  await repository.createRule(
    task.id,
    'Products',
    {
      type: 'css',
      container: '.product',
      fields: { name: { selector: '.name', value: 'text', dataType: 'string' } },
    },
    'human',
  );
  const queue = new LocalQueue(repository, 10_000);
  const scheduler = new LocalScheduler(repository, queue);
  resources.push({ scheduler, queue, repository });
  return { repository, scheduler, task };
}

describe('Local Scheduler recovery', () => {
  it('enqueues exactly one catch-up Run for run-once misfires', async () => {
    const { repository, scheduler, task } = await fixture('run-once');
    const lastTriggeredAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await repository.markScheduleTriggered(task.id, lastTriggeredAt);
    await scheduler.schedule(task.id, '* * * * *', 'Asia/Shanghai', {
      misfirePolicy: 'run-once',
      lastTriggeredAt,
    });
    expect(await repository.listRuns(task.id)).toHaveLength(1);

    await scheduler.schedule(task.id, '* * * * *', 'Asia/Shanghai', {
      misfirePolicy: 'run-once',
      lastTriggeredAt,
    });
    expect(await repository.listRuns(task.id)).toHaveLength(1);
  });

  it('does not catch up a skipped misfire', async () => {
    const { repository, scheduler, task } = await fixture('skip');
    await scheduler.schedule(task.id, '* * * * *', 'Asia/Shanghai', {
      misfirePolicy: 'skip',
      lastTriggeredAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    expect(await repository.listRuns(task.id)).toEqual([]);
  });
});
