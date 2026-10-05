import { eq } from 'drizzle-orm';
import { cloudPrices } from './schema.js';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { RedisClient } from 'bun';
import {
  responseSchemas,
  cloudListResponseSchemas,
  cloudPrefix as base,
  challengeInput,
  verifyInput,
  loginInput,
  orderInput,
  modelInput,
  priceInput,
  chatInput,
  id,
  key,
  simulationSchema,
  channelSchema,
  password,
  email,
  cloudListQuerySchema,
  type CloudListQuery,
} from '@zhiyun/cloud-contracts';
import { database } from './db.js';
import {
  readConfig,
  systemClock,
  DomainError,
  requireValue,
  type Config,
  type Clock,
} from './config.js';
import { Auth, type Principal } from './auth.js';
import { Billing } from './billing.js';
import { AiGateway } from './ai.js';
import { Worker } from './jobs.js';
import { encrypt, hash } from './security.js';
import * as OTPAuth from 'otpauth';
import { cloudLists, queryCloudList } from './lists.js';

type Env = { Variables: { principal: Principal } };
const empty = z.object({});
const errorSchema = z.object({ error: z.object({ code: z.string() }) });
export function createApp(options: { config?: Config; clock?: Clock } = {}) {
  const config = options.config ?? readConfig(),
    clock = options.clock ?? systemClock;
  const db = database(config.CLOUD_DATABASE_URL),
    auth = new Auth(db, config, clock),
    billing = new Billing(db, config, clock),
    ai = new AiGateway(billing),
    worker = new Worker(billing);
  const app = new OpenAPIHono<Env>({
    defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: { code: 'INVALID_INPUT' } }, 400);
    },
  });
  const redis = new RedisClient(config.CLOUD_REDIS_URL, {
    connectionTimeout: 500,
    enableOfflineQueue: false,
  });
  redis.onconnect = () => undefined;
  redis.onclose = () => undefined;
  const principal = (c: Context<Env>) => c.get('principal');
  const user = (c: Context<Env>) => requireValue(principal(c)?.userId, 'USER_REQUIRED');
  const cookieName = (staff: boolean) => (staff ? 'zy_staff' : 'zy_user');
  async function rate(keyValue: string, maximum: number) {
    const slot = Math.floor(clock.now().getTime() / 60000),
      rateKey = `rate:${hash(keyValue)}:${slot}`;
    let n: number;
    try {
      n = Number(await redis.send('INCR', [rateKey]));
      if (n === 1) await redis.send('EXPIRE', [rateKey, '120']);
    } catch {
      const [r] =
        await db.sql`insert into cloud_rate_limits(key,count,expires_at) values (${rateKey},1,${new Date(clock.now().getTime() + 120000)}) on conflict(key) do update set count=cloud_rate_limits.count+1 returning count`;
      n = r!.count as number;
    }
    if (n > maximum) throw new DomainError('RATE_LIMIT', 429);
  }
  app.use(
    `${base}/*`,
    bodyLimit({
      maxSize: 524288,
      onError: (c) => c.json({ error: { code: 'BODY_TOO_LARGE' } }, 413),
    }),
  );
  app.use(`${base}/*`, async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    c.header('Vary', 'Cookie, Authorization');
    c.header('X-Content-Type-Options', 'nosniff');
    const path = new URL(c.req.url).pathname;
    const staff = path.startsWith(`${base}/admin`),
      bearer = c.req.header('authorization')?.replace(/^Bearer /, '');
    const token = bearer ?? getCookie(c, cookieName(staff));
    if (token) {
      try {
        const p = await auth.session(token);
        if (staff !== Boolean(p.staffId)) throw new DomainError('IDENTITY_SCOPE', 403);
        c.set('principal', p);
      } catch (error) {
        if (!(error instanceof DomainError) || error.status !== 401) throw error;
      }
    }
    if (bearer && !c.get('principal')) throw new DomainError('UNAUTHENTICATED', 401);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      const publicNative =
        path === `${base}/desktop/exchange` || path === `${base}/desktop/refresh`;
      const origin = c.req.header('origin');
      if (publicNative) {
        if (origin) throw new DomainError('NATIVE_ONLY', 403);
      } else if (!bearer) {
        if (origin !== (staff ? config.CLOUD_ADMIN_ORIGIN : config.CLOUD_PORTAL_ORIGIN))
          throw new DomainError('ORIGIN_REJECTED', 403);
        const p = c.get('principal');
        if (p && c.req.header('x-csrf-token') !== p.csrf)
          throw new DomainError('CSRF_REJECTED', 403);
      }
    }
    await rate(`route:${path}`, path.includes('/auth/') || path.includes('/login') ? 60 : 600);
    await next();
  });
  app.onError((error, c) => {
    const code =
      error instanceof DomainError
        ? error.code
        : error instanceof z.ZodError
          ? 'INVALID_INPUT'
          : 'INTERNAL_ERROR';
    const status =
      error instanceof DomainError ? error.status : error instanceof z.ZodError ? 400 : 500;
    // Deliberately exclude request body, cookies, upstream errors, and database query parameters.
    if (status === 500) console.error(JSON.stringify({ event: 'cloud.error', name: error.name }));
    return c.json({ error: { code } }, status as 400);
  });
  function route<S extends z.ZodObject>(
    method: 'get' | 'post',
    path: string,
    summary: string,
    input: S,
    scope: 'public' | 'user' | 'staff',
    roles: string[],
    handler: (c: Context<Env>, body: z.infer<S>) => Promise<unknown>,
  ) {
    const responseContract =
      (method === 'get' ? cloudListResponseSchemas[path] : undefined) ?? responseSchemas[path];
    app.openapi(
      createRoute({
        method,
        path: `${base}${path}`,
        summary,
        tags: [path.split('/')[1]!],
        ...(method === 'post'
          ? { request: { body: { content: { 'application/json': { schema: input } } } } }
          : input !== empty
            ? { request: { query: input } }
            : {}),
        responses: {
          200: {
            description: 'Success',
            content: {
              'application/json': {
                schema: z.object({ data: responseContract ?? z.unknown() }),
              },
            },
          },
          400: {
            description: 'Invalid request',
            content: { 'application/json': { schema: errorSchema } },
          },
          401: {
            description: 'Authentication required',
            content: { 'application/json': { schema: errorSchema } },
          },
          403: {
            description: 'Permission denied',
            content: { 'application/json': { schema: errorSchema } },
          },
          409: {
            description: 'State conflict',
            content: { 'application/json': { schema: errorSchema } },
          },
        },
      }),
      async (c) => {
        const p = c.get('principal');
        if (scope !== 'public' && (!p || (scope === 'staff' ? !p.staffId : !p.userId)))
          throw new DomainError('UNAUTHENTICATED', 401);
        if (roles.length && !roles.includes(p?.role ?? '')) throw new DomainError('FORBIDDEN', 403);
        if (
          method === 'get' &&
          input !== empty &&
          Object.values(c.req.queries()).some((values) => values.length !== 1)
        )
          throw new DomainError('INVALID_INPUT', 400);
        const body =
          method === 'post'
            ? input.parse(await c.req.json())
            : input.parse(input === empty ? {} : c.req.query());
        const data = await handler(c, body);
        if (responseContract) {
          const parsed = responseContract.safeParse(JSON.parse(JSON.stringify(data)));
          if (!parsed.success) throw new DomainError('RESPONSE_CONTRACT_FAILED', 500);
          return c.json({ data: parsed.data }, 200);
        }
        return c.json({ data }, 200);
      },
    );
  }
  function setSession(
    c: Context<Env>,
    s: { access: string; csrf: string; expiresAt: string },
    staff = false,
  ) {
    setCookie(c, cookieName(staff), s.access, {
      httpOnly: true,
      secure: (staff ? config.CLOUD_ADMIN_ORIGIN : config.CLOUD_PORTAL_ORIGIN).startsWith('https:'),
      sameSite: 'Strict',
      path: `${base}${staff ? '/admin' : ''}`,
      expires: new Date(s.expiresAt),
    });
    return { csrf: s.csrf, expiresAt: s.expiresAt };
  }
  route('get', '/health', 'Database and cache readiness', empty, 'public', [], async () => {
    await db.sql`select 1`;
    let cache = 'available';
    try {
      await redis.ping();
    } catch {
      cache = 'degraded';
    }
    return {
      database: 'available',
      cache,
      payments: config.CLOUD_MOCK_PAYMENTS === 'true' ? 'simulation' : 'disabled',
    };
  });
  route('get', '/catalog', 'Published test subscriptions', empty, 'public', [], async () => ({
    simulation: true,
    prices: await db.orm
      .select({ id: cloudPrices.id, config: cloudPrices.config })
      .from(cloudPrices)
      .where(eq(cloudPrices.published, true)),
    models: await db.sql`select id,config->>'name' as name from cloud_models where enabled=true`,
  }));
  route(
    'post',
    '/auth/challenges',
    'Send phone or email verification challenge',
    challengeInput,
    'public',
    [],
    async (c, b) => auth.challenge(b.target, b.purpose, principal(c)),
  );
  route(
    'post',
    '/auth/verify',
    'Consume challenge, verify or securely bind identity',
    verifyInput,
    'public',
    [],
    async (c, b) => {
      const s = await auth.verify(b.challengeId, b.code, b.password, principal(c));
      return 'access' in s ? setSession(c, s) : s;
    },
  );
  route('post', '/auth/login', 'Email password login', loginInput, 'public', [], async (c, b) => {
    await rate(`login:${b.email}`, 8);
    return setSession(c, await auth.login(b.email, b.password));
  });
  route('post', '/auth/logout', 'Revoke current session', empty, 'user', [], async (c) => {
    await db.sql`update cloud_sessions set revoked_at=${clock.now()} where id=${principal(c).sessionId}`;
    deleteCookie(c, cookieName(false), { path: base });
    return { signedOut: true };
  });
  route('get', '/me', 'Private account summary', empty, 'user', [], async (c) => {
    const uid = user(c);
    await db.sql.begin((tx) => billing.syncCredits(tx, uid));
    const [balance] =
      await db.sql`select coalesce(sum(available),0)::int as available,coalesce(sum(reserved),0)::int as reserved,min(ends_at) as "expiresAt" from cloud_credit_periods where user_id=${uid} and state='active'`;
    return {
      id: uid,
      csrf: principal(c).csrf,
      identities:
        await db.sql`select id,target,verified from cloud_identities where user_id=${uid}`,
      balance,
      terms: await db.sql`select * from cloud_terms where user_id=${uid} order by starts_at desc`,
      agreements:
        await db.sql`select * from cloud_agreements where user_id=${uid} order by created_at desc`,
      environment: 'test',
      deviceLimit: 2,
    };
  });
  for (const [path, definition] of Object.entries(cloudLists)) {
    const listPath = path as keyof typeof cloudLists;
    const own = path.startsWith('/me/');
    route(
      'get',
      path,
      own ? `List own ${path.slice(4)}` : `Inspect ${path.slice(7)}`,
      cloudListQuerySchema(listPath),
      own ? 'user' : 'staff',
      definition.roles,
      async (c, query) => {
        if (path === '/admin/inbox') billing.simulationOnly();
        const actorId = own ? user(c) : requireValue(principal(c).staffId);
        return queryCloudList(db, listPath, query as CloudListQuery, {
          actorId,
          role: own ? 'user' : (principal(c).role ?? ''),
          ...(own ? { userId: actorId } : {}),
        });
      },
    );
  }
  route(
    'post',
    '/me/sessions/revoke',
    'Revoke own session',
    z.object({ id }),
    'user',
    [],
    async (c, b) => {
      await db.sql`update cloud_sessions set revoked_at=${clock.now()} where id=${b.id} and user_id=${user(c)}`;
      return { revoked: true };
    },
  );
  async function revokeDevice(deviceId: string, actor: string, userId: string | null) {
    return db.sql.begin(async (tx) => {
      const [device] =
        await tx`update cloud_devices set revoked_at=${clock.now()} where id=${deviceId} and (${userId}::uuid is null or user_id=${userId}) returning id`;
      requireValue(device);
      await tx`update cloud_sessions set revoked_at=${clock.now()} where device_id=${deviceId}`;
      await billing.audit(tx, actor, 'device.revoke', deviceId);
      return { revoked: true };
    });
  }
  route(
    'post',
    '/me/devices/revoke',
    'Unbind device immediately',
    z.object({ id }),
    'user',
    [],
    async (c, b) => revokeDevice(b.id, user(c), user(c)),
  );
  route(
    'post',
    '/billing/orders',
    'Create simulated checkout',
    orderInput,
    'user',
    [],
    async (c, b) => billing.order(user(c), b.priceId, b.channel, b.key),
  );
  route(
    'post',
    '/billing/agreements',
    'Prepare simulated recurring agreement',
    z.object({ priceId: id, channel: channelSchema }),
    'user',
    [],
    async (c, b) => billing.agreement(user(c), b.priceId, b.channel),
  );
  route(
    'post',
    '/billing/agreements/cancel',
    'Stop future charges; keep paid term',
    z.object({ id }),
    'user',
    [],
    async (c, b) => {
      await db.sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${b.id}))`;
        await billing.agreementEvent(user(c), b.id, 'cancel');
      });
      return { canceled: true };
    },
  );
  route(
    'post',
    '/simulation/payment',
    'Simulate payment notification scenarios',
    z.object({ orderId: id, scenario: simulationSchema }),
    'user',
    [],
    async (c, b) => {
      await billing.simulate(user(c), b.orderId, b.scenario);
      await worker.tick();
      return { simulated: true };
    },
  );
  route(
    'post',
    '/simulation/agreement',
    'Confirm simulated agreement',
    z.object({ id }),
    'user',
    [],
    async (c, b) => {
      await billing.agreementEvent(user(c), b.id, 'sign');
      await worker.tick();
      return { simulated: true };
    },
  );
  route(
    'post',
    '/desktop/authorize',
    'Authorize PKCE loopback desktop',
    z.object({
      challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      redirectUri: z.url(),
      deviceId: id,
      deviceName: z.string().min(1).max(80),
    }),
    'user',
    [],
    async (c, b) => auth.authorize(user(c), b),
  );
  route(
    'post',
    '/desktop/exchange',
    'Exchange one-time authorization with PKCE',
    z.object({
      code: key,
      verifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/),
      redirectUri: z.url(),
    }),
    'public',
    [],
    async (_c, b) => auth.exchange(b.code, b.verifier, b.redirectUri),
  );
  route(
    'post',
    '/desktop/refresh',
    'Rotate desktop refresh credential',
    z.object({ refreshToken: key }),
    'public',
    [],
    async (_c, b) => auth.refresh(b.refreshToken),
  );
  route(
    'get',
    '/ai/models',
    'Available hosted models for this account',
    empty,
    'user',
    [],
    async (c) => {
      const rows =
        await db.sql`select distinct m.id,m.config from cloud_models m join cloud_orders o on o.snapshot->'modelIds' ? m.id::text join cloud_terms t on t.order_id=o.id where t.user_id=${user(c)} and t.starts_at<=${clock.now()} and t.ends_at>${clock.now()} and t.revoked_at is null and m.enabled=true`;
      return rows.map((r) => {
        const m = modelInput.parse(r.config);
        return {
          id: r.id,
          name: m.name,
          inputRate: m.inputRate,
          outputRate: m.outputRate,
          maxOutput: m.maxOutput,
          environment: 'test',
        };
      });
    },
  );
  // OpenAI-compatible wire format allows every existing local AI operation to use the same proxy.
  app.openapi(
    createRoute({
      method: 'post',
      path: `${base}/ai/chat/completions`,
      summary: 'Reserve credits and stream hosted model output',
      request: {
        headers: z.object({ 'x-request-id': id, 'x-assistant-turn': z.string().min(1).max(100) }),
        body: { content: { 'application/json': { schema: chatInput } } },
      },
      responses: {
        200: {
          description: 'OpenAI-compatible stream or completion',
          content: {
            'text/event-stream': { schema: z.string() },
            'application/json': { schema: z.unknown() },
          },
        },
      },
    }),
    async (c) => {
      if (!principal(c)?.userId) throw new DomainError('UNAUTHENTICATED', 401);
      return ai.call(
        principal(c),
        c.req.valid('header')['x-request-id'],
        c.req.valid('header')['x-assistant-turn'],
        c.req.valid('json'),
        c.req.raw.signal,
      );
    },
  );
  route(
    'post',
    '/ai/status',
    'Get request settlement status',
    z.object({ id }),
    'user',
    [],
    async (c, b) =>
      requireValue(
        (
          await db.sql`select id,turn_id,status,input_tokens,output_tokens,cost,error_code from cloud_ai_requests where id=${b.id} and user_id=${user(c)}`
        )[0],
      ),
  );
  route(
    'post',
    '/ai/cancel',
    'Request cancellation without re-dispatch',
    z.object({ id }),
    'user',
    [],
    async (c, b) => {
      await db.sql`update cloud_ai_requests set cancel_requested=true where id=${b.id} and user_id=${user(c)}`;
      return { requested: true };
    },
  );
  route(
    'post',
    '/admin/login',
    'Independent staff password and TOTP login',
    loginInput,
    'public',
    [],
    async (c, b) => {
      await rate(`staff:${b.email}`, 6);
      return setSession(c, await auth.login(b.email, b.password, true, b.totp), true);
    },
  );
  route('get', '/admin/me', 'Staff role and CSRF token', empty, 'staff', [], async (c) => ({
    id: principal(c).staffId,
    role: principal(c).role,
    csrf: principal(c).csrf,
  }));
  route(
    'get',
    '/admin/metrics',
    'Worker heartbeat and accounting health',
    empty,
    'staff',
    ['owner', 'operator', 'finance'],
    async () => ({
      worker:
        (await db.sql`select updated_at from cloud_runtime_status where key='worker'`)[0] ?? null,
      jobs: await db.sql`select status,count(*)::int as count from cloud_jobs group by status`,
      requests:
        await db.sql`select status,count(*)::int as count,coalesce(sum(cost),0)::bigint as credits from cloud_ai_requests group by status`,
      ledger: (
        await db.sql`select coalesce(sum(available),0)::bigint as available,coalesce(sum(reserved),0)::bigint as reserved from cloud_credit_periods`
      )[0],
    }),
  );
  route('post', '/admin/logout', 'Revoke staff session', empty, 'staff', [], async (c) => {
    await db.sql`update cloud_sessions set revoked_at=${clock.now()} where id=${principal(c).sessionId}`;
    deleteCookie(c, cookieName(true), { path: `${base}/admin` });
    return { signedOut: true };
  });
  route(
    'post',
    '/admin/models',
    'Create immutable model and rate version',
    modelInput,
    'staff',
    ['owner', 'operator'],
    async (c, b) =>
      db.sql.begin(async (tx) => {
        const [m] = await tx`insert into cloud_models(config) values (${tx.json(b)}) returning id`;
        await billing.audit(tx, principal(c).staffId, 'model.create', m!.id);
        return m!;
      }),
  );
  route(
    'post',
    '/admin/models/test',
    'Test configured upstream before enabling',
    z.object({ id }),
    'staff',
    ['owner', 'operator'],
    async (c, b) => {
      const r = await ai.modelTest(b.id);
      await db.sql.begin((tx) => billing.audit(tx, principal(c).staffId, 'model.test', b.id));
      return r;
    },
  );
  route(
    'post',
    '/admin/models/disable',
    'Disable new requests on model version',
    z.object({ id }),
    'staff',
    ['owner', 'operator'],
    async (c, b) =>
      db.sql.begin(async (tx) => {
        await tx`update cloud_models set enabled=false where id=${b.id}`;
        await billing.audit(tx, principal(c).staffId, 'model.disable', b.id);
        return { disabled: true };
      }),
  );
  route(
    'post',
    '/admin/prices',
    'Create immutable price and allowance version',
    priceInput,
    'staff',
    ['owner', 'finance'],
    async (c, b) =>
      db.sql.begin(async (tx) => {
        const [p] = await tx`insert into cloud_prices(config) values (${tx.json(b)}) returning id`;
        await billing.audit(tx, principal(c).staffId, 'price.create', p!.id);
        return p!;
      }),
  );
  route(
    'post',
    '/admin/prices/publish',
    'Publish a complete test subscription',
    z.object({ id, published: z.boolean() }),
    'staff',
    ['owner', 'finance'],
    async (c, b) =>
      db.sql.begin(async (tx) => {
        billing.simulationOnly();
        const p = priceInput.parse(
          requireValue((await tx`select config from cloud_prices where id=${b.id}`)[0]).config,
        );
        const models =
          await tx`select id from cloud_models where id in ${tx(p.modelIds)} and enabled=true and tested_at is not null`;
        if (b.published && models.length !== p.modelIds.length)
          throw new DomainError('CATALOG_INCOMPLETE');
        await tx`update cloud_prices set published=${b.published} where id=${b.id}`;
        await billing.audit(tx, principal(c).staffId, 'price.publish', b.id, {
          published: b.published,
        });
        return { published: b.published };
      }),
  );
  route(
    'post',
    '/admin/refunds',
    'Request a simulated full refund',
    z.object({ orderId: id, reason: z.string().min(4).max(500) }),
    'staff',
    ['owner', 'finance'],
    async (c, b) => billing.refund(principal(c).staffId!, b.orderId, b.reason),
  );
  route(
    'post',
    '/admin/simulation/refund',
    'Confirm simulated channel refund',
    z.object({ orderId: id, scenario: z.enum(['success', 'unknown']) }),
    'staff',
    ['owner', 'finance'],
    async (c, b) => {
      billing.simulationOnly();
      await db.sql.begin(async (tx) => {
        await billing.enqueue(
          tx,
          `refund:${b.orderId}`,
          'refund',
          { orderId: b.orderId },
          new Date(clock.now().getTime() + (b.scenario === 'unknown' ? 60000 : 0)),
        );
        await billing.audit(tx, principal(c).staffId, 'simulation.refund', b.orderId, {
          scenario: b.scenario,
        });
      });
      await worker.tick();
      return { simulated: true };
    },
  );
  route(
    'post',
    '/admin/simulation/payment',
    'Exercise payment fault scenarios',
    z.object({ orderId: id, scenario: simulationSchema }),
    'staff',
    ['owner', 'finance'],
    async (c, b) => {
      await billing.simulate(null, b.orderId, b.scenario);
      await db.sql.begin((tx) =>
        billing.audit(tx, principal(c).staffId, 'simulation.staff-payment', b.orderId, {
          scenario: b.scenario,
        }),
      );
      await worker.tick();
      return { simulated: true };
    },
  );
  route(
    'post',
    '/admin/simulation/agreement',
    'Configure recurring debit failure scenario',
    z.object({ id, scenario: simulationSchema }),
    'staff',
    ['owner', 'finance'],
    async (c, b) => {
      billing.simulationOnly();
      await db.sql.begin(async (tx) => {
        await tx`update cloud_agreements set scenario=${b.scenario} where id=${b.id}`;
        await billing.audit(tx, principal(c).staffId, 'simulation.agreement', b.id, {
          scenario: b.scenario,
        });
      });
      return { updated: true };
    },
  );
  route(
    'post',
    '/admin/credits/adjust',
    'Audited credit compensation',
    z.object({
      periodId: id,
      amount: z.number().int().min(-100000000).max(100000000),
      key,
      reason: z.string().min(4).max(500),
    }),
    'staff',
    ['owner', 'finance'],
    async (c, b) => {
      await billing.adjust(principal(c).staffId!, b.periodId, b.amount, b.key, b.reason);
      return { adjusted: true };
    },
  );
  route(
    'post',
    '/admin/devices/revoke',
    'Revoke device and cloud credentials',
    z.object({ id }),
    'staff',
    ['owner', 'support'],
    async (c, b) => revokeDevice(b.id, principal(c).staffId!, null),
  );
  route(
    'post',
    '/admin/users/status',
    'Suspend cloud account only',
    z.object({ id, status: z.enum(['active', 'disabled']) }),
    'staff',
    ['owner', 'support'],
    async (c, b) =>
      db.sql.begin(async (tx) => {
        await tx`update cloud_users set status=${b.status} where id=${b.id}`;
        if (b.status === 'disabled')
          await tx`update cloud_sessions set revoked_at=${clock.now()} where user_id=${b.id}`;
        await billing.audit(tx, principal(c).staffId, 'user.status', b.id, { status: b.status });
        return { updated: true };
      }),
  );
  route(
    'post',
    '/admin/jobs/retry',
    'Retry durable failed task',
    z.object({ id }),
    'staff',
    ['owner', 'operator'],
    async (c, b) =>
      db.sql.begin(async (tx) => {
        await tx`update cloud_jobs set status='pending',attempts=0,due_at=${clock.now()} where id=${b.id} and status='failed'`;
        await billing.audit(tx, principal(c).staffId, 'job.retry', b.id);
        return { queued: true };
      }),
  );
  route(
    'post',
    '/admin/requests/release',
    'Release uncertain reservation as audited compensation; never retry upstream',
    z.object({ id, reason: z.string().min(10).max(500) }),
    'staff',
    ['owner', 'finance'],
    async (c, b) => {
      const r = requireValue(
        (await db.sql`select status from cloud_ai_requests where id=${b.id}`)[0],
      );
      if (r.status !== 'review') throw new DomainError('NOT_IN_REVIEW');
      await ai.settle(b.id, null, true, { actorId: principal(c).staffId!, reason: b.reason });
      return { released: true };
    },
  );
  route(
    'post',
    '/admin/staff',
    'Create staff with mandatory TOTP enrollment',
    z.object({ email, password, role: z.enum(['support', 'finance', 'operator']) }),
    'staff',
    ['owner'],
    async (c, b) => {
      const secret = new OTPAuth.Secret({ size: 20 });
      const passwordHash = await Bun.password.hash(b.password, { algorithm: 'argon2id' });
      return db.sql.begin(async (tx) => {
        const [s] =
          await tx`insert into cloud_staff(email,password_hash,mfa_secret,role) values (${b.email},${passwordHash},${encrypt(secret.base32, config.CLOUD_MFA_KEY)},${b.role}) returning id`;
        await billing.audit(tx, principal(c).staffId, 'staff.create', s!.id);
        return {
          id: s!.id,
          enrollmentUri: new OTPAuth.TOTP({
            issuer: 'ZhiYun Admin',
            label: b.email,
            secret,
          }).toString(),
        };
      });
    },
  );
  route(
    'post',
    '/admin/staff/disable',
    'Disable staff and revoke sessions',
    z.object({ id }),
    'staff',
    ['owner'],
    async (c, b) =>
      db.sql.begin(async (tx) => {
        if (b.id === principal(c).staffId) throw new DomainError('CANNOT_DISABLE_SELF');
        await tx`update cloud_staff set disabled=true where id=${b.id} and role<>'owner'`;
        await tx`update cloud_sessions set revoked_at=${clock.now()} where staff_id=${b.id}`;
        await billing.audit(tx, principal(c).staffId, 'staff.disable', b.id);
        return { disabled: true };
      }),
  );
  app.doc(`${base}/openapi.json`, {
    openapi: '3.1.0',
    info: { title: '织云商业平台 API', version: '1.0.0' },
  });
  return {
    app,
    db,
    auth,
    billing,
    ai,
    worker,
    config,
    close: async () => {
      redis.close();
      await db.close();
    },
  };
}
