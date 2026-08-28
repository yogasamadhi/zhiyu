import { expect, test, type APIRequestContext } from '@playwright/test';

let createdTaskId = '';
const apiBaseUrl = `http://127.0.0.1:${process.env.E2E_API_PORT ?? 45300}`;
const fixtureBaseUrl = `http://127.0.0.1:${process.env.E2E_FIXTURE_PORT ?? 45100}`;

async function deleteTask(request: APIRequestContext, id: string) {
  const session = await request.post(`${apiBaseUrl}/api/v1/session`, {
    data: { nonce: 'headless-development-session' },
  });
  const token = (await session.json()).token as string;
  return request.delete(`${apiBaseUrl}/api/v1/tasks/${id}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

test.afterEach(async ({ request }) => {
  if (createdTaskId) {
    await deleteTask(request, createdTaskId);
    createdTaskId = '';
  }
});

test('installs the built-in example with an active rule without running it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '添加示例任务' }).first().click();
  await expect(page).toHaveURL(/\/tasks\/[^/]+$/);
  const match = page.url().match(/tasks\/([^/]+)$/);
  expect(match?.[1]).toBeTruthy();
  createdTaskId = match![1]!;
  await expect(page.getByRole('heading', { name: '示例：豆瓣电影 Top 250' })).toBeVisible();
  await expect(page.getByText('v1', { exact: true })).toBeVisible();
  await expect(page.getByText('https://movie.douban.com/top250', { exact: true })).toBeVisible();
});

test('creates, analyzes, saves, runs and exports a static task', async ({ page, request }) => {
  await page.goto('/');
  await page
    .getByRole('link', { name: /新建任务/ })
    .first()
    .click();
  await page.getByLabel('任务名称').fill(`E2E fixture ${Date.now()}`);
  await page.getByLabel('URL').fill(`${fixtureBaseUrl}/products`);
  await page.getByRole('button', { name: /分析网页/ }).click();

  await expect(page.getByRole('heading', { name: 'Rule Builder' })).toBeVisible();
  const match = page.url().match(/tasks\/([^/]+)\/edit/);
  expect(match?.[1]).toBeTruthy();
  const taskId = match![1]!;
  createdTaskId = taskId;
  await expect(page.getByRole('cell', { name: '织云商品 01', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '测试规则' }).click();
  await expect(page.getByRole('cell', { name: '织云商品 10', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认并保存规则' }).click();
  await expect(page.getByText('规则版本已保存')).toBeVisible();

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

  const deleted = await deleteTask(request, taskId);
  expect(deleted.status()).toBe(204);
  createdTaskId = '';
});

test('uses Playwright and Load More for a dynamic task', async ({ page }) => {
  await page.goto('/tasks/new');
  await page.getByLabel('任务名称').fill(`Dynamic E2E ${Date.now()}`);
  await page.getByLabel('URL').fill(`${fixtureBaseUrl}/dynamic-products`);
  await page.getByText('高级设置').click();
  await page.getByLabel('使用浏览器').check();
  await page.getByLabel('分页方式').selectOption('loadMore');
  await page.getByLabel('分页按钮 Selector').fill('#load-more');
  await page.getByRole('button', { name: /分析网页/ }).click();

  await expect(page.getByRole('heading', { name: 'Rule Builder' })).toBeVisible();
  const match = page.url().match(/tasks\/([^/]+)\/edit/);
  expect(match?.[1]).toBeTruthy();
  createdTaskId = match![1]!;
  await expect(page.getByRole('cell', { name: '织云商品 01', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认并保存规则' }).click();
  await expect(page.getByText('规则版本已保存')).toBeVisible();

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
  await page.getByLabel('使用浏览器').check();
  await page.getByLabel('分页方式').selectOption('infinite');
  await page.getByRole('button', { name: /分析网页/ }).click();

  await expect(page.getByRole('heading', { name: 'Rule Builder' })).toBeVisible();
  const match = page.url().match(/tasks\/([^/]+)\/edit/);
  expect(match?.[1]).toBeTruthy();
  createdTaskId = match![1]!;
  await page.getByRole('button', { name: '确认并保存规则' }).click();
  await page.goto(`/tasks/${createdTaskId}`);
  await page.getByRole('button', { name: '运行' }).click();
  await expect(page.locator('.page-heading .badge')).toHaveText('succeeded', { timeout: 40_000 });
  await expect(page.getByRole('cell', { name: '织云商品 30', exact: true })).toBeVisible();
  await expect(page.getByText('30', { exact: true }).first()).toBeVisible();
});
