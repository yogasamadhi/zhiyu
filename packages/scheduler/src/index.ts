import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { Cron } from 'croner';
import type { QueueAdapter, Repository, RuntimeJob, SchedulerAdapter } from '@zhiyun/contracts';

export interface CrawlJobData {
  taskId: string;
  runId?: string;
  scheduled?: boolean;
}

export interface Scheduler {
  schedule(
    taskId: string,
    cron: string,
    timezone?: string,
    recovery?: { misfirePolicy: 'skip' | 'run-once'; lastTriggeredAt: string | null },
  ): Promise<void>;
  unschedule(taskId: string): Promise<void>;
}

function connection(redisUrl: string) {
  return new IORedis(redisUrl, { maxRetriesPerRequest: null });
}

function missedRunAt(
  pattern: string,
  timezone: string,
  recovery?: { misfirePolicy: 'skip' | 'run-once'; lastTriggeredAt: string | null },
): Date | null {
  if (recovery?.misfirePolicy !== 'run-once' || !recovery.lastTriggeredAt) return null;
  const calculator = new Cron(pattern, { timezone, paused: true });
  try {
    const next = calculator.nextRun(new Date(recovery.lastTriggeredAt));
    return next && next.getTime() < Date.now() ? next : null;
  } finally {
    calculator.stop();
  }
}

export class TaskQueue implements Scheduler, QueueAdapter, SchedulerAdapter {
  private readonly queue: Queue<CrawlJobData>;
  private readonly redis: IORedis;
  private worker?: Worker<CrawlJobData>;

  constructor(
    private readonly redisUrl: string,
    private readonly queueName = 'zhiyun-crawl',
  ) {
    this.redis = connection(redisUrl);
    this.queue = new Queue<CrawlJobData>(queueName, { connection: this.redis });
  }

  async enqueue(taskId: string, runId: string): Promise<void> {
    await this.queue.add(
      'manual',
      { taskId, runId },
      { jobId: `run-${runId}`, removeOnComplete: 100 },
    );
  }

  async start(handler: (job: RuntimeJob) => Promise<void>): Promise<void> {
    if (this.worker) return;
    this.worker = this.createWorker(async (job) => {
      await handler({
        id: String(job.id ?? crypto.randomUUID()),
        taskId: job.data.taskId,
        ...(job.data.runId ? { runId: job.data.runId } : {}),
        scheduled: job.data.scheduled ?? false,
      });
    });
  }

  async cancel(runId: string): Promise<boolean> {
    const job = await this.queue.getJob(`run-${runId}`);
    if (!job) return false;
    await job.remove();
    return true;
  }

  async schedule(
    taskId: string,
    cron: string,
    timezone = 'Asia/Shanghai',
    recovery?: { misfirePolicy: 'skip' | 'run-once'; lastTriggeredAt: string | null },
  ): Promise<void> {
    await this.queue.upsertJobScheduler(
      `schedule-${taskId}`,
      { pattern: cron, tz: timezone },
      {
        name: 'scheduled',
        data: { taskId, scheduled: true },
        opts: { removeOnComplete: 100 },
      },
    );
    const missed = missedRunAt(cron, timezone, recovery);
    if (missed) {
      await this.queue.add(
        'scheduled-misfire',
        { taskId, scheduled: true },
        {
          jobId: `misfire-${taskId}-${missed.getTime()}`,
          removeOnComplete: 100,
        },
      );
    }
  }

  async unschedule(taskId: string): Promise<void> {
    await this.queue.removeJobScheduler(`schedule-${taskId}`);
  }

  createWorker(handler: (job: Job<CrawlJobData>) => Promise<void>): Worker<CrawlJobData> {
    return new Worker<CrawlJobData>(this.queueName, handler, {
      connection: connection(this.redisUrl),
      concurrency: 4,
    });
  }

  async withTaskLock(taskId: string, action: () => Promise<void>): Promise<boolean> {
    const key = `zhiyun:task-lock:${taskId}`;
    const token = crypto.randomUUID();
    const acquired = await this.redis.set(key, token, 'PX', 120_000, 'NX');
    if (!acquired) return false;
    const renewal = setInterval(() => {
      void this.redis.eval(
        "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end",
        1,
        key,
        token,
        '120000',
      );
    }, 30_000);
    renewal.unref?.();
    try {
      await action();
      return true;
    } finally {
      clearInterval(renewal);
      await this.redis.eval(
        "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
        1,
        key,
        token,
      );
    }
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    await this.redis.quit();
  }
}

export class LocalQueue implements QueueAdapter {
  private handler?: (job: RuntimeJob) => Promise<void>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private active = 0;
  private draining = false;
  private closing = false;

  constructor(
    private readonly repository: Repository,
    private readonly pollMs = 200,
  ) {}

  async start(handler: (job: RuntimeJob) => Promise<void>): Promise<void> {
    this.handler = handler;
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain(), this.pollMs);
    this.timer.unref?.();
    await this.drain();
  }

  async enqueue(taskId: string, runId: string): Promise<void> {
    await this.repository.enqueueRuntimeJob({ id: crypto.randomUUID(), taskId, runId });
    await this.drain();
  }

  async enqueueScheduled(taskId: string, runId: string): Promise<void> {
    await this.repository.enqueueRuntimeJob({
      id: crypto.randomUUID(),
      taskId,
      runId,
      scheduled: true,
    });
    await this.drain();
  }

  async cancel(runId: string): Promise<boolean> {
    return this.repository.cancelRuntimeJob(runId);
  }

  private async drain(): Promise<void> {
    if (this.draining || this.closing || !this.handler) return;
    this.draining = true;
    try {
      while (this.active < 4) {
        const job = await this.repository.claimRuntimeJob();
        if (!job) break;
        this.active += 1;
        void this.handler(job)
          .finally(() => this.repository.finishRuntimeJob(job.id))
          .finally(() => {
            this.active -= 1;
            void this.drain();
          });
      }
    } finally {
      this.draining = false;
    }
  }

  async withTaskLock(_taskId: string, action: () => Promise<void>): Promise<boolean> {
    await action();
    return true;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.active > 0 || this.draining)
      await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export class LocalScheduler implements SchedulerAdapter {
  private readonly jobs = new Map<string, Cron>();

  constructor(
    private readonly repository: Repository,
    private readonly queue: LocalQueue,
  ) {}

  async schedule(
    taskId: string,
    cron: string,
    timezone = 'Asia/Shanghai',
    recovery?: { misfirePolicy: 'skip' | 'run-once'; lastTriggeredAt: string | null },
  ): Promise<void> {
    await this.unschedule(taskId);
    const job = new Cron(cron, { timezone }, () => {
      void this.repository
        .markScheduleTriggered(taskId)
        .then(() => this.repository.getActiveRule(taskId))
        .then((active) => (active ? this.repository.createRun(taskId) : null))
        .then((run) => (run ? this.queue.enqueueScheduled(taskId, run.id) : undefined))
        .catch(() => undefined);
    });
    this.jobs.set(taskId, job);
    if (missedRunAt(cron, timezone, recovery)) {
      await this.repository
        .getActiveRule(taskId)
        .then((active) => (active ? this.repository.createRun(taskId) : null))
        .then(async (run) => {
          if (!run) return;
          await this.repository.markScheduleTriggered(taskId);
          await this.queue.enqueueScheduled(taskId, run.id);
        })
        .catch(() => undefined);
    }
  }

  async unschedule(taskId: string): Promise<void> {
    this.jobs.get(taskId)?.stop();
    this.jobs.delete(taskId);
  }

  async close(): Promise<void> {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }
}
