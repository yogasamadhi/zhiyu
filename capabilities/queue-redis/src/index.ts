import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import {
  DurableJobDispatcher,
  type DurableJobDispatcherOptions,
  type EnqueueJobInput,
  type JobDispatcherDiagnostics,
  type JobHandlerRegistry,
  type JobResourceClass,
  type PlatformJob,
  type PlatformJobQueue,
  type PlatformJobState,
  type PlatformRepository,
} from '@zhiyun/platform-core';

const RESOURCE_CLASSES: readonly JobResourceClass[] = [
  'browser-heavy',
  'python-heavy',
  'io',
  'delivery',
];
const QUEUE_PREFIX = 'zhiyun-platform-v1';
export const LEGACY_BULLMQ_QUEUES = Object.freeze(['zhiyun-crawl']);
export const LEGACY_REDIS_PREFIX = 'zhiyun:';

interface PlatformQueueData {
  jobId: string;
}

export interface RedisQueueReadiness {
  readonly redis: {
    status: 'ok' | 'error';
    connectionStatus: string;
  };
  readonly queue: {
    status: 'ok' | 'error';
    started: boolean;
    counts: Readonly<Record<JobResourceClass, number>>;
  };
}

export class RedisPlatformJobQueue implements PlatformJobQueue {
  private readonly dispatcher: DurableJobDispatcher;
  private readonly redis: IORedis;
  private readonly queues = new Map<JobResourceClass, Queue<PlatformQueueData>>();
  private readonly workers: Worker<PlatformQueueData>[] = [];
  private started = false;
  private lastError: string | null = null;
  private readonly capacities: Record<JobResourceClass, number>;
  private readonly recoveryIntervalMs: number;
  private recoveryTimer: ReturnType<typeof setInterval> | undefined;
  private recovering = false;

  constructor(
    private readonly repository: PlatformRepository,
    private readonly redisUrl: string,
    handlers: JobHandlerRegistry,
    options: DurableJobDispatcherOptions = {},
  ) {
    this.capacities = {
      'browser-heavy': options.capacities?.['browser-heavy'] ?? 2,
      'python-heavy': options.capacities?.['python-heavy'] ?? 1,
      io: options.capacities?.io ?? 2,
      delivery: options.capacities?.delivery ?? 2,
    };
    this.recoveryIntervalMs = Math.max(10, options.recoveryIntervalMs ?? 5_000);
    this.dispatcher = new DurableJobDispatcher(repository, handlers, {
      ...options,
      capacities: this.capacities,
    });
    this.redis = redisConnection(redisUrl);
    for (const resourceClass of RESOURCE_CLASSES) {
      this.queues.set(
        resourceClass,
        new Queue<PlatformQueueData>(queueName(resourceClass), { connection: this.redis }),
      );
    }
  }

  async enqueue(input: EnqueueJobInput): Promise<PlatformJob> {
    const job = await this.repository.enqueueJob(input);
    await this.signal(job);
    return job;
  }

  get(id: string): Promise<PlatformJob | null> {
    return this.repository.getJob(id);
  }

  list(options?: {
    ownerPluginId?: string;
    states?: readonly PlatformJobState[];
    limit?: number;
  }): Promise<PlatformJob[]> {
    return this.repository.listJobs(options);
  }

