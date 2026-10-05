import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { testEnvironment } from '../../tooling/scripts/test-environment.js';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import type { RuntimeBootstrap } from '@zhiyun/contracts';

const desktopRoot = resolve(import.meta.dirname, '..');
const platformDirectory = `ZhiYun-${process.platform}-${process.arch}`;
const executablePath =
  process.platform === 'darwin'
    ? join(desktopRoot, 'out', platformDirectory, 'ZhiYun.app', 'Contents', 'MacOS', 'ZhiYun')
    : join(desktopRoot, 'out', platformDirectory, 'ZhiYun.exe');

let electronApp: ElectronApplication;
let profile = '';

async function request<T>(page: Page, path: string, body?: unknown): Promise<T> {
  return page.evaluate(
    async ({ path, body, key }) => {
      const bootstrap = await (
        window as typeof window & {
          zhiyunRuntime: { getBootstrap(): Promise<RuntimeBootstrap> };
        }
      ).zhiyunRuntime.getBootstrap();
      const session = await fetch(`${bootstrap.baseUrl}/api/v2/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: bootstrap.sessionNonce }),
      });
      if (!session.ok) throw new Error(`Packaged smoke session HTTP ${session.status}`);
      const { token } = (await session.json()) as { token: string };
      const response = await fetch(`${bootstrap.baseUrl}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`Packaged smoke ${path}: HTTP ${response.status}`);
      return response.json();
    },
    { path, body, key: randomUUID() },
  ) as Promise<T>;
}

