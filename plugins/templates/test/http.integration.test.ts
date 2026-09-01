import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteCollectionRepository } from '@zhiyun/plugin-collection';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { registerTemplatesHttp } from '../src/index.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

describe('template instantiation HTTP contract', () => {
  it('compensates a failed quality policy and safely retries the same idempotency key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhiyun-template-http-'));
    const filePath = join(directory, 'zhiyun.sqlite3');
    const platform = await openSqlitePlatformRepository({
      dataDirectory: directory,
      filePath,
      graphRevision: 'template-http-test',
    });
    const collection = new SqliteCollectionRepository(filePath);
    await collection.migrate();
    const app = Fastify({ logger: false });
    let qualityCalls = 0;
    await registerTemplatesHttp(app, {
      platform,
      collection,
      credentialProtection: {
        runtimeMode: 'headless',
        credentialStore: {
          put: async () => 'unused',
          resolve: async <T>() => undefined as T,
          delete: async () => undefined,
        },
      },
      quality: {
        async upsertPolicy(_taskId, policy) {
          qualityCalls += 1;
          if (qualityCalls === 1) throw new Error('injected policy failure');
          return policy;
        },
      },
    });
    await app.ready();
    cleanup.push(async () => {
      await app.close();
      await collection.close();
      await platform.close();
      await rm(directory, { recursive: true, force: true });
    });

    const body = {
      startUrl: 'https://example.com/products',
      parameters: {
        container: '.product',
        titleSelector: '.title',
        linkSelector: 'a',
      },
      saveAsDraft: true,
    };
    const request = async (payload: Record<string, unknown>) =>
      await app.inject({
        method: 'POST',
        url: '/api/v2/task-templates/change-monitor/instantiate',
        headers: { 'idempotency-key': 'same-template-request' },
        payload,
      });

    const failed = await request(body);
    expect(failed.statusCode).toBe(400);
    expect(failed.json()).toMatchObject({ detail: 'injected policy failure' });
    expect((await collection.listTasks()).items).toHaveLength(0);

    const succeeded = await request(body);
    expect(succeeded.statusCode).toBe(201);
    expect(succeeded.json()).toMatchObject({
      status: 'draft',
      origin: { kind: 'template', templateId: 'change-monitor', templateVersion: 1 },
      activeRule: { rule: { name: '价格、库存或内容变化监控规则' } },
    });
    expect((await collection.listTasks()).items).toHaveLength(1);
    const replay = await request(body);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(succeeded.json().id);
    expect(qualityCalls).toBe(2);

    const conflict = await request({ ...body, name: 'different request' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ title: 'IDEMPOTENCY_CONFLICT' });
  });
});
