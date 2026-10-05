import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SchedulingEnvironment } from '@zhiyun/contracts';
import { watchSchedulingEnvironment } from '../src/scheduling-environment.js';

afterEach(() => vi.useRealTimers());
describe('desktop scheduling environment', () => {
  it('publishes sleep, resume and connection changes once, then removes owned observers', async () => {
    vi.useFakeTimers();
    const power = new EventEmitter(),
      received: SchedulingEnvironment[] = [];
    let online = true;
    const stop = watchSchedulingEnvironment(
      power,
      () => online,
      (state) => received.push(state),
    );
    expect(received).toEqual([{ suspended: false, online: true }]);
    power.emit('suspend');
    power.emit('suspend');
    online = false;
    await vi.advanceTimersByTimeAsync(5000);
    power.emit('resume');
    power.emit('resume');
    online = true;
    await vi.advanceTimersByTimeAsync(10000);
    expect(received).toEqual([
      { suspended: false, online: true },
      { suspended: true, online: true },
      { suspended: true, online: false },
      { suspended: false, online: false },
      { suspended: false, online: true },
    ]);
    stop();
    expect(power.listenerCount('suspend') + power.listenerCount('resume')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    power.emit('suspend');
    expect(received).toHaveLength(5);
  });
});
