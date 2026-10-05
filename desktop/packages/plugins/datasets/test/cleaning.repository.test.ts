import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { SqliteDatasetRepository } from '../src/persistence/sqlite/index.js';
import {
  DatasetCleaningConflictError,
  SqliteDatasetCleaningRepository,
} from '../src/persistence/sqlite/cleaning.js';

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zhiyun-cleaning-repository-'));
  const filePath = join(root, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory: root,
    filePath,
    graphRevision: 'cleaning-repository-test',
  });
  const datasets = new SqliteDatasetRepository(filePath);
  disposals.push(async () => {
    await datasets.close();
    await platform.close();
    await rm(root, { recursive: true, force: true });
  });
  await datasets.migrate();
  const cleaning = new SqliteDatasetCleaningRepository(filePath);
  disposals.push(() => cleaning.close());
  const committed = await datasets.commitRunRecords({
    sourceTaskId: randomUUID(),
    sourceRunId: randomUUID(),
    settings: { mode: 'snapshot', keyFields: ['id'], detectRemoved: true },
    records: [{ sourceUrl: 'http://127.0.0.1/fixture', data: { id: 1, value: ' 10 ' } }],
  });
  await datasets.claimSnapshotMaterialization(committed.dataset.id, committed.snapshot.fingerprint);
  // Repository tests use identifiers; real file handling is covered in Worker/service integration.
  const source = await datasets.completeSnapshotMaterialization({
    snapshotId: committed.snapshot.id,
    parquetArtifactId: randomUUID(),
    manifestArtifactId: randomUUID(),
    rowCount: 1,
    warnings: [],
  });
  return { root, filePath, datasets, cleaning, source, datasetId: committed.dataset.id };
}

