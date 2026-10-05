import { beforeAll, afterAll, beforeEach, test, expect } from 'bun:test';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { database } from '../src/db.js';
import { calendarMonth } from '../src/billing.js';
import { encrypt, secret, hash, decrypt } from '../src/security.js';
import * as OTPAuth from 'otpauth';
import type { Principal } from '../src/auth.js';
import { assertTestDatabase } from '../../../tooling/scripts/test-environment.js';
let time = new Date('2028-01-31T04:00:00.000Z');
const config = readConfig({
  ...process.env,
  NODE_ENV: 'test',
  CLOUD_DATABASE_URL:
    process.env.CLOUD_TEST_DATABASE_URL ??
    'postgres://zhiyun:zhiyun-local@127.0.0.1:55432/zhiyun_cloud_test',
});
assertTestDatabase(config.CLOUD_DATABASE_URL);
const cloud = createApp({ config, clock: { now: () => new Date(time) } });
const { db, auth, billing, ai, worker } = cloud;
let uid: string, other: string, model: string, price: string, principal: Principal;
beforeAll(async () => {
  const uri = new URL(config.CLOUD_DATABASE_URL),
    admin = database(new URL('/postgres', uri).toString());
  try {
    await admin.sql.unsafe(`create database "${uri.pathname.slice(1).replaceAll('"', '""')}"`);
  } catch (error) {
    if ((error as { code: string }).code !== '42P04') throw error;
  } finally {
    await admin.close();
  }
  await migrate(config.CLOUD_DATABASE_URL);
});
beforeEach(async () => {
  time = new Date('2028-01-31T04:00:00.000Z');
  await db.sql`truncate cloud_users,cloud_staff,cloud_models,cloud_prices,cloud_jobs,cloud_audit,cloud_rate_limits,cloud_refresh_history restart identity cascade`;
  uid = (await db.sql`insert into cloud_users default values returning id`)[0]!.id;
  other = (await db.sql`insert into cloud_users default values returning id`)[0]!.id;
  const device = crypto.randomUUID();
  await db.sql`insert into cloud_devices(id,user_id,name) values (${device},${uid},'test desktop')`;
  const session = await db.sql.begin((tx) => auth.issue(tx, uid, null, device));
  principal = await auth.session(session.access);
  model = (
    await db.sql`insert into cloud_models(config,tested_at,enabled) values (${db.sql.json({ name: 'Mock AI', adapter: 'mock', upstreamModel: 'mock', inputRate: 1, outputRate: 2, maxOutput: 1024, maxContext: 32768 })},${time},true) returning id`
  )[0]!.id;
  price = (
    await db.sql`insert into cloud_prices(config,published) values (${db.sql.json({ name: 'Test monthly', cycle: 'month', amountFen: 100, credits: 10000, modelIds: [model] })},true) returning id`
  )[0]!.id;
});
afterAll(async () => {
  await cloud.close();
});
async function purchase(channel: 'mock-wechat' | 'mock-alipay' = 'mock-wechat', priceId = price) {
  const order = await billing.order(uid, priceId, channel, crypto.randomUUID());
  await billing.simulate(uid, order.id, 'success');
  await worker.tick();
  return order.id as string;
}
async function call(
  path: string,
  body?: unknown,
  token?: string,
  origin = config.CLOUD_PORTAL_ORIGIN,
  csrf?: string,
) {
  return cloud.app.request(`/api/cloud/v1${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      origin,
      'content-type': 'application/json',
      ...(token ? { cookie: `zy_user=${token}` } : {}),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
test('calendar anchors preserve month end, leap year and annual anniversary', () => {
  expect(calendarMonth(time, 1).toISOString()).toBe('2028-02-29T04:00:00.000Z');
  expect(calendarMonth(time, 2).toISOString()).toBe('2028-03-31T04:00:00.000Z');
  expect(calendarMonth(new Date('2028-02-29T04:00Z'), 12).toISOString()).toBe(
    '2029-02-28T04:00:00.000Z',
  );
});
for (const channel of ['mock-wechat', 'mock-alipay'] as const) {
  test(`${channel}: duplicate + reordered notifications fulfill once`, async () => {
    const order = await billing.order(uid, price, channel, 'same-order-key');
    expect((await billing.order(uid, price, channel, 'same-order-key')).id).toBe(order.id);
    await billing.simulate(uid, order.id, 'out-of-order');
    await worker.tick();
    await billing.event(order.id, 'success', `${order.id}:duplicate-fact`);
    await billing.event(order.id, 'failure', `${order.id}:late-failure`);
    expect((await db.sql`select status from cloud_orders where id=${order.id}`)[0]!.status).toBe(
      'paid',
    );
    expect((await db.sql`select * from cloud_terms`).length).toBe(1);
    expect((await db.sql`select * from cloud_credit_ledger where kind='grant'`).length).toBe(1);
  });
  test(`${channel}: recurring recovery, unknown query and cancellation`, async () => {
    const agreement = await billing.agreement(uid, price, channel);
    await billing.agreementEvent(uid, agreement.id, 'sign');
    await worker.tick();
    await worker.tick();
    expect((await db.sql`select * from cloud_terms`).length).toBe(1);
    await expect(
      billing.agreement(uid, price, channel === 'mock-wechat' ? 'mock-alipay' : 'mock-wechat'),
    ).rejects.toThrow('END_OLD_AGREEMENT_FIRST');
    time = new Date('2028-02-29T04:00Z');
    await db.sql`update cloud_agreements set scenario='unknown' where id=${agreement.id}`;
    await worker.tick();
    expect((await db.sql`select * from cloud_orders`).length).toBe(2);
    time = new Date(time.getTime() + 61000);
    await worker.tick();
    await worker.tick();
    expect((await db.sql`select * from cloud_terms`).length).toBe(2);
    await billing.agreementEvent(uid, agreement.id, 'cancel');
    const count = (await db.sql`select * from cloud_orders`).length;
    time = new Date('2028-04-01T04:00Z');
    await worker.tick();
    expect((await db.sql`select * from cloud_orders`).length).toBe(count);
    expect((await db.sql`select * from cloud_terms where revoked_at is not null`).length).toBe(0);
  });
}
test('yearly subscription grants monthly, no rollover or early-renewal refill', async () => {
  const year = (
    await db.sql`insert into cloud_prices(config,published) values (${db.sql.json({ name: 'Year', cycle: 'year', amountFen: 1000, credits: 10000, modelIds: [model] })},true) returning id`
  )[0]!.id;
  await purchase('mock-alipay', year);
  expect((await db.sql`select * from cloud_credit_periods`).length).toBe(12);
  expect((await db.sql`select * from cloud_credit_ledger where kind='grant'`).length).toBe(1);
  const first = (await db.sql`select * from cloud_credit_periods where state='active'`)[0]!;
  await billing.adjust(
    null as unknown as string,
    first.id,
    -10000,
    'drain-month-credits',
    'test consumption equivalent',
  );
  await purchase();
  expect(
    (await db.sql`select available from cloud_credit_periods where id=${first.id}`)[0]!.available,
  ).toBe(0);
  time = new Date('2028-02-29T04:00Z');
  await worker.tick();
  expect(
    (await db.sql`select available from cloud_credit_periods where state='active'`)[0]!.available,
  ).toBe(10000);
  expect((await db.sql`select * from cloud_credit_ledger where kind='grant'`).length).toBe(2);
});
test('concurrent reservations cannot overspend; repeated settlement is idempotent', async () => {
  await purchase();
  const period = (await db.sql`select * from cloud_credit_periods where state='active'`)[0]!;
  await db.sql`update cloud_credit_periods set available=3 where id=${period.id}`;
  const input = {
    model,
    messages: [{ role: 'user' as const, content: 'hello' }],
    max_tokens: 1024,
  };
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const results = await Promise.allSettled(
    ids.map((id) => ai.reserve(principal, id, 'one-turn', input)),
  );
  expect(results.filter((r) => r.status === 'fulfilled').length).toBe(1);
  const id = ids[results.findIndex((r) => r.status === 'fulfilled')]!;
  await ai.settle(id, { prompt_tokens: 100, completion_tokens: 10 });
  await ai.settle(id, { prompt_tokens: 100, completion_tokens: 10 });
  expect((await db.sql`select * from cloud_credit_ledger where kind='settle'`).length).toBe(1);
  expect(
    (await db.sql`select reserved from cloud_credit_periods where id=${period.id}`)[0]!.reserved,
  ).toBe(0);
  await expect(ai.reserve(principal, id, 'one-turn', input)).rejects.toThrow('REQUEST_SETTLED');
});
test('hosted streaming uses trusted usage and groups assistant turns', async () => {
  await purchase();
  const id = crypto.randomUUID();
  const response = await ai.call(
    principal,
    id,
    'assistant-turn-1',
    { model, messages: [{ role: 'user', content: 'hello' }], stream: true },
    new AbortController().signal,
  );
  expect(await response.text()).toContain('[DONE]');
  const [r] = await db.sql`select * from cloud_ai_requests where id=${id}`;
  expect(r!.status).toBe('settled');
  expect(r!.input_tokens).toBeGreaterThan(0);
  expect(r!.turn_id).toBe('assistant-turn-1');
  expect(r).not.toHaveProperty('messages');
});
test('monthly grant and hosted reservation complete without foreign-key lock deadlock', async () => {
  const year = (
    await db.sql`insert into cloud_prices(config,published) values (${db.sql.json({ name: 'Year', cycle: 'year', amountFen: 1000, credits: 10000, modelIds: [model] })},true) returning id`
  )[0]!.id;
  await purchase('mock-wechat', year);
  time = calendarMonth(time, 1);
  let reservation: Promise<PromiseSettledResult<unknown>[]> | undefined;
  await db.sql.begin(async (tx) => {
    await tx`set local statement_timeout='3s'`;
    await tx`select id from cloud_credit_periods where user_id=${uid} for update`;
    reservation = Promise.allSettled([
      ai.reserve(principal, crypto.randomUUID(), 'monthly-boundary', {
        model,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ]);
    // Hold the worker's period lock until the API is waiting on it, then write a ledger row.
    // Its user foreign key must remain compatible with the API's user serialization lock.
    let waiting = false;
    for (let i = 0; i < 100 && !waiting; i++) {
      // Use an autocommit observer so PostgreSQL refreshes its activity snapshot each time.
      const [row] =
        await db.sql`select exists(select 1 from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock' and query like 'select p.* from cloud_credit_periods p join cloud_terms t%') as waiting`;
      waiting = row!.waiting;
      if (!waiting) await tx`select pg_sleep(0.01)`;
    }
    expect(waiting).toBe(true);
    await billing.syncCredits(tx, uid);
  });
  expect((await reservation)![0]!.status).toBe('fulfilled');
  expect((await db.sql`select * from cloud_credit_ledger where kind='grant'`).length).toBe(2);
});
test('uncertain usage holds credits across worker recovery, manual compensation does not retry', async () => {
  await purchase();
  const id = crypto.randomUUID();
  await ai.reserve(principal, id, 'uncertain-turn', {
    model,
    messages: [{ role: 'user', content: 'hello' }],
  });
  await db.sql`update cloud_ai_requests set status='calling' where id=${id}`;
  time = new Date(time.getTime() + 180000);
  await worker.tick();
  expect((await db.sql`select status from cloud_ai_requests where id=${id}`)[0]!.status).toBe(
    'review',
  );
  await ai.settle(id, null, true);
  expect((await db.sql`select status from cloud_ai_requests where id=${id}`)[0]!.status).toBe(
    'released',
  );
});
test('refund waits for confirmation, revokes unspent credits, preserves settled history', async () => {
  const order = await purchase();
  const id = crypto.randomUUID();
  await ai.reserve(principal, id, 'refund-turn', {
    model,
    messages: [{ role: 'user', content: 'hello' }],
  });
  await billing.refund(uid, order, 'User requests test refund');
  expect((await db.sql`select status from cloud_orders where id=${order}`)[0]!.status).toBe('paid');
  await billing.confirmRefund(order);
  await billing.confirmRefund(order);
  await ai.settle(id, { prompt_tokens: 12, completion_tokens: 20 });
  const [period] = await db.sql`select * from cloud_credit_periods`;
  expect(period!.available).toBe(0);
  expect(period!.reserved).toBe(0);
  expect(period!.state).toBe('revoked');
  expect((await db.sql`select * from cloud_credit_ledger where kind='settle'`).length).toBe(1);
});
test('OTP attempts persist, cannot replay, identities bind only after target verification', async () => {
  const challenge = await auth.challenge('13800138000', 'login');
  const inbox = (
    await db.sql`select code from cloud_test_inbox where challenge_id=${challenge.challengeId}`
  )[0]!;
  await expect(auth.verify(challenge.challengeId, '000000', undefined)).rejects.toThrow();
  expect(
    (await db.sql`select attempts from cloud_challenges where id=${challenge.challengeId}`)[0]!
      .attempts,
  ).toBe(1);
  const login = await auth.verify(challenge.challengeId, inbox.code, undefined);
  expect('access' in login).toBe(true);
  await expect(auth.verify(challenge.challengeId, inbox.code, undefined)).rejects.toThrow();
  const bind = await auth.challenge('13800138000', 'bind', principal);
  const b = (
    await db.sql`select code from cloud_test_inbox where challenge_id=${bind.challengeId}`
  )[0]!;
  await expect(auth.verify(bind.challengeId, b.code, undefined, principal)).rejects.toThrow(
    'IDENTITY_ALREADY_BOUND',
  );
});
test('password reset revokes sessions; password login requires verified email', async () => {
  const c = await auth.challenge('person@example.com', 'verify');
  const code = (
    await db.sql`select code from cloud_test_inbox where challenge_id=${c.challengeId}`
  )[0]!.code;
  await auth.verify(c.challengeId, code, 'long-test-password');
  const s = await auth.login('person@example.com', 'long-test-password');
  const reset = await auth.challenge('person@example.com', 'reset');
  await auth.verify(
    reset.challengeId,
    (await db.sql`select code from cloud_test_inbox where challenge_id=${reset.challengeId}`)[0]!
      .code,
    'new-test-password-long',
  );
  await expect(auth.session(s.access)).rejects.toThrow('UNAUTHENTICATED');
  await expect(auth.login('person@example.com', 'long-test-password')).rejects.toThrow(
    'INVALID_CREDENTIALS',
  );
});
test('CSRF, ownership and user/staff identity boundaries', async () => {
  const session = await db.sql.begin((tx) => auth.issue(tx, uid, null));
  expect(
    (
      await call(
        '/billing/orders',
        { priceId: price, channel: 'mock-wechat', key: 'csrf-test-key' },
        session.access,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await call(
        '/billing/orders',
        { priceId: price, channel: 'mock-wechat', key: 'csrf-test-key' },
        session.access,
        'https://evil.test',
        session.csrf,
      )
    ).status,
  ).toBe(403);
  const order = await billing.order(other, price, 'mock-alipay', 'other-user-order');
  expect(
    (
      await call(
        '/simulation/payment',
        { orderId: order.id, scenario: 'success' },
        session.access,
        config.CLOUD_PORTAL_ORIGIN,
        session.csrf,
      )
    ).status,
  ).toBe(404);
  const me = await call('/me', undefined, session.access);
  expect(me.headers.get('cache-control')).toContain('no-store');
  expect((await me.json()).data.id).toBe(uid);
  expect((await call('/admin/me', undefined, session.access)).status).toBe(401);
});
test('staff TOTP mandatory, replay rejected, encrypted seed reversible', async () => {
  const seed = new OTPAuth.Secret({ size: 20 }),
    passwordHash = await Bun.password.hash('staff-test-password');
  await db.sql`insert into cloud_staff(email,password_hash,mfa_secret,role) values ('staff@example.com',${passwordHash},${encrypt(seed.base32, config.CLOUD_MFA_KEY)},'owner')`;
  expect(decrypt(encrypt(seed.base32, config.CLOUD_MFA_KEY), config.CLOUD_MFA_KEY)).toBe(
    seed.base32,
  );
  await expect(auth.login('staff@example.com', 'staff-test-password', true)).rejects.toThrow(
    'MFA_REQUIRED',
  );
  const token = new OTPAuth.TOTP({ secret: seed }).generate({ timestamp: time.getTime() });
  const s = await auth.login('staff@example.com', 'staff-test-password', true, token);
  expect((await auth.session(s.access)).role).toBe('owner');
  await expect(auth.login('staff@example.com', 'staff-test-password', true, token)).rejects.toThrow(
    'MFA_REPLAY',
  );
});
test('PKCE S256, two devices, refresh reuse revokes family, immediate unbind', async () => {
  const verifier = secret(),
    challenge = Buffer.from(hash(verifier), 'hex').toString('base64url'),
    device = crypto.randomUUID(),
    redirectUri = 'http://127.0.0.1:54321/callback';
  const code = await auth.authorize(uid, {
    challenge,
    redirectUri,
    deviceId: device,
    deviceName: 'second',
  });
  await expect(auth.exchange(code.code, secret(), redirectUri)).rejects.toThrow(
    'INVALID_AUTHORIZATION',
  );
  const first = await auth.exchange(code.code, verifier, redirectUri);
  const rotated = await auth.refresh(first.refresh!);
  await expect(auth.refresh(first.refresh!)).rejects.toThrow('INVALID_REFRESH');
  await expect(auth.session(rotated.access)).rejects.toThrow('UNAUTHENTICATED');
  const third = await auth.authorize(uid, {
    challenge,
    redirectUri,
    deviceId: crypto.randomUUID(),
    deviceName: 'third',
  });
  await expect(auth.exchange(third.code, verifier, redirectUri)).rejects.toThrow('DEVICE_LIMIT');
  await db.sql`update cloud_devices set revoked_at=${time} where id=${principal.deviceId}`;
  await purchase();
  await expect(
    ai.reserve(principal, crypto.randomUUID(), 'revoked-device', {
      model,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  ).rejects.toThrow('DEVICE_REVOKED');
});
test('production refuses simulation, test model cannot reach production', () => {
  expect(() => readConfig({ NODE_ENV: 'production' })).toThrow('Production refuses');
});

test('Redis outage falls back to PostgreSQL and does not affect accounting', async () => {
  const offline = createApp({
    config: { ...config, CLOUD_REDIS_URL: 'redis://127.0.0.1:1' },
    clock: { now: () => time },
  });
  try {
    const health = await offline.app.request('/api/cloud/v1/health');
    expect((await health.json()).data.cache).toBe('degraded');
    await purchase();
    expect(
      (await db.sql`select available from cloud_credit_periods where state='active'`)[0]!.available,
    ).toBe(10000);
    expect((await db.sql`select * from cloud_rate_limits`).length).toBeGreaterThan(0);
  } finally {
    await offline.close();
  }
});
test('expired reservation releases no spendable credits; invalid usage remains in review', async () => {
  await purchase();
  const id = crypto.randomUUID();
  await ai.reserve(principal, id, 'expired-turn', {
    model,
    messages: [{ role: 'user', content: 'hello' }],
  });
  time = calendarMonth(time, 1);
  await worker.tick();
  await ai.settle(id, { prompt_tokens: 100000000, completion_tokens: 1 });
  expect((await db.sql`select status from cloud_ai_requests where id=${id}`)[0]!.status).toBe(
    'review',
  );
  await ai.settle(id, { prompt_tokens: 100, completion_tokens: 1 });
  expect((await db.sql`select available from cloud_credit_periods`)[0]!.available).toBe(0);
});
test('unpublished or disabled-model catalog cannot be purchased', async () => {
  await db.sql`update cloud_prices set published=false where id=${price}`;
  await expect(billing.order(uid, price, 'mock-wechat', 'unpublished-key')).rejects.toThrow(
    'PRICE_NOT_AVAILABLE',
  );
  await db.sql`update cloud_prices set published=true where id=${price}`;
  await db.sql`update cloud_models set enabled=false where id=${model}`;
  await expect(billing.order(uid, price, 'mock-wechat', 'disabled-model-key')).rejects.toThrow(
    'CATALOG_INCOMPLETE',
  );
});
test('a closed order with a later confirmed provider success is fulfilled once', async () => {
  const order = await billing.order(uid, price, 'mock-alipay', 'close-race-order');
  time = new Date(time.getTime() + 1900000);
  await worker.tick();
  expect((await db.sql`select status from cloud_orders where id=${order.id}`)[0]!.status).toBe(
    'closed',
  );
  await billing.simulate(uid, order.id, 'duplicate');
  await worker.tick();
  expect((await db.sql`select * from cloud_terms where order_id=${order.id}`).length).toBe(1);
});

test('tool-call stream passes through, each round settles once, duplicate does not call upstream', async () => {
  const { AiGateway } = await import('../src/ai.js');
  await purchase();
  let calls = 0;
  const fixture = new AiGateway(billing, async () => {
    calls++;
    return new Response(
      'data: ' +
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'local-tool',
                    type: 'function',
                    function: { name: 'local_read', arguments: '{}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 15 },
        }) +
        '\n\ndata: [DONE]\n\n',
    );
  });
  const input = {
    model,
    messages: [{ role: 'user' as const, content: 'read local data' }],
    stream: true,
  };
  const id = crypto.randomUUID();
  expect(
    await (
      await fixture.call(principal, id, 'tool-round', input, new AbortController().signal)
    ).text(),
  ).toContain('local_read');
  await expect(
    fixture.call(principal, id, 'tool-round', input, new AbortController().signal),
  ).rejects.toThrow('REQUEST_SETTLED');
  expect(calls).toBe(1);
  await (
    await fixture.call(
      principal,
      crypto.randomUUID(),
      'tool-round',
      { ...input, messages: [{ role: 'tool', content: 'local result' }] },
      new AbortController().signal,
    )
  ).text();
  expect(calls).toBe(2);
  expect(
    (await db.sql`select * from cloud_ai_requests where turn_id='tool-round' and status='settled'`)
      .length,
  ).toBe(2);
});
test('missing usage, upstream disconnect and client cancellation never blindly retry', async () => {
  const { AiGateway } = await import('../src/ai.js');
  await purchase();
  let calls = 0;
  const fixture = new AiGateway(billing, async () => {
    calls++;
    return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: [DONE]\n\n');
  });
  const id = crypto.randomUUID(),
    input = { model, messages: [{ role: 'user' as const, content: 'hello' }], stream: true };
  await (
    await fixture.call(principal, id, 'missing-usage', input, new AbortController().signal)
  ).text();
  expect((await db.sql`select status from cloud_ai_requests where id=${id}`)[0]!.status).toBe(
    'review',
  );
  const abort = new AbortController();
  abort.abort();
  const canceled = crypto.randomUUID();
  await expect(fixture.call(principal, canceled, 'cancel', input, abort.signal)).rejects.toThrow(
    'REQUEST_CANCELED',
  );
  expect(calls).toBe(1);
  expect((await db.sql`select status from cloud_ai_requests where id=${canceled}`)[0]!.status).toBe(
    'released',
  );
  const failed = new AiGateway(billing, async () => {
    throw new Error('upstream timeout');
  });
  const failureId = crypto.randomUUID();
  await expect(
    failed.call(principal, failureId, 'failed', input, new AbortController().signal),
  ).rejects.toThrow();
  expect(
    (await db.sql`select status from cloud_ai_requests where id=${failureId}`)[0]!.status,
  ).toBe('review');
});
test('durable processing resumes from a second application instance', async () => {
  const order = await billing.order(uid, price, 'mock-wechat', 'restart-payment-key');
  await billing.simulate(uid, order.id, 'delay');
  time = new Date(time.getTime() + 61000);
  const restarted = createApp({ config, clock: { now: () => time } });
  try {
    await restarted.worker.tick();
    await restarted.worker.tick();
    expect((await db.sql`select * from cloud_terms where order_id=${order.id}`).length).toBe(1);
  } finally {
    await restarted.close();
  }
});

test('verified PKCE reauthorizes an unbound device without reviving its old sessions', async () => {
  const old = await db.sql.begin((tx) => auth.issue(tx, uid, null, principal.deviceId));
  await db.sql`update cloud_devices set revoked_at=${time} where id=${principal.deviceId}`;
  const verifier = secret(),
    redirectUri = 'http://127.0.0.1:54321/callback';
  const code = await auth.authorize(uid, {
    challenge: Buffer.from(hash(verifier), 'hex').toString('base64url'),
    redirectUri,
    deviceId: principal.deviceId!,
    deviceName: 'reauthorized',
  });
  const fresh = await auth.exchange(code.code, verifier, redirectUri);
  expect((await auth.session(fresh.access)).deviceId).toBe(principal.deviceId);
  await expect(auth.session(old.access)).rejects.toThrow('UNAUTHENTICATED');
});
