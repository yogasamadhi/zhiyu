import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

let electronApp: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const desktopRoot = resolve(import.meta.dirname, '..');
  const profile = await mkdtemp(join(tmpdir(), 'zhiyun-desktop-e2e-'));
  electronApp = await electron.launch({
    args: [desktopRoot, `--user-data-dir=${profile}`],
    cwd: desktopRoot,
    env: { ...process.env, NODE_ENV: 'test' },
  });
  if (process.env.ZHIYUN_E2E_LOG === '1') {
    electronApp.process().stdout?.on('data', (chunk) => process.stdout.write(String(chunk)));
    electronApp.process().stderr?.on('data', (chunk) => process.stderr.write(String(chunk)));
  }
  page = await electronApp.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await electronApp?.close();
});

test.afterEach(async () => {
  for (const window of electronApp.windows().filter((candidate) => candidate !== page)) {
    await window.close().catch(() => undefined);
  }
});

test('uses a sandboxed Renderer and completes the desktop static workflow', async () => {
  expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe(
    'undefined',
  );
  expect(await page.evaluate(() => Object.keys(window.zhiyunRuntime!))).toEqual([
    'getBootstrap',
    'onBootstrapChanged',
  ]);
  await page
    .getByRole('link', { name: /新建任务/ })
    .first()
    .click();
  await page.getByLabel('任务名称').fill(`Desktop fixture ${Date.now()}`);
  await page.getByRole('button', { name: /分析网页/ }).click();
  await expect(page.getByRole('heading', { name: 'Rule Builder' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '织云商品 01', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认并保存规则' }).click();
  await expect(page.getByText('规则版本已保存')).toBeVisible();
  const taskId = page.url().match(/tasks\/([^/]+)\/edit/)?.[1];
  expect(taskId).toBeTruthy();
  await page.goto(`app://zhiyun/tasks/${taskId}`);
  await page.getByRole('button', { name: '运行' }).click();
  await expect(page.locator('.page-heading .badge')).toHaveText('succeeded');
  await expect(page.getByRole('cell', { name: '织云商品 10', exact: true })).toBeVisible();
});

test('uses bundled Playwright for a dynamic desktop task', async () => {
  await page.goto('app://zhiyun/tasks/new');
  await page.getByLabel('任务名称').fill(`Desktop dynamic ${Date.now()}`);
  await page.getByLabel('URL').fill('http://127.0.0.1:45100/dynamic-products');
  await page.getByText('高级设置').click();
  await page.getByLabel('使用浏览器').check();
  await page.getByLabel('分页方式').selectOption('loadMore');
  await page.getByLabel('分页按钮 Selector').fill('#load-more');
  await page.getByRole('button', { name: /分析网页/ }).click();
  await expect(page.getByRole('cell', { name: '织云商品 01', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认并保存规则' }).click();
  const taskId = page.url().match(/tasks\/([^/]+)\/edit/)?.[1];
  await page.goto(`app://zhiyun/tasks/${taskId}`);
  await page.getByRole('button', { name: '运行' }).click();
  await expect(page.locator('.page-heading .badge')).toHaveText('succeeded', { timeout: 40_000 });
  await expect(page.getByRole('cell', { name: '织云商品 30', exact: true })).toBeVisible();
  await expect(page.getByText('Browser', { exact: true })).toBeVisible();
});

test('captures an isolated login session and crawls an authenticated page', async () => {
  await page.goto('app://zhiyun/tasks/new');
  await page.getByLabel('任务名称').fill(`Desktop login ${Date.now()}`);
  await page.getByLabel('URL').fill('http://127.0.0.1:45100/private-products');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page).toHaveURL(/tasks\/[^/]+\/edit/);
  await page.getByText('高级设置').click();
  await page.getByLabel('登录 URL').fill('http://127.0.0.1:45100/login');

  const loginWindowPromise = electronApp.waitForEvent('window');
  await page.getByRole('button', { name: '打开安全登录窗口' }).click();
  const loginWindow = await loginWindowPromise;
  await loginWindow.waitForLoadState('domcontentloaded');
  await expect(loginWindow.getByRole('heading', { name: 'Fixture 登录' })).toBeVisible();
  await loginWindow.getByRole('button', { name: '登录' }).click();
  await expect(loginWindow.getByRole('heading', { name: '登录后商品' })).toBeVisible();
  const closed = loginWindow.waitForEvent('close');
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().includes('/private-products'))
      ?.close();
  });
  await closed;

  await expect(page.getByText('登录态已安全保存')).toBeVisible();
  await expect(page.getByRole('button', { name: '重新登录' })).toBeVisible();
  await page.getByRole('button', { name: /分析网页/ }).click();
  await expect(page.getByRole('heading', { name: 'Rule Builder' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '织云商品 01', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认并保存规则' }).click();
  const taskId = page.url().match(/tasks\/([^/]+)\/edit/)?.[1];
  expect(taskId).toBeTruthy();
  await page.goto(`app://zhiyun/tasks/${taskId}`);
  await page.getByRole('button', { name: '运行' }).click();
  await expect(page.locator('.page-heading .badge')).toHaveText('succeeded', { timeout: 40_000 });
  await expect(page.getByRole('cell', { name: '织云商品 10', exact: true })).toBeVisible();
  await expect(page.getByText('Browser', { exact: true })).toBeVisible();
});
