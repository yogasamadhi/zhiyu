import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { SqliteDatasetRepository } from '../src/persistence/sqlite/index.js';
import type { DatasetBatchInput, DatasetIngestionInput } from '../src/contracts/index.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of cleanups.splice(0).reverse())
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  if (errors.length) throw new AggregateError(errors, 'Batch fixture cleanup failed');
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const fingerprint = hash('rule-version-and-config-1');
const row = (id: string, value: number) => ({
  sourceUrl: `https://fixture.invalid/${id}`,
  data: { id, value },
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-batch-ingestion-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory: directory,
    filePath,
    graphRevision: 'batch-ingestion-test',
  });
  cleanups.push(() => platform.close());
  let repository = new SqliteDatasetRepository(filePath);
  cleanups.push(() => repository.close());
  await repository.migrate();
  return {
    get repository() {
      return repository;
    },
    async reopen() {
      await repository.close();
      repository = new SqliteDatasetRepository(filePath);
      await repository.migrate();
    },
  };
}
function ingestion(
  sourceTaskId = randomUUID(),
  sourceRunId = randomUUID(),
  strategy: DatasetIngestionInput['dedupe']['strategy'] = 'none',
  mode: DatasetIngestionInput['settings']['mode'] = 'snapshot',
): DatasetIngestionInput {
  return {
    sourceTaskId,
    sourceRunId,
    fingerprint,
    settings: { mode, keyFields: ['id'], detectRemoved: mode === 'snapshot' },
    dedupe: { strategy, fields: strategy === 'fields' ? ['id'] : [] },
  };
}
function batch(
  input: DatasetIngestionInput,
  label: string,
  records: DatasetBatchInput['records'],
): DatasetBatchInput {
  const batchKey = hash(label);
  return {
    sourceRunId: input.sourceRunId,
    fingerprint: input.fingerprint,
    batchKey,
    checksum: hash(JSON.stringify(records)),
    artifactKey: `collection-batches/${input.sourceRunId}/${batchKey}.json`,
    records,
    maxRecords: 10000,
  };
}
describe('durable bounded Dataset ingestion', () => {
  it('replays a committed batch after reopening and projects the same rows, fingerprint and statistics as the array path', async () => {
    const f = await fixture();
    const input = ingestion();
    expect(await f.repository.beginIngestion(input)).toEqual({
      acceptedCount: 0,
      committed: false,
    });
    const first = batch(input, 'page-1-batch-0', [row('a', 1), row('b', 2)]);
    expect(await f.repository.stageBatch(first)).toEqual({
      acceptedCount: 2,
      totalCount: 2,
      reused: false,
    });
    expect(await f.repository.getDatasetBySourceTask(input.sourceTaskId)).toBeNull();
    await f.reopen();
    expect(await f.repository.beginIngestion(input)).toEqual({
      acceptedCount: 2,
      committed: false,
    });
    expect(await f.repository.stageBatch(first)).toEqual({
      acceptedCount: 2,
      totalCount: 2,
      reused: true,
    });
    const second = batch(input, 'page-2-batch-0', [row('a', 3), row('c', 4)]);
    expect((await f.repository.stageBatch(second)).totalCount).toBe(4);
    const projected = await f.repository.commitIngestion(input.sourceRunId, fingerprint);
    const ordinary = await f.repository.commitRunRecords({
      sourceTaskId: randomUUID(),
      sourceRunId: randomUUID(),
      settings: input.settings,
      records: [...first.records, ...second.records],
    });
    expect(projected.snapshot.fingerprint).toBe(ordinary.snapshot.fingerprint);
    expect(projected.stats).toEqual(ordinary.stats);
    expect(projected.stats).toEqual({ added: 3, updated: 0, removed: 0, unchanged: 0, current: 3 });
    expect(
      (await f.repository.listRunRecords(input.sourceRunId)).items
        .map((item) => item.data)
        .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    ).toEqual([row('a', 3).data, row('b', 2).data, row('c', 4).data]);
    await f.reopen();
    expect((await f.repository.commitIngestion(input.sourceRunId, fingerprint)).reused).toBe(true);
    expect(await f.repository.listSnapshots(projected.dataset.id)).toHaveLength(1);
    expect((await f.repository.stageBatch(first)).reused).toBe(true);
  });
  it.each(['hash', 'fields', 'none'] as const)(
    'keeps %s deduplication across durable batches',
    async (strategy) => {
      const f = await fixture();
      const input = ingestion(undefined, undefined, strategy, 'append');
      await f.repository.beginIngestion(input);
      await f.repository.stageBatch(batch(input, 'one', [row('a', 1), row('b', 2)]));
      const staged = await f.repository.stageBatch(batch(input, 'two', [row('a', 1), row('a', 3)]));
      const expected = strategy === 'fields' ? 2 : strategy === 'hash' ? 3 : 4;
      expect(staged.totalCount).toBe(expected);
      const result = await f.repository.commitIngestion(input.sourceRunId, fingerprint);
      expect(result.stats.current).toBe(expected);
      expect((await f.repository.listRunRecords(input.sourceRunId)).items).toHaveLength(expected);
      expect(result.stats.added).toBe(expected);
    },
  );
  it('projects every staged row across bounded read pages without changing the array-path fingerprint', async () => {
    const f = await fixture();
    const input = ingestion();
    const records = Array.from({ length: 1001 }, (_, i) => row(String(i), i));
    await f.repository.beginIngestion(input);
    for (let offset = 0; offset < records.length; offset += 500) {
      const result = await f.repository.stageBatch(
        batch(input, `page-${offset}`, records.slice(offset, offset + 500)),
      );
      expect(result.totalCount).toBe(Math.min(offset + 500, records.length));
    }
    await f.reopen();
    const result = await f.repository.commitIngestion(input.sourceRunId, fingerprint);
    const ordinary = await f.repository.commitRunRecords({
      sourceTaskId: randomUUID(),
      sourceRunId: randomUUID(),
      settings: input.settings,
      records,
    });
    expect(result.snapshot.fingerprint).toBe(ordinary.snapshot.fingerprint);
    expect(result.stats).toEqual(ordinary.stats);
    expect(result.stats.current).toBe(1001);
    let cursor: string | undefined;
    const ids = new Set<string>();
    do {
      const page = await f.repository.listRunRecords(input.sourceRunId, cursor, 200);
      for (const record of page.items) ids.add(String(record.data.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids.size).toBe(1001);
    expect(await f.repository.listSnapshots(result.dataset.id)).toHaveLength(1);
  });
  it('rejects changed rule/configuration, changed replay payload, invalid checksums and oversized batches without replacing staged rows', async () => {
    const f = await fixture();
    const input = ingestion();
    await f.repository.beginIngestion(input);
    const saved = batch(input, 'stable-key', [row('a', 1)]);
    await f.repository.stageBatch(saved);
    await expect(
      f.repository.beginIngestion({ ...input, fingerprint: hash('another-rule') }),
    ).rejects.toThrow('configuration changed');
    await expect(
      f.repository.beginIngestion({
        ...input,
        settings: { ...input.settings, keyFields: ['value'] },
      }),
    ).rejects.toThrow('configuration changed');
    await expect(
      f.repository.stageBatch({ ...saved, fingerprint: hash('another-rule') }),
    ).rejects.toThrow('checkpoint does not match');
    await expect(
      f.repository.stageBatch(batch(input, 'stable-key', [row('a', 999)])),
    ).rejects.toThrow('contents changed');
    await expect(f.repository.stageBatch({ ...saved, checksum: hash('wrong') })).rejects.toThrow(
      'checksum',
    );
    await expect(
      f.repository.stageBatch(
        batch(
          input,
          'oversized',
          Array.from({ length: 501 }, (_, i) => row(String(i), i)),
        ),
      ),
    ).rejects.toThrow('oversized');
    const result = await f.repository.commitIngestion(input.sourceRunId, fingerprint);
    expect((await f.repository.listRecords(result.dataset.id)).items[0]?.data).toEqual({
      id: 'a',
      value: 1,
    });
    expect(await f.repository.listSnapshots(result.dataset.id)).toHaveLength(1);
  });
  it('discards only uncommitted staging, keeps other runs, and preserves existing Snapshot metadata', async () => {
    const f = await fixture();
    const input = ingestion();
    const old = await f.repository.commitRunRecords({
      sourceTaskId: input.sourceTaskId,
      sourceRunId: randomUUID(),
      settings: input.settings,
      records: [row('a', 1)],
    });
    const original = await f.repository.getSnapshot(old.snapshot.id);
    await f.repository.beginIngestion(input);
    await f.repository.stageBatch(batch(input, 'to-cancel', [row('a', 999)]));
    const other = ingestion();
    await f.repository.beginIngestion(other);
    await f.repository.stageBatch(batch(other, 'keep-other', [row('b', 2)]));
    await f.repository.discardIngestion(input.sourceRunId);
    expect((await f.repository.listRecords(old.dataset.id)).items[0]?.data).toEqual({
      id: 'a',
      value: 1,
    });
    expect(await f.repository.getSnapshot(old.snapshot.id)).toEqual(original);
    await expect(f.repository.commitIngestion(input.sourceRunId, fingerprint)).rejects.toThrow(
      'does not match',
    );
    expect((await f.repository.commitIngestion(other.sourceRunId, fingerprint)).stats.current).toBe(
      1,
    );
  });
  it('projects removals over multiple bounded pages and keeps prior Snapshots immutable', async () => {
    const f = await fixture();
    const input = ingestion();
    const old = await f.repository.commitRunRecords({
      sourceTaskId: input.sourceTaskId,
      sourceRunId: randomUUID(),
      settings: input.settings,
      records: Array.from({ length: 1201 }, (_, i) => row(String(i), i)),
    });
    const original = await f.repository.getSnapshot(old.snapshot.id);
    await f.repository.beginIngestion(input);
    await f.repository.stageBatch(batch(input, 'only', [row('0', 99), row('1200', 1200)]));
    const result = await f.repository.commitIngestion(input.sourceRunId, fingerprint);
    expect(result.stats).toEqual({ added: 0, updated: 1, removed: 1199, unchanged: 1, current: 2 });
    expect((await f.repository.listRecords(result.dataset.id)).items).toHaveLength(2);
    expect(await f.repository.getSnapshot(old.snapshot.id)).toEqual(original);
    expect((await f.repository.commitIngestion(input.sourceRunId, fingerprint)).stats).toEqual(
      result.stats,
    );
    expect(await f.repository.listSnapshots(result.dataset.id)).toHaveLength(2);
  });
});
