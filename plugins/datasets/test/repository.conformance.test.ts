import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformRepository } from '@zhiyun/platform-core';
import { openPostgresPlatformRepository } from '@zhiyun/storage-postgres-v1';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import type { DatasetRepository } from '../src/contracts/index.js';
import { PostgresDatasetRepository } from '../src/persistence/postgres/index.js';
import { SqliteDatasetRepository } from '../src/persistence/sqlite/index.js';
import { DatasetFingerprintBuilder } from '../src/domain/index.js';

interface Fixture {
  repository: DatasetRepository;
  platform: PlatformRepository;
  dispose(): Promise<void>;
}

defineDatasetConformance('SQLite', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-datasets-sqlite-'));
  const filePath = join(dataDirectory, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory,
    filePath,
    graphRevision: 'datasets-test',
  });
  const repository = new SqliteDatasetRepository(filePath);
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

defineDatasetConformance('PostgreSQL', async () => {
  const database = await createTemporaryDatabase();
  const platform = await openPostgresPlatformRepository({
    connectionString: database.connectionString,
    graphRevision: 'datasets-test',
  });
  const repository = new PostgresDatasetRepository(database.connectionString);
  await repository.migrate();
  return {
    repository,
    platform,
    async dispose() {
      await repository.close();
      await platform.close();
      await database.drop();
    },
  };
});