  async cancel(id: string): Promise<PlatformJob | null> {
    const current = await this.repository.getJob(id);
    if (!current) return null;
    const canceled = await this.repository.requestJobCancel(id);
    if (canceled?.state === 'canceled') {
      const queued = await this.queues.get(current.resourceClass)?.getJob(id);
      await queued?.remove().catch(() => undefined);
    }
    return canceled;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const resourceClass of RESOURCE_CLASSES) {
      const worker = new Worker<PlatformQueueData>(
        queueName(resourceClass),
        (job) => this.process(job),
        {
          connection: redisConnection(this.redisUrl),
          concurrency: this.capacities[resourceClass],
        },
      );
      worker.on('error', (error) => {
        this.lastError = error.message.slice(0, 2_000);
      });
      this.workers.push(worker);
    }
    void this.recoverAndReconcile().catch((error: unknown) => {
      this.lastError = safeError(error);
    });
    this.recoveryTimer = setInterval(() => {
      void this.recoverAndReconcile().catch((error: unknown) => {
        this.lastError = safeError(error);
      });
    }, this.recoveryIntervalMs);
    this.recoveryTimer.unref?.();
  }

  diagnostics(): JobDispatcherDiagnostics & {
    started: boolean;
    redisStatus: string;
    lastError: string | null;
  } {
    return {
      ...this.dispatcher.diagnostics(),
      started: this.started,
      redisStatus: this.redis.status,
      lastError: this.lastError,
    };
  }

  async readiness(timeoutMs = 2_000): Promise<RedisQueueReadiness> {
    const redisProbe = withTimeout(this.redis.ping(), timeoutMs)
      .then((response) => response === 'PONG')
      .catch(() => false);
    const emptyCounts = Object.fromEntries(
      RESOURCE_CLASSES.map((resourceClass) => [resourceClass, 0]),
    ) as Record<JobResourceClass, number>;
    const queueProbe = this.started
      ? withTimeout(
          Promise.all(
            RESOURCE_CLASSES.map(async (resourceClass) => {
              const counts = await this.queues
                .get(resourceClass)!
                .getJobCounts('wait', 'active', 'delayed', 'failed');
              return [
                resourceClass,
                Object.values(counts).reduce((total, count) => total + count, 0),
              ] as const;
            }),
          ),
          timeoutMs,
        )
          .then((entries) => ({
            ok: true as const,
            counts: Object.fromEntries(entries) as Record<JobResourceClass, number>,
          }))
          .catch(() => ({ ok: false as const, counts: emptyCounts }))
      : Promise.resolve({ ok: false as const, counts: emptyCounts });
    const [redisOk, queue] = await Promise.all([redisProbe, queueProbe]);
    return {
      redis: {
        status: redisOk ? 'ok' : 'error',
        connectionStatus: this.redis.status,
      },
      queue: {
        status: queue.ok ? 'ok' : 'error',
        started: this.started,
        counts: queue.counts,
      },
    };
  }

  async close(): Promise<void> {
    this.started = false;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = undefined;
    await Promise.allSettled(this.workers.splice(0).map((worker) => worker.close()));
    await this.dispatcher.close();
    await Promise.allSettled([...this.queues.values()].map((queue) => queue.close()));
    if (this.redis.status !== 'end') await this.redis.quit();
  }

  private async process(job: Job<PlatformQueueData>): Promise<void> {
    await this.dispatcher.tick(job.data.jobId);
    await this.dispatcher.drain();
  }

  private async signal(job: PlatformJob): Promise<void> {
    await this.queues
      .get(job.resourceClass)!
      .add(
        job.type,
        { jobId: job.id },
        { jobId: job.id, removeOnComplete: 1_000, removeOnFail: 1_000 },
      );
  }

  private async reconcileQueuedJobs(): Promise<void> {
    const jobs = await this.repository.listJobs({ states: ['queued'], limit: 1_000 });
    for (const job of jobs) {
      const existing = await this.queues.get(job.resourceClass)!.getJob(job.id);
      if (existing) {
        const state = await existing.getState();
        if (state === 'completed' || state === 'failed' || state === 'unknown') {
          await existing.remove().catch(() => undefined);
        } else {
          continue;
        }
      }
      await this.signal(job);
    }
  }

  private async recoverAndReconcile(): Promise<void> {
    if (this.recovering || !this.started) return;
    this.recovering = true;
    try {
      await this.repository.recoverExpiredJobs();
      await this.reconcileQueuedJobs();
    } finally {
      this.recovering = false;
    }
  }
}

export async function resetLegacyRedis(redisUrl: string): Promise<{
  queues: number;
  keys: number;
}> {
  const redis = redisConnection(redisUrl);
  let queues = 0;
  let keys = 0;
  try {
    for (const name of LEGACY_BULLMQ_QUEUES) {
      const queue = new Queue(name, { connection: redis });
      try {
        await queue.obliterate({ force: true });
        queues += 1;
      } finally {
        await queue.close();
      }
    }
    let cursor = '0';
    do {
      const [nextCursor, batch] = await redis.scan(
        cursor,
        'MATCH',
        `${LEGACY_REDIS_PREFIX}*`,
        'COUNT',
        500,
      );
      cursor = nextCursor;
      if (batch.length > 0) keys += await redis.unlink(...batch);
    } while (cursor !== '0');
    return { queues, keys };
  } finally {
    if (redis.status !== 'end') await redis.quit();
  }
}

function queueName(resourceClass: JobResourceClass): string {
  return `${QUEUE_PREFIX}-${resourceClass}`;
}

function redisConnection(redisUrl: string): IORedis {
  return new IORedis(redisUrl, { maxRetriesPerRequest: null });
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Readiness probe timed out')), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
