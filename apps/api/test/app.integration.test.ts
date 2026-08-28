import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresRepository } from '@zhiyun/storage';
import { buildApp } from '../src/app.js';

let fixture: Server;
let fixtureUrl: string;
let app: FastifyInstance;
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
  app = await buildApp();
  await app.ready();
  const session = await app.inject({
    method: 'POST',
    url: '/api/v1/session',
    payload: { nonce: 'headless-development-session' },
  });
  token = session.json().token as string;
}, 20_000);

afterAll(async () => {
  if (taskId) {
    await app.inject({ method: 'DELETE', url: `/api/v1/tasks/${taskId}`, headers: headers() });
  }
  await app.close();
  await new Promise<void>((resolve, reject) =>
    fixture.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('ZhiYun Runtime API v1 lifecycle', () => {
  it('rejects removed legacy API paths with Problem Details', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/tasks' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('creates, analyzes and versions a task rule', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
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
      url: `/api/v1/tasks/${taskId}/analyze`,
      headers: headers(),
      payload: { useAi: true, forceBrowser: false },
    });
    expect(analysis.statusCode).toBe(200);
    expect(analysis.json().preview).toHaveLength(10);
    expect(analysis.json().aiUsed).toBe(true);

    const rule = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/rules`,
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
      url: `/api/v1/tasks/${taskId}/rules/${rule.json().rule.id}/versions`,
      headers: headers({ 'idempotency-key': crypto.randomUUID() }),
      payload: { definition: analysis.json().candidate, generatedBy: 'human' },
    });
    expect(version.statusCode).toBe(201);
    expect(version.json().version).toBe(2);

    const extractDemo = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/ai/extract`,
      headers: headers(),
      payload: { definition: analysis.json().candidate },
    });
    expect(extractDemo.statusCode).toBe(200);
    expect(extractDemo.json().records).toHaveLength(10);
    expect(extractDemo.json().persisted).toBe(false);
    const aiOperations = (await new PostgresRepository().listEvents(0, 1_000)).items
      .filter((event) => event.type === 'ai.request.completed' && event.aggregateId === taskId)
      .map((event) => event.payload.operation);
    expect(aiOperations).toEqual(
      expect.arrayContaining(['generateSchema', 'generateRule', 'extract']),
    );
  });

  it('requires a repair proposal to be tested before activation', async () => {
    const proposed = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/rules/${ruleId}/repair-proposals`,
      headers: headers(),
      payload: { error: 'The page layout changed' },
    });
    expect(proposed.statusCode).toBe(201);
    const proposalId = proposed.json().id as string;

    const auditEvent = (await new PostgresRepository().listEvents(0, 1_000)).items.find(
      (event) =>
        event.type === 'ai.request.completed' &&
        event.aggregateId === taskId &&
        event.payload.operation === 'suggestRepair',
    );
    expect(auditEvent?.payload).toMatchObject({
      provider: 'mock',
      model: 'deterministic-fixture',
      operation: 'suggestRepair',
      taskId,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(JSON.stringify(auditEvent)).not.toContain('The page layout changed');
    expect(JSON.stringify(auditEvent)).not.toContain('<!doctype html>');

    const untested = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/rules/${ruleId}/repair-proposals/${proposalId}/apply`,
      headers: headers({ 'idempotency-key': crypto.randomUUID() }),
    });
    expect(untested.statusCode).toBe(409);

    const tested = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/rules/${ruleId}/repair-proposals/${proposalId}/test`,
      headers: headers(),
    });
    expect(tested.statusCode).toBe(200);
    expect(tested.json().records).toHaveLength(10);
    expect(tested.json().proposal.testedAt).toEqual(expect.any(String));

    const applied = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/rules/${ruleId}/repair-proposals/${proposalId}/apply`,
      headers: headers({ 'idempotency-key': crypto.randomUUID() }),
    });
    expect(applied.statusCode).toBe(201);
    expect(applied.json().version).toBe(3);
  });

  it('enforces authorization, idempotency and optimistic concurrency', async () => {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/tasks' });
    expect(unauthorized.statusCode).toBe(401);

    const missingKey = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/run`,
      headers: headers(),
    });
    expect(missingKey.statusCode).toBe(428);

    const task = await app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${taskId}`,
      headers: headers(),
    });
    const stale = await app.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${taskId}`,
      headers: headers({ 'if-match': '"999"' }),
      payload: { name: 'Stale' },
    });
    expect(stale.statusCode).toBe(412);
    expect(task.headers.etag).toBe('"1"');
  });

  it('runs asynchronously, persists records and creates artifacts', async () => {
    const key = crypto.randomUUID();
    const queued = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/run`,
      headers: headers({ 'idempotency-key': key }),
    });
    expect(queued.statusCode).toBe(202);
    runId = queued.json().runId as string;
    const repeated = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/run`,
      headers: headers({ 'idempotency-key': key }),
    });
    expect(repeated.json().runId).toBe(runId);

    let status = 'queued';
    for (let attempt = 0; attempt < 60 && !['succeeded', 'failed'].includes(status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const run = await app.inject({
        method: 'GET',
        url: `/api/v1/runs/${runId}`,
        headers: headers(),
      });
      status = run.json().status as string;
    }
    expect(status).toBe('succeeded');

    const records = await app.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}/records`,
      headers: headers(),
    });
    expect(records.json().items).toHaveLength(10);

    for (const format of ['csv', 'json', 'xlsx']) {
      const exported = await app.inject({
        method: 'POST',
        url: `/api/v1/runs/${runId}/exports`,
        headers: headers({ 'idempotency-key': crypto.randomUUID() }),
        payload: { format },
      });
      expect(exported.statusCode).toBe(201);
      const content = await app.inject({
        method: 'GET',
        url: `/api/v1/artifacts/${exported.json().artifactRef}/content`,
        headers: headers(),
      });
      expect(content.rawPayload.byteLength).toBeGreaterThan(10);
    }

    const datasetExport = await app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/dataset/exports`,
      headers: headers({ 'idempotency-key': crypto.randomUUID() }),
      payload: { format: 'json', jsonMode: 'jsonl', fields: ['name', 'price'] },
    });
    expect(datasetExport.statusCode).toBe(201);
    const datasetContent = await app.inject({
      method: 'GET',
      url: `/api/v1/artifacts/${datasetExport.json().artifactRef}/content`,
      headers: headers(),
    });
    expect(datasetContent.body).toContain('Item 0');
  }, 15_000);

  it('scopes, filters, rate-limits and revokes read-only Data API tokens', async () => {
    const wrongScope = await app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      headers: headers(),
      payload: {
        name: 'Wrong scope',
        taskIds: [crypto.randomUUID()],
        rateLimitPerMinute: 10,
      },
    });
    expect(wrongScope.statusCode).toBe(201);
    const forbidden = await app.inject({
      method: 'GET',
      url: `/api/v1/data/tasks/${taskId}/records`,
      headers: { authorization: `Bearer ${wrongScope.json().token as string}` },
    });
    expect(forbidden.statusCode).toBe(403);

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/api-tokens',
      headers: headers(),
      payload: { name: 'One request', taskIds: [taskId], rateLimitPerMinute: 1 },
    });
    expect(created.statusCode).toBe(201);
    const dataToken = created.json().token as string;
    const filtered = await app.inject({
      method: 'GET',
      url: `/api/v1/data/tasks/${taskId}/records?limit=5&fields=name,price&filter=${encodeURIComponent(JSON.stringify({ name: 'Item 0' }))}`,
      headers: { authorization: `Bearer ${dataToken}` },
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().items).toHaveLength(1);
    expect(Object.keys(filtered.json().items[0].data).sort()).toEqual(['name', 'price']);

    const limited = await app.inject({
      method: 'GET',
      url: `/api/v1/data/tasks/${taskId}/records`,
      headers: { authorization: `Bearer ${dataToken}` },
    });
    expect(limited.statusCode).toBe(429);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/api-tokens/${created.json().id as string}`,
      headers: headers(),
    });
    expect(revoked.statusCode).toBe(204);
    const rejected = await app.inject({
      method: 'GET',
      url: `/api/v1/data/tasks/${taskId}/records`,
      headers: { authorization: `Bearer ${dataToken}` },
    });
    expect(rejected.statusCode).toBe(401);
  });

  it('registers and removes a five-field cron schedule using If-Match', async () => {
    const task = await app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${taskId}`,
      headers: headers(),
    });
    const scheduled = await app.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${taskId}`,
      headers: headers({ 'if-match': task.headers.etag! }),
      payload: { schedule: { mode: 'cron', cron: '*/30 * * * *', timezone: 'Asia/Shanghai' } },
    });
    expect(scheduled.statusCode).toBe(200);
    expect(scheduled.json().schedule.misfirePolicy).toBe('skip');
    const paused = await app.inject({
      method: 'POST',
      url: '/api/v1/scheduler/pause',
      headers: headers(),
    });
    expect(paused.json().schedulingPaused).toBe(true);
    const pausedSummary = await app.inject({
      method: 'GET',
      url: '/api/v1/runtime/summary',
      headers: headers(),
    });
    expect(pausedSummary.json().schedulingPaused).toBe(true);
    const resumed = await app.inject({
      method: 'POST',
      url: '/api/v1/scheduler/resume',
      headers: headers(),
    });
    expect(resumed.json().schedulingPaused).toBe(false);
    const manual = await app.inject({
      method: 'PUT',
      url: `/api/v1/tasks/${taskId}`,
      headers: headers({ 'if-match': scheduled.headers.etag! }),
      payload: { schedule: { mode: 'manual', timezone: 'Asia/Shanghai' } },
    });
    expect(manual.statusCode).toBe(200);
  });
});
