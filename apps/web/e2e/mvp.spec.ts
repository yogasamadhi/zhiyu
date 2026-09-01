import { expect, test, type Page } from '@playwright/test';

let createdTaskId = '';
let csrfToken = '';
const apiBaseUrl = `http://127.0.0.1:${process.env.E2E_API_PORT ?? 45300}`;
const fixtureBaseUrl = `http://127.0.0.1:${process.env.E2E_FIXTURE_PORT ?? 45100}`;
const bootstrapToken =
  process.env.E2E_BOOTSTRAP_TOKEN ?? 'zhiyun-e2e-bootstrap-token-with-at-least-32-bytes';
const adminEmail = 'e2e-admin@zhiyun.local';
const adminPassword = 'e2e-admin-password-2026';

async function deleteTask(page: Page, id: string) {
  const task = await page.request.get(`${apiBaseUrl}/api/v2/tasks/${id}`);
  return page.request.delete(`${apiBaseUrl}/api/v2/tasks/${id}`, {
    headers: {
      'x-csrf-token': csrfToken,
      'idempotency-key': crypto.randomUUID(),
      'if-match': task.headers().etag ?? '"0"',
    },
  });
}

test.beforeAll(async ({ request }) => {
  const status = await request.get(`${apiBaseUrl}/api/v2/auth/status`);
  expect(status.ok()).toBeTruthy();
  if (!((await status.json()) as { initialized: boolean }).initialized) {
    const setup = await request.post(`${apiBaseUrl}/api/v2/auth/setup`, {
      data: {
        bootstrapToken,
        email: adminEmail,
        displayName: 'E2E Admin',
        password: adminPassword,
      },
    });
    expect(setup.status()).toBe(201);
  }
});

test.beforeEach(async ({ page }) => {
  const login = await page.request.post(`${apiBaseUrl}/api/v2/auth/login`, {
    data: { email: adminEmail, password: adminPassword },
  });
  expect(login.ok()).toBeTruthy();
  csrfToken = ((await login.json()) as { csrfToken: string }).csrfToken;
});

test.afterEach(async ({ page }) => {
  if (createdTaskId) {
    await deleteTask(page, createdTaskId);
    createdTaskId = '';
  }
});