describe('durable cleaning recipes and selection history', () => {
  it('keeps versions immutable, rejects stale edits and survives reopening', async () => {
    const f = await fixture();
    const initial = await f.cleaning.saveRecipe({
      datasetId: f.datasetId,
      name: ' Trim price ',
      steps: [{ type: 'trim', fields: ['value'] }],
      expectedFields: { value: 'string' },
    });
    const updated = await f.cleaning.saveRecipe({
      datasetId: f.datasetId,
      recipeId: initial.recipe.id,
      expectedRevision: 1,
      name: 'Convert price',
      steps: [
        { type: 'trim', fields: ['value'] },
        { type: 'convert', fields: ['value'], targetType: 'number', onError: 'null' },
      ],
      expectedFields: { value: 'string' },
    });
    expect(initial.recipe.name).toBe('Trim price');
    expect(updated.recipe.revision).toBe(2);
    expect(updated.version.id).not.toBe(initial.version.id);
    expect(await f.cleaning.getRecipeVersion(initial.version.id)).toEqual(initial.version);
    await expect(
      f.cleaning.saveRecipe({
        datasetId: f.datasetId,
        recipeId: initial.recipe.id,
        expectedRevision: 1,
        name: 'Stale overwrite',
        steps: initial.version.steps,
        expectedFields: {},
      }),
    ).rejects.toBeInstanceOf(DatasetCleaningConflictError);
    const reopened = new SqliteDatasetCleaningRepository(f.filePath);
    try {
      expect(await reopened.getRecipe(initial.recipe.id)).toEqual(updated.recipe);
      expect(await reopened.getRecipeVersion(initial.version.id)).toEqual(initial.version);
      expect(await reopened.listRecipes(f.datasetId)).toEqual([updated.recipe]);
    } finally {
      await reopened.close();
    }
  });

  it('publishes every parent and undoes/redoes by selection without changing snapshots or records', async () => {
    const f = await fixture();
    const saved = await f.cleaning.saveRecipe({
      datasetId: f.datasetId,
      name: 'Trim and convert',
      steps: [
        { type: 'trim', fields: ['value'] },
        { type: 'convert', fields: ['value'], targetType: 'number', onError: 'null' },
      ],
      expectedFields: { value: 'string' },
    });
    const originalRecords = await f.datasets.listRecords(f.datasetId);
    const published = await f.cleaning.publishSession({
      datasetId: f.datasetId,
      inputSnapshotId: f.source.id,
      recipeVersionId: saved.version.id,
      reportArtifactId: randomUUID(),
      steps: [
        {
          fingerprint: 'b'.repeat(64),
          rowCount: 1,
          parquetArtifactId: randomUUID(),
          manifestArtifactId: randomUUID(),
        },
        {
          fingerprint: 'c'.repeat(64),
          rowCount: 1,
          parquetArtifactId: randomUUID(),
          manifestArtifactId: randomUUID(),
        },
      ],
    });
    expect(published.session.selectedStep).toBe(2);
    expect(published.session.selectedSnapshotId).toBe(published.snapshots[1]!.id);
    expect(published.snapshots[0]!.projectionSettings).toMatchObject({
      inputSnapshotId: f.source.id,
      recipeVersionId: saved.version.id,
      step: 1,
    });
    expect(published.snapshots[1]!.projectionSettings).toMatchObject({
      inputSnapshotId: published.snapshots[0]!.id,
      rootSnapshotId: f.source.id,
      step: 2,
    });
    const undone = await f.cleaning.selectStep(published.session.id, 1, 1);
    expect(undone.selectedSnapshotId).toBe(published.snapshots[0]!.id);
    const atSource = await f.cleaning.selectStep(published.session.id, 0, 2);
    expect(atSource.selectedSnapshotId).toBe(f.source.id);
    const redone = await f.cleaning.selectStep(published.session.id, 2, 3);
    expect(redone.selectedSnapshotId).toBe(published.snapshots[1]!.id);
    await expect(f.cleaning.selectStep(published.session.id, 0, 1)).rejects.toBeInstanceOf(
      DatasetCleaningConflictError,
    );
    await expect(f.cleaning.selectStep(published.session.id, 3, 4)).rejects.toThrow(
      'step was not found',
    );
    expect(await f.cleaning.getSession(published.session.id)).toEqual(redone);
    expect(await f.datasets.getSnapshot(f.source.id)).toEqual(f.source);
    for (const derived of published.snapshots)
      expect(await f.datasets.getSnapshot(derived.id)).toEqual(derived);
    expect(await f.datasets.listRecords(f.datasetId)).toEqual(originalRecords);
    expect(await f.cleaning.listSessions(f.datasetId)).toEqual([redone]);
    const reopened = new SqliteDatasetCleaningRepository(f.filePath);
    try {
      expect(await reopened.getSession(redone.id)).toEqual(redone);
    } finally {
      await reopened.close();
    }
  });

  it('rejects invalid publications atomically and never accepts executable recipes', async () => {
    const f = await fixture();
    await expect(
      f.cleaning.saveRecipe({
        datasetId: f.datasetId,
        name: 'Script',
        steps: [{ type: 'python', code: 'print(1)' } as never],
        expectedFields: {},
      }),
    ).rejects.toThrow();
    await expect(
      f.cleaning.saveRecipe({
        datasetId: f.datasetId,
        name: 'Empty',
        steps: [],
        expectedFields: {},
      }),
    ).rejects.toThrow();
    const saved = await f.cleaning.saveRecipe({
      datasetId: f.datasetId,
      name: 'Trim',
      steps: [{ type: 'trim', fields: ['value'] }],
      expectedFields: {},
    });
    const before = await f.datasets.listSnapshots(f.datasetId);
    const input = {
      datasetId: f.datasetId,
      inputSnapshotId: f.source.id,
      recipeVersionId: saved.version.id,
      reportArtifactId: randomUUID(),
      steps: [
        {
          fingerprint: f.source.fingerprint,
          rowCount: 1,
          parquetArtifactId: randomUUID(),
          manifestArtifactId: randomUUID(),
        },
      ],
    };
    await expect(f.cleaning.publishSession(input)).rejects.toThrow('derived fingerprints');
    await expect(
      f.cleaning.publishSession({
        ...input,
        steps: [input.steps[0]!, { ...input.steps[0]!, fingerprint: 'd'.repeat(64) }],
      }),
    ).rejects.toThrow('recipe version');
    await expect(f.cleaning.publishSession({ ...input, datasetId: randomUUID() })).rejects.toThrow(
      'ready input',
    );
    await expect(
      f.cleaning.publishSession({
        ...input,
        steps: [{ ...input.steps[0]!, fingerprint: 'd'.repeat(64), rowCount: 2 }],
      }),
    ).rejects.toThrow('row counts');
    expect(await f.datasets.listSnapshots(f.datasetId)).toEqual(before);
    expect(await f.cleaning.listSessions(f.datasetId)).toEqual([]);
  });

  it('rolls back all intermediate snapshots if publication fails after its first insert', async () => {
    const f = await fixture();
    const saved = await f.cleaning.saveRecipe({
      datasetId: f.datasetId,
      name: 'Trim twice',
      steps: [
        { type: 'trim', fields: ['value'] },
        { type: 'trim', fields: ['value'] },
      ],
      expectedFields: { value: 'string' },
    });
    const before = await f.datasets.listSnapshots(f.datasetId);
    const injected = new Database(f.filePath);
    try {
      injected.exec(
        `CREATE TRIGGER cleaning_fixture_failure BEFORE INSERT ON dataset_snapshots WHEN NEW.fingerprint = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' BEGIN SELECT RAISE(ABORT, 'fixture publication failure'); END`,
      );
      await expect(
        f.cleaning.publishSession({
          datasetId: f.datasetId,
          inputSnapshotId: f.source.id,
          recipeVersionId: saved.version.id,
          reportArtifactId: randomUUID(),
          steps: [
            {
              fingerprint: 'b'.repeat(64),
              rowCount: 1,
              parquetArtifactId: randomUUID(),
              manifestArtifactId: randomUUID(),
            },
            {
              fingerprint: 'c'.repeat(64),
              rowCount: 1,
              parquetArtifactId: randomUUID(),
              manifestArtifactId: randomUUID(),
            },
          ],
        }),
      ).rejects.toThrow('fixture publication failure');
    } finally {
      injected.close();
    }
    expect(await f.datasets.listSnapshots(f.datasetId)).toEqual(before);
    expect(await f.cleaning.listSessions(f.datasetId)).toEqual([]);
  });
});
