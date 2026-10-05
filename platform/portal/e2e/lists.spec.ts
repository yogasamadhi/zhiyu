import { expect, test, type Page } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { database } from '../../server/src/db.js';
import { assertTestDatabase } from '../../../tooling/scripts/test-environment.js';

const portalOrigin = process.env.CLOUD_PORTAL_ORIGIN!;
const adminOrigin = process.env.CLOUD_ADMIN_ORIGIN!;
const id = (i: number) => `a1000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const ids = Array.from({ length: 205 }, (_, i) => id(i + 1)).reverse();
const seed = `WITH seed AS (SELECT i,('a1000000-0000-4000-8000-'||lpad(i::text,12,'0'))::uuid AS id FROM generate_series(1,205) s(i))`;
function totp() {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', Buffer.from('48656c6c6f21deadbeef', 'hex'))
    .update(counter)
    .digest();
  const offset = digest[19]! & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
async function search(page: Page, q: string) {
  await page.getByLabel('搜索记录', { exact: true }).fill(q);
  await page.getByRole('button', { name: '查询', exact: true }).click();
}
async function collect(page: Page) {
  const seen: string[] = [];
  for (let index = 0; index < 5; index++) {
    await expect(
      page.getByText(`第 ${index + 1} 页 · ${index === 4 ? 5 : 50} 条`, { exact: true }),
    ).toBeVisible();
    const rows = page.locator('table tbody tr');
    await expect(rows).toHaveCount(index === 4 ? 5 : 50);
    seen.push(...(await rows.locator('td:first-child').allTextContents()));
    if (index < 4) await page.getByRole('button', { name: '下一页', exact: true }).click();
  }
  expect(seen).toEqual(ids);
  await expect(page.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await expect(page.getByText('第 4 页 · 50 条', { exact: true })).toBeVisible();
}

test('Portal and Admin query complete history, filter, paginate and ignore an obsolete response', async ({
  browser,
}) => {
  test.setTimeout(120000);
  if (!process.env.CLOUD_E2E_DATABASE_URL)
    throw new Error('Run cloud:e2e with its isolated database');
  const uri = assertTestDatabase(process.env.CLOUD_E2E_DATABASE_URL, 'e2e');
  const db = database(uri.toString());
  const userContext = await browser.newContext(),
    adminContext = await browser.newContext();
  const portal = await userContext.newPage(),
    admin = await adminContext.newPage();
  portal.setDefaultTimeout(10000);
  admin.setDefaultTimeout(10000);
  let releaseObsolete: () => void = () => undefined;
  try {
    const uid = crypto.randomUUID(),
      model = crypto.randomUUID(),
      price = crypto.randomUUID();
    await db.sql`INSERT INTO cloud_users(id) VALUES (${uid})`;
    await db.sql`INSERT INTO cloud_identities(user_id,target,password_hash,verified)
      SELECT ${uid},'lists-user@example.invalid',password_hash,true FROM cloud_identities WHERE target='user@zhiyun.test'`;
    await db.sql`INSERT INTO cloud_staff(email,password_hash,mfa_secret,role)
      SELECT 'lists-admin@example.invalid',password_hash,mfa_secret,'owner' FROM cloud_staff WHERE email='admin@zhiyun.test'`;
    await db.sql`INSERT INTO cloud_models(id,config,tested_at,enabled)
      VALUES (${model},${db.sql.json({ name: 'List fixture mock', adapter: 'mock', upstreamModel: 'mock', inputRate: 1, outputRate: 2, maxOutput: 1024, maxContext: 32768 })},now(),true)`;
    const snapshot = {
      name: 'Historical fixture',
      cycle: 'month',
      amountFen: 100,
      credits: 10000,
      modelIds: [model],
    };
    await db.sql`INSERT INTO cloud_prices(id,config) VALUES (${price},${db.sql.json(snapshot)})`;
    await db.sql.unsafe(
      `${seed} INSERT INTO cloud_users(id,status,created_at) SELECT id,CASE WHEN i%2=0 THEN 'disabled' ELSE 'active' END,'2020-01-01'::timestamptz FROM seed`,
      [],
    );
    await db.sql.unsafe(
      `${seed} INSERT INTO cloud_orders(id,user_id,price_id,snapshot,channel,key,status,created_at)
      SELECT id,$1::uuid,$2::uuid,$3::text::jsonb,'mock-wechat','list-'||i,CASE WHEN i%2=0 THEN 'paid' ELSE 'closed' END,'2020-01-01'::timestamptz FROM seed`,
      [uid, price, JSON.stringify(snapshot)],
    );
    await db.sql.unsafe(
      `${seed} INSERT INTO cloud_terms(id,user_id,order_id,starts_at,ends_at,anchor)
      SELECT id,$1::uuid,id,'2020-01-01'::timestamptz,'2020-02-01'::timestamptz,'2020-01-01'::timestamptz FROM seed`,
      [uid],
    );
    await db.sql.unsafe(
      `${seed} INSERT INTO cloud_credit_periods(id,user_id,term_id,starts_at,ends_at,allowance,state)
      SELECT id,$1::uuid,id,'2020-01-01'::timestamptz,'2020-02-01'::timestamptz,10000,'expired' FROM seed`,
      [uid],
    );
    await db.sql.unsafe(
      `${seed} INSERT INTO cloud_ai_requests(id,user_id,turn_id,fingerprint,model_id,rate_snapshot,period_id,reserved,status,input_tokens,output_tokens,cost,created_at,updated_at)
      SELECT id,$1::uuid,'list-turn-'||i,'list-fixture',$2::uuid,'{}'::jsonb,id,0,'settled',10,5,1,'2020-01-01'::timestamptz,'2020-01-01'::timestamptz FROM seed`,
      [uid, model],
    );
    await db.sql.unsafe(
      `${seed} INSERT INTO cloud_credit_ledger(id,user_id,period_id,kind,amount,key,request_id,created_at)
      SELECT id,$1::uuid,id,'grant',1,'list-ledger-'||i,id,'2020-01-01'::timestamptz FROM seed`,
      [uid],
    );
    await db.sql.unsafe(
      `${seed} INSERT INTO cloud_devices(id,user_id,name,created_at,revoked_at)
      SELECT id,$1::uuid,'Historical device '||i,'2020-01-01'::timestamptz,'2020-02-01'::timestamptz FROM seed`,
      [uid],
    );
    await db.sql.unsafe(
      `${seed} INSERT INTO cloud_sessions(id,user_id,digest,csrf,expires_at,created_at,revoked_at)
      SELECT id,$1::uuid,'list-session-'||i,'fixture-only','2020-02-01'::timestamptz,'2020-01-01'::timestamptz,'2020-02-01'::timestamptz FROM seed`,
      [uid],
    );
    await portal.goto(`${portalOrigin}/login`);
    await portal.getByLabel('邮箱或中国大陆手机号').fill('lists-user@example.invalid');
    await portal.getByLabel('密码（邮箱注册、找回密码至少 12 位）').fill('Test-Only-Password-2026');
    await portal.getByRole('button', { name: '邮箱密码登录' }).click();
    await expect(portal.getByRole('heading', { name: '已登录' })).toBeVisible();
    await portal.goto(`${portalOrigin}/account/orders`);
    await search(portal, 'a1000000');
    await collect(portal);
    await search(portal, id(1));
    await expect(portal.getByRole('cell', { name: id(1), exact: true })).toBeVisible();
    await expect(portal.locator('table tbody tr')).toHaveCount(1);
    await portal.getByRole('button', { name: '清除筛选', exact: true }).click();
    await portal.getByLabel('状态', { exact: true }).selectOption('paid');
    await portal.getByRole('button', { name: '查询', exact: true }).click();
    await expect(portal.locator('table tbody tr')).toHaveCount(50);
    await expect(portal.getByRole('cell', { name: 'paid', exact: true })).toHaveCount(50);
    for (const width of [390, 1440]) {
      await portal.setViewportSize({ width, height: 900 });
      expect(
        await portal.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
    // Hold a real server response until a later filter has rendered. The old request is aborted.
    let obsoleteFetched = false,
      obsoleteDone = false;
    const gate = new Promise<void>((resolve) => {
      releaseObsolete = resolve;
    });
    await portal.route('**/api/cloud/v1/me/orders?*', async (route) => {
      if (new URL(route.request().url()).searchParams.get('q') !== id(1)) return route.continue();
      try {
        const response = await route.fetch();
        obsoleteFetched = true;
        await gate;
        await route.fulfill({ response });
      } catch {
        /* Expected if the obsolete browser request has already been aborted. */
      } finally {
        obsoleteDone = true;
      }
    });
    await portal.getByLabel('状态', { exact: true }).selectOption('');
    await search(portal, id(1));
    await expect.poll(() => obsoleteFetched, { timeout: 10000 }).toBe(true);
    await search(portal, id(2));
    await expect(portal.getByRole('cell', { name: id(2), exact: true })).toBeVisible();
    releaseObsolete();
    await expect.poll(() => obsoleteDone, { timeout: 10000 }).toBe(true);
    await expect(portal.getByRole('cell', { name: id(1), exact: true })).toHaveCount(0);
    await portal.unroute('**/api/cloud/v1/me/orders?*');
    await portal.goto(`${portalOrigin}/account/credits`);
    await search(portal, id(1));
    await expect(portal.getByRole('cell', { name: 'grant', exact: true })).toBeVisible();
    await portal.getByRole('button', { name: '查看 AI 请求用量', exact: true }).click();
    await expect(portal.getByRole('cell', { name: 'list-turn-205', exact: true })).toBeVisible();
    await search(portal, id(1));
    await expect(portal.getByRole('cell', { name: 'list-turn-1', exact: true })).toBeVisible();
    await portal.getByRole('button', { name: '查看积分流水', exact: true }).click();
    await expect(portal.getByText('第 1 页 · 50 条', { exact: true })).toBeVisible();
    await portal.goto(`${portalOrigin}/account/devices`);
    await search(portal, id(1));
    await expect(
      portal.getByRole('heading', { name: 'Historical device 1', exact: true }),
    ).toBeVisible();
    await expect(portal.getByText('第 1 页 · 1 条', { exact: true })).toBeVisible();
    await portal.goto(`${portalOrigin}/account/security`);
    await search(portal, id(1));
    await expect(portal.getByText('第 1 页 · 1 条', { exact: true })).toBeVisible();
    await expect(
      portal.getByText('2020-01-01T00:00:00.000Z · 已撤销', { exact: true }),
    ).toBeVisible();

    await admin.goto(adminOrigin);
    await admin.getByLabel('管理员邮箱').fill('lists-admin@example.invalid');
    await admin.getByLabel('密码', { exact: true }).fill('Test-Only-Password-2026');
    await admin.getByLabel('TOTP 动态验证码').fill(totp());
    await admin.getByRole('button', { name: '安全登录' }).click();
    await expect(admin.getByRole('heading', { name: '运营概览' })).toBeVisible();
    await admin.getByRole('link', { name: '用户账户', exact: true }).click();
    await search(admin, 'a1000000');
    await collect(admin);
    await search(admin, id(1));
    await expect(admin.getByRole('cell', { name: id(1), exact: true })).toBeVisible();
    await admin.getByRole('link', { name: '订单与支付', exact: true }).click();
    await admin.getByLabel('用户编号', { exact: true }).fill(uid);
    await admin.getByRole('button', { name: '查询', exact: true }).click();
    await collect(admin);
    for (const width of [390, 1440]) {
      await admin.setViewportSize({ width, height: 900 });
      expect(
        await admin.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    }
  } finally {
    releaseObsolete?.();
    await userContext.close();
    await adminContext.close();
    await db.close();
  }
});
