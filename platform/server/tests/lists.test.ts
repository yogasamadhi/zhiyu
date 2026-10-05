import { afterAll, beforeAll, expect, test } from 'bun:test';
import { cloudListOptions, type CloudListPath, type CloudListPage } from '@zhiyun/cloud-contracts';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { database } from '../src/db.js';
import { migrate } from '../src/migrate.js';
import { assertTestDatabase, testEnvironment } from '../../../tooling/scripts/test-environment.js';

// This suite creates its own database inside the wrapper's disposable PostgreSQL instance.
if (!process.env.CLOUD_TEST_DATABASE_URL)
  throw new Error('Run cloud:test to provide an isolated PostgreSQL instance');
const uri = assertTestDatabase(process.env.CLOUD_TEST_DATABASE_URL);
const databaseName = `zhiyun_lists_${crypto.randomUUID().replaceAll('-', '')}_test`;
uri.pathname = `/${databaseName}`;
assertTestDatabase(uri.toString());
const redis = new URL(process.env.CLOUD_REDIS_URL ?? 'redis://127.0.0.1:1');
if (!['localhost', '127.0.0.1', '[::1]'].includes(redis.hostname))
  throw new Error('List tests require a local Redis instance');
const config = readConfig({
  ...testEnvironment(process.env),
  CLOUD_DATABASE_URL: uri.toString(),
  CLOUD_REDIS_URL: redis.toString(),
});
const timestamp = '2028-01-31T04:00:00.000000Z';
const cloud = createApp({ config, clock: { now: () => new Date(timestamp) } });
const { db, auth } = cloud;
const uid = crypto.randomUUID(),
  other = crypto.randomUUID();
