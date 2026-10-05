import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalyticsWorkerSupervisor, type AnalyticsWorkerSupervisorState } from '../src/index.js';

const workspaceRoot = resolve(import.meta.dirname, '../../../..');
const python =
  process.platform === 'win32'
    ? join(workspaceRoot, 'analytics-worker', '.venv', 'Scripts', 'python.exe')
    : join(workspaceRoot, 'analytics-worker', '.venv', 'bin', 'python');
const supervisors: AnalyticsWorkerSupervisor[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(supervisors.splice(0).map((supervisor) => supervisor.stop()));
  await Promise.allSettled(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe.skipIf(!existsSync(python))('AnalyticsWorkerSupervisor integration', () => {
  it('restarts a crashed Worker without putting credentials in process arguments', async () => {
    const states: AnalyticsWorkerSupervisorState[] = [];
    const directory = await mkdtemp(join(tmpdir(), 'zhiyun-worker-supervisor-'));
    temporaryDirectories.push(directory);
    const supervisor = new AnalyticsWorkerSupervisor({
      command: python,
      args: ['-m', 'zhiyun_analytics_worker'],
      workspaceRoot: directory,
      restartWindowMs: 30_000,
      onStateChange: (state) => states.push(state),
    });
    supervisors.push(supervisor);
    const first = await supervisor.start();
    expect(first.token.length).toBeGreaterThan(32);
    expect(['-m', 'zhiyun_analytics_worker']).not.toContain(first.token);
    expect(JSON.stringify(supervisor.diagnostics())).not.toContain(first.token);
    const pid = supervisor.diagnostics().pid;
    expect(typeof pid).toBe('number');
    process.kill(pid as number, 'SIGKILL');
    const deadline = Date.now() + 8_000;
    while (
      !states.some((state) => state.status === 'ready' && state.generation === 2) &&
      Date.now() < deadline
    ) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    expect(states).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'degraded', generation: 1 }),
        expect.objectContaining({ status: 'ready', generation: 2 }),
      ]),
    );
  }, 12_000);
});
