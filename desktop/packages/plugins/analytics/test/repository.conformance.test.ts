import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformRepository } from '@zhiyun/platform-core';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import type { AnalysisRepository } from '../src/contracts/index.js';
import { SqliteAnalysisRepository } from '../src/persistence/sqlite/index.js';

interface Fixture {
  repository: AnalysisRepository;
  platform: PlatformRepository;
  dispose(): Promise<void>;
}

defineAnalysisConformance('SQLite', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-analytics-sqlite-'));
  const filePath = join(dataDirectory, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory,
    filePath,
    graphRevision: 'analytics-test',
  });
  const repository = new SqliteAnalysisRepository(filePath);
  await repository.migrate();
  return {
    repository,
    platform,
    async dispose() {
      await repository.close();
      await platform.close();
      await rm(dataDirectory, { recursive: true, force: true });
    },
  };
});

function defineAnalysisConformance(name: string, create: () => Promise<Fixture>): void {
  describe(`${name} AnalysisRepository conformance`, () => {
    let fixture: Fixture;
    let recipeId = '';
    let jobId = '';
    let resultId = '';
    const datasetId = randomUUID();
    const snapshotId = randomUUID();

    beforeAll(async () => {
      fixture = await create();
    });

    afterAll(async () => {
      if (fixture) await fixture.dispose();
    });

    it('records the forward-only Analytics migration', async () => {
      expect(await fixture.platform.listMigrations()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: 'analytics',
            migrationId: '001-initial',
            pluginVersion: '1.0.0',
          }),
        ]),
      );
    });

    it('creates, pages and revision-guards Recipes', async () => {
      const recipe = await fixture.repository.createRecipe({
        name: 'Descriptive baseline',
        datasetId,
        methodId: 'stats.descriptive',
        methodVersion: '1.0.0',
        parameters: { fields: ['value'] },
      });
      recipeId = recipe.id;
      expect(recipe).toMatchObject({ revision: 1, datasetId, methodVersion: '1.0.0' });
      expect((await fixture.repository.listRecipes(undefined, 1)).items).toEqual([recipe]);
      expect(
        await fixture.repository.updateRecipe(recipe.id, 99, {
          ...recipe,
          name: 'Conflict',
        }),
      ).toBe('revision-conflict');
      const updated = await fixture.repository.updateRecipe(recipe.id, 1, {
        name: 'Updated descriptive baseline',
        datasetId,
        methodId: recipe.methodId,
        methodVersion: recipe.methodVersion,
        parameters: { fields: ['value', 'score'] },
      });
      expect(updated).toMatchObject({ revision: 2, name: 'Updated descriptive baseline' });
      expect(await fixture.repository.deleteRecipe(recipe.id, 1)).toBe('revision-conflict');
    });

    it('persists Job provenance and saves an idempotent structured Result', async () => {
      jobId = randomUUID();
      await fixture.platform.enqueueJob({
        id: jobId,
        ownerPluginId: 'analytics',
        type: 'analytics.job.execute',
        resourceClass: 'python-heavy',
        payload: { snapshotId },
        maxAttempts: 2,
      });
      const metadata = await fixture.repository.createJobMetadata(jobId, {
        recipeId,
        datasetId,
        snapshotId,
        methodId: 'stats.descriptive',
        methodVersion: '1.0.0',
        parameters: { fields: ['value'] },
      });
      expect(metadata).toMatchObject({ id: jobId, resultId: null, startedAt: null });
      await fixture.repository.markJobStarted(jobId);
      const saved = await fixture.repository.saveResult({
        jobId,
        datasetId,
        snapshotId,
        methodId: 'stats.descriptive',
        methodVersion: '1.0.0',
        summary: { rowCount: 10 },
        metrics: { mean: 5 },
        tables: [{ id: 'descriptive', rows: [{ field: 'value', mean: 5 }] }],
        series: [],
        artifacts: [
          {
            id: randomUUID(),
            kind: 'analysis.table',
            contentType: 'application/vnd.apache.parquet',
            filename: 'table.parquet',
          },
        ],
        warnings: ['sample warning'],
        sampling: { applied: true, inputRows: 100, sampleRows: 10, seed: 42 },
        workerVersion: '1.0.0',
      });
      resultId = saved.id;
      expect(saved).toMatchObject({ id: resultId, jobId, sampling: { applied: true } });
      expect(await fixture.repository.getResult(resultId)).toEqual(saved);
      await expect(
        fixture.repository.saveResult({ ...saved, summary: { ignored: true } }),
      ).resolves.toEqual(saved);
      expect(await fixture.repository.getJobMetadata(jobId)).toMatchObject({
        resultId,
        completedAt: expect.any(String),
      });
    });

    it('owns durable Recipe and Job lifecycle events', async () => {
      const eventTypes = (await fixture.platform.listEvents(0, 1000)).map(({ type }) => type);
      expect(eventTypes).toEqual(
        expect.arrayContaining([
          'analysis.recipe.created',
          'analysis.recipe.updated',
          'analysis.job.created',
          'analysis.job.started',
          'analysis.job.succeeded',
        ]),
      );
    });
  });
}