const roles = ['owner', 'support', 'finance', 'operator'] as const;
type Role = (typeof roles)[number];
type Row = Record<string, unknown>;
const tokens = {} as Record<Role | 'user' | 'other' | 'secondOwner', string>;
const fixtureId = (i: number) =>
  `${i <= 205 ? 'b' : 'c'}0000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const seed = `WITH seed AS (
  SELECT i,(CASE WHEN i<=205 THEN 'b0000000-0000-4000-8000-' ELSE 'c0000000-0000-4000-8000-' END||lpad(i::text,12,'0'))::uuid AS id
  FROM generate_series(1,206) s(i)
)`;
const userExpression = 'CASE WHEN i=206 THEN $2::uuid ELSE $3::uuid END';
const fixtures: Record<
  CloudListPath,
  { table: string; sort: string; status: string; selected: number[] }
> = {
  '/me/orders': { table: 'cloud_orders', sort: 'created_at', status: 'paid', selected: even() },
  '/me/credits': {
    table: 'cloud_credit_ledger',
    sort: 'created_at',
    status: 'adjust',
    selected: even(),
  },
  '/me/periods': {
    table: 'cloud_credit_periods',
    sort: 'starts_at',
    status: 'expired',
    selected: even(),
  },
  '/me/devices': {
    table: 'cloud_devices',
    sort: 'created_at',
    status: 'revoked',
    selected: range().slice(1),
  },
  '/me/sessions': {
    table: 'cloud_sessions',
    sort: 'created_at',
    status: 'revoked',
    selected: even(),
  },
  '/me/usage': {
    table: 'cloud_ai_requests',
    sort: 'created_at',
    status: 'released',
    selected: even(),
  },
  '/admin/users': {
    table: 'cloud_users',
    sort: 'created_at',
    status: 'disabled',
    selected: even(),
  },
  '/admin/prices': {
    table: 'cloud_prices',
    sort: 'created_at',
    status: 'published',
    selected: even(),
  },
  '/admin/models': {
    table: 'cloud_models',
    sort: 'created_at',
    status: 'enabled',
    selected: even(),
  },
  '/admin/subscriptions': {
    table: 'cloud_terms',
    sort: 'starts_at',
    status: 'revoked',
    selected: even(),
  },
  '/admin/orders': { table: 'cloud_orders', sort: 'created_at', status: 'paid', selected: even() },
  '/admin/refunds': {
    table: 'cloud_refunds',
    sort: 'created_at',
    status: 'confirmed',
    selected: even(),
  },
  '/admin/credits': {
    table: 'cloud_credit_ledger',
    sort: 'created_at',
    status: 'adjust',
    selected: even(),
  },
  '/admin/periods': {
    table: 'cloud_credit_periods',
    sort: 'starts_at',
    status: 'expired',
    selected: even(),
  },
  '/admin/devices': {
    table: 'cloud_devices',
    sort: 'created_at',
    status: 'revoked',
    selected: range().slice(1),
  },
  '/admin/staff': {
    table: 'cloud_staff',
    sort: 'email',
    status: 'support',
    selected: range().filter((i) => i % 4 === 1),
  },
  '/admin/jobs': { table: 'cloud_jobs', sort: 'created_at', status: 'failed', selected: even() },
  '/admin/audit': { table: 'cloud_audit', sort: 'created_at', status: '', selected: [] },
  '/admin/requests': {
    table: 'cloud_ai_requests',
    sort: 'created_at',
    status: 'released',
    selected: even(),
  },
  '/admin/agreements': {
    table: 'cloud_agreements',
    sort: 'created_at',
    status: 'canceled',
    selected: range().slice(1),
  },
  '/admin/inbox': { table: 'cloud_test_inbox', sort: 'expires_at', status: '', selected: [] },
};
const permissions: Record<string, readonly Role[]> = {
  users: ['owner', 'support'],
  prices: ['owner', 'finance', 'operator'],
  models: ['owner', 'operator'],
  subscriptions: ['owner', 'finance', 'support'],
  orders: ['owner', 'finance', 'support'],
  refunds: ['owner', 'finance'],
  credits: ['owner', 'finance', 'support'],
  periods: ['owner', 'finance'],
  devices: ['owner', 'support'],
  staff: ['owner'],
  jobs: ['owner', 'operator'],
  audit: roles,
  requests: ['owner', 'operator', 'finance'],
  agreements: ['owner', 'finance', 'support'],
  inbox: ['owner', 'support'],
};
function range() {
  return Array.from({ length: 205 }, (_, i) => i + 1);
}
function even() {
  return range().filter((i) => i % 2 === 0);
}
let created = false;
beforeAll(async () => {
  const admin = database(new URL('/postgres', uri).toString());
  try {
    await admin.sql.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;
  } finally {
    await admin.close();
  }
  await migrate(uri.toString());
  await db.sql`INSERT INTO cloud_users(id) VALUES (${uid}),(${other})`;
  await db.sql.unsafe(
    `${seed} INSERT INTO cloud_users(id,status,created_at)
    SELECT id,CASE WHEN i%2=0 THEN 'disabled' ELSE 'active' END,$1::timestamptz FROM seed`,
    [timestamp],
  );
  await db.sql.unsafe(
    `${seed} INSERT INTO cloud_models(id,config,tested_at,enabled,created_at)
    SELECT id,'{"name":"Fixture mock","adapter":"mock","upstreamModel":"mock","inputRate":1,"outputRate":2,"maxOutput":1024,"maxContext":32768}'::jsonb,$1::timestamptz,i%2=0,$1::timestamptz FROM seed`,
    [timestamp],
  );
  await db.sql.unsafe(
    `${seed} INSERT INTO cloud_prices(id,config,published,created_at)
    SELECT id,jsonb_build_object('name','Fixture price','cycle','month','amountFen',100,'credits',10000,'modelIds',jsonb_build_array(id)),i%2=0,$1::timestamptz FROM seed`,
    [timestamp],
  );
  await db.sql.unsafe(
    `${seed} INSERT INTO cloud_devices(id,user_id,name,revoked_at,created_at)
    SELECT id,${userExpression},'Fixture device',CASE WHEN i=1 THEN NULL ELSE $1::timestamptz END,$1::timestamptz FROM seed`,
    [timestamp, other, uid],
  );
  await db.sql.unsafe(
    `${seed} INSERT INTO cloud_orders(id,user_id,price_id,snapshot,channel,key,status,created_at)
    SELECT s.id,${userExpression},s.id,p.config,'mock-wechat','fixture-'||i,CASE WHEN i%2=0 THEN 'paid' ELSE 'closed' END,$1::timestamptz FROM seed s JOIN cloud_prices p ON p.id=s.id`,
    [timestamp, other, uid],
  );
  await db.sql.unsafe(
    `${seed} INSERT INTO cloud_terms(id,user_id,order_id,starts_at,ends_at,anchor,revoked_at)
    SELECT id,${userExpression},id,$1::timestamptz,$1::timestamptz+interval '1 month',$1::timestamptz,CASE WHEN i%2=0 THEN $1::timestamptz ELSE NULL END FROM seed`,
    [timestamp, other, uid],
  );
  await db.sql.unsafe(
    `${seed} INSERT INTO cloud_credit_periods(id,user_id,term_id,starts_at,ends_at,allowance,state)
    SELECT id,${userExpression},id,$1::timestamptz,$1::timestamptz+interval '1 month',10000,CASE WHEN i%2=0 THEN 'expired' ELSE 'revoked' END FROM seed`,
    [timestamp, other, uid],
  );
  await db.sql.unsafe(
    `${seed} INSERT INTO cloud_ai_requests(id,user_id,turn_id,fingerprint,model_id,rate_snapshot,period_id,reserved,status,input_tokens,output_tokens,cost,created_at,updated_at)
    SELECT id,${userExpression},'fixture-turn-'||i,'fixture-fingerprint',id,'{}'::jsonb,id,0,CASE WHEN i%2=0 THEN 'released' ELSE 'settled' END,10,5,1,$1::timestamptz,$1::timestamptz FROM seed`,
    [timestamp, other, uid],
  );
  await db.sql.unsafe(
    `${seed} INSERT INTO cloud_credit_ledger(id,user_id,period_id,kind,amount,key,request_id,created_at)
    SELECT id,${userExpression},id,CASE WHEN i%2=0 THEN 'adjust' ELSE 'grant' END,1,'fixture-ledger-'||i,id,$1::timestamptz FROM seed`,
    [timestamp, other, uid],
  );
  await db.sql.unsafe(
    `${seed} INSERT INTO cloud_refunds(id,order_id,status,reason,created_at)
    SELECT id,id,CASE WHEN i%2=0 THEN 'confirmed' ELSE 'pending' END,'Fixture refund',$1::timestamptz FROM seed`,
    [timestamp],
  );
  await db.sql.unsafe(
    `${seed} INSERT INTO cloud_agreements(id,user_id,price_id,channel,status,created_at)
    SELECT id,${userExpression},id,'mock-wechat',CASE WHEN i=1 THEN 'active' ELSE 'canceled' END,$1::timestamptz FROM seed`,
    [timestamp, other, uid],
  );
  await db.sql.unsafe(
    `${seed} INSERT INTO cloud_sessions(id,user_id,digest,csrf,expires_at,revoked_at,created_at)
    SELECT id,${userExpression},'hidden-session-digest-'||i,'hidden-session-csrf',$1::timestamptz+interval '1 day',CASE WHEN i%2=0 THEN $1::timestamptz ELSE NULL END,$1::timestamptz FROM seed`,
    [timestamp, other, uid],
  );
  await db.sql.unsafe(
    `${seed} INSERT INTO cloud_staff(id,email,password_hash,mfa_secret,role)
    SELECT id,'fixture-'||lpad(i::text,3,'0')||'@example.invalid','hidden-staff-password','hidden-staff-mfa',CASE i%4 WHEN 0 THEN 'owner' WHEN 1 THEN 'support' WHEN 2 THEN 'finance' ELSE 'operator' END FROM seed`,
    [],
  );
  await db.sql.unsafe(
    `${seed} INSERT INTO cloud_jobs(id,key,kind,payload,due_at,status,created_at)
    SELECT id,'fixture-job-'||i,'fixture','{}'::jsonb,$1::timestamptz,CASE WHEN i%2=0 THEN 'failed' ELSE 'done' END,$1::timestamptz FROM seed`,
    [timestamp],
  );
  await db.sql.unsafe(
    `${seed} INSERT INTO cloud_audit(id,action,detail,created_at)
    SELECT id,'fixture','{}'::jsonb,$1::timestamptz FROM seed`,
    [timestamp],
  );
  await db.sql.unsafe(
    `${seed} INSERT INTO cloud_challenges(id,target,purpose,digest,expires_at,created_at)
    SELECT id,'fixture@example.invalid','verify','fixture-digest',$1::timestamptz,$1::timestamptz FROM seed`,
    [timestamp],
  );
  await db.sql.unsafe(
    `${seed} INSERT INTO cloud_test_inbox(id,challenge_id,target,code,expires_at)
    SELECT id,id,'fixture@example.invalid','123456',$1::timestamptz FROM seed`,
    [timestamp],
  );
  tokens.user = (await db.sql.begin((tx) => auth.issue(tx, uid, null))).access;
  tokens.other = (await db.sql.begin((tx) => auth.issue(tx, other, null))).access;
  for (const role of [...roles, 'secondOwner'] as const) {
    const staffId = crypto.randomUUID();
    await db.sql`INSERT INTO cloud_staff(id,email,password_hash,mfa_secret,role)
      VALUES (${staffId},${`${role}@example.invalid`},'fixture-hash','fixture-mfa',${role === 'secondOwner' ? 'owner' : role})`;
    tokens[role] = (await db.sql.begin((tx) => auth.issue(tx, null, staffId))).access;
  }
}, 20000);
afterAll(async () => {
  await cloud.close();
  if (!created) return;
  const admin = database(new URL('/postgres', uri).toString());
  try {
    await admin.sql.unsafe(`DROP DATABASE "${databaseName}"`);
  } finally {
    await admin.close();
  }
});

function get(path: string, query: Record<string, string | number> = {}, token?: string) {
  const params = new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)]),
  );
  return cloud.app.request(`/api/cloud/v1${path}${params.size ? `?${params}` : ''}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}
