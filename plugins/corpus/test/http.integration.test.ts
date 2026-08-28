import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import {
  CorpusBuildService,
  CorpusRecipeService,
  CorpusService,
} from '../src/application/index.js';
import { registerCorpusHttp } from '../src/http/index.js';
import { SqliteCorpusRepository } from '../src/persistence/sqlite/index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Corpus HTTP contract', () => {
  it('enforces idempotency, revisions and RFC 7807 while creating a Build', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-corpus-http-'));
    roots.push(dataDirectory);
    const filePath = join(dataDirectory, 'zhiyun.sqlite3');
    const platform = await openSqlitePlatformRepository({
      dataDirectory,
      filePath,
      graphRevision: 'corpus-http-test',
    });
    const repository = new SqliteCorpusRepository(filePath);
    await repository.migrate();
    const datasetId = crypto.randomUUID();
    const snapshotId = crypto.randomUUID();
    const snapshots = {
      async getSnapshot(id: string) {
        return id === snapshotId
          ? {
              id,
              datasetId,
              sourceRunId: null,
              fingerprint: 'a'.repeat(64),
              status: 'ready' as const,
              parquetArtifactId: crypto.randomUUID(),
            }
          : null;
      },
    };
    const app = Fastify();
    await registerCorpusHttp(app, {
      corpora: new CorpusService(repository),
      recipes: new CorpusRecipeService(repository),
      builds: new CorpusBuildService(repository, platform, snapshots),
      platform,
    });
    try {
      const body = { name: 'Bilingual corpus', datasetId };
      const createdResponse = await app.inject({
        method: 'POST',
        url: '/api/v2/corpora',
        headers: { 'idempotency-key': 'create-corpus' },
        payload: body,
      });
      expect(createdResponse.statusCode).toBe(201);
      const corpus = createdResponse.json();
      expect(createdResponse.headers.etag).toBe('"1"');
      const replayed = await app.inject({
        method: 'POST',
        url: '/api/v2/corpora',
        headers: { 'idempotency-key': 'create-corpus' },
        payload: body,
      });
      expect(replayed.json()).toEqual(corpus);

      const missingRevision = await app.inject({
        method: 'PUT',
        url: `/api/v2/corpora/${corpus.id}`,
        headers: { 'idempotency-key': 'update-corpus' },
        payload: { name: 'Updated', datasetId },
      });
      expect(missingRevision.statusCode).toBe(428);
      expect(missingRevision.headers['content-type']).toContain('application/problem+json');

      const recipeResponse = await app.inject({
        method: 'POST',
        url: `/api/v2/corpora/${corpus.id}/recipes`,
        headers: { 'idempotency-key': 'create-recipe' },
        payload: {
          name: 'Default',
          snapshotPolicy: { mode: 'pinned', snapshotId },
          selectedTextFields: ['title', 'body'],
          metadataFields: ['category'],
          stripHtml: true,
          unicodeNormalization: 'NFKC',
          deduplication: 'exact-and-near',
          nearDuplicateThreshold: 0.9,
          chunkSize: 2000,
          chunkOverlap: 200,
          languagePolicy: 'zh-en-first',
          outputFormats: ['parquet', 'jsonl'],
        },
      });
      expect(recipeResponse.statusCode).toBe(201);
      const recipe = recipeResponse.json();

      const buildResponse = await app.inject({
        method: 'POST',
        url: `/api/v2/corpora/${corpus.id}/builds`,
        headers: { 'idempotency-key': 'create-build' },
        payload: { recipeId: recipe.id, snapshotId },
      });
      expect(buildResponse.statusCode).toBe(202);
      expect(buildResponse.json()).toMatchObject({
        corpusId: corpus.id,
        recipeId: recipe.id,
        snapshotId,
        state: 'queued',
      });
    } finally {
      await app.close();
      await repository.close();
      await platform.close();
    }
  });
});