function defineDatasetConformance(name: string, create: () => Promise<Fixture>): void {
  describe(`${name} DatasetRepository conformance`, () => {
    let fixture: Fixture;
    const sourceTaskId = randomUUID();
    const firstRunId = randomUUID();
    let datasetId = '';
    let secondFingerprint = '';

    beforeAll(async () => {
      fixture = await create();
    });

    afterAll(async () => {
      if (fixture) await fixture.dispose();
    });

    it('records its forward-only Plugin migration', async () => {
      expect(await fixture.platform.listMigrations()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: 'datasets',
            migrationId: '001-initial',
            pluginVersion: '1.0.0',
          }),
        ]),
      );
    });

    it('projects the first Run under an independent Dataset ID', async () => {
      const committed = await fixture.repository.commitRunRecords({
        sourceTaskId,
        sourceRunId: firstRunId,
        settings: { mode: 'snapshot', keyFields: ['id'], detectRemoved: true },
        records: [
          { sourceUrl: 'https://example.com/1', data: { id: 1, name: 'A' } },
          { sourceUrl: 'https://example.com/2', data: { id: 2, name: 'B' } },
        ],
      });
      datasetId = committed.dataset.id;
      expect(datasetId).not.toBe(sourceTaskId);
      expect(committed).toMatchObject({
        reused: false,
        stats: { added: 2, updated: 0, removed: 0, unchanged: 0, current: 2 },
        snapshot: { status: 'projected', rowCount: 2 },
      });
      expect(committed.snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(await fixture.repository.getDatasetBySourceTask(sourceTaskId)).toEqual(
        committed.dataset,
      );
    });

    it('reuses a committed sourceRunId without applying input twice', async () => {
      const repeated = await fixture.repository.commitRunRecords({
        sourceTaskId,
        sourceRunId: firstRunId,
        settings: { mode: 'snapshot', keyFields: ['id'], detectRemoved: true },
        records: [{ sourceUrl: 'https://example.com/ignored', data: { id: 99 } }],
      });
      expect(repeated).toMatchObject({ reused: true, stats: { added: 2, current: 2 } });
      expect((await fixture.repository.listRecords(datasetId)).items).toHaveLength(2);
    });

    it('tracks updates, removals and additions as Dataset-owned changes', async () => {
      const secondRunId = randomUUID();
      const committed = await fixture.repository.commitRunRecords({
        sourceTaskId,
        sourceRunId: secondRunId,
        settings: { mode: 'snapshot', keyFields: ['id'], detectRemoved: true },
        records: [
          { sourceUrl: 'https://example.com/3', data: { id: 3, name: 'C' } },
          { sourceUrl: 'https://example.com/1', data: { id: 1, name: 'A2' } },
        ],
      });
      secondFingerprint = committed.snapshot.fingerprint;
      expect(committed.stats).toEqual({
        added: 1,
        updated: 1,
        removed: 1,
        unchanged: 0,
        current: 2,
      });
      const current = await fixture.repository.listRecords(datasetId, undefined, 100);
      expect(current.items.map(({ data }) => data.id).sort()).toEqual([1, 3]);
      const all = await fixture.repository.listRecords(datasetId, undefined, 100, {
        includeRemoved: true,
      });
      expect(all.items).toHaveLength(3);
      const changes = await fixture.repository.listChanges(datasetId, undefined, 100, secondRunId);
      expect(changes.items.map(({ type }) => type).sort()).toEqual(['added', 'removed', 'updated']);
    });

    it('builds the same fingerprint for equal content regardless of Run or input order', async () => {
      const committed = await fixture.repository.commitRunRecords({
        sourceTaskId,
        sourceRunId: randomUUID(),
        settings: { mode: 'snapshot', keyFields: ['id'], detectRemoved: true },
        records: [
          { sourceUrl: 'https://example.com/1', data: { name: 'A2', id: 1 } },
          { sourceUrl: 'https://example.com/3', data: { name: 'C', id: 3 } },
        ],
      });
      expect(committed.snapshot.fingerprint).toBe(secondFingerprint);
      expect(committed.stats).toMatchObject({ unchanged: 2, current: 2 });
      expect(
        await fixture.repository.findSnapshotByFingerprint(datasetId, secondFingerprint),
      ).not.toBeNull();
      const events = await fixture.platform.listEvents(0, 1_000);
      expect(events.map(({ type }) => type)).toContain('dataset.projected');
    });

    it('streams one consistent ordered view and atomically materializes its Snapshot', async () => {
      const streamed = await fixture.repository.withConsistentSnapshotRead(
        datasetId,
        async ({ dataset, records }) => {
          const builder = new DatasetFingerprintBuilder(dataset.schemaVersion, dataset.settings);
          const keys: string[] = [];
          for await (const record of records) {
            keys.push(record.recordKey);
            builder.add(record);
          }
          return { keys, fingerprint: builder.digest() };
        },
      );
      expect(streamed.keys).toEqual([...streamed.keys].sort());
      expect(streamed.fingerprint).toBe(secondFingerprint);
      const claim = await fixture.repository.claimSnapshotMaterialization(
        datasetId,
        secondFingerprint,
      );
      expect(claim).toMatchObject({
        claimed: true,
        reused: false,
        snapshot: { status: 'preparing' },
      });
      const ready = await fixture.repository.completeSnapshotMaterialization({
        snapshotId: claim.snapshot.id,
        parquetArtifactId: randomUUID(),
        manifestArtifactId: randomUUID(),
        rowCount: 2,
        warnings: ['fixture warning'],
      });
      expect(ready).toMatchObject({ status: 'ready', rowCount: 2, warnings: ['fixture warning'] });
      await expect(
        fixture.repository.claimSnapshotMaterialization(datasetId, secondFingerprint),
      ).resolves.toMatchObject({ claimed: false, reused: true, snapshot: { id: ready.id } });
    });
  });
}

async function createTemporaryDatabase(): Promise<{
  connectionString: string;
  drop(): Promise<void>;
}> {
  const baseConnectionString =
    process.env.DATABASE_URL ?? 'postgresql://zhiyun:zhiyun@localhost:45432/zhiyun';
  const databaseName = `zhiyun_datasets_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(baseConnectionString);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  await admin.end();
  const databaseUrl = new URL(baseConnectionString);
  databaseUrl.pathname = `/${databaseName}`;
  return {
    connectionString: databaseUrl.toString(),
    async drop() {
      const cleanup = postgres(adminUrl.toString(), { max: 1 });
      await cleanup`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname=${databaseName} AND pid<>pg_backend_pid()
      `;
      await cleanup.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await cleanup.end();
    },
  };
}