const actor = (path: CloudListPath) => (path.startsWith('/me/') ? tokens.user : tokens.owner);
async function page(
  path: CloudListPath,
  query: Record<string, string | number>,
  token = actor(path),
) {
  const result = await get(path, query, token);
  const body = (await result.json()) as { data: CloudListPage<Row>; error?: { code: string } };
  expect(result.status, `${path}: ${body.error?.code ?? 'OK'}`).toBe(200);
  return body.data;
}
async function all(
  path: CloudListPath,
  query: Record<string, string | number> = { q: 'b0000000' },
) {
  const ids: string[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await page(path, { ...query, limit: 17, ...(cursor ? { cursor } : {}) });
    expect(result.items.length).toBeLessThanOrEqual(17);
    ids.push(...result.items.map((row) => String(row.id)));
    cursor = result.nextCursor;
    if (cursor) {
      expect(cursors.has(cursor)).toBe(false);
      cursors.add(cursor);
    }
  } while (cursor);
  return ids;
}

for (const [pathValue, fixture] of Object.entries(fixtures)) {
  const path = pathValue as CloudListPath;
  test(`${path}: all 205 records, tied ordering, filters and invalid input`, async () => {
    expect(await all(path)).toEqual(range().reverse().map(fixtureId));
    expect((await page(path, { q: 'B0000000', limit: 100 })).items).toHaveLength(100);
    expect((await page(path, { q: fixtureId(1) })).items.map((row) => row.id)).toEqual([
      fixtureId(1),
    ]);
    for (const q of ['%', '_not-present', "' OR 1=1 --", '\\'])
      expect((await page(path, { q })).items).toHaveLength(0);
    if (fixture.status)
      expect(await all(path, { q: 'b0000000', status: fixture.status })).toEqual(
        fixture.selected.toReversed().map(fixtureId),
      );
    if (fixture.sort !== 'email') {
      expect(await all(path, { q: 'b0000000', from: timestamp, to: timestamp })).toEqual(
        range().reverse().map(fixtureId),
      );
      expect(
        (await page(path, { q: 'b0000000', to: '2028-01-31T03:59:59.999999Z' })).items,
      ).toHaveLength(0);
    }
    for (const query of [
      { limit: '0' },
      { limit: '101' },
      { limit: 'NaN' },
      { limit: '1.5' },
      { cursor: 'invalid' },
      { cursor: '!bad' },
      { cursor: 'a'.repeat(4097) },
      { sort: 'id' },
      { q: 'x'.repeat(161) },
      { status: 'not-a-status' },
      { from: 'invalid-date', to: 'invalid-date' },
      { from: '2028-01-31T04:00:00.000002Z', to: '2028-01-31T04:00:00.000001Z' },
      { from: '2028-01-31T04:00:00.0000001Z' },
    ])
      expect((await get(path, query, actor(path))).status).toBe(400);
    expect((await get(`${path}?limit=1&limit=2`, {}, actor(path))).status).toBe(400);
    const first = await page(path, { q: 'b0000000', limit: 17 });
    expect(first.nextCursor).not.toBeNull();
    expect(
      (await get(path, { q: fixtureId(1), cursor: first.nextCursor! }, actor(path))).status,
    ).toBe(400);
    expect(
      (
        await get(
          path,
          { q: 'b0000000', status: fixture.status || 'unsupported', cursor: first.nextCursor! },
          actor(path),
        )
      ).status,
    ).toBe(400);
    // Page size may change without changing the query or its ordering boundary.
    const next = await page(path, { q: 'b0000000', limit: 100, cursor: first.nextCursor! });
    expect(next.items.map((row) => row.id)).toEqual(
      range().reverse().slice(17, 117).map(fixtureId),
    );
    const alternate = path.startsWith('/me/') ? tokens.other : tokens.secondOwner;
    expect((await get(path, { q: 'b0000000', cursor: first.nextCursor! }, alternate)).status).toBe(
      400,
    );
    expect((await get(path)).status).toBe(401);
    expect((await get(path, {}, path.startsWith('/me/') ? tokens.owner : tokens.user)).status).toBe(
      403,
    );
    const anotherPath: CloudListPath = path === '/me/orders' ? '/me/credits' : '/me/orders';
    expect(
      (await get(anotherPath, { q: 'b0000000', cursor: first.nextCursor! }, tokens.user)).status,
    ).toBe(400);
  });
  if (path.startsWith('/me/')) {
    test(`${path}: user ownership cannot be changed with query parameters`, async () => {
      expect((await page(path, { q: fixtureId(206) })).items).toHaveLength(0);
      expect(
        (await page(path, { q: fixtureId(206) }, tokens.other)).items.map((row) => row.id),
      ).toEqual([fixtureId(206)]);
      expect((await get(path, { userId: other }, tokens.user)).status).toBe(400);
    });
  } else {
    test(`${path}: staff roles and supported user filtering`, async () => {
      for (const role of roles)
        expect((await get(path, { q: fixtureId(1) }, tokens[role])).status).toBe(
          permissions[path.slice('/admin/'.length)]!.includes(role) ? 200 : 403,
        );
      if (cloudListOptions[path].userFilter) {
        expect(await all(path, { q: 'b0000000', userId: uid })).toEqual(
          range().reverse().map(fixtureId),
        );
        expect((await page(path, { userId: other })).items.map((row) => row.id)).toEqual([
          fixtureId(206),
        ]);
        expect((await get(path, { userId: 'not-uuid' }, tokens.owner)).status).toBe(400);
      } else expect((await get(path, { userId: other }, tokens.owner)).status).toBe(400);
    });
  }
}
test('session and staff secrets are absent from both response and search', async () => {
  for (const path of ['/me/sessions', '/admin/staff'] as const) {
    const result = await page(path, { q: fixtureId(1) });
    const serialized = JSON.stringify(result);
    for (const hidden of ['digest', 'csrf', 'password_hash', 'mfa_secret', '__cursorSort'])
      expect(serialized).not.toContain(hidden);
    expect((await page(path, { q: 'hidden-' })).items).toHaveLength(0);
  }
});
test('search treats percent and underscore as literal text', async () => {
  const literal = crypto.randomUUID(),
    wildcard = crypto.randomUUID();
  await db.sql`INSERT INTO cloud_audit(id,action) VALUES
    (${literal},'literal%wild_card'),(${wildcard},'literalXwildYcard')`;
  expect(
    (await page('/admin/audit', { q: 'literal%wild_card' })).items.map((row) => row.id),
  ).toEqual([literal]);
  expect(
    (await page('/admin/audit', { q: 'literalXwildYcard' })).items.map((row) => row.id),
  ).toEqual([wildcard]);
});
test('POST model and price creation keep singular responses beside GET pagination', async () => {
  for (const [path, body] of [
    [
      '/admin/models',
      {
        name: 'Created mock',
        adapter: 'mock',
        upstreamModel: 'mock',
        inputRate: 1,
        outputRate: 2,
        maxOutput: 1024,
        maxContext: 32768,
      },
    ],
    [
      '/admin/prices',
      {
        name: 'Created price',
        cycle: 'month',
        amountFen: 100,
        credits: 10000,
        modelIds: [fixtureId(2)],
      },
    ],
  ] as const) {
    const response = await cloud.app.request(`/api/cloud/v1${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.owner}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as { data: { id: string } };
    expect(result.data.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await page(path, { q: result.data.id })).items.map((row) => row.id)).toEqual([
      result.data.id,
    ]);
  }
});
test('timestamp cursors preserve PostgreSQL microseconds across pages', async () => {
  const newer = crypto.randomUUID(),
    older = crypto.randomUUID();
  await db.sql`INSERT INTO cloud_users(id,status,created_at) VALUES
    (${newer},'active','2028-02-01T00:00:00.000002Z'),(${older},'active','2028-02-01T00:00:00.000001Z')`;
  const query = {
    from: '2028-02-01T00:00:00.000001Z',
    to: '2028-02-01T00:00:00.000002Z',
    limit: 1,
  };
  const first = await page('/admin/users', query);
  expect(first.items.map((row) => row.id)).toEqual([newer]);
  const second = await page('/admin/users', { ...query, cursor: first.nextCursor! });
  expect(second.items.map((row) => row.id)).toEqual([older]);
  expect(second.nextCursor).toBeNull();
  expect(
    (await page('/admin/users', { ...query, from: query.to })).items.map((row) => row.id),
  ).toEqual([newer]);
  expect(
    (await page('/admin/users', { ...query, to: query.from })).items.map((row) => row.id),
  ).toEqual([older]);
});
