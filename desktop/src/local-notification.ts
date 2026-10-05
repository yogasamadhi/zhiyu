import type { LocalNotificationResult } from '@zhiyun/contracts';

interface NativeNotification {
  once(event: 'show' | 'failed', listener: () => void): unknown;
  removeListener(event: 'show' | 'failed', listener: () => void): unknown;
  show(): void;
}

export interface NativeNotificationDriver {
  isSupported(): boolean;
  create(options: { title: string; body: string }): NativeNotification;
}

// A supported platform is not proof of delivery. Only Electron's show event confirms it.
export async function showLocalNotification(
  input: { title: unknown; body: unknown },
  driver: NativeNotificationDriver,
  timeoutMs = 1_500,
): Promise<LocalNotificationResult> {
  try {
    if (
      typeof input.title !== 'string' ||
      typeof input.body !== 'string' ||
      input.title.length > 200 ||
      input.body.length > 1_000
    )
      return { status: 'failed' };
    if (!driver.isSupported()) return { status: 'unsupported' };
    const notification = driver.create({ title: input.title, body: input.body });
    return await new Promise<LocalNotificationResult>((resolve) => {
      let settled = false;
      const finish = (status: LocalNotificationResult['status']) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        notification.removeListener('show', shown);
        notification.removeListener('failed', failed);
        resolve({ status });
      };
      const shown = () => finish('shown'),
        failed = () => finish('failed');
      const timer = setTimeout(() => finish('unconfirmed'), timeoutMs);
      timer.unref?.();
      notification.once('show', shown);
      notification.once('failed', failed);
      try {
        notification.show();
      } catch {
        finish('failed');
      }
    });
  } catch {
    return { status: 'failed' };
  }
}
