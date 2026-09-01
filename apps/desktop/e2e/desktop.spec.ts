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
  if (process.env.ZHIYUN_E2E_LOG === '1') {
    page.on('console', (message) => console.log(`[renderer:${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => console.error('[renderer:error]', error));
    page.on('requestfailed', (request) =>
      console.error(`[renderer:requestfailed] ${request.url()} ${request.failure()?.errorText}`),
    );
  }
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

test('renders the crawler assistant without a Renderer crash', async () => {
  const errors: string[] = [];
  const recordError = (error: Error) => errors.push(error.stack ?? error.message);
  page.on('pageerror', recordError);
  try {
    await page.goto('app://zhiyun/');
    await page.getByRole('link', { name: 'AI 创建' }).first().click();
    await expect(page.getByRole('heading', { name: '对话创建爬虫' })).toBeVisible();
    await expect(page.getByText('演示模式')).toBeVisible();
    await page.getByRole('link', { name: '采集任务' }).first().click();
    await expect(page.getByRole('heading', { name: '采集任务' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    page.off('pageerror', recordError);
  }
});

test('selects a curated AI provider and model without an editable Base URL', async () => {
  await page.goto('app://zhiyun/settings');
  await expect(page.getByRole('heading', { name: 'AI Provider' })).toBeVisible();

  const providerSelect = page.getByLabel('模型厂商');
  const modelSelect = page.getByLabel('模型 ID');
  await expect(providerSelect.locator('option')).toHaveCount(13);
  await providerSelect.selectOption('deepseek');

  await expect(modelSelect).toHaveValue('deepseek-v4-pro');
  await expect(modelSelect.locator('option')).toHaveCount(2);
  await expect(page.getByText('https://api.deepseek.com', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '官方模型文档' })).toHaveAttribute(
    'href',
    'https://api-docs.deepseek.com/updates',
  );
  await expect(page.getByLabel('Base URL')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存 Provider' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '配置 Key' })).toBeVisible();
});

test('uses a sandboxed Renderer and completes the desktop static workflow', async () => {
  const taskCreationRequests: string[] = [];
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      request.method() === 'POST' &&
      (pathname === '/api/v2/tasks' || pathname === '/api/v2/tasks/initialize')
    ) {
      taskCreationRequests.push(pathname);
    }
  });
  await page.goto('app://zhiyun/');
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
  const startUrl = page.getByLabel('URL', { exact: true });
  await expect(startUrl).toHaveValue('');
  await startUrl.fill('http://127.0.0.1:45100/products');
  await page.getByText('高级设置').click();
  await page.getByLabel(/允许 localhost/).check();
  await page.getByRole('button', { name: /分析网页/ }).click();
  await expect(page.getByRole('heading', { name: 'Rule Builder' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '织云商品 01', exact: true })).toBeVisible();
  expect(taskCreationRequests).toEqual([]);
  await page.getByRole('button', { name: '确认并保存规则' }).click();
  await expect(page.getByText('规则版本已保存')).toBeVisible();
  expect(taskCreationRequests).toEqual(['/api/v2/tasks/initialize']);
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
  await expect(page.locator('.page-heading .badge')).toHaveText('succeeded', { timeout: 40_000 });
  await expect(page.getByRole('cell', { name: '织云商品 30', exact: true })).toBeVisible();
  await expect(page.getByText('Browser', { exact: true })).toBeVisible();
});

test('captures an isolated login session and crawls an authenticated page', async () => {
  await page.goto('app://zhiyun/tasks/new');
  await page.getByLabel('任务名称').fill(`Desktop login ${Date.now()}`);
  await page.getByLabel('URL').fill('http://127.0.0.1:45100/private-products');
  await page.getByText('高级设置').click();
  await page.getByLabel(/允许 localhost/).check();
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(page).toHaveURL(/tasks\/[^/]+\/edit/);
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
  await expect(page.getByText('规则版本已保存')).toBeVisible();
  await expect(page).toHaveURL(/tasks\/[^/]+\/edit/);
  const taskId = page.url().match(/tasks\/([^/]+)\/edit/)?.[1];
  expect(taskId).toBeTruthy();
  await page.goto(`app://zhiyun/tasks/${taskId}`);
  await page.getByRole('button', { name: '运行' }).click();
  await expect(page.locator('.page-heading .badge')).toHaveText('succeeded', { timeout: 40_000 });
  await expect(page.getByRole('cell', { name: '织云商品 10', exact: true })).toBeVisible();
  await expect(page.getByText('Browser', { exact: true })).toBeVisible();
});