test.beforeAll(async () => {
  await access(executablePath);
  profile = await mkdtemp(join(tmpdir(), 'zhiyun-packaged-smoke-'));
  console.info('PACKAGED_SMOKE_PROFILE', profile);
  electronApp = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${profile}`],
    env: { ...testEnvironment(process.env), TMPDIR: profile, TMP: profile, TEMP: profile },
  });
  if (process.env.ZHIYUN_E2E_LOG === '1') {
    electronApp.process().stdout?.on('data', (chunk) => process.stdout.write(String(chunk)));
    electronApp.process().stderr?.on('data', (chunk) => process.stderr.write(String(chunk)));
  }
});

test.afterAll(async () => {
  await electronApp?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

test('runs a dynamic crawl and analysis from the self-contained packaged application', async ({
  browserName,
}, info) => {
  void browserName;
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  expect(
    await electronApp.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      executable: app.getPath('exe'),
    })),
  ).toEqual({ packaged: true, executable: executablePath });
  type Readiness = {
    status: string;
    checks: { analyticsWorker: { status: string; workerStatus: string } };
  };
  await expect
    .poll(
      async () => (await request<Readiness>(page, '/ready')).checks.analyticsWorker.workerStatus,
    )
    .toBe('ready');
  const readiness = await request<Readiness>(page, '/ready');
  expect(readiness).toMatchObject({
    status: 'ready',
    checks: { analyticsWorker: { status: 'ok', workerStatus: 'ready' } },
  });
  await page.goto('app://zhiyun/tasks/new?professional=1');
  await expect(page.getByLabel('URL')).toHaveValue('');
  await page.getByLabel('任务名称').fill(`Packaged smoke ${Date.now()}`);
  await page.getByLabel('URL').fill('http://127.0.0.1:45100/dynamic-products');
  await page.getByText('高级设置').click();
  await page.getByLabel(/允许 localhost/).check();
  await page.getByLabel('使用浏览器').check();
  await page.getByLabel('分页方式').selectOption('loadMore');
  await page.getByLabel('分页按钮 Selector').fill('#load-more');
  await page.getByRole('button', { name: /分析网页/ }).click();
  await expect(page.getByRole('cell', { name: '织云商品 01', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认并保存规则' }).click();
  await expect(page.getByText('规则版本已保存')).toBeVisible();
  await expect(page).toHaveURL(/tasks\/[^/]+\/edit/);
  const taskId = page.url().match(/tasks\/([^/]+)\/edit/)?.[1];
  expect(taskId).toBeTruthy();
  await page.goto(`app://zhiyun/tasks/${taskId}`);
  await page.getByRole('button', { name: '运行' }).click();
  await expect(page.locator('.page-heading .badge')).toHaveText('已完成', { timeout: 60_000 });
  await expect(page.getByRole('cell', { name: '织云商品 30', exact: true })).toBeVisible();
  await expect(page.getByText('Browser', { exact: true })).toBeVisible();

  await page.goto(`app://zhiyun/tasks/${taskId}`);
  await page.getByRole('link', { name: '数据', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Packaged smoke/ })).toBeVisible();
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page).toHaveURL(/\/analytics\?datasetId=/, { timeout: 60_000 });
  await page.getByRole('button', { name: '从当前数据创建版本', exact: true }).click();
  await expect(page.getByLabel('数据版本', { exact: true })).not.toHaveValue('', {
    timeout: 60_000,
  });
  const datasetId = new URL(page.url()).searchParams.get('datasetId')!;
  expect(datasetId).toBeTruthy();
  const records = await request<{ items: Array<{ data: Record<string, unknown> }> }>(
    page,
    `/api/v2/datasets/${datasetId}/records?limit=100`,
  );
  expect(records.items).toHaveLength(30);
  expect(records.items.some((record) => Object.values(record.data).includes('织云商品 30'))).toBe(
    true,
  );
  const snapshotId = await page.getByLabel('数据版本', { exact: true }).inputValue();
  const snapshot = await request<{ id: string; status: string; rowCount: number }>(
    page,
    `/api/v2/datasets/${datasetId}/snapshots/${snapshotId}`,
  );
  expect(snapshot).toMatchObject({ id: snapshotId, status: 'ready', rowCount: 30 });
  await page.getByRole('option', { name: /数据概况/ }).click();
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page).toHaveURL(/\/analytics\/jobs\/[^/]+$/, { timeout: 30_000 });
  await expect(page.locator('.job-status-line .badge')).toHaveText('已完成', {
    timeout: 60_000,
  });
  await expect(page.getByRole('heading', { name: '分析结果', exact: true })).toBeVisible();
  const analysisJobId = new URL(page.url()).pathname.split('/').at(-1)!;
  const analysisState = await request<{ state: string; resultId: string; snapshotId: string }>(
    page,
    `/api/v2/analytics/jobs/${analysisJobId}`,
  );
  expect(analysisState).toMatchObject({ state: 'succeeded', snapshotId });
  expect(analysisState.resultId).toBeTruthy();
  const analysisPath = join(profile, 'analysis-result.json');
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, analysisPath);
  await page.getByRole('button', { name: '导出结果', exact: true }).click();
  await expect
    .poll(async () =>
      readFile(analysisPath, 'utf8')
        .then((value) => JSON.parse(value).methodId)
        .catch(() => ''),
    )
    .toBe('data.profile');
  const analysis = JSON.parse(await readFile(analysisPath, 'utf8')) as {
    id: string;
    methodId: string;
    snapshotId: string;
    workerVersion: string;
  };
  expect(analysis).toMatchObject({
    id: analysisState.resultId,
    methodId: 'data.profile',
    snapshotId,
  });
  expect(analysis.workerVersion).toBeTruthy();

  await page.goto(`app://zhiyun/corpora?datasetId=${datasetId}`);
  await page.getByLabel('任务名称', { exact: true }).fill('Packaged product corpus');
  await expect(page.getByLabel('数据版本', { exact: true })).not.toHaveValue('');
  await page.getByRole('button', { name: '创建语料库', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Packaged product corpus', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await expect(page.getByLabel('文本字段', { exact: true })).not.toHaveValues([]);
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '生成预览', exact: true }).click();
  await expect(page.getByText('已预览 20 / 30 行', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '下一步', exact: true }).click();
  await page.getByRole('button', { name: '开始构建', exact: true }).click();
  const corpusVersion = page.locator('a[href*="/versions/"]').first();
  await expect(corpusVersion).toBeVisible({ timeout: 60_000 });
  await corpusVersion.click();
  const corpusPath = join(profile, 'documents.jsonl');
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, corpusPath);
  await page.getByText('导出文件', { exact: true }).click();
  await page.getByRole('button', { name: 'corpus.jsonl', exact: true }).click();
  await expect
    .poll(async () =>
      readFile(corpusPath, 'utf8')
        .then((value) => value.trim().split('\n').length)
        .catch(() => 0),
    )
    .toBe(30);
  const report = {
    measuredAt: new Date().toISOString(),
    system: process.platform,
    arch: process.arch,
    application: { packaged: true, executable: executablePath },
    profile,
    environment: 'filtered testEnvironment; owned temporary profile and TMPDIR',
    readiness,
    collection: { taskId, datasetId, recordsRead: records.items.length },
    snapshot,
    analysis: { ...analysisState, result: analysis },
    corpusExportRows: 30,
  };
  await writeFile(info.outputPath('packaged-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  await info.attach('packaged-smoke', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
});