test('instantiates an official template with an active rule without running it', async ({
  page,
}) => {
  await page.goto('/tasks/new');
  await page.getByRole('button', { name: /普通列表页/ }).click();
  await expect(page.getByText(/已加载官方模板“普通列表页”/)).toBeVisible();
  await page.getByLabel('任务名称').fill(`Template E2E ${Date.now()}`);
  await page.getByLabel('URL', { exact: true }).fill(`${fixtureBaseUrl}/products`);
  await page.getByLabel('记录容器选择器').fill('.product-card');
  await page.getByLabel('标题选择器').fill('.product-title');
  await page.getByLabel('链接选择器').fill('a.product-link');
  await page.getByText('高级设置').click();
  await page.getByLabel(/允许 localhost/).check();
  await page.getByRole('button', { name: '测试规则' }).click();
  await expect(page.getByRole('cell', { name: '织云商品 01', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认并保存规则' }).click();
  await expect(page.getByText('规则版本已保存')).toBeVisible();
  await expect(page).toHaveURL(/\/tasks\/[^/]+\/edit$/);
  const match = page.url().match(/tasks\/([^/]+)\/edit$/);
  expect(match?.[1]).toBeTruthy();
  createdTaskId = match![1]!;
  await page.goto(`/tasks/${createdTaskId}`);
  await expect(page.getByText(/来源：template · 活动规则 v1/)).toBeVisible();
  await expect(page.getByText(`${fixtureBaseUrl}/products`, { exact: true })).toBeVisible();
});

test('creates, analyzes, saves, runs and exports a static task', async ({ page }) => {
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
  await page.goto('/');
  await page
    .getByRole('link', { name: /新建任务/ })
    .first()
    .click();
  await page.getByLabel('任务名称').fill(`E2E fixture ${Date.now()}`);
  await page.getByLabel('URL').fill(`${fixtureBaseUrl}/products`);
  await page.getByText('高级设置').click();
  await page.getByLabel(/允许 localhost/).check();
  await page.getByRole('radio', { name: '每 N 分钟' }).click();
  await expect(page.getByText('未来 5 次执行')).toBeVisible();
  await expect(page.locator('.schedule-preview li')).toHaveCount(5);
  await page.getByRole('button', { name: /分析网页/ }).click();

  await expect(page.getByRole('heading', { name: 'Rule Builder' })).toBeVisible();
  expect(taskCreationRequests).toEqual([]);
  await expect(page).toHaveURL(/\/tasks\/new(?:\?.*)?$/);
  await expect(page.getByRole('cell', { name: '织云商品 01', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '测试规则' }).click();
  await expect(page.getByRole('cell', { name: '织云商品 10', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认并保存规则' }).click();
  await expect(page.getByText('规则版本已保存')).toBeVisible();
  expect(taskCreationRequests).toEqual(['/api/v2/tasks/initialize']);
  const match = page.url().match(/tasks\/([^/]+)\/edit/);
  expect(match?.[1]).toBeTruthy();
  const taskId = match![1]!;
  createdTaskId = taskId;

  await page.goto(`/tasks/${taskId}`);
  await page.getByRole('button', { name: '运行' }).click();
  await expect(page.locator('.page-heading .badge')).toHaveText('succeeded', { timeout: 30_000 });
  await expect(page.getByRole('cell', { name: '织云商品 01', exact: true })).toBeVisible();
  const csvDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV' }).click();
  expect((await csvDownload).suggestedFilename()).toMatch(/\.csv$/);
  const xlsxDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 Excel' }).click();
  expect((await xlsxDownload).suggestedFilename()).toMatch(/\.xlsx$/);

  const deleted = await deleteTask(page, taskId);
  expect(deleted.status()).toBe(204);
  createdTaskId = '';
});

test('uses Playwright and Load More for a dynamic task', async ({ page }) => {
  await page.goto('/tasks/new');
  await page.getByLabel('任务名称').fill(`Dynamic E2E ${Date.now()}`);
  await page.getByLabel('URL').fill(`${fixtureBaseUrl}/dynamic-products`);
  await page.getByText('高级设置').click();
  await page.getByLabel(/允许 localhost/).check();
  await page.getByLabel('使用浏览器').check();
  await page.getByLabel('分页方式').selectOption('loadMore');
  await page.getByLabel('分页按钮 Selector').fill('#load-more');
  await page.getByRole('button', { name: /分析网页/ }).click();

  await expect(page.getByRole('heading', { name: 'Rule Builder' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '织云商品 01', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认并保存规则' }).click();
  await expect(page.getByText('规则版本已保存')).toBeVisible();
  const match = page.url().match(/tasks\/([^/]+)\/edit/);
  expect(match?.[1]).toBeTruthy();
  createdTaskId = match![1]!;

  await page.goto(`/tasks/${createdTaskId}`);
  await page.getByRole('button', { name: '运行' }).click();
  await expect(page.locator('.page-heading .badge')).toHaveText('succeeded', { timeout: 35_000 });
  await expect(page.getByRole('cell', { name: '织云商品 30', exact: true })).toBeVisible();
  await expect(page.getByText('Browser', { exact: true })).toBeVisible();
});

test('stops Infinite Scroll after the dynamic fixture is exhausted', async ({ page }) => {
  await page.goto('/tasks/new');
  await page.getByLabel('任务名称').fill(`Infinite E2E ${Date.now()}`);
  await page.getByLabel('URL').fill(`${fixtureBaseUrl}/dynamic-products`);
  await page.getByText('高级设置').click();
  await page.getByLabel(/允许 localhost/).check();
  await page.getByLabel('使用浏览器').check();
  await page.getByLabel('分页方式').selectOption('infinite');
  await page.getByRole('button', { name: /分析网页/ }).click();

  await expect(page.getByRole('heading', { name: 'Rule Builder' })).toBeVisible();
  await page.getByRole('button', { name: '确认并保存规则' }).click();
  await expect(page.getByText('规则版本已保存')).toBeVisible();
  await expect(page).toHaveURL(/\/tasks\/[^/]+\/edit$/);
  const match = page.url().match(/tasks\/([^/]+)\/edit/);
  expect(match?.[1]).toBeTruthy();
  createdTaskId = match![1]!;
  await page.goto(`/tasks/${createdTaskId}`);
  await page.getByRole('button', { name: '运行' }).click();
  await expect(page.locator('.page-heading .badge')).toHaveText('succeeded', { timeout: 40_000 });
  await expect(page.getByRole('cell', { name: '织云商品 30', exact: true })).toBeVisible();
  await expect(page.getByText('30', { exact: true }).first()).toBeVisible();
});
