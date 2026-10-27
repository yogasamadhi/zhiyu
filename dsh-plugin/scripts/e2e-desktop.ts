import { lifecycleFlow } from './lifecycle-flow.ts';
import { presentationFlow } from './presentation-flow.ts';
import { _electron as electron } from 'playwright';
import { resolve } from 'node:path';
import { businessFlow } from './business-flow.ts';
import { strict as assert } from 'node:assert';
const root = resolve('.artifacts/dsh-plugin');
const home = resolve(root, 'desktop-home');
const app = await electron.launch({
  executablePath: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
  args: [`--user-data-dir=${resolve(root, 'desktop-user-data')}`],
  env: {
    PATH: process.env.PATH!,
    HOME: home,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: 'fixture-not-a-real-provider-key',
  },
  timeout: 120000,
});
try {
  const page = await app.firstWindow();
  await page.getByText('织云', { exact: true }).waitFor({ timeout: 180000 });
  await page.getByText('织云', { exact: true }).click();
  await page.getByRole('link', { name: '采集任务', exact: true }).waitFor({ timeout: 180000 });
  console.log('DESKTOP_PANEL_READY');
  const rpc = async (method: string, args: unknown = {}) =>
    page.evaluate(
      async ({ method, args }) => {
        const endpoint = method.includes('/') ? method : `zhiyun/${method}`;
        const r = await fetch(`/api/${endpoint}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: crypto.randomUUID(),
            method: endpoint,
            payload: { args },
          }),
        });
        const v = await r.json();
        if (!v.result?.ok) throw new Error(JSON.stringify(v));
        return v.result.value;
      },
      { method, args },
    );
  const workspaces = await rpc('workspaces');
  const flow = await businessFlow(workspaces[0].id, (input) => rpc('invoke', { input }));
  const saved = await rpc('saveArtifact', {
    workspaceId: workspaces[0].id,
    artifactId: flow.artifact.id,
    filename: flow.artifact.filename,
  });
  assert.equal(saved.saved, true);
  await presentationFlow(page, rpc, workspaces[0].id);
  await lifecycleFlow(page, rpc, workspaces[0].id, flow.taskId, home);
  await page.screenshot({ path: resolve(root, 'desktop-workbench.png') });
  console.log('DESKTOP_BUSINESS_FLOW_PASSED');
} catch (error) {
  const page = await app.firstWindow();
  console.error('WORKBENCH_FAILURE', await page.locator('body').innerText());
  await page.screenshot({ path: resolve(root, 'desktop-failure.png') });
  throw error;
} finally {
  await app.close();
}
