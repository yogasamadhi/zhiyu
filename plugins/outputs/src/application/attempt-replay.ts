import type { PlatformJobQueue } from '@zhiyun/platform-core';
import type { OutputRepository } from '../contracts/index.js';
import { enqueueEventNotification, enqueueOutputDelivery } from './index.js';

export interface OutputAttemptReplayOptions {
  intervalMs?: number;
  maximumAutomaticAttempts?: number;
  now?: () => number;
}

/**
 * Replays the durable side of the output outbox. This closes the process-crash
 * window between committing an attempt and creating its queue job, and starts
 * a fresh deterministic job for retryable attempts whose backoff has elapsed.
 */
export class OutputAttemptReplay {
  private timer: ReturnType<typeof setInterval> | undefined;
  private sweeping = false;
  private readonly intervalMs: number;
  private readonly maximumAutomaticAttempts: number;
  private readonly now: () => number;

  constructor(
    private readonly repository: OutputRepository,
    private readonly jobs: PlatformJobQueue,
    options: OutputAttemptReplayOptions = {},
  ) {
    this.intervalMs = Math.max(1_000, options.intervalMs ?? 30_000);
    this.maximumAutomaticAttempts = Math.max(1, options.maximumAutomaticAttempts ?? 10);
    this.now = options.now ?? Date.now;
  }

  async start(): Promise<void> {
    await this.sweep();
    this.timer = setInterval(() => void this.sweep(), this.intervalMs);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const [deliveries, notifications] = await Promise.all([
        this.repository.listDeliveryAttempts(),
        this.repository.listEventNotificationAttempts(),
      ]);
      await Promise.allSettled([
        ...deliveries.map(async (attempt) => {
          if (attempt.status === 'pending') {
            await enqueueOutputDelivery(this.jobs, attempt);
            return;
          }
          if (!this.retryDue(attempt)) return;
          const updated = await this.repository.updateDeliveryAttempt(attempt.id, {
            status: 'pending',
            attempt: attempt.attempt + 1,
            error: null,
            nextAttemptAt: null,
          });
          if (updated) await enqueueOutputDelivery(this.jobs, updated);
        }),
        ...notifications.map(async (attempt) => {
          if (attempt.status === 'pending') {
            await enqueueEventNotification(this.jobs, attempt);
            return;
          }
          if (!this.retryDue(attempt)) return;
          const updated = await this.repository.updateEventNotificationAttempt(attempt.id, {
            status: 'pending',
            attempt: attempt.attempt + 1,
            error: null,
            nextAttemptAt: null,
          });
          if (updated) await enqueueEventNotification(this.jobs, updated);
        }),
      ]);
    } finally {
      this.sweeping = false;
    }
  }

  private retryDue(attempt: {
    status: string;
    attempt: number;
    nextAttemptAt: string | null;
  }): boolean {
    return (
      attempt.status === 'failed' &&
      attempt.attempt < this.maximumAutomaticAttempts &&
      attempt.nextAttemptAt !== null &&
      Date.parse(attempt.nextAttemptAt) <= this.now()
    );
  }
}
