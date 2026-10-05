import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import { registerDatasetsHttp } from '../src/http/index.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AnalyticsWorkerClient, AnalyticsWorkerSupervisor } from '@zhiyun/analytics-worker-client';
import { LocalArtifactStore } from '@zhiyun/artifact-store';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { DatasetSnapshotService } from '../src/application/index.js';
import { SqliteDatasetRepository } from '../src/persistence/sqlite/index.js';

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

describe.skipIf(!existsSync(python))('DatasetSnapshotService integration', () => {
  it('streams SQLite records through the Worker into reusable immutable Artifacts', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-snapshot-service-'));
    roots.push(dataDirectory);
    const filePath = join(dataDirectory, 'zhiyun.sqlite3');
    const platform = await openSqlitePlatformRepository({
      dataDirectory,
      filePath,
      graphRevision: 'snapshot-service-test',
    });
    const repository = new SqliteDatasetRepository(filePath);
    await repository.migrate();
    const artifacts = new LocalArtifactStore(dataDirectory);
    await artifacts.initialize();
    const supervisor = new AnalyticsWorkerSupervisor({
      command: python,
      args: ['-m', 'zhiyun_analytics_worker'],
      workspaceRoot: join(dataDirectory, 'job-workspaces'),
    });
    const app = Fastify();
    try {
      const connection = await supervisor.start();
      const committed = await repository.commitRunRecords({
        sourceTaskId: crypto.randomUUID(),
        sourceRunId: crypto.randomUUID(),
        settings: { mode: 'snapshot', keyFields: ['id'], detectRemoved: true },
        records: [
          {
            sourceUrl: 'https://example.test/1',
            data: {
              __zhiyun_record_key: 'original-1',
              中文字段: '第一行',
              id: 1,
              score: 10,
              occurredAt: '2026-01-01',
              nested: { value: 1 },
            },
          },
          {
            sourceUrl: 'https://example.test/2',
            data: {
              __zhiyun_record_key: 'original-2',
              中文字段: '第二行',
              id: 2,
              score: 12.5,
              occurredAt: '2026-01-02T00:00:00Z',
              nested: [1],
            },
          },
        ],
      });
      const service = new DatasetSnapshotService(
        repository,
        platform,
        artifacts,
        new AnalyticsWorkerClient(connection),
        { pollIntervalMs: 10, timeoutMs: 30_000 },
      );
      await registerDatasetsHttp(app, {
        repository,
        snapshots: service,
        platform,
        artifactStore: artifacts,
      });
      const pendingSchema = await app.inject({
        method: 'GET',
        url: `/api/v2/datasets/${committed.dataset.id}/fields?snapshotId=${committed.snapshot.id}`,
      });
      expect(pendingSchema.statusCode).toBe(409);
      const materialized = await service.materialize(committed.dataset.id);
      expect(materialized).toMatchObject({
        reused: false,
        inProgress: false,
        snapshot: {
          status: 'ready',
          fingerprint: committed.snapshot.fingerprint,
          rowCount: 2,
        },
      });
      const parquetArtifact = await platform.getArtifact(materialized.snapshot.parquetArtifactId!);
      const manifestArtifact = await platform.getArtifact(
        materialized.snapshot.manifestArtifactId!,
      );
      expect(parquetArtifact).not.toBeNull();
      expect(manifestArtifact).not.toBeNull();
      const parquet = await readFile(await artifacts.resolveArtifact(parquetArtifact!.storageKey));
      expect(parquet.subarray(0, 4).toString('ascii')).toBe('PAR1');
      expect(parquet.subarray(-4).toString('ascii')).toBe('PAR1');
      const manifest = JSON.parse(
        await readFile(await artifacts.resolveArtifact(manifestArtifact!.storageKey), 'utf8'),
      ) as { fingerprint: string; rowCount: number };
      expect(manifest).toMatchObject({ fingerprint: committed.snapshot.fingerprint, rowCount: 2 });
      const schemaResponse = await app.inject({
        method: 'GET',
        url: `/api/v2/datasets/${committed.dataset.id}/fields?snapshotId=${materialized.snapshot.id}`,
      });
      expect(schemaResponse.statusCode).toBe(200);
      const schema = schemaResponse.json();
      expect(schema).toMatchObject({
        sampled: false,
        sampleCount: 2,
        fields: expect.arrayContaining([
          expect.objectContaining({ name: 'id', type: 'number' }),
          expect.objectContaining({ name: '中文字段', label: '中文字段', type: 'text' }),
          expect.objectContaining({ name: 'occurredAt', type: 'date' }),
        ]),
      });
      const reserved = schema.fields.find(
        (field: { label: string }) => field.label === '__zhiyun_record_key',
      );
      expect(reserved.name).not.toBe('__zhiyun_record_key');
      const sampled = (
        await app.inject({ method: 'GET', url: `/api/v2/datasets/${committed.dataset.id}/fields` })
      ).json();
      expect(sampled).toMatchObject({ sampled: true, sampleCount: 2 });

      await expect(service.materialize(committed.dataset.id)).resolves.toMatchObject({
        reused: true,
        inProgress: false,
        snapshot: { id: materialized.snapshot.id },
      });
      expect(await readdir(join(dataDirectory, 'job-workspaces'))).toEqual([]);
      expect((await platform.listEvents(0, 100)).map(({ type }) => type)).toContain(
        'dataset.snapshot.ready',
      );
    } finally {
      await app.close();
      await supervisor.stop();
      await artifacts.close();
      await repository.close();
      await platform.close();
    }
  }, 45_000);
});
