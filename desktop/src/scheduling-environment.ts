import type { SchedulingEnvironment } from '@zhiyun/contracts';

interface PowerEvents {
  on(event: 'suspend' | 'resume', listener: () => void): unknown;
  removeListener(event: 'suspend' | 'resume', listener: () => void): unknown;
}

export function watchSchedulingEnvironment(
  power: PowerEvents,
  isOnline: () => boolean,
  publish: (environment: SchedulingEnvironment) => void,
  intervalMs = 5_000,
): () => void {
  let state: SchedulingEnvironment = { suspended: false, online: isOnline() };
  const update = (suspended = state.suspended) => {
    const next = { suspended, online: isOnline() };
    if (next.suspended === state.suspended && next.online === state.online) return;
    state = next;
    publish({ ...state });
  };
  const suspend = () => update(true),
    resume = () => update(false);
  publish({ ...state });
  power.on('suspend', suspend);
  power.on('resume', resume);
  const timer = setInterval(() => update(), intervalMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    power.removeListener('suspend', suspend);
    power.removeListener('resume', resume);
  };
}
