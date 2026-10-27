import { lifecycleFlow } from './lifecycle-flow.ts';
import { presentationFlow } from './presentation-flow.ts';
import { businessFlow } from './business-flow.ts';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { strict as assert } from 'node:assert';
let url: string | undefined;
for (let attempt = 0; attempt < 100 && !url; attempt++) {
  const log = await readFile(
    process.env.DSH_TEST_LOG ?? '.artifacts/dsh-plugin/web-host.log',
    'utf8',
  );
  url = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=\S+/)?.[0];
  if (!url) await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!url) throw new Error('Test Host did not publish its URL');
const browser = await chromium.launch({
  headless: true,
  executablePath: resolve(
    'dsh-plugin/resources/playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  ),
});
const page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto(url);
  await page.waitForTimeout(2500);
  if (await page.getByText('继续', { exact: true }).count())
    await page.getByText('继续', { exact: true }).click();
  await page.getByText('织云', { exact: true }).click();
  await page.getByRole('link', { name: '采集任务', exact: true }).waitFor({ timeout: 180000 });
  const base = page.url();
  for (const name of ['采集任务', '数据集', '分析与报告', '语料工作台', '输出连接', '凭据与导出']) {
    await page.getByRole('link', { name, exact: true }).click();
    await page.waitForTimeout(600);
    assert.equal(page.url(), base);
    console.log('PAGE', name, await page.locator('.zhiyun-page').innerText());
  }
  const rpc = async (method: string, args: unknown = {}) => {
    const endpoint = method.includes('/') ? method : `zhiyun/${method}`;
    const r = await page.request.post(new URL(`/api/${endpoint}`, base).href, {
      timeout: 180_000,
      data: {
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method: endpoint,
        payload: { args },
      },
    });
    assert.equal(r.status(), 200);
    const v = await r.json();
    if (!v.result?.ok) throw new Error(JSON.stringify(v));
    return v.result.value;
  };
  const workspaces = await rpc('workspaces');
  console.log('WORKSPACES', workspaces);
  const flow = await businessFlow(workspaces[0].id, (input) => rpc('invoke', { input }));
  if (workspaces[1]) {
    const isolated = await rpc('invoke', {
      input: { workspaceId: workspaces[1].id, operationId: 'listDatasets' },
    });
    assert.ok(!isolated.body.items.some((row: { id: string }) => row.id === flow.datasetId));
    console.log('WORKSPACE_ISOLATION_PASSED');
  }
  const credential = await rpc('setCredential', {
    workspaceId: workspaces[0].id,
    kind: 'task-secret-headers',
    value: { 'X-Fixture-Secret': 'zhiyun-manual-fixture-value' },
  });
  const task = await rpc('invoke', {
    input: { workspaceId: workspaces[0].id, operationId: 'getTask', path: { taskId: flow.taskId } },
  });
  const bound = await rpc('invoke', {
    input: {
      workspaceId: workspaces[0].id,
      operationId: 'updateTask',
      path: { taskId: flow.taskId },
      body: {
        credentialBindings: {
          ...task.body.credentialBindings,
          secretHeadersRef: credential.reference,
        },
      },
      headers: { 'if-match': task.headers.etag },
    },
  });
  assert.equal(bound.status, 200);
  assert.equal(bound.body.credentialBindings.secretHeadersRef, credential.reference);
  assert.ok(!JSON.stringify(bound).includes('zhiyun-manual-fixture-value'));
  console.log('CREDENTIAL_REFERENCE_PASSED');
  const prompting = rpc('invoke', {
    input: {
      workspaceId: workspaces[0].id,
      operationId: 'promptTaskCredential',
      path: { taskId: flow.taskId, kind: 'secretHeaders' },
      body: { revision: bound.body.revision },
    },
  });
  await page.getByRole('dialog', { name: '输入凭据' }).waitFor({ timeout: 15000 });
  await page
    .getByRole('textbox', { name: 'Secret JSON' })
    .fill(JSON.stringify({ 'X-Fixture-Prompt': 'manual-prompt-value' }));
  await page.getByRole('button', { name: '保存到 DSH', exact: true }).click();
  assert.equal((await prompting).status, 200);
  console.log('MANUAL_CREDENTIAL_PROMPT_PASSED');
  const saved = await rpc('saveArtifact', {
    workspaceId: workspaces[0].id,
    artifactId: flow.artifact.id,
    filename: flow.artifact.filename,
  });
  assert.equal(saved.saved, true);
  assert.match(await readFile(saved.path, 'utf8'), /Item/);
  await page.getByRole('link', { name: '数据集', exact: true }).click();
  await page.locator(`a[href="/datasets/${flow.datasetId}"]`).click();
  await page.waitForTimeout(1000);
  console.log('DATASET_PAGE', await page.locator('.zhiyun-page').innerText());
  await page.screenshot({ path: '.artifacts/dsh-plugin/web-dataset.png' });
  await page.locator('.zhiyun-page summary').filter({ hasText: '导出' }).click();
  const downloading = page.waitForEvent('download', { timeout: 180000 });
  await page.getByRole('button', { name: /JSON ·/ }).click();
  const download = await downloading;
  assert.ok(await download.path());
  console.log('ARTIFACT_DOWNLOAD_PASSED');
  await presentationFlow(page, rpc, workspaces[0].id);
  if (process.env.DSH_TEST_HOME)
    await lifecycleFlow(page, rpc, workspaces[0].id, flow.taskId, process.env.DSH_TEST_HOME);
  assert.equal(errors.length, 0, errors.join('\n'));
  await page.screenshot({ path: '.artifacts/dsh-plugin/web-pages.png' });
} catch (error) {
  console.error('WORKBENCH_FAILURE', await page.locator('body').innerText(), errors);
  await page.screenshot({ path: '.artifacts/dsh-plugin/web-failure.png' });
  throw error;
} finally {
  await browser.close();
}
