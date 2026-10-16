import { useEffect } from 'react';
import { runtimeClient } from '@zhiyun/client';

const storageKey = 'zhiyun-run-notifications';

export function readRunNotificationsEnabled(): boolean {
  try {
    return localStorage.getItem(storageKey) !== 'off';
  } catch {
    return true;
  }
}

export function setRunNotificationsEnabled(enabled: boolean) {
  try {
    if (enabled) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, 'off');
  } catch {
    /* Storage can be unavailable; notifications then stay at the default. */
  }
}

/**
 * Shows a system notification when a Run finishes while the window is in the background.
 * The event stream replays history on connect, so only events created after mounting count.
 */
export function useRunNotifications(zh: boolean) {
  useEffect(() => {
    if (typeof Notification === 'undefined') return;
    const since = Date.now();
    return runtimeClient.onDomainEvent((event) => {
      if (event.type !== 'run.succeeded' && event.type !== 'run.failed') return;
      if (Date.parse(event.createdAt) < since || document.hasFocus()) return;
      if (!readRunNotificationsEnabled() || Notification.permission === 'denied') return;
      const succeeded = event.type === 'run.succeeded';
      const count = event.payload.recordCount;
      const title = succeeded
        ? zh
          ? '织云采集已完成'
          : 'ZhiYun collection finished'
        : zh
          ? '织云采集失败'
          : 'ZhiYun collection failed';
      const body = succeeded
        ? zh
          ? `本次运行采集了 ${typeof count === 'number' ? count : '—'} 条记录。`
          : `This run collected ${typeof count === 'number' ? count : '—'} records.`
        : zh
          ? '打开应用查看失败原因。'
          : 'Open the app to see why it failed.';
      try {
        new Notification(title, { body, tag: event.aggregateId });
      } catch {
        /* The host can refuse notifications; the in-app status still updates. */
      }
    });
  }, [zh]);
}
