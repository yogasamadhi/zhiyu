import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalyticsWorkerClient, AnalyticsWorkerSupervisor } from '@zhiyun/analytics-worker-client';
import { LocalArtifactStore } from '@zhiyun/artifact-store';
import { DurableJobDispatcher, JobHandlerRegistry } from '@zhiyun/platform-core';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { CorpusBuildService, createCorpusBuildHandler } from '../src/application/index.js';
import { SqliteCorpusRepository } from '../src/persistence/sqlite/index.js';

const workspaceRoot = resolve(import.meta.dirname, '../../..');
const python =
  process.platform === 'win32'
    ? join(workspaceRoot, 'services', 'analytics-worker', '.venv', 'Scripts', 'python.exe')
    : join(workspaceRoot, 'services', 'analytics-worker', '.venv', 'bin', 'python');
const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(!existsSync(python))('Corpus executor integration', () => {
  it('builds a reproducible Artifact-only Corpus Version through the actual Worker', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-corpus-executor-'));
    roots.push(dataDirectory);
    const filePath = join(dataDirectory, 'zhiyun.sqlite3');
    const platform = await openSqlitePlatformRepository({
      dataDirectory,
      filePath,
      graphRevision: 'corpus-executor-test',
    });
    const repository = new SqliteCorpusRepository(filePath);
    await repository.migrate();
    const artifacts = new LocalArtifactStore(dataDirectory);
    await artifacts.initialize();
    const supervisor = new AnalyticsWorkerSupervisor({
      command: python,
      args: ['-m', 'zhiyun_analytics_worker'],
      workspaceRoot: join(dataDirectory, 'job-workspaces'),
    });
    const handlers = new JobHandlerRegistry();
    let dispatcher: DurableJobDispatcher | undefined;
    try {
      const connection = await supervisor.start();
      const worker = new AnalyticsWorkerClient(connection);
      const snapshotJobId = 'corpus-fixture-snapshot';
      const snapshotWorkspace = await artifacts.openWorkspace(snapshotJobId);
      await writeFile(
        await snapshotWorkspace.resolve('input.ndjson'),
        [
          record('one', '<h1>知云语料</h1>', '数据清洗。'.repeat(80)),
          record('two', '<h1>知云语料</h1>', '数据清洗。'.repeat(80)),
          record('three', 'English corpus', 'This is a reusable corpus sentence. '.repeat(20)),
        ]
          .map((item) => JSON.stringify(item))
          .join('\n') + '\n',
      );
      await worker.submit({
        jobId: snapshotJobId,
        methodId: 'dataset.normalize_snapshot',
        methodVersion: '1.0.0',
        inputArtifactRef: 'input.ndjson',
        outputArtifactRef: 'normalize-result.json',
        parameters: { fingerprint: 'a'.repeat(64) },
      });
      await waitForTerminal(worker, snapshotJobId);
      const snapshotFile = await artifacts.commitWorkspaceFile(
        snapshotJobId,
        'snapshot.parquet',
        'datasets/corpus-fixture/snapshot.parquet',
      );
      const snapshotArtifact = await platform.createArtifact({
        ownerPluginId: 'datasets',
        kind: 'dataset.snapshot.parquet',
        filename: 'snapshot.parquet',
        contentType: 'application/vnd.apache.parquet',
        ...snapshotFile,
        metadata: {},
      });
      await artifacts.removeWorkspace(snapshotJobId);

      const datasetId = crypto.randomUUID();
      const snapshotId = crypto.randomUUID();
      const corpus = await repository.createCorpus({ name: 'Corpus', datasetId });
      const recipe = await repository.createRecipe(corpus.id, {
        name: 'Default',
        snapshotPolicy: { mode: 'pinned', snapshotId },
        selectedTextFields: ['title', 'body'],
        metadataFields: ['category'],
        stripHtml: true,
        unicodeNormalization: 'NFKC',
        deduplication: 'exact-and-near',
        nearDuplicateThreshold: 0.9,
        chunkSize: 200,
        chunkOverlap: 20,
        languagePolicy: 'zh-en-first',
        outputFormats: ['parquet', 'jsonl', 'markdown'],
      });
      const snapshots = {
        async getSnapshot(id: string) {
          return id === snapshotId
            ? {
                id: snapshotId,
                datasetId,
                sourceRunId: null,
                fingerprint: 'a'.repeat(64),
                status: 'ready' as const,
                parquetArtifactId: snapshotArtifact.id,
              }
            : null;
        },
      };
      const service = new CorpusBuildService(repository, platform, snapshots);
      const created = await service.create(
        corpus.id,
        { recipeId: recipe.id, snapshotId },
        'same-corpus-build',
      );
      const replayed = await service.create(
        corpus.id,
        { recipeId: recipe.id, snapshotId },
        'same-corpus-build',
      );
      expect(replayed.id).toBe(created.id);
      expect((await platform.listJobs({ ownerPluginId: 'corpus' })).length).toBe(1);

      handlers.register({
        type: 'corpus.build.execute',
        ownerPluginId: 'corpus',
        resourceClass: 'python-heavy',
        handler: createCorpusBuildHandler({
          repository,
          platform,
          snapshots,
          artifactStore: artifacts,
          worker,
        }),
      });
      dispatcher = new DurableJobDispatcher(platform, handlers, {
        pollIntervalMs: 10,
        leaseMs: 5_000,
      });
      await dispatcher.tick(created.id);
      await dispatcher.drain();
      const completed = await service.get(created.id);
      expect(completed).toMatchObject({ state: 'succeeded', versionId: expect.any(String) });
      const version = await service.getVersion(completed!.versionId!);
      expect(version).toMatchObject({
        corpusId: corpus.id,
        datasetId,
        snapshotId,
        snapshotFingerprint: 'a'.repeat(64),
        recipeRevision: 1,
        stats: { inputRowCount: 3, documentCount: 2, exactDuplicates: 1 },
        workerVersion: '1.0.0',
      });
      expect(version!.artifacts.map(({ filename }) => filename).sort()).toEqual([
        'chunks.parquet',
        'corpus.jsonl',
        'corpus.md',
        'documents.parquet',
        'manifest.json',
      ]);
      expect(await readdir(join(dataDirectory, 'job-workspaces'))).toEqual([]);
    } finally {
      await dispatcher?.close();
      await supervisor.stop();
      await artifacts.close();
      await repository.close();
      await platform.close();
    }
  }, 60_000);
});

function record(key: string, title: string, body: string) {
  return {
    recordKey: key,
    sourceUrl: `https://example.test/${key}`,
    contentHash: key.padEnd(64, 'a'),
    removed: false,
    data: { title, body, category: key },
  };
}

async function waitForTerminal(worker: AnalyticsWorkerClient, jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const job = await worker.job(jobId);
    if (job.state === 'succeeded') return;
    if (job.state === 'failed' || job.state === 'canceled') throw new Error(JSON.stringify(job));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error('Worker fixture Job timed out');
}
