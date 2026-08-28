import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAiProvider } from '@zhiyun/ai-runtime';
import { ZhiYunError, type CrawlerService } from '@zhiyun/contracts';
import { FileArtifactStore, AesCredentialStore } from '@zhiyun/platform';
import { LocalQueue, LocalScheduler } from '@zhiyun/scheduler';
import { SqliteRepository } from '@zhiyun/sqlite-storage';
import { buildRuntime, type ZhiYunRuntime } from '../src/index.js';

const runtimes: ZhiYunRuntime[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function securityRuntime(options: { adminToken?: string; crawler?: CrawlerService } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-runtime-security-'));
  temporaryDirectories.push(directory);
  const repository = new SqliteRepository(':memory:');
  await repository.migrate();
  const queue = new LocalQueue(repository, 10_000);
  const scheduler = new LocalScheduler(repository, queue);
  const crawler: CrawlerService = {
    async crawl() {
      return {
        records: [],
        metadata: {
          requestCount: 0,
          recordCount: 0,
          browserUsed: false,
          aiUsed: false,
        },
      };
    },
  };
  const runtime = await buildRuntime(
    {
      repository,
      queue,
      scheduler,
      crawler: options.crawler ?? crawler,
      ai: createAiProvider(),
      credentialStore: new AesCredentialStore(join(directory, 'credentials'), undefined, false),
      artifactStore: new FileArtifactStore(join(directory, 'artifacts')),
      host: {
        metadata: {
          runtimeId: crypto.randomUUID(),
          generation: 7,
          apiVersion: 'v1',
          mode: 'desktop',
          version: 'test',
          startedAt: new Date().toISOString(),
        },
        capabilities: {
          platform: 'darwin',
          browser: true,
          cron: true,
          credentials: true,
          artifactSaveDialog: true,
          notifications: false,
          tray: true,
        },
      },
    },
    {
      sessionNonce: 'one-time-nonce',
      allowedOrigins: ['app://zhiyun'],
      logger: false,
      ...(options.adminToken ? { adminToken: options.adminToken } : {}),
    },
  );
  runtimes.push(runtime);
  await runtime.app.ready();
  return runtime;
}

describe('Runtime security contract', () => {
  it('bootstraps trend sources idempotently and exposes explicit preference APIs', async () => {
    const runtime = await securityRuntime();
    const session = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { nonce: 'one-time-nonce' },
    });
    const authorization = { authorization: `Bearer ${session.json().token as string}` };

    const initial = await runtime.app.inject({
      method: 'GET',
      url: '/api/v1/trend-sources',
      headers: authorization,
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toHaveLength(4);
    expect(
      initial.json().filter((source: { supported: boolean }) => source.supported),
    ).toHaveLength(3);

    const [firstBootstrap, concurrentBootstrap] = await Promise.all([
      runtime.app.inject({
        method: 'POST',
        url: '/api/v1/trend-sources/bootstrap',
        headers: authorization,
      }),
      runtime.app.inject({
        method: 'POST',
        url: '/api/v1/trend-sources/bootstrap',
        headers: authorization,
      }),
    ]);
    expect(firstBootstrap.statusCode).toBe(202);
    expect(concurrentBootstrap.statusCode).toBe(202);
    expect(
      firstBootstrap.json().sources.filter((source: { taskId: string | null }) => source.taskId),
    ).toHaveLength(3);
    const tasks = await runtime.app.inject({
      method: 'GET',
      url: '/api/v1/tasks?limit=100',
      headers: authorization,
    });
    expect(tasks.json().items).toHaveLength(3);

    const content = {
      platform: 'fanqie',
      contentType: 'novel',
      externalId: 'fixture-book',
      title: 'Fixture book',
      url: 'https://fanqienovel.com/page/42',
      coverUrl: null,
      author: null,
      summary: 'Content snapshot',
      tags: ['悬疑'],
      metadata: {},
    };
    for (const kind of ['like', 'completed', 'dislike']) {
      const response = await runtime.app.inject({
        method: 'POST',
        url: '/api/v1/preferences/signals',
        headers: authorization,
        payload: { kind, content },
      });
      expect(response.statusCode).toBe(200);
    }
    const signals = await runtime.app.inject({
      method: 'GET',
      url: '/api/v1/preferences/signals',
      headers: authorization,
    });
    expect(
      signals
        .json()
        .items.map((signal: { kind: string }) => signal.kind)
        .sort(),
    ).toEqual(['completed', 'dislike']);
    const profile = await runtime.app.inject({
      method: 'GET',
      url: '/api/v1/preferences/profile',
      headers: authorization,
    });
    expect(profile.json()).toMatchObject({ signalCount: 2 });

    const unsupportedImport = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/preferences/import',
      headers: authorization,
      payload: { url: 'https://example.com/not-supported', kind: 'like' },
    });
    expect(unsupportedImport.statusCode).toBe(422);
    const reset = await runtime.app.inject({
      method: 'DELETE',
      url: '/api/v1/preferences/signals',
      headers: authorization,
    });
    expect(reset.json()).toEqual({ deleted: 2 });
  });

  it('persists cancellation and aborts an active crawler (security)', async () => {
    let signalWasAborted = false;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const crawler: CrawlerService = {
      async crawl(input) {
        notifyStarted();
        return new Promise((_resolve, reject) => {
          input.signal?.addEventListener(
            'abort',
            () => {
              signalWasAborted = true;
              reject(new ZhiYunError('CANCELED', 'test crawl canceled'));
            },
            { once: true },
          );
        });
      },
    };
    const runtime = await securityRuntime({ crawler });
    const session = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { nonce: 'one-time-nonce' },
    });
    const authorization = { authorization: `Bearer ${session.json().token as string}` };
    const taskResponse = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { ...authorization, 'idempotency-key': crypto.randomUUID() },
      payload: {
        name: 'Cancelable task',
        startUrl: 'https://example.com/products',
        instruction: 'Get products',
      },
    });
    const taskId = taskResponse.json().id as string;
    await runtime.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/rules`,
      headers: { ...authorization, 'idempotency-key': crypto.randomUUID() },
      payload: {
        name: 'Cancelable rule',
        definition: {
          type: 'css',
          container: '.item',
          fields: { name: { selector: 'h2', value: 'text', dataType: 'string' } },
        },
      },
    });
    const queued = await runtime.app.inject({
      method: 'POST',
      url: `/api/v1/tasks/${taskId}/run`,
      headers: { ...authorization, 'idempotency-key': crypto.randomUUID() },
    });
    expect(queued.statusCode).toBe(202);
    const runId = queued.json().runId as string;
    await started;
    const canceled = await runtime.app.inject({
      method: 'POST',
      url: `/api/v1/runs/${runId}/cancel`,
      headers: authorization,
    });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json().status).toBe('canceled');
    expect(canceled.json().cancelRequestedAt).toEqual(expect.any(String));
    await expect.poll(() => signalWasAborted).toBe(true);
    const persisted = await runtime.app.inject({
      method: 'GET',
      url: `/api/v1/runs/${runId}`,
      headers: authorization,
    });
    expect(persisted.json().status).toBe('canceled');
  });

  it('allows authenticated update headers and methods from the desktop origin (security)', async () => {
    const runtime = await securityRuntime();
    const response = await runtime.app.inject({
      method: 'OPTIONS',
      url: '/api/v1/tasks/example',
      headers: {
        origin: 'app://zhiyun',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'authorization,content-type,if-match',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('app://zhiyun');
    expect(response.headers['access-control-allow-methods']).toContain('PUT');
    expect(response.headers['access-control-allow-headers']).toContain('if-match');
  });

  it('rejects nonce replay and disallowed origins (security)', async () => {
    const runtime = await securityRuntime();
    const first = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers: { origin: 'app://zhiyun' },
      payload: { nonce: 'one-time-nonce' },
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers['x-runtime-generation']).toBe('7');

    const replay = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      headers: { origin: 'app://zhiyun' },
      payload: { nonce: 'one-time-nonce' },
    });
    expect(replay.statusCode).toBe(401);

    const rejectedOrigin = await runtime.app.inject({
      method: 'GET',
      url: '/api/v1/version',
      headers: { origin: 'https://attacker.example' },
    });
    expect(rejectedOrigin.statusCode).toBe(403);
  });

  it('redacts secrets from RFC 7807 instances (security)', async () => {
    const runtime = await securityRuntime();
    const session = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { nonce: 'one-time-nonce' },
    });
    const response = await runtime.app.inject({
      method: 'GET',
      url: '/api/v1/does-not-exist?token=do-not-leak&query=visible',
      headers: { authorization: `Bearer ${session.json().token as string}` },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).not.toContain('do-not-leak');
    expect(response.json().instance).toContain('query=visible');
    expect(response.json().instance).toContain('REDACTED');
  });

  it('requires the administrator token when configured (security)', async () => {
    const adminToken = 'a'.repeat(32);
    const runtime = await securityRuntime({ adminToken });
    const nonce = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { nonce: 'one-time-nonce' },
    });
    expect(nonce.statusCode).toBe(401);
    const session = await runtime.app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { adminToken },
    });
    expect(session.statusCode).toBe(200);
  });
});
