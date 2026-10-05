import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnalyticsWorkerClient, AnalyticsWorkerSupervisor } from '@zhiyun/analytics-worker-client';
import { LocalArtifactStore } from '@zhiyun/artifact-store';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import {
  cleaningRecipeInputSchema,
  cleaningSessionDetailSchema,
  cleaningStepSchema,
} from '@zhiyun/shared';
import { DatasetCleaningService } from '../src/application/cleaning.js';
import { DatasetSnapshotService } from '../src/application/index.js';
import { SqliteDatasetRepository } from '../src/persistence/sqlite/index.js';
import { registerDatasetsHttp } from '../src/http/index.js';
import type { SnapshotWorkerClient } from '../src/contracts/index.js';
import { testEnvironment } from '../../../../../tooling/scripts/test-environment.js';

const desktop = resolve(import.meta.dirname, '../../../..');
const python = join(
  desktop,
  'analytics-worker/.venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const fixture = JSON.parse(
  await readFile(join(desktop, 'tooling/evaluations/cleaning-fixtures.json'), 'utf8'),
) as {
  cases: Array<{
    id: string;
    rows: Array<Record<string, unknown>>;
    steps: unknown[];
    expected: unknown[];
    errorRows: number;
    removedRows: number;
  }>;
};
const readScript = `import sys,orjson,pyarrow.parquet as pq
from zhiyun_analytics_worker.cleaning import json_value
manifest=orjson.loads(open(sys.argv[2],"rb").read())
rows=[{c["sourceField"]:json_value(row[c["physicalName"]]) for c in manifest["columns"]} for row in pq.read_table(sys.argv[1]).to_pylist()]
print(orjson.dumps(rows).decode())`;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'zhiyun-cleaning-service-'));
  const filePath = join(root, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory: root,
    filePath,
    graphRevision: 'cleaning-service-test',
  });
  const datasets = new SqliteDatasetRepository(filePath);
  await datasets.migrate();
  const artifacts = new LocalArtifactStore(root);
  await artifacts.initialize();
  const supervisor = new AnalyticsWorkerSupervisor({
    command: python,
    args: ['-m', 'zhiyun_analytics_worker'],
    workspaceRoot: join(root, 'job-workspaces'),
    env: testEnvironment(process.env),
  });
  const worker = new AnalyticsWorkerClient(await supervisor.start());
  const snapshots = new DatasetSnapshotService(datasets, platform, artifacts, worker, {
    pollIntervalMs: 5,
    timeoutMs: 30_000,
  });
  const cleaning = new DatasetCleaningService(datasets, platform, artifacts, worker, {
    pollIntervalMs: 5,
    timeoutMs: 30_000,
  });
  const app = Fastify();
  await registerDatasetsHttp(app, {
    repository: datasets,
    snapshots,
    cleaning,
    platform,
    artifactStore: artifacts,
  });
  async function source(rows: Array<Record<string, unknown>>, sourceTaskId = crypto.randomUUID()) {
    const committed = await datasets.commitRunRecords({
      sourceTaskId,
      sourceRunId: crypto.randomUUID(),
      settings: { mode: 'append', keyFields: ['__fixture_missing_key__'], detectRemoved: false },
      records: rows.map((data, i) => ({ sourceUrl: `http://127.0.0.1/fixture/${i}`, data })),
    });
    const materialized = await snapshots.materialize(committed.dataset.id);
    const parquet = (await platform.getArtifact(materialized.snapshot.parquetArtifactId!))!;
    const manifest = (await platform.getArtifact(materialized.snapshot.manifestArtifactId!))!;
    return {
      datasetId: committed.dataset.id,
      snapshot: materialized.snapshot,
      parquetPath: await artifacts.resolveArtifact(parquet.storageKey),
      manifestPath: await artifacts.resolveArtifact(manifest.storageKey),
    };
  }
  async function rows(snapshotId: string) {
    const snapshot = (await datasets.getSnapshot(snapshotId))!;
    const parquet = (await platform.getArtifact(snapshot.parquetArtifactId!))!;
    const manifest = (await platform.getArtifact(snapshot.manifestArtifactId!))!;
    return new Promise<unknown[]>((accept, reject) =>
      execFile(
        python,
        [
          '-c',
          readScript,
          join(root, 'artifacts', parquet.storageKey),
          join(root, 'artifacts', manifest.storageKey),
        ],
        {
          cwd: join(desktop, 'analytics-worker'),
          env: testEnvironment(process.env),
          timeout: 15_000,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout) => (error ? reject(error) : accept(JSON.parse(stdout) as unknown[])),
      ),
    );
  }
  return {
    root,
    platform,
    datasets,
    artifacts,
    worker,
    cleaning,
    app,
    source,
    rows,
    async close() {
      await cleaning.close();
      await app.close();
      await supervisor.stop();
      await artifacts.close();
      await datasets.close();
      await platform.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe('real cleaning Worker, ArtifactStore, SQLite and HTTP', () => {
  let f: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    f = await setup();
  }, 30_000);
  afterAll(async () => {
    await f?.close();
  });

  it.each(fixture.cases)(
    '$id persists the exact golden output and protects source files',
    async (testCase) => {
      const source = await f.source(testCase.rows);
      const original = await Promise.all([
        readFile(source.parquetPath),
        readFile(source.manifestPath),
      ]);
      const raw = await f.datasets.listRecords(source.datasetId);
      const before = await f.datasets.listSnapshots(source.datasetId);
      const steps = testCase.steps.map((step) => cleaningStepSchema.parse(step));
      const preview = await f.cleaning.preview(source.datasetId, {
        mode: 'steps',
        snapshotId: source.snapshot.id,
        steps,
        expectedFields: {},
      });
      expect(await f.datasets.listSnapshots(source.datasetId)).toEqual(before);
      expect(preview.steps[0]!.errorRowCount).toBe(testCase.errorRows);
      const saved = await f.cleaning.saveRecipe(source.datasetId, {
        name: testCase.id,
        steps,
        expectedFields: {},
      });
      const result = cleaningSessionDetailSchema.parse(
        await f.cleaning.apply(source.datasetId, {
          snapshotId: source.snapshot.id,
          recipeVersionId: saved.version.id,
        }),
      );
      expect(await f.rows(result.session.selectedSnapshotId)).toEqual(testCase.expected);
      expect(result.report.steps[0]!.removedRowCount).toBe(testCase.removedRows);
      const derived = (await f.datasets.getSnapshot(result.session.selectedSnapshotId))!;
      expect(result.report.parquetArtifactRef).toBe(derived.parquetArtifactId);
      expect(result.report.manifestArtifactRef).toBe(derived.manifestArtifactId);
      expect(await f.cleaning.getSession(source.datasetId, result.session.id)).toEqual(result);
      expect(await f.datasets.getSnapshot(source.snapshot.id)).toEqual(source.snapshot);
      expect(await f.datasets.listRecords(source.datasetId)).toEqual(raw);
      expect(
        await Promise.all([readFile(source.parquetPath), readFile(source.manifestPath)]),
      ).toEqual(original);
      expect(await readdir(join(f.root, 'job-workspaces'))).toEqual([]);
    },
    30_000,
  );

  it('reuses an immutable recipe version, restores each actual output and rejects changed types', async () => {
    const source = await f.source([
      { value: ' 1 ' },
      { value: '1' },
      { value: 'N/A' },
      { value: 'bad' },
    ]);
    const steps = [
      { type: 'trim', fields: ['value'] },
      { type: 'normalize_null', fields: ['value'] },
      { type: 'convert', fields: ['value'], targetType: 'number' },
      { type: 'dedupe', fields: ['value'] },
    ].map((step) => cleaningStepSchema.parse(step));
    const saved = await f.cleaning.saveRecipe(source.datasetId, {
      name: 'Price',
      steps,
      expectedFields: { value: 'string' },
    });
    const first = await f.cleaning.apply(source.datasetId, {
      snapshotId: source.snapshot.id,
      recipeVersionId: saved.version.id,
    });
    expect(await f.rows(first.session.selectedSnapshotId)).toEqual([{ value: 1 }, { value: null }]);
    const originalVersion = await f.datasets.cleaning.getRecipeVersion(saved.version.id);
    const edited = await f.cleaning.saveRecipe(source.datasetId, {
      name: 'Edited',
      steps: [steps[0]!],
      expectedFields: { value: 'string' },
      recipeId: saved.recipe.id,
      expectedRevision: 1,
    });
    expect(edited.version.id).not.toBe(saved.version.id);
    const second = await f.source([{ value: ' 9 ' }, { value: '9' }, { value: '10' }]);
    const replayed = await f.cleaning.apply(second.datasetId, {
      snapshotId: second.snapshot.id,
      recipeVersionId: saved.version.id,
    });
    expect(await f.rows(replayed.session.selectedSnapshotId)).toEqual([
      { value: 9 },
      { value: 10 },
    ]);
    expect(await f.datasets.cleaning.getRecipeVersion(saved.version.id)).toEqual(originalVersion);
    let selected = await f.cleaning.selectStep(source.datasetId, first.session.id, 2, 1);
    expect(await f.rows(selected.session.selectedSnapshotId)).toEqual([
      { value: '1' },
      { value: '1' },
      { value: null },
      { value: 'bad' },
    ]);
    selected = await f.cleaning.selectStep(source.datasetId, first.session.id, 0, 2);
    expect(await f.rows(selected.session.selectedSnapshotId)).toEqual([
      { value: ' 1 ' },
      { value: '1' },
      { value: 'N/A' },
      { value: 'bad' },
    ]);
    selected = await f.cleaning.selectStep(source.datasetId, first.session.id, 4, 3);
    expect(await f.rows(selected.session.selectedSnapshotId)).toEqual([
      { value: 1 },
      { value: null },
    ]);
    await expect(f.cleaning.selectStep(source.datasetId, first.session.id, 0, 1)).rejects.toThrow(
      'history changed',
    );
    const wrongType = await f.source([{ value: 10 }]);
    const before = await f.datasets.listSnapshots(wrongType.datasetId);
    await expect(
      f.cleaning.apply(wrongType.datasetId, {
        snapshotId: wrongType.snapshot.id,
        recipeVersionId: saved.version.id,
      }),
    ).rejects.toMatchObject({ code: 'METHOD_INCOMPATIBLE' });
    expect(await f.datasets.listSnapshots(wrongType.datasetId)).toEqual(before);
    expect(await readdir(join(f.root, 'job-workspaces'))).toEqual([]);
  }, 30_000);

  it('uses strict HTTP bodies, scoped history, idempotent saves and revision conflicts', async () => {
    const source = await f.source([{ value: ' text ' }]);
    const base = `/api/v2/datasets/${source.datasetId}/cleaning`;
    const body = {
      name: 'HTTP trim',
      steps: [{ type: 'trim', fields: ['value'] }],
      expectedFields: { value: 'string' },
    };
    const key = crypto.randomUUID();
    const missing = await f.app.inject({ method: 'POST', url: `${base}/recipes`, payload: body });
    expect(missing.statusCode).toBe(428);
    const first = await f.app.inject({
      method: 'POST',
      url: `${base}/recipes`,
      headers: { 'idempotency-key': key },
      payload: body,
    });
    expect(first.statusCode, first.body).toBe(201);
    const repeated = await f.app.inject({
      method: 'POST',
      url: `${base}/recipes`,
      headers: { 'idempotency-key': key },
      payload: body,
    });
    expect(repeated.json()).toEqual(first.json());
    const conflicting = await f.app.inject({
      method: 'POST',
      url: `${base}/recipes`,
      headers: { 'idempotency-key': key },
      payload: { ...body, name: 'Changed' },
    });
    expect(conflicting.statusCode).toBe(409);
    const applied = await f.app.inject({
      method: 'POST',
      url: `${base}/sessions`,
      headers: { 'idempotency-key': crypto.randomUUID() },
      payload: { snapshotId: source.snapshot.id, recipeVersionId: first.json().version.id },
    });
    expect(applied.statusCode, applied.body).toBe(201);
    const detail = cleaningSessionDetailSchema.parse(applied.json());
    const selected = await f.app.inject({
      method: 'POST',
      url: `${base}/sessions/${detail.session.id}/selection`,
      headers: { 'idempotency-key': crypto.randomUUID() },
      payload: { selectedStep: 0, expectedRevision: 1 },
    });
    expect(selected.statusCode, selected.body).toBe(200);
    expect(selected.json().session.selectedSnapshotId).toBe(source.snapshot.id);
    const stale = await f.app.inject({
      method: 'POST',
      url: `${base}/sessions/${detail.session.id}/selection`,
      headers: { 'idempotency-key': crypto.randomUUID() },
      payload: { selectedStep: 1, expectedRevision: 1 },
    });
    expect(stale.statusCode).toBe(409);
    const forbiddenStep = await f.app.inject({
      method: 'POST',
      url: `${base}/preview`,
      payload: {
        mode: 'steps',
        snapshotId: source.snapshot.id,
        steps: [{ type: 'python', code: 'print(1)' }],
      },
    });
    expect(forbiddenStep.statusCode).toBe(400);
    const other = await f.source([{ value: 'other' }]);
    const scoped = await f.app.inject({
      method: 'GET',
      url: `/api/v2/datasets/${other.datasetId}/cleaning/sessions/${detail.session.id}`,
    });
    expect(scoped.statusCode).toBe(404);
  }, 30_000);

  it('removes only newly published files and descriptors if history publication fails', async () => {
    const source = await f.source([{ value: ' keep ' }]);
    const saved = await f.cleaning.saveRecipe(
      source.datasetId,
      cleaningRecipeInputSchema.parse({
        name: 'Trim',
        steps: [{ type: 'trim', fields: ['value'] }],
      }),
    );
    const created: string[] = [];
    const platform = new Proxy(f.platform, {
      get(target, key) {
        if (key === 'createArtifact')
          return async (input: Parameters<typeof target.createArtifact>[0]) => {
            created.push(input.id!);
            return target.createArtifact(input);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const cleaning = new Proxy(f.datasets.cleaning, {
      get(target, key) {
        if (key === 'publishSession')
          return async () => {
            throw new Error('fixture publication failure');
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const datasets = new Proxy(f.datasets, {
      get(target, key) {
        if (key === 'cleaning') return cleaning;
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const service = new DatasetCleaningService(datasets, platform, f.artifacts, f.worker, {
      pollIntervalMs: 5,
    });
    try {
      await expect(
        service.apply(source.datasetId, {
          snapshotId: source.snapshot.id,
          recipeVersionId: saved.version.id,
        }),
      ).rejects.toThrow('publication failure');
    } finally {
      await service.close();
    }
    expect(created).toHaveLength(3);
    for (const id of created) expect(await f.platform.getArtifact(id)).toBeNull();
    expect(await f.platform.getArtifact(source.snapshot.parquetArtifactId!)).not.toBeNull();
    expect(await f.datasets.cleaning.listSessions(source.datasetId)).toEqual([]);
    expect(await readdir(join(f.root, 'job-workspaces'))).toEqual([]);
  }, 30_000);

  it('cancels active work before closing and retains a workspace if stop cannot be proven', async () => {
    const source = await f.source([{ value: ' data ' }]);
    const saved = await f.cleaning.saveRecipe(
      source.datasetId,
      cleaningRecipeInputSchema.parse({
        name: 'Lifecycle',
        steps: [{ type: 'trim', fields: ['value'] }],
      }),
    );
    for (const stop of [true, false]) {
      let jobId = '',
        canceled = false;
      let accepted!: () => void;
      const submitted = new Promise<void>((resolve) => {
        accepted = resolve;
      });
      const worker: SnapshotWorkerClient = {
        async submit(input) {
          jobId = input.jobId;
          accepted();
          return { id: jobId, state: 'running' };
        },
        async job() {
          return { id: jobId, state: canceled && stop ? 'canceled' : 'running' };
        },
        async cancel() {
          canceled = true;
          return { id: jobId, state: stop ? 'canceled' : 'running' };
        },
      };
      const service = new DatasetCleaningService(f.datasets, f.platform, f.artifacts, worker, {
        pollIntervalMs: 1,
        timeoutMs: 10_000,
        cancelGraceMs: 10,
      });
      const executing = service
        .apply(source.datasetId, {
          snapshotId: source.snapshot.id,
          recipeVersionId: saved.version.id,
        })
        .catch((error: unknown) => error);
      await submitted;
      await service.close();
      expect(canceled).toBe(true);
      expect(await executing).toMatchObject({ code: stop ? 'CANCELED' : 'WORKER_CRASHED' });
      const workspaces = await readdir(join(f.root, 'job-workspaces'));
      expect(workspaces.includes(jobId)).toBe(!stop);
      if (!stop) await f.artifacts.removeWorkspace(jobId); // This fixture has no real Worker process.
    }
  }, 30_000);

  it('rejects a corrupted saved report before changing its selection', async () => {
    const source = await f.source([{ value: ' text ' }]);
    const saved = await f.cleaning.saveRecipe(
      source.datasetId,
      cleaningRecipeInputSchema.parse({
        name: 'Integrity',
        steps: [{ type: 'trim', fields: ['value'] }],
      }),
    );
    const result = await f.cleaning.apply(source.datasetId, {
      snapshotId: source.snapshot.id,
      recipeVersionId: saved.version.id,
    });
    const artifact = (await f.platform.getArtifact(result.session.reportArtifactId))!;
    await writeFile(await f.artifacts.resolveArtifact(artifact.storageKey), 'corrupted fixture');
    await expect(
      f.cleaning.selectStep(source.datasetId, result.session.id, 0, 1),
    ).rejects.toMatchObject({ code: 'INVALID_ARTIFACT' });
    expect(await f.datasets.cleaning.getSession(result.session.id)).toEqual(result.session);
  }, 30_000);

  it('releases a failed mutation key so a corrected recipe can be applied', async () => {
    const source = await f.source([{ value: 10 }]);
    const bad = await f.cleaning.saveRecipe(
      source.datasetId,
      cleaningRecipeInputSchema.parse({
        name: 'Wrong type',
        steps: [{ type: 'trim', fields: ['value'] }],
        expectedFields: { value: 'string' },
      }),
    );
    const good = await f.cleaning.saveRecipe(
      source.datasetId,
      cleaningRecipeInputSchema.parse({
        name: 'Number',
        steps: [{ type: 'convert', fields: ['value'], targetType: 'number' }],
        expectedFields: { value: 'int' },
      }),
    );
    const key = crypto.randomUUID(),
      url = `/api/v2/datasets/${source.datasetId}/cleaning/sessions`;
    const failed = await f.app.inject({
      method: 'POST',
      url,
      headers: { 'idempotency-key': key },
      payload: { snapshotId: source.snapshot.id, recipeVersionId: bad.version.id },
    });
    expect(failed.statusCode, failed.body).toBe(400);
    expect(failed.json().code).toBe('METHOD_INCOMPATIBLE');
    const corrected = await f.app.inject({
      method: 'POST',
      url,
      headers: { 'idempotency-key': key },
      payload: { snapshotId: source.snapshot.id, recipeVersionId: good.version.id },
    });
    expect(corrected.statusCode, corrected.body).toBe(201);
  }, 30_000);
});
