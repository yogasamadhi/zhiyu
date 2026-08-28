import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import {
  AnalysisJobService,
  AnalysisRecipeService,
  AnalyticsCatalog,
} from '../src/application/index.js';
import type { AnalyticsWorkerControl } from '../src/contracts/index.js';
import { registerAnalyticsHttp } from '../src/http/index.js';
import { SqliteAnalysisRepository } from '../src/persistence/sqlite/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Analytics HTTP v2', () => {
  it('enforces idempotency, ETag and RFC 7807 for Recipe and Job mutations', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-analytics-http-'));
    roots.push(dataDirectory);
    const filePath = join(dataDirectory, 'zhiyun.sqlite3');
    const platform = await openSqlitePlatformRepository({
      dataDirectory,
      filePath,
      graphRevision: 'analytics-http-test',
    });
    const repository = new SqliteAnalysisRepository(filePath);
    await repository.migrate();
    const worker = fakeWorker();
    const catalog = new AnalyticsCatalog(worker);
    const recipes = new AnalysisRecipeService(repository, catalog);
    const datasetId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    const jobs = new AnalysisJobService(
      repository,
      platform,
      {
        async getSnapshot(id) {
          return id === snapshotId
            ? {
                id,
                datasetId,
                status: 'ready' as const,
                parquetArtifactId: crypto.randomUUID(),
              }
            : null;
        },
      },
      catalog,
    );
    const app = Fastify();
    await registerAnalyticsHttp(app, { platform, catalog, recipes, jobs });
    try {
      const body = {
        name: 'Profile Recipe',
        datasetId,
        methodId: 'data.profile',
        methodVersion: '1.0.0',
        parameters: {},
      };
      const missingKey = await app.inject({
        method: 'POST',
        url: '/api/v2/analytics/recipes',
        payload: body,
      });
      expect(missingKey.statusCode).toBe(400);
      expect(missingKey.headers['content-type']).toContain('application/problem+json');
      expect(missingKey.json()).toMatchObject({ code: 'VALIDATION_ERROR', status: 400 });

      const created = await app.inject({
        method: 'POST',
        url: '/api/v2/analytics/recipes',
        headers: { 'idempotency-key': 'create-recipe' },
        payload: body,
      });
      expect(created.statusCode).toBe(201);
      const recipe = created.json();
      const replayed = await app.inject({
        method: 'POST',
        url: '/api/v2/analytics/recipes',
        headers: { 'idempotency-key': 'create-recipe' },
        payload: body,
      });
      expect(replayed.json()).toEqual(recipe);
      expect((await repository.listRecipes()).items).toHaveLength(1);

      const fetched = await app.inject({
        method: 'GET',
        url: `/api/v2/analytics/recipes/${recipe.id}`,
      });
      expect(fetched.headers.etag).toBe('"1"');
      const missingMatch = await app.inject({
        method: 'PUT',
        url: `/api/v2/analytics/recipes/${recipe.id}`,
        headers: { 'idempotency-key': 'update-without-match' },
        payload: { ...body, name: 'Updated' },
      });
      expect(missingMatch.statusCode).toBe(428);
      const updated = await app.inject({
        method: 'PUT',
        url: `/api/v2/analytics/recipes/${recipe.id}`,
        headers: { 'idempotency-key': 'update-recipe', 'if-match': '"1"' },
        payload: { ...body, name: 'Updated' },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.headers.etag).toBe('"2"');
      const stale = await app.inject({
        method: 'PUT',
        url: `/api/v2/analytics/recipes/${recipe.id}`,
        headers: { 'idempotency-key': 'stale-update', 'if-match': '"1"' },
        payload: { ...body, name: 'Stale' },
      });
      expect(stale.statusCode).toBe(412);

      const jobBody = {
        datasetId,
        snapshotId,
        methodId: 'data.profile',
        methodVersion: '1.0.0',
        parameters: {},
      };
      const firstJob = await app.inject({
        method: 'POST',
        url: '/api/v2/analytics/jobs',
        headers: { 'idempotency-key': 'profile-job' },
        payload: jobBody,
      });
      const secondJob = await app.inject({
        method: 'POST',
        url: '/api/v2/analytics/jobs',
        headers: { 'idempotency-key': 'profile-job' },
        payload: jobBody,
      });
      expect(firstJob.statusCode).toBe(202);
      expect(secondJob.json().id).toBe(firstJob.json().id);
      expect(await platform.listJobs({ ownerPluginId: 'analytics' })).toHaveLength(1);
    } finally {
      await app.close();
      await repository.close();
      await platform.close();
    }
  });
});

function fakeWorker(): AnalyticsWorkerControl {
  return {
    async methods() {
      return [
        {
          id: 'data.profile',
          version: '1.0.0',
          category: 'data-quality',
          titleKey: 'analytics.methods.data.profile.title',
          descriptionKey: 'analytics.methods.data.profile.description',
          supportedFieldTypes: ['any'],
          parameterSchema: {
            type: 'object',
            additionalProperties: false,
            properties: {},
          },
          outputSchema: { type: 'object' },
          recommendedVisualizations: ['table'],
          resourceLimits: { maxInputBytes: 5 * 1024 ** 3 },
          supportsSampling: false,
        },
      ];
    },
    async version() {
      return { workerVersion: '1.0.0' };
    },
    async submit() {
      throw new Error('not used');
    },
    async job() {
      throw new Error('not used');
    },
    async cancel() {
      throw new Error('not used');
    },
  };
}
