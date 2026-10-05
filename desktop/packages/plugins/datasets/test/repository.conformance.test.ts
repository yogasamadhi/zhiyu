import { compareDatasetRuns } from '../src/application/diff.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformRepository } from '@zhiyun/platform-core';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import type { DatasetRepository } from '../src/contracts/index.js';
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

    it('queries all pages with Unicode fields, dates, nulls and matching consistent exports', async () => {
      const taskId = randomUUID(),
        runId = randomUUID();
      const records = Array.from({ length: 130 }, (_, index) => ({
        sourceUrl: `https://example.com/${index}`,
        data: {
          编号: index,
          名称: index % 2 === 0 ? '中文商品' : 'Other',
          价格: index,
          日期:
            index === 0
              ? 'invalid'
              : `2026-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00Z`,
          空值: index % 3 === 0 ? null : 'ok',
        },
      }));
      const { dataset } = await fixture.repository.commitRunRecords({
        sourceTaskId: taskId,
        sourceRunId: runId,
        settings: { mode: 'snapshot', keyFields: ['编号'], detectRemoved: true },
        records,
      });
      const originalPage = await fixture.repository.listRecords(dataset.id, undefined, 7);
      const last = originalPage.items.at(-1)!;
      const legacyCursor = Buffer.from(
        JSON.stringify({ at: last.lastSeenAt, id: last.id }),
      ).toString('base64url');
      const legacyNext = await fixture.repository.listRecords(dataset.id, legacyCursor, 7);
      const modernNext = await fixture.repository.listRecords(
        dataset.id,
        originalPage.nextCursor!,
        7,
      );
      expect(legacyNext.items.map((record) => record.id)).toEqual(
        modernNext.items.map((record) => record.id),
      );
      const options = {
        query: '中文',
        filters: [{ field: '价格', operator: 'gte' as const, value: 50, type: 'number' as const }],
        sort: { field: '价格', direction: 'asc' as const, type: 'number' as const },
      };
      const all: number[] = [];
      let cursor: string | undefined;
      do {
        const page = await fixture.repository.listRecords(dataset.id, cursor, 7, options);
        expect(page.totalCount).toBe(130);
        expect(page.matchedCount).toBe(40);
        all.push(...page.items.map((r) => r.data.价格 as number));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(all).toEqual(Array.from({ length: 40 }, (_, index) => 50 + index * 2));
      const exported = await fixture.repository.withConsistentSnapshotRead(
        dataset.id,
        async (read) => {
          const rows: number[] = [];
          for await (const record of read.records) rows.push(record.data.价格 as number);
          return rows;
        },
        options,
      );
      expect(exported).toEqual(all);
      const first = await fixture.repository.listRecords(dataset.id, undefined, 7, options);
      await expect(
        fixture.repository.listRecords(dataset.id, first.nextCursor!, 7, {
          ...options,
          query: 'Other',
        }),
      ).rejects.toThrow();
      expect(
        (
          await fixture.repository.listRecords(dataset.id, undefined, 5, {
            filters: [{ field: '空值', operator: 'empty' }],
          })
        ).matchedCount,
      ).toBe(44);
      expect(
        (
          await fixture.repository.listRecords(dataset.id, undefined, 1, {
            filter: { missing: null },
          })
        ).matchedCount,
      ).toBe(0);
      expect(
        (
          await fixture.repository.listRecords(dataset.id, undefined, 1, {
            filters: [{ field: 'missing', operator: 'empty' }],
          })
        ).matchedCount,
      ).toBe(130);
      const dates = await fixture.repository.listRecords(dataset.id, undefined, 500, {
        filters: [{ field: '日期', operator: 'gt', type: 'date', value: '2026-01-20' }],
      });
      expect(
        dates.items.every((r) => Date.parse(String(r.data.日期)) > Date.parse('2026-01-20')),
      ).toBe(true);
    });

    it('compares both selected runs and counts differences beyond the requested page', async () => {
      const task = randomUUID(),
        run1 = randomUUID(),
        run2 = randomUUID(),
        run3 = randomUUID();
      const settings = { mode: 'snapshot' as const, keyFields: ['id'], detectRemoved: true };
      const rows = (start: number, end: number, value: string) =>
        Array.from({ length: end - start }, (_, i) => ({
          sourceUrl: 'https://example.com',
          data: { id: i + start, value },
        }));
      const first = await fixture.repository.commitRunRecords({
        sourceTaskId: task,
        sourceRunId: run1,
        settings,
        records: rows(0, 80, 'a'),
      });
      await fixture.repository.commitRunRecords({
        sourceTaskId: task,
        sourceRunId: run2,
        settings,
        records: rows(20, 100, 'b'),
      });
      await fixture.repository.commitRunRecords({
        sourceTaskId: task,
        sourceRunId: run3,
        settings,
        records: rows(20, 100, 'b'),
      });
      const diff = await compareDatasetRuns(
        fixture.repository,
        first.dataset.id,
        run1,
        run3,
        undefined,
        5,
      );
      expect(diff.items).toHaveLength(5);
      expect(diff.stats).toEqual({ added: 20, updated: 60, removed: 20 });
      expect(diff.nextCursor).not.toBeNull();
      expect(
        (await compareDatasetRuns(fixture.repository, first.dataset.id, run2, run3)).stats,
      ).toEqual({ added: 0, updated: 0, removed: 0 });
      expect(
        (await compareDatasetRuns(fixture.repository, first.dataset.id, run3, run1)).stats,
      ).toEqual({ added: 20, updated: 60, removed: 20 });
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
