import { Cron } from 'croner';
import type { SchedulingEnvironment } from '@zhiyun/contracts';
import type { PlatformJobQueue, PlatformRepository } from '@zhiyun/platform-core';
import type { CollectionRepository } from '../contracts/index.js';

const available = (environment: SchedulingEnvironment) =>
  !environment.suspended && environment.online;

export class CollectionScheduler {
  private readonly schedules = new Map<string, { signature: string; cron: Cron }>();
  private readonly triggers = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private syncing: Promise<void> | undefined;
  private running = false;
  private firstSync = true;
  private lastObservedAt = Date.now();
  private interruptedAt: number | undefined;
  private resumeFrom: number | undefined;
  private environment: SchedulingEnvironment;

  constructor(
    private readonly repository: CollectionRepository,
    private readonly platform: PlatformRepository,
    private readonly jobs: PlatformJobQueue,
    private readonly syncIntervalMs = 5_000,
    environment: SchedulingEnvironment = { suspended: false, online: true },
  ) {
    this.environment = { ...environment };
    if (!available(environment)) this.interruptedAt = Date.now();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.sync();
    if (!this.running) return;
    this.timer = setInterval(() => void this.sync().catch(() => undefined), this.syncIntervalMs);
    this.timer.unref?.();
  }

  async setEnvironment(environment: SchedulingEnvironment): Promise<void> {
    const wasAvailable = available(this.environment),
      isAvailable = available(environment);
    this.environment = { ...environment };
    if (wasAvailable && !isAvailable) {
      this.interruptedAt = Date.now();
      this.stopCrons();
    } else if (!wasAvailable && isAvailable) {
      this.resumeFrom = this.interruptedAt ?? this.lastObservedAt;
      this.interruptedAt = undefined;
    }
    await this.sync();
  }

  async close(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.stopCrons();
    await this.syncing;
    await Promise.allSettled(this.triggers.values());
    this.stopCrons();
  }

  private stopCrons(): void {
    for (const entry of this.schedules.values()) entry.cron.stop();
    this.schedules.clear();
  }

  private async sync(): Promise<void> {
    if (!this.running || !available(this.environment)) return;
    if (this.syncing) {
      await this.syncing;
      if (this.resumeFrom !== undefined) await this.sync();
      return;
    }
    this.syncing = this.synchronize();
    try {
      await this.syncing;
    } finally {
      this.syncing = undefined;
    }
  }

  private async synchronize(): Promise<void> {
    const now = Date.now();
    // This also catches sleep/clock gaps when a host lifecycle message was unavailable.
    if (!this.firstSync && now - this.lastObservedAt > Math.max(30_000, this.syncIntervalMs * 3))
      this.resumeFrom ??= this.lastObservedAt;
    const resumeFrom = this.resumeFrom;
    this.resumeFrom = undefined;
    const initial = this.firstSync;
    if (resumeFrom !== undefined) this.stopCrons();
    const tasks = await this.repository.listScheduledTasks();
    if (!this.running || !available(this.environment)) return;
    const active = new Set(tasks.map(({ id }) => id));
    for (const [id, entry] of this.schedules) {
      if (!active.has(id)) {
        entry.cron.stop();
        this.schedules.delete(id);
      }
    }
    for (const task of tasks) {
      if (!this.running || !available(this.environment)) return;
      if (task.schedule.mode !== 'cron' || !task.schedule.cron) continue;
      const signature = `${task.schedule.cron}\0${task.schedule.timezone}\0${task.schedule.misfirePolicy}`;
      if (this.schedules.get(task.id)?.signature === signature) continue;
      this.schedules.get(task.id)?.cron.stop();
      const cron = new Cron(task.schedule.cron, { timezone: task.schedule.timezone }, () => {
        if (Date.now() - this.lastObservedAt > Math.max(30_000, this.syncIntervalMs * 3)) {
          void this.sync().catch(() => undefined);
        } else void this.trigger(task.id);
      });
      this.schedules.set(task.id, { signature, cron });
      const lastTriggeredAt = task.lastTriggeredAt
        ? Date.parse(task.lastTriggeredAt)
        : Date.parse(task.updatedAt);
      const from = initial
        ? lastTriggeredAt
        : resumeFrom !== undefined
          ? Math.max(resumeFrom, lastTriggeredAt)
          : undefined;
      if (
        task.schedule.misfirePolicy === 'run-once' &&
        from !== undefined &&
        missedRun(task.schedule.cron, task.schedule.timezone, from, now)
      )
        await this.trigger(task.id, true);
    }
    this.firstSync = false;
    this.lastObservedAt = now;
  }

  private trigger(taskId: string, misfire = false): Promise<void> {
    const current = this.triggers.get(taskId);
    if (current) return current;
    const operation = this.triggerOnce(taskId, misfire);
    this.triggers.set(taskId, operation);
    void operation.finally(() => {
      if (this.triggers.get(taskId) === operation) this.triggers.delete(taskId);
    });
    return operation;
  }

  private async triggerOnce(taskId: string, misfire: boolean): Promise<void> {
    let createdRunId: string | undefined;
    try {
      if (!this.running || !available(this.environment)) return;
      if ((await this.platform.getRuntimeSetting<boolean>('scheduling.paused')) === true) return;
      if (!(await this.repository.getActiveRule(taskId))) return;
      if (!this.running || !available(this.environment)) return;
      const run = await this.repository.createRun(taskId, undefined, { scheduled: true, misfire });
      createdRunId = run.id;
      await this.jobs.enqueue({
        id: run.id,
        ownerPluginId: 'collection',
        type: 'collection.crawl.execute',
        resourceClass: 'browser-heavy',
        payload: { taskId, runId: run.id, scheduled: true },
        maxAttempts: 2,
      });
      await this.repository.markScheduleTriggered(taskId);
    } catch {
      // The existing active-Run constraint remains the final guard against concurrent triggers.
      if (createdRunId) {
        try {
          if (await this.jobs.get(createdRunId))
            await this.repository.markScheduleTriggered(taskId);
          else await this.repository.cancelRun(createdRunId);
        } catch {
          /* Preserve uncertain queue state for the existing recovery path. */
        }
      }
    }
  }
}

function missedRun(pattern: string, timezone: string, from: number, now: number): boolean {
  if (!Number.isFinite(from) || from >= now) return false;
  const calculator = new Cron(pattern, { timezone, paused: true });
  try {
    const next = calculator.nextRun(new Date(from));
    return Boolean(next && next.getTime() <= now);
  } finally {
    calculator.stop();
  }
}
