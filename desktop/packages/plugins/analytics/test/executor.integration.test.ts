import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalyticsWorkerClient, AnalyticsWorkerSupervisor } from '@zhiyun/analytics-worker-client';
import { LocalArtifactStore } from '@zhiyun/artifact-store';
import { DurableJobDispatcher, JobHandlerRegistry } from '@zhiyun/platform-core';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import {
  AnalysisJobService,
  AnalyticsCatalog,
  createAnalysisJobHandler,
} from '../src/application/index.js';
import { SqliteAnalysisRepository } from '../src/persistence/sqlite/index.js';

const workspaceRoot = resolve(import.meta.dirname, '../../../..');
const python =
  process.platform === 'win32'
    ? join(workspaceRoot, 'analytics-worker', '.venv', 'Scripts', 'python.exe')
    : join(workspaceRoot, 'analytics-worker', '.venv', 'bin', 'python');
const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe.skipIf(!existsSync(python))('Analytics executor integration', () => {
  it('runs a persisted idempotent Job against an immutable Snapshot', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-analysis-executor-'));
    roots.push(dataDirectory);
    const filePath = join(dataDirectory, 'zhiyun.sqlite3');
    const platform = await openSqlitePlatformRepository({
      dataDirectory,
      filePath,
      graphRevision: 'analytics-executor-test',
    });
    const repository = new SqliteAnalysisRepository(filePath);
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
      const snapshotJobId = 'analytics-fixture-snapshot';
      const snapshotWorkspace = await artifacts.openWorkspace(snapshotJobId);
      await writeFile(
        await snapshotWorkspace.resolve('input.ndjson'),
        [
          {
            recordKey: 'one',
            sourceUrl: 'https://example.test/1',
            contentHash: 'a'.repeat(64),
            removed: false,
            data: { value: 10, score: 1.5 },
          },
          {
            recordKey: 'two',
            sourceUrl: 'https://example.test/2',
            contentHash: 'b'.repeat(64),
            removed: false,
            data: { value: 20, score: 2.5 },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
      );
      await worker.submit({
        jobId: snapshotJobId,
        methodId: 'dataset.normalize_snapshot',
        methodVersion: '1.0.0',
        inputArtifactRef: 'input.ndjson',
        outputArtifactRef: 'normalize-result.json',
        parameters: { fingerprint: 'c'.repeat(64) },
      });
      await waitForTerminal(worker, snapshotJobId);
      const snapshotFile = await artifacts.commitWorkspaceFile(
        snapshotJobId,
        'snapshot.parquet',
        'datasets/fixture/snapshot.parquet',
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
      const snapshots = {
        async getSnapshot(id: string) {
          return id === snapshotId
            ? {
                id: snapshotId,
                datasetId,
                status: 'ready' as const,
                parquetArtifactId: snapshotArtifact.id,
              }
            : null;
        },
      };
      const service = new AnalysisJobService(
        repository,
        platform,
        snapshots,
        new AnalyticsCatalog(worker),
      );
      const input = {
        datasetId,
        snapshotId,
        methodId: 'stats.descriptive',
        methodVersion: '1.0.0',
        parameters: { fields: ['value', 'score'] },
      };
      const created = await service.create(input, 'same-request');
      const replayed = await service.create(input, 'same-request');
      expect(replayed.id).toBe(created.id);
      expect((await platform.listJobs({ ownerPluginId: 'analytics' })).length).toBe(1);
      await expect(
        service.create({ ...input, parameters: { fields: ['value'] } }, 'same-request'),
      ).rejects.toMatchObject({ code: 'ANALYSIS_JOB_CONFLICT' });

      handlers.register({
        type: 'analytics.job.execute',
        ownerPluginId: 'analytics',
        resourceClass: 'python-heavy',
        handler: createAnalysisJobHandler({
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
      expect(completed).toMatchObject({
        state: 'succeeded',
        progress: 1,
        resultId: expect.any(String),
      });
      const result = await service.result(completed!.resultId!);
      expect(result).toMatchObject({
        jobId: created.id,
        methodId: 'stats.descriptive',
        sampling: { applied: false, inputRows: 2, sampleRows: 2 },
        workerVersion: '1.0.0',
      });
      expect(result!.tables[0]).toMatchObject({ id: 'descriptive' });
      expect(await readdir(join(dataDirectory, 'job-workspaces'))).toEqual([]);
    } finally {
      await dispatcher?.close();
      await supervisor.stop();
      await artifacts.close();
      await repository.close();
      await platform.close();
    }
  }, 45_000);
});

async function waitForTerminal(worker: AnalyticsWorkerClient, jobId: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const job = await worker.job(jobId);
    if (job.state === 'succeeded') return;
    if (job.state === 'failed' || job.state === 'canceled') throw new Error(JSON.stringify(job));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error('Worker fixture Job timed out');
}
