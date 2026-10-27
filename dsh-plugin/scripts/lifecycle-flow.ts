import { glob, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import type { Page } from 'playwright';
export async function lifecycleFlow(
  page: Page,
  rpc: (method: string, args?: Record<string, unknown>) => Promise<unknown>,
  workspaceId: string,
  taskId: string,
  home: string,
) {
  const pids: number[] = [];
  for await (const lock of glob(join(home, 'zhiyun/*/*/.runtime.lock'))) {
    const pid = Number(await readFile(lock, 'utf8'));
    pids.push(pid);
    try {
      pids.push(
        ...execFileSync('/usr/bin/pgrep', ['-P', String(pid)], { encoding: 'utf8' })
          .trim()
          .split(/\s+/)
          .map(Number),
      );
    } catch {
      /* no children */
    }
  }
  assert.ok(pids.length);
  const disabled = await rpc('pluginManager/setBundleEnabled', {
    name: 'dsh-zhiyun',
    enabled: false,
  });
  console.log('BUNDLE_DISABLED', JSON.stringify(disabled));
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 200 && pids.some(alive); i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(pids.some(alive), false, 'Disabled plugin retained its process');
  console.log('BUNDLE_DISABLED_PROCESS_CLEANUP_PASSED');
  const enabled = await rpc('pluginManager/setBundleEnabled', {
    name: 'dsh-zhiyun',
    enabled: true,
  });
  console.log('BUNDLE_ENABLED', JSON.stringify(enabled));
  await page.getByText('织云', { exact: true }).click();
  await page.getByRole('link', { name: '采集任务', exact: true }).waitFor({ timeout: 180000 });
  const result = (await rpc('invoke', {
    input: { workspaceId, operationId: 'getTask', path: { taskId } },
  })) as { status: number; body: { id: string } };
  assert.equal(result.status, 200);
  assert.equal(result.body.id, taskId);
  console.log('BUNDLE_REENABLE_HISTORY_PASSED');
}
