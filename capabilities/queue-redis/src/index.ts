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

export class RedisPlatformJobQueue implements PlatformJobQueue {
  private readonly dispatcher: DurableJobDispatcher;
  private readonly redis: IORedis;
  private readonly queues = new Map<JobResourceClass, Queue<PlatformQueueData>>();
  private readonly workers: Worker<PlatformQueueData>[] = [];
  private started = false;
  private lastError: string | null = null;
  private readonly capacities: Record<JobResourceClass, number>;

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
    void this.reconcileQueuedJobs().catch((error: unknown) => {
      this.lastError = safeError(error);
    });
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

  async close(): Promise<void> {
    this.started = false;
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
      if (!existing) await this.signal(job);
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
