import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAiProvider } from '@zhiyun/ai-runtime';
import { LocalArtifactStore } from '@zhiyun/artifact-store';
import type { CrawlerService } from '@zhiyun/contracts';
import { AesCredentialStore } from '@zhiyun/platform';
import { JobHandlerRegistry } from '@zhiyun/platform-core';
import { SqliteAnalysisRepository } from '@zhiyun/plugin-analytics';
import { SqliteCollectionRepository } from '@zhiyun/plugin-collection';
import { SqliteCorpusRepository } from '@zhiyun/plugin-corpus';
import { SqliteDatasetRepository } from '@zhiyun/plugin-datasets';
import { SqliteOutputRepository } from '@zhiyun/plugin-outputs';
import { SqlitePreferencesRepository } from '@zhiyun/plugin-preferences';
import { resolveProductGraph } from '@zhiyun/product-profiles';
import { LocalPlatformJobQueue } from '@zhiyun/queue-local-v1';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { buildLevel2Runtime, openApiDocument, type Level2Runtime } from '../src/index.js';

const runtimes: Level2Runtime[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Level 2 Runtime composition', () => {
  it('starts the immutable graph and runs Collection into an independent Dataset', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhiyun-level2-runtime-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'zhiyun.sqlite3');
    const graph = resolveProductGraph('test');
    const platform = await openSqlitePlatformRepository({
      dataDirectory: directory,
      filePath: databasePath,
      graphRevision: graph.revision,
    });
    const repositories = {
      platform,
      datasets: new SqliteDatasetRepository(databasePath),
      collection: new SqliteCollectionRepository(databasePath),
      outputs: new SqliteOutputRepository(databasePath),
      preferences: new SqlitePreferencesRepository(databasePath),
      analytics: new SqliteAnalysisRepository(databasePath),
      corpus: new SqliteCorpusRepository(databasePath),
    };
    const handlers = new JobHandlerRegistry();
    const jobs = new LocalPlatformJobQueue(platform, handlers, { pollIntervalMs: 60_000 });
    const crawler: CrawlerService = {
      async crawl() {
        return {
          records: [
            {
              sourceUrl: 'https://example.com/items/1',
              data: { id: 'item-1', name: 'Level 2 fixture', score: 9.5 },
            },
          ],
          metadata: {
            requestCount: 1,
            recordCount: 1,
            browserUsed: false,
            aiUsed: false,
          },
        };
      },
    };
    const runtime = await buildLevel2Runtime(
      {
        repositories,
        handlers,
        jobs,
        crawler,
        ai: createAiProvider(),
        credentialStore: new AesCredentialStore(join(directory, 'credentials'), undefined, false),
        artifactStore: new LocalArtifactStore(directory),
        openApiDocument: openApiDocument(),
        host: {
          metadata: {
            runtimeId: crypto.randomUUID(),
            generation: 1,
            apiVersion: 'v2',
            mode: 'desktop',
            productVersion: '1.0.0',
            analyticsWorkerStatus: 'unavailable',
            startedAt: new Date().toISOString(),
          },
          capabilities: {
            platform: 'darwin',
            browser: true,
            cron: true,
            credentials: true,
            artifactSaveDialog: false,
            notifications: false,
            tray: false,
          },
        },
      },
      {
        sessionNonce: 'level2-test-nonce',
        profileId: 'test',
        allowedOrigins: ['app://zhiyun'],
        logger: false,
      },
    );
    runtimes.push(runtime);
    await runtime.app.ready();

    expect(runtime.graph.pluginIds).toEqual(
      expect.arrayContaining(['platform', 'collection', 'datasets', 'analytics', 'corpus']),
    );
    expect(runtime.graph.pluginIds).not.toContain('legacy.runtime');

    const session = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/session',
      payload: { nonce: 'level2-test-nonce' },
    });
    expect(session.statusCode).toBe(200);
    expect(session.headers['x-runtime-generation']).toBe('1');
    const authorization = { authorization: `Bearer ${session.json().token as string}` };

    const replay = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/session',
      payload: { nonce: 'level2-test-nonce' },
    });
    expect(replay.statusCode).toBe(401);

    const unauthenticated = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/tasks',
      headers: {
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers['content-type']).toContain('application/problem+json');
    expect(unauthenticated.headers['x-trace-id']).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(unauthenticated.json()).toMatchObject({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    });

    const updatePreflight = await runtime.app.inject({
      method: 'OPTIONS',
      url: '/api/v2/tasks/example',
      headers: {
        origin: 'app://zhiyun',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'authorization,content-type,if-match,idempotency-key',
      },
    });
    expect(updatePreflight.statusCode).toBe(204);
    expect(updatePreflight.headers['access-control-allow-methods']).toContain('PUT');

    const graphResponse = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/runtime/graph',
      headers: authorization,
    });
    expect(graphResponse.statusCode).toBe(200);
    expect(graphResponse.json()).toMatchObject({
      profileId: 'test',
      graphRevision: graph.revision,
    });

    const taskResponse = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/tasks',
      headers: { ...authorization, 'idempotency-key': crypto.randomUUID() },
      payload: {
        name: 'Level 2 task',
        startUrl: 'https://example.com/items',
        instruction: 'Collect the fixture items',
      },
    });
    expect(taskResponse.statusCode).toBe(201);
    const taskId = taskResponse.json().id as string;

    const ruleResponse = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${taskId}/rules`,
      headers: { ...authorization, 'idempotency-key': crypto.randomUUID() },
      payload: {
        name: 'Fixture rule',
        definition: {
          type: 'json',
          container: '$.items',
          fields: { id: { path: '$.id', dataType: 'string' } },
        },
      },
    });
    expect(ruleResponse.statusCode).toBe(201);

    const queued = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${taskId}/runs`,
      headers: { ...authorization, 'idempotency-key': crypto.randomUUID() },
    });
    expect(queued.statusCode).toBe(202);
    await jobs.dispatchOnce();

    const runResponse = await runtime.app.inject({
      method: 'GET',
      url: `/api/v2/runs/${queued.json().runId as string}`,
      headers: authorization,
    });
    expect(runResponse.json()).toMatchObject({ status: 'succeeded', recordCount: 1 });

    const datasets = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/datasets',
      headers: authorization,
    });
    expect(datasets.statusCode).toBe(200);
    expect(datasets.json().items).toHaveLength(1);
    expect(datasets.json().items[0]).toMatchObject({ sourceTaskId: taskId, currentCount: 1 });

    const analytics = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/analytics/methods',
      headers: authorization,
    });
    expect(analytics.statusCode).toBe(503);
    expect(analytics.json()).toMatchObject({ code: 'ANALYTICS_UNAVAILABLE' });

    const legacy = await runtime.app.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: authorization,
    });
    expect(legacy.statusCode).toBe(404);
    expect(legacy.headers['content-type']).toContain('application/problem+json');

    const redacted = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/does-not-exist?token=do-not-leak&query=visible',
      headers: authorization,
    });
    expect(redacted.statusCode).toBe(404);
    expect(redacted.body).not.toContain('do-not-leak');
    expect(redacted.json()).toMatchObject({
      code: 'NOT_FOUND',
      instance: expect.stringContaining('query=visible'),
      traceId: expect.any(String),
    });
  });
});
