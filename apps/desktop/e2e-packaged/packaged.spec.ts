import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';

const desktopRoot = resolve(import.meta.dirname, '..');
const platformDirectory = `ZhiYun-${process.platform}-${process.arch}`;
const executablePath =
  process.platform === 'darwin'
    ? join(desktopRoot, 'out', platformDirectory, 'ZhiYun.app', 'Contents', 'MacOS', 'ZhiYun')
    : join(desktopRoot, 'out', platformDirectory, 'ZhiYun.exe');

let electronApp: ElectronApplication;
let profile = '';

test.beforeAll(async () => {
  await access(executablePath);
  profile = await mkdtemp(join(tmpdir(), 'zhiyun-packaged-smoke-'));
  electronApp = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${profile}`],
    env: { ...process.env, NODE_ENV: 'test' },
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

test('runs a dynamic crawl and analysis from the self-contained packaged application', async () => {
  const page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  expect(
    await electronApp.evaluate(({ app }) => ({
      packaged: app.isPackaged,
      executable: app.getPath('exe'),
    })),
  ).toEqual({ packaged: true, executable: executablePath });
  await page.goto('app://zhiyun/tasks/new');
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
  await expect(page.locator('.page-heading .badge')).toHaveText('succeeded', { timeout: 60_000 });
  await expect(page.getByRole('cell', { name: '织云商品 30', exact: true })).toBeVisible();
  await expect(page.getByText('Browser', { exact: true })).toBeVisible();

  await page.goto(`app://zhiyun/tasks/${taskId}`);
  await page.getByRole('link', { name: '数据', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Packaged smoke/ })).toBeVisible();
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  await expect(page).toHaveURL(/\/analytics\?datasetId=.*snapshotId=/, { timeout: 60_000 });
  await expect(page.getByLabel('Snapshot ID')).not.toHaveValue('');
  await page.getByRole('option', { name: /data\.profile/ }).click();
  await page.getByRole('button', { name: '开始分析', exact: true }).click();
  const analysisJob = page.locator('a[href*="/analytics/jobs/"]').first();
  await expect(analysisJob).toBeVisible({ timeout: 30_000 });
  await analysisJob.click();
  await expect(page.locator('.job-status-line .badge')).toHaveText('succeeded', {
    timeout: 60_000,
  });
  await expect(page.getByRole('heading', { name: '分析结果' })).toBeVisible();
});
