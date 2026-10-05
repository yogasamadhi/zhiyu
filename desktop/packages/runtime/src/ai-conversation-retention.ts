import type { AiConversationRepository } from '@zhiyun/plugin-ai-assistance';

export class AiConversationRetention {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly repository: AiConversationRepository) {}

  async start(): Promise<void> {
    await this.cleanup();
    this.timer = setInterval(() => void this.cleanup(), 24 * 60 * 60_000);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async cleanup(): Promise<void> {
    await this.repository.cleanupInactive(
      new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
    );
  }
}
