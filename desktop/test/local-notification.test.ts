import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { showLocalNotification, type NativeNotificationDriver } from '../src/local-notification.js';

afterEach(() => vi.useRealTimers());
describe('native notification outcomes', () => {
  it('does not create notifications on unsupported systems', async () => {
    const create = vi.fn();
    expect(
      await showLocalNotification(
        { title: 'Fixture', body: 'Counts only' },
        { isSupported: () => false, create },
      ),
    ).toEqual({ status: 'unsupported' });
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['show', 'failed', 'throw'] as const)(
    'handles %s without failing the caller and removes listeners',
    async (event) => {
      const notification = Object.assign(new EventEmitter(), {
        show() {
          if (event === 'throw') throw new Error('PRIVATE OS ERROR');
          notification.emit(event);
        },
      });
      const driver: NativeNotificationDriver = {
        isSupported: () => true,
        create: () => notification,
      };
      const result = await showLocalNotification({ title: 'Fixture', body: 'Counts only' }, driver);
      expect(result).toEqual({ status: event === 'show' ? 'shown' : 'failed' });
      expect(notification.listenerCount('show') + notification.listenerCount('failed')).toBe(0);
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    },
  );

  it('reports unconfirmed when the system is silent and ignores late callbacks', async () => {
    vi.useFakeTimers();
    const notification = Object.assign(new EventEmitter(), { show() {} });
    const pending = showLocalNotification(
      { title: 'Fixture', body: 'Counts only' },
      { isSupported: () => true, create: () => notification },
      1500,
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toEqual({ status: 'unconfirmed' });
    notification.emit('show');
    notification.emit('failed');
    expect(notification.listenerCount('show') + notification.listenerCount('failed')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('contains support probe and construction failures and rejects invalid payloads', async () => {
    const input = { title: 'Fixture', body: 'Counts only' };
    expect(
      await showLocalNotification(input, {
        isSupported() {
          throw new Error('PRIVATE');
        },
        create: vi.fn(),
      }),
    ).toEqual({ status: 'failed' });
    expect(
      await showLocalNotification(input, {
        isSupported: () => true,
        create() {
          throw new Error('PRIVATE');
        },
      }),
    ).toEqual({ status: 'failed' });
    const create = vi.fn();
    expect(
      await showLocalNotification(
        { title: {}, body: input.body },
        { isSupported: () => true, create },
      ),
    ).toEqual({ status: 'failed' });
    expect(create).not.toHaveBeenCalled();
  });
});
