import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformRepository } from '@zhiyun/platform-core';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import type { CorpusRepository, CreateCorpusRecipeInput } from '../src/contracts/index.js';
import { SqliteCorpusRepository } from '../src/persistence/sqlite/index.js';

interface Fixture {
  repository: CorpusRepository;
  platform: PlatformRepository;
  dispose(): Promise<void>;
}

defineCorpusConformance('SQLite', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-corpus-sqlite-'));
  const filePath = join(dataDirectory, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory,
    filePath,
    graphRevision: 'corpus-test',
  });
  const repository = new SqliteCorpusRepository(filePath);
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

function defineCorpusConformance(name: string, create: () => Promise<Fixture>): void {
  describe(`${name} CorpusRepository conformance`, () => {
    let fixture: Fixture;
    const datasetId = randomUUID();
    const snapshotId = randomUUID();
    let corpusId = '';
    let recipeId = '';
    let buildId = '';
    let versionId = '';

    beforeAll(async () => {
      fixture = await create();
    });

    afterAll(async () => {
      if (fixture) await fixture.dispose();
    });

    it('records the forward-only Corpus migration', async () => {
      expect(await fixture.platform.listMigrations()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: 'corpus',
            migrationId: '001-initial',
            pluginVersion: '1.0.0',
          }),
        ]),
      );
    });

    it('creates, pages and revision-guards Corpora and Recipes', async () => {
      const corpus = await fixture.repository.createCorpus({ name: 'Bilingual corpus', datasetId });
      corpusId = corpus.id;
      expect((await fixture.repository.listCorpora(undefined, 1)).items).toEqual([corpus]);
      expect(
        await fixture.repository.updateCorpus(corpus.id, 99, { name: 'Conflict', datasetId }),
      ).toBe('revision-conflict');
      expect(
        await fixture.repository.updateCorpus(corpus.id, 1, { name: 'Updated corpus', datasetId }),
      ).toMatchObject({ name: 'Updated corpus', revision: 2 });

      const recipe = await fixture.repository.createRecipe(corpus.id, recipeInput());
      recipeId = recipe.id;
      expect(recipe).toMatchObject({ corpusId, datasetId, revision: 1, chunkSize: 2000 });
      expect(await fixture.repository.listRecipes(corpus.id)).toEqual([recipe]);
      expect(await fixture.repository.updateRecipe(corpus.id, recipe.id, 99, recipeInput())).toBe(
        'revision-conflict',
      );
      expect(
        await fixture.repository.updateRecipe(corpus.id, recipe.id, 1, {
          ...recipeInput(),
          name: 'Updated recipe',
        }),
      ).toMatchObject({ revision: 2, name: 'Updated recipe' });
    });

    it('persists Build provenance and an idempotent Artifact-only Version', async () => {
      buildId = randomUUID();
      await fixture.platform.enqueueJob({
        id: buildId,
        ownerPluginId: 'corpus',
        type: 'corpus.build.execute',
        resourceClass: 'python-heavy',
        payload: { snapshotId },
        maxAttempts: 2,
      });
      await fixture.repository.createBuildMetadata(buildId, {
        corpusId,
        recipeId,
        recipeRevision: 2,
        datasetId,
        snapshotId,
      });
      await fixture.repository.markBuildStarted(buildId);
      const input = {
        corpusId,
        buildId,
        datasetId,
        snapshotId,
        snapshotFingerprint: 'a'.repeat(64),
        recipeId,
        recipeRevision: 2,
        fingerprint: 'b'.repeat(64),
        workerVersion: '1.0.0',
        stats: {
          inputRowCount: 10,
          documentCount: 8,
          chunkCount: 12,
          characterCount: 1000,
          failureCount: 0,
          exactDuplicates: 1,
          nearDuplicates: 1,
          languages: { zh: 4, en: 4 },
        },
        artifacts: [
          {
            id: randomUUID(),
            kind: 'corpus.documents',
            contentType: 'application/vnd.apache.parquet',
            filename: 'documents.parquet',
            checksum: 'c'.repeat(64),
            size: 100,
          },
        ],
      };
      const version = await fixture.repository.saveVersion(input);
      versionId = version.id;
      expect(version).toMatchObject({ fingerprint: 'b'.repeat(64), stats: { documentCount: 8 } });
      await expect(fixture.repository.saveVersion(input)).resolves.toEqual(version);
      expect(await fixture.repository.findVersion(corpusId, 'b'.repeat(64))).toEqual(version);
      expect(await fixture.repository.getVersion(versionId)).toEqual(version);
      expect(await fixture.repository.listVersions(corpusId)).toEqual([version]);
      expect(await fixture.repository.getBuildMetadata(buildId)).toMatchObject({
        versionId,
        completedAt: expect.any(String),
      });
    });

    it('owns durable Corpus lifecycle events', async () => {
      const eventTypes = (await fixture.platform.listEvents(0, 1000)).map(({ type }) => type);
      expect(eventTypes).toEqual(
        expect.arrayContaining([
          'corpus.created',
          'corpus.recipe.created',
          'corpus.build.created',
          'corpus.build.started',
          'corpus.version.created',
        ]),
      );
    });
  });
}

function recipeInput(): CreateCorpusRecipeInput {
  return {
    name: 'Default corpus recipe',
    snapshotPolicy: { mode: 'latest' as const },
    selectedTextFields: ['title', 'body'],
    metadataFields: ['category'],
    stripHtml: true,
    unicodeNormalization: 'NFKC' as const,
    deduplication: 'exact-and-near' as const,
    nearDuplicateThreshold: 0.9,
    chunkSize: 2000,
    chunkOverlap: 200,
    languagePolicy: 'zh-en-first' as const,
    outputFormats: ['parquet', 'jsonl'],
  };
}
