import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { database } from '../../server/src/db.js';
import { testEnvironment } from '../../../tooling/scripts/test-environment.js';
const portalOrigin = process.env.CLOUD_PORTAL_ORIGIN ?? 'http://localhost:3130';
const apiOrigin = process.env.CLOUD_SERVER_URL ?? 'http://localhost:3230';
test('packaged Electron PKCE login, simulated purchase, hosted assistant, BYOK and unbinding', async ({
  browser,
}) => {
  test.skip(
    process.env.CLOUD_DESKTOP_E2E !== 'true' || process.platform !== 'darwin',
    'Run CLOUD_DESKTOP_E2E=true bun run cloud:e2e after desktop:package on macOS',
  );
  test.setTimeout(120000);
  const root = resolve(import.meta.dirname, '../../..'),
    profile = await mkdtemp(join(tmpdir(), 'zhiyun-cloud-packaged-'));
  const app = await electron.launch({
    executablePath: join(
      root,
      'desktop/out',
      `ZhiYun-darwin-${process.arch}`,
      'ZhiYun.app/Contents/MacOS/ZhiYun',
    ),
    args: [`--user-data-dir=${profile}`],
    env: {
      ...testEnvironment(process.env),
      ZHIYUN_CLOUD_API_URL: apiOrigin,
      ZHIYUN_CLOUD_PORTAL_URL: portalOrigin,
    },
  });
  const context = await browser.newContext(),
    portal = await context.newPage();
  const db = database(
    process.env.CLOUD_E2E_DATABASE_URL ??
      'postgres://zhiyun:zhiyun-local@127.0.0.1:55432/zhiyun_cloud_e2e_test',
  );
  try {
    expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
    await app.evaluate(({ shell }) => {
      shell.openExternal = async (url: string) => {
        (globalThis as unknown as { cloudAuthUrl: string }).cloudAuthUrl = url;
      };
    });
    const desktop = await app.firstWindow();
    await desktop.waitForLoadState('domcontentloaded');
    await desktop.goto('app://zhiyun/settings?section=ai');
    await desktop.getByRole('button', { name: '登录云账户', exact: true }).click();
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as unknown as { cloudAuthUrl?: string }).cloudAuthUrl ?? ''),
      )
      .toContain('/desktop/authorize');
    const url = await app.evaluate(
      () => (globalThis as unknown as { cloudAuthUrl: string }).cloudAuthUrl,
    );
    await portal.goto(url);
    await portal.getByRole('button', { name: '先登录账户' }).click();
    await portal.getByLabel('邮箱或中国大陆手机号').fill('user@zhiyun.test');
    await portal.getByLabel('密码（邮箱注册、找回密码至少 12 位）').fill('Test-Only-Password-2026');
    await portal.getByRole('button', { name: '邮箱密码登录' }).click();
    await portal.getByRole('link', { name: '继续授权桌面端' }).click();
    await portal.getByRole('button', { name: '授权此设备' }).click();
    await expect(desktop.getByRole('button', { name: '退出云账户' })).toBeVisible();
    // Prepare a published test catalog if this test is run independently of the portal publication test.
    if (!(await db.sql`select 1 from cloud_prices where published=true`).length) {
      const [m] =
        await db.sql`insert into cloud_models(config,enabled,tested_at) values (${db.sql.json({ name: 'Packaged mock', adapter: 'mock', upstreamModel: 'mock', inputRate: 1, outputRate: 2, maxOutput: 1024, maxContext: 32768 })},true,now()) returning id`;
      await db.sql`insert into cloud_prices(config,published) values (${db.sql.json({ name: 'Packaged monthly', cycle: 'month', amountFen: 100, credits: 10000, modelIds: [m!.id] })},true)`;
    }
    await portal.goto(`${portalOrigin}/pricing`);
    await portal.getByRole('button', { name: '模拟购买' }).first().click();
    await portal.getByRole('button', { name: '模拟成功', exact: true }).click();
    await expect(portal.getByText('支付成功', { exact: true })).toBeVisible();
    await desktop.getByRole('button', { name: '刷新账户' }).click();
    const modelSelect = desktop.getByLabel('托管模型', { exact: true });
    await expect(modelSelect.locator('option')).not.toHaveCount(1);
    const model = await modelSelect.locator('option').nth(1).getAttribute('value');
    await modelSelect.selectOption(model!);
    await desktop.getByRole('button', { name: '使用托管 AI' }).click();
    await expect(desktop.getByText('平台托管 AI', { exact: true })).toBeVisible();
    await desktop.goto('app://zhiyun/');
    await desktop.getByRole('button', { name: '用样例带我体验', exact: true }).click();
    await desktop.getByLabel('发送给织云助手').fill('请简要介绍织云。');
    await desktop.getByRole('button', { name: '发送', exact: true }).click();
    await expect(
      desktop
        .getByText('这是织云托管 AI 的模拟响应。工具会继续在桌面端执行。', { exact: false })
        .last(),
    ).toBeVisible({ timeout: 30000 });
    expect(
      (await db.sql`select * from cloud_ai_requests where status='settled'`).length,
    ).toBeGreaterThan(0);
    const encrypted = await readFile(join(profile, 'cloud-session.enc'));
    expect(encrypted.toString()).not.toContain('refresh');
    expect(
      await desktop.evaluate(() =>
        Object.keys((window as unknown as { zhiyunCloud: object }).zhiyunCloud),
      ),
    ).not.toContain('token');
    await desktop.goto('app://zhiyun/settings?section=ai');
    await desktop.getByRole('button', { name: '手动切换为自带 Key' }).click();
    await expect(desktop.getByText('自带 API Key（免费）', { exact: true })).toBeVisible();
    await portal.goto(`${portalOrigin}/account/devices`);
    await portal.getByRole('button', { name: '解绑设备', exact: true }).first().click();
    await expect(portal.getByText('设备已解绑', { exact: true })).toBeVisible();
    await desktop.getByRole('button', { name: '退出云账户', exact: true }).click();
    await expect(desktop.getByRole('button', { name: '登录云账户', exact: true })).toBeVisible();
    await desktop.goto('app://zhiyun/tasks');
    await expect(desktop.getByRole('heading', { name: '采集任务', exact: true })).toBeVisible();
  } finally {
    await app.close();
    await context.close();
    await db.close();
    await rm(profile, { recursive: true, force: true });
  }
});
