import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
const portalOrigin = process.env.CLOUD_PORTAL_ORIGIN ?? 'http://localhost:3130';
const adminOrigin = process.env.CLOUD_ADMIN_ORIGIN ?? 'http://localhost:3131';
const totp = () => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', Buffer.from('48656c6c6f21deadbeef', 'hex'))
    .update(bytes)
    .digest();
  const offset = digest[19]! & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
};
test('Admin publication → portal simulated purchase → subscription, credits and cancellation', async ({
  browser,
}) => {
  const adminContext = await browser.newContext(),
    userContext = await browser.newContext();
  const admin = await adminContext.newPage(),
    portal = await userContext.newPage();
  await admin.goto(adminOrigin);
  await admin.getByLabel('管理员邮箱').fill('admin@zhiyun.test');
  await admin.getByLabel('密码', { exact: true }).fill('Test-Only-Password-2026');
  await admin.getByLabel('TOTP 动态验证码').fill(totp());
  await admin.getByRole('button', { name: '安全登录' }).click();
  await expect(admin.getByRole('heading', { name: '运营概览' })).toBeVisible();
  await admin.getByRole('link', { name: '托管模型与费率' }).click();
  const modelForm = admin
    .locator('section')
    .filter({ has: admin.getByRole('heading', { name: '新增模型与费率版本' }) });
  await modelForm.getByLabel('展示名称').fill('E2E 托管模型');
  await modelForm.getByRole('button', { name: '提交操作' }).click();
  await expect(admin.getByRole('status')).toContainText('操作成功');
  const models = await (
    await adminContext.request.get(`${adminOrigin}/api/cloud/v1/admin/models`)
  ).json();
  const modelId = models.data.items[0].id;
  const testModel = admin
    .locator('section')
    .filter({ has: admin.getByRole('heading', { name: '测试并启用模型版本' }) });
  await testModel.getByLabel('记录编号').fill(modelId);
  await testModel.getByRole('button', { name: '提交操作' }).click();
  await expect(admin.getByRole('cell', { name: 'true', exact: true })).toBeVisible();
  await admin.getByRole('link', { name: '商品与价格' }).click();
  const priceForm = admin
    .locator('section')
    .filter({ has: admin.getByRole('heading', { name: '新增不可变价格版本' }) });
  await priceForm.getByLabel('商品名称').fill('E2E 月付测试');
  await priceForm.getByLabel('模拟售价（分）').fill('100');
  await priceForm.getByLabel('每月积分额度').fill('10000');
  await priceForm.getByLabel('已测试模型编号（逗号分隔）').fill(modelId);
  await priceForm.getByRole('button', { name: '提交操作' }).click();
  await expect(admin.getByRole('status')).toContainText('操作成功');
  const prices = await (
    await adminContext.request.get(`${adminOrigin}/api/cloud/v1/admin/prices`)
  ).json();
  const priceId = prices.data.items[0].id;
  const publish = admin
    .locator('section')
    .filter({ has: admin.getByRole('heading', { name: '发布 / 下架测试商品' }) });
  await publish.getByLabel('记录编号').fill(priceId);
  await publish.getByRole('button', { name: '提交操作' }).click();
  await expect(admin.getByRole('cell', { name: 'true', exact: true })).toBeVisible();
  await portal.goto('/login');
  await portal.getByLabel('邮箱或中国大陆手机号').fill('user@zhiyun.test');
  await portal.getByLabel('密码（邮箱注册、找回密码至少 12 位）').fill('Test-Only-Password-2026');
  await portal.getByRole('button', { name: '邮箱密码登录' }).click();
  await expect(portal.getByRole('heading', { name: '已登录' })).toBeVisible();
  await portal.goto('/pricing');
  await expect(
    portal.getByText('模拟支付，不会实际扣款。测试积分仅可用于测试模型池。'),
  ).toBeVisible();
  await portal.getByRole('button', { name: '模拟购买' }).click();
  await expect(portal.getByRole('heading', { name: '模拟收银台' })).toBeVisible();
  await portal.getByRole('button', { name: '重复通知' }).click();
  await expect(portal.getByRole('status').first()).toContainText('重复通知已提交');
  await portal.goto('/account');
  await expect(portal.getByText('10,000', { exact: true })).toBeVisible();
  await portal.goto('/account/orders');
  await expect(portal.getByRole('cell', { name: 'paid', exact: true })).toHaveCount(1);
  await portal.goto('/pricing');
  await portal.getByRole('button', { name: '模拟签约自动续费' }).click();
  await expect(portal.getByRole('status').first()).toContainText('已模拟签约');
  await portal.goto('/account/subscription');
  await portal.getByRole('button', { name: '取消自动续费' }).click();
  await expect(portal.getByRole('status').first()).toContainText('已停止未来');
  await portal.goto('/account/security');
  await portal.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(portal.getByText('请先登录，查看托管账户与订阅。')).toBeVisible();
  // A second independent browser cannot retrieve the first user's account or staff data.
  const anonymous = await browser.newContext();
  expect((await anonymous.request.get(`${portalOrigin}/api/cloud/v1/me`)).status()).toBe(401);
  expect((await anonymous.request.get(`${portalOrigin}/api/cloud/v1/admin/me`)).status()).toBe(404);
  await anonymous.close();
  await adminContext.close();
  await userContext.close();
});
test('responsive public pages, clear free boundary, no horizontal overflow', async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ['/', '/pricing', '/download', '/docs', '/login']) {
      await page.goto(path);
      await expect(page.locator('h1,h2').first()).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
  }
  await page.goto('/');
  await expect(page.getByText('本地工具免费 · 自带 Key 免费 · 托管 AI 按需订阅')).toBeVisible();
  await page.screenshot({
    path: new URL('../../../.artifacts/cloud/portal-home.png', import.meta.url).pathname,
    fullPage: true,
  });
});
