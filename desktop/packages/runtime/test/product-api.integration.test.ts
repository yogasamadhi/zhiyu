import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProductRuntimeFixture } from './support/product-runtime.js';

let fixture!: Server;
let closeRuntime: (() => Promise<void>) | undefined;
let credentials: Awaited<ReturnType<typeof createProductRuntimeFixture>>['credentials'];
let fixtureUrl: string;
let app!: FastifyInstance;
let token = '';
let taskId = '';
let runId = '';
let ruleId = '';

const requestSettings = {
  headers: {},
  cookies: [],
  timeoutMs: 10_000,
  retries: 1,
  retryBackoffMs: 100,
  concurrency: 1,
  delayMs: 0,
  maxRequests: 10,
  maxRuntimeMs: 30_000,
  domainRateLimitPerMinute: 60,
  respectRobotsTxt: true,
  maxResponseBytes: 20 * 1024 * 1024,
  redirectLimit: 10,
};

function headers(extra: Record<string, string> = {}) {
  return { authorization: `Bearer ${token}`, ...extra };
}

beforeAll(async () => {
  fixture = createServer((request, response) => {
    if (request.url === '/robots.txt') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('User-agent: *\nAllow: /');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      `<!doctype html><main>${Array.from(
        { length: 10 },
        (_, index) =>
          `<article class="product-card"><a class="product-link" href="/p/${index}"><h2 class="product-title">Item ${index}</h2></a><span class="price">¥${index + 1}</span><span class="sales">销量 ${index}</span></article>`,
      ).join('')}</main>`,
    );
  });
  await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  fixtureUrl = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}/products`;
  const runtime = await createProductRuntimeFixture();
  app = runtime.app;
  closeRuntime = runtime.close;
  credentials = runtime.credentials;
  await app.ready();
  const session = await app.inject({
    method: 'POST',
    url: '/api/v2/session',
    payload: { nonce: 'product-integration-session' },
  });
  token = session.json().token as string;
}, 20_000);

afterAll(async () => {
  if (taskId && app) {
    const task = await app.inject({
      method: 'GET',
      url: `/api/v2/tasks/${taskId}`,
      headers: headers(),
    });
    await app.inject({
      method: 'DELETE',
      url: `/api/v2/tasks/${taskId}`,
      headers: headers({
        'if-match': task.headers.etag ?? '"1"',
        'idempotency-key': crypto.randomUUID(),
      }),
    });
  }
  await closeRuntime?.();
  if (fixture?.listening) {
    await new Promise<void>((resolve, reject) =>
      fixture.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

describe('ZhiYun Runtime API v2 lifecycle', () => {
  it('separates process liveness from infrastructure readiness', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });

    const readiness = await app.inject({ method: 'GET', url: '/ready' });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toMatchObject({
      status: 'ready',
      checks: {
        database: { status: 'ok' },
        queue: { status: 'ok', implementation: 'local' },
        browser: { status: 'ok' },
        analyticsWorker: { status: 'ok', workerStatus: 'ready' },
      },
    });
  });

  it('rejects removed legacy API paths with Problem Details', async () => {
    for (const url of ['/api/tasks', '/api/v1/version', '/api/v1/tasks']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/problem+json');
    }
  });

  it('publishes v2 Runtime metadata and the immutable owned graph', async () => {
    const metadata = await app.inject({ method: 'GET', url: '/api/v2/runtime' });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json()).toMatchObject({
      apiVersion: 'v2',
      productVersion: '1.0.0',
      profileId: 'test',
      graphRevision: expect.any(String),
      analyticsWorkerStatus: 'ready',
    });
    const graph = await app.inject({ method: 'GET', url: '/api/v2/runtime/graph' });
    expect(graph.statusCode).toBe(200);
    expect(graph.json()).toMatchObject({
      profileId: 'test',
      graphRevision: metadata.json().graphRevision,
      plugins: expect.arrayContaining([expect.objectContaining({ id: 'collection' })]),
      routes: expect.arrayContaining([
        expect.objectContaining({ operationId: 'listTasks', ownerPluginId: 'collection' }),
      ]),
    });
  });

  it('creates, analyzes and versions a task rule', async () => {
    const request = {
      method: 'POST' as const,
      url: '/api/v2/tasks',
      headers: headers({ 'idempotency-key': crypto.randomUUID() }),
      payload: {
        name: 'Integration fixture',
        startUrl: fixtureUrl,
        instruction: 'Get name, price, sales and link',
        schedule: { mode: 'manual', timezone: 'Asia/Shanghai' },
        requestSettings: {
          ...requestSettings,
          headers: { Authorization: 'Bearer secret', 'X-Public': 'visible' },
          cookies: [{ name: 'session', value: 'secret', path: '/', sameSite: 'Lax' }],
        },
        browserSettings: {
          enabled: false,
          waitUntil: 'domcontentloaded',
          actions: [],
          storageState: { cookies: [], origins: [] },
        },
        pagination: { type: 'none' },
        outputSettings: { persistRecords: true },
        networkPolicy: {
          allowPrivateNetworks: true,
          allowedHosts: [],
          allowedCidrs: [],
        },
      },
    };
    const rejected = await app.inject(request);
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().code).toBe('CREDENTIAL_ERROR');
    // The Host stores secrets; the Renderer passes only opaque references.
    const credentialBindings = {
      secretHeadersRef: await credentials.put('task-secret-headers', {
        Authorization: 'Bearer secret',
      }),
      cookiesRef: await credentials.put('task-cookies', request.payload.requestSettings.cookies),
      browserStorageStateRef: await credentials.put(
        'browser-storage-state',
        request.payload.browserSettings.storageState,
      ),
    };
    const created = await app.inject({
      ...request,
      headers: headers({ 'idempotency-key': crypto.randomUUID() }),
      payload: {
        ...request.payload,
        requestSettings: {
          ...request.payload.requestSettings,
          headers: { 'X-Public': 'visible' },
          cookies: [],
        },
        browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
        credentialBindings,
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.etag).toBe('"1"');
    expect(created.json().requestSettings.headers).toEqual({ 'X-Public': 'visible' });
    expect(created.json().requestSettings.cookies).toEqual([]);
    expect(created.json().browserSettings.storageState).toBeUndefined();
    expect(created.json().credentialBindings).toMatchObject({
      secretHeadersRef: expect.any(String),
      cookiesRef: expect.any(String),
      browserStorageStateRef: expect.any(String),
    });
    taskId = created.json().id as string;

    const analysis = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${taskId}/rule-analysis`,
      headers: headers(),
      payload: { useAi: true, forceBrowser: false },
    });
    expect(analysis.statusCode).toBe(200);
    expect(analysis.json().preview).toHaveLength(10);
    expect(analysis.json().aiUsed).toBe(true);

    const rule = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${taskId}/rules`,
      headers: headers({ 'idempotency-key': crypto.randomUUID() }),
      payload: {
        name: 'Products',
        definition: analysis.json().candidate,
        generatedBy: 'system',
      },
    });
    expect(rule.statusCode).toBe(201);
    expect(rule.json().version.version).toBe(1);
    ruleId = rule.json().rule.id as string;

    const version = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${taskId}/rules/${rule.json().rule.id}/versions`,
      headers: headers({ 'idempotency-key': crypto.randomUUID() }),
      payload: { definition: analysis.json().candidate, generatedBy: 'human' },
    });
    expect(version.statusCode).toBe(201);
    expect(version.json().version).toBe(2);

    const extractDemo = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${taskId}/ai/extract`,
      headers: headers(),
      payload: { definition: analysis.json().candidate },
    });
    expect(extractDemo.statusCode).toBe(200);
    expect(extractDemo.json().records).toHaveLength(10);
    expect(extractDemo.json().persisted).toBe(false);
  });

  it('requires a repair proposal to be tested before activation', async () => {
    const proposed = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${taskId}/rules/${ruleId}/repair-proposals`,
      headers: headers({ 'idempotency-key': crypto.randomUUID() }),
      payload: { error: 'The page layout changed' },
    });
    expect(proposed.statusCode).toBe(201);
    const proposalId = proposed.json().id as string;

    const untested = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${taskId}/rules/${ruleId}/repair-proposals/${proposalId}/apply`,
      headers: headers({ 'idempotency-key': crypto.randomUUID() }),
    });
    expect(untested.statusCode).toBe(409);

    const tested = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${taskId}/rules/${ruleId}/repair-proposals/${proposalId}/test`,
      headers: headers({ 'idempotency-key': crypto.randomUUID() }),
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json().records).toHaveLength(10);
    expect(tested.json().proposal.testedAt).toEqual(expect.any(String));

    const applied = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${taskId}/rules/${ruleId}/repair-proposals/${proposalId}/apply`,
      headers: headers({ 'idempotency-key': crypto.randomUUID() }),
    });
    expect(applied.statusCode).toBe(201);
    expect(applied.json().version).toBe(3);
  });

  it('enforces authorization, idempotency and optimistic concurrency', async () => {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v2/tasks' });
    expect(unauthorized.statusCode).toBe(401);

    const missingKey = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${taskId}/runs`,
      headers: headers(),
    });
    expect(missingKey.statusCode).toBe(428);

    const task = await app.inject({
      method: 'GET',
      url: `/api/v2/tasks/${taskId}`,
      headers: headers(),
    });
    const stale = await app.inject({
      method: 'PUT',
      url: `/api/v2/tasks/${taskId}`,
      headers: headers({ 'if-match': '"999"', 'idempotency-key': crypto.randomUUID() }),
      payload: { name: 'Stale' },
    });
    expect(stale.statusCode).toBe(412);
    expect(task.headers.etag).toBe('"1"');
  });

  it('runs asynchronously, persists records and creates artifacts', async () => {
    const key = crypto.randomUUID();
    const queued = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${taskId}/runs`,
      headers: headers({ 'idempotency-key': key }),
    });
    expect(queued.statusCode).toBe(202);
    runId = queued.json().runId as string;
    const repeated = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${taskId}/runs`,
      headers: headers({ 'idempotency-key': key }),
    });
    expect(repeated.json().runId).toBe(runId);

    let status = 'queued';
    for (let attempt = 0; attempt < 60 && !['succeeded', 'failed'].includes(status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const run = await app.inject({
        method: 'GET',
        url: `/api/v2/runs/${runId}`,
        headers: headers(),
      });
      status = run.json().status as string;
    }
    expect(status).toBe('succeeded');

    const records = await app.inject({
      method: 'GET',
      url: `/api/v2/runs/${runId}/records`,
      headers: headers(),
    });
    expect(records.json().items).toHaveLength(10);

    for (const format of ['csv', 'json', 'xlsx']) {
      const exported = await app.inject({
        method: 'POST',
        url: `/api/v2/runs/${runId}/exports`,
        headers: headers({ 'idempotency-key': crypto.randomUUID() }),
        payload: { format },
      });
      expect(exported.statusCode).toBe(201);
      const content = await app.inject({
        method: 'GET',
        url: `/api/v2/artifacts/${exported.json().artifactRef}/content`,
        headers: headers(),
      });
      expect(content.rawPayload.byteLength).toBeGreaterThan(10);
    }

    const datasets = await app.inject({
      method: 'GET',
      url: `/api/v2/datasets?sourceTaskId=${taskId}`,
      headers: headers(),
    });
    const datasetId = datasets.json().items[0].id as string;
    const datasetExport = await app.inject({
      method: 'POST',
      url: `/api/v2/datasets/${datasetId}/exports`,
      headers: headers({ 'idempotency-key': crypto.randomUUID() }),
      payload: { format: 'json', jsonMode: 'jsonl', fields: ['name', 'price'] },
    });
    expect(datasetExport.statusCode).toBe(201);
    const datasetContent = await app.inject({
      method: 'GET',
      url: `/api/v2/artifacts/${datasetExport.json().id}/content`,
      headers: headers(),
    });
    expect(datasetContent.body).toContain('Item 0');
  }, 15_000);

  it('scopes, filters, rate-limits and revokes read-only Data API tokens', async () => {
    const wrongScope = await app.inject({
      method: 'POST',
      url: '/api/v2/api-tokens',
      headers: headers({ 'idempotency-key': crypto.randomUUID() }),
      payload: {
        name: 'Wrong scope',
        taskIds: [crypto.randomUUID()],
        rateLimitPerMinute: 10,
      },
    });
    expect(wrongScope.statusCode).toBe(201);
    const forbidden = await app.inject({
      method: 'GET',
      url: `/api/v2/data/tasks/${taskId}/records`,
      headers: { authorization: `Bearer ${wrongScope.json().token as string}` },
    });
    expect(forbidden.statusCode).toBe(403);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v2/api-tokens',
      headers: headers({ 'idempotency-key': crypto.randomUUID() }),
      payload: { name: 'One request', taskIds: [taskId], rateLimitPerMinute: 1 },
    });
    expect(created.statusCode).toBe(201);
    const dataToken = created.json().token as string;
    const filtered = await app.inject({
      method: 'GET',
      url: `/api/v2/data/tasks/${taskId}/records?limit=5&fields=name,price&filter=${encodeURIComponent(JSON.stringify({ name: 'Item 0' }))}`,
      headers: { authorization: `Bearer ${dataToken}` },
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().items).toHaveLength(1);
    expect(Object.keys(filtered.json().items[0].data).sort()).toEqual(['name', 'price']);

    const limited = await app.inject({
      method: 'GET',
      url: `/api/v2/data/tasks/${taskId}/records`,
      headers: { authorization: `Bearer ${dataToken}` },
    });
    expect(limited.statusCode).toBe(429);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v2/api-tokens/${created.json().id as string}`,
      headers: headers({ 'idempotency-key': crypto.randomUUID() }),
    });
    expect(revoked.statusCode).toBe(204);
    const rejected = await app.inject({
      method: 'GET',
      url: `/api/v2/data/tasks/${taskId}/records`,
      headers: { authorization: `Bearer ${dataToken}` },
    });
    expect(rejected.statusCode).toBe(401);
  });

  it('registers and removes a five-field cron schedule using If-Match', async () => {
    const task = await app.inject({
      method: 'GET',
      url: `/api/v2/tasks/${taskId}`,
      headers: headers(),
    });
    const scheduled = await app.inject({
      method: 'PUT',
      url: `/api/v2/tasks/${taskId}`,
      headers: headers({
        'if-match': task.headers.etag!,
        'idempotency-key': crypto.randomUUID(),
      }),
      payload: { schedule: { mode: 'cron', cron: '*/30 * * * *', timezone: 'Asia/Shanghai' } },
    });
    expect(scheduled.statusCode).toBe(200);
    expect(scheduled.json().schedule.misfirePolicy).toBe('skip');
    const paused = await app.inject({
      method: 'POST',
      url: '/api/v2/scheduler/pause',
      headers: headers({ 'idempotency-key': crypto.randomUUID() }),
    });
    expect(paused.json().schedulingPaused).toBe(true);
    const pausedSummary = await app.inject({
      method: 'GET',
      url: '/api/v2/runtime/summary',
      headers: headers(),
    });
    expect(pausedSummary.json()).toMatchObject({
      schedulingPaused: true,
      analyticsWorkerStatus: 'ready',
      queueBacklog: expect.any(Number),
      uptimeSeconds: expect.any(Number),
      jobsByState: expect.objectContaining({ queued: expect.any(Number) }),
    });
    const resumed = await app.inject({
      method: 'POST',
      url: '/api/v2/scheduler/resume',
      headers: headers({ 'idempotency-key': crypto.randomUUID() }),
    });
    expect(resumed.json().schedulingPaused).toBe(false);
    const manual = await app.inject({
      method: 'PUT',
      url: `/api/v2/tasks/${taskId}`,
      headers: headers({
        'if-match': scheduled.headers.etag!,
        'idempotency-key': crypto.randomUUID(),
      }),
      payload: { schedule: { mode: 'manual', timezone: 'Asia/Shanghai' } },
    });
    expect(manual.statusCode).toBe(200);
  });
});
