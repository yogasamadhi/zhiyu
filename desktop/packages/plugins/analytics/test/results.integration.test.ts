import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import type { PlatformJobQueue } from '@zhiyun/platform-core';
import type { AnalyticsWorkerControl, SaveAnalysisResultInput } from '../src/contracts/index.js';
import { AnalysisJobService, AnalyticsCatalog } from '../src/application/index.js';
import { analyticsSqliteMigration001 } from '../src/migrations/sqlite/index.js';
import { SqliteAnalysisRepository } from '../src/persistence/sqlite/index.js';
import { compareAnalysisResults } from '../src/application/provenance.js';

interface Fixture {
  root: string;
  path: string;
  platform: Awaited<ReturnType<typeof openSqlitePlatformRepository>>;
  db: Database.Database;
  repository: SqliteAnalysisRepository;
}
const fixtures: Fixture[] = [];
afterEach(async () => {
  for (const entry of fixtures.splice(0)) {
    entry.db.close();
    await entry.repository.close();
    await entry.platform.close();
    await rm(entry.root, { recursive: true, force: true });
  }
});

async function fixture(legacy = false): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'zhiyun-analysis-results-'));
  const path = join(root, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory: root,
    filePath: path,
    graphRevision: 'result-test',
  });
  const db = new Database(path);
  db.pragma('foreign_keys=ON');
  const entry = { root, path, platform, db, repository: new SqliteAnalysisRepository(path) };
  fixtures.push(entry);
  if (!legacy) await entry.repository.migrate();
  return entry;
}

async function save(
  entry: Awaited<ReturnType<typeof fixture>>,
  tables: SaveAnalysisResultInput['tables'],
  series: SaveAnalysisResultInput['series'] = [],
  parameters = { fields: ['value'], threshold: 1.5 },
) {
  const input = {
    jobId: randomUUID(),
    datasetId: randomUUID(),
    snapshotId: randomUUID(),
    methodId: 'stats.outliers',
    methodVersion: '1.0.0',
    summary: { rowCount: tables[0]?.rows.length ?? 0 },
    metrics: {},
    tables,
    series,
    artifacts: [],
    warnings: [],
    sampling: { applied: false, inputRows: 1, sampleRows: 1, seed: null },
    workerVersion: '1.0.0',
  } satisfies SaveAnalysisResultInput;
  await entry.repository.createJobMetadata(input.jobId, { ...input, parameters });
  return { input, result: await entry.repository.saveResult(input) };
}

describe('Analysis result persistence and bounded queries', () => {
  it('freezes metadata before an immediate queue dispatch and replays after Recipe deletion and Worker shutdown', async () => {
    const entry = await fixture();
    const datasetId = randomUUID(),
      snapshotId = randomUUID();
    const recipe = await entry.repository.createRecipe({
      name: 'Frozen',
      datasetId,
      methodId: 'stats.descriptive',
      methodVersion: '1.0.0',
      parameters: { fields: ['value'] },
    });
    const worker: AnalyticsWorkerControl = {
      async methods() {
        return [
          {
            id: 'stats.descriptive',
            version: '1.0.0',
            category: 'statistics',
            titleKey: 'title',
            descriptionKey: 'description',
            supportedFieldTypes: ['number'],
            parameterSchema: {
              type: 'object',
              additionalProperties: false,
              required: ['fields'],
              properties: { fields: { type: 'array', minItems: 1, items: { type: 'string' } } },
            },
            outputSchema: {},
            recommendedVisualizations: ['table'],
            resourceLimits: {},
            supportsSampling: false,
          },
        ];
      },
      async version() {
        return { workerVersion: '1.0.0' };
      },
      async submit() {
        throw new Error('Not executed by this test');
      },
      async job() {
        throw new Error('Not executed by this test');
      },
      async cancel() {
        throw new Error('Not executed by this test');
      },
    };
    let available = true;
    const queue: PlatformJobQueue = {
      async enqueue(input) {
        expect(await entry.repository.getJobMetadata(input.id!)).toMatchObject({
          parameters: { fields: ['value'] },
          provenance: {
            analysisRecipeId: recipe.id,
            analysisRecipeRevision: 1,
            inputFingerprint: 'a'.repeat(64),
          },
        });
        return entry.platform.enqueueJob(input);
      },
      get: (id) => entry.platform.getJob(id),
      list: (options) => entry.platform.listJobs(options),
      cancel: (id) => entry.platform.requestJobCancel(id),
      start() {},
      async close() {},
    };
    const service = new AnalysisJobService(
      entry.repository,
      entry.platform,
      {
        async getSnapshot(id) {
          return id === snapshotId
            ? {
                id,
                datasetId,
                status: 'ready',
                parquetArtifactId: randomUUID(),
                fingerprint: 'a'.repeat(64),
              }
            : null;
        },
      },
      new AnalyticsCatalog(() => (available ? worker : undefined)),
      queue,
    );
    const input = {
      recipeId: recipe.id,
      datasetId,
      snapshotId,
      methodId: recipe.methodId,
      methodVersion: recipe.methodVersion,
      parameters: { fields: ['value'] },
      questionId: 'distribution' as const,
    };
    const created = await service.create(input, 'frozen-replay');
    await entry.repository.deleteRecipe(recipe.id, 1);
    available = false;
    expect(await service.create(input, 'frozen-replay')).toEqual(created);
    await expect(
      service.create({ ...input, parameters: { fields: ['other'] } }, 'frozen-replay'),
    ).rejects.toMatchObject({ code: 'ANALYSIS_JOB_CONFLICT' });
    expect(await entry.repository.getJobMetadata(created.id)).toMatchObject({
      parameters: { fields: ['value'] },
      provenance: { analysisRecipeRevision: 1 },
    });
  });

  it('upgrades a populated 001 database without inventing legacy lineage or changing original blobs', async () => {
    const entry = await fixture(true);
    const { db } = entry;
    db.exec(analyticsSqliteMigration001);
    db.prepare(
      "INSERT INTO plugin_migrations(plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result) VALUES ('analytics','001-initial','1.0.0',?,?,0,'succeeded')",
    ).run(
      createHash('sha256').update(analyticsSqliteMigration001).digest('hex'),
      new Date().toISOString(),
    );
    const job = randomUUID(),
      result = randomUUID(),
      dataset = randomUUID(),
      snapshot = randomUUID();
    const tables = JSON.stringify([
      {
        id: 'old',
        columns: [{ name: 'value' }],
        rows: Array.from({ length: 407 }, (_, value) => ({ value })),
      },
    ]);
    const series = JSON.stringify([{ id: 'old', type: 'bar', data: [{ value: 2 }] }]);
    const sampling = '{"applied":false,"inputRows":407,"sampleRows":407,"seed":null}';
    db.prepare(
      "INSERT INTO analysis_jobs(id,recipe_id,dataset_id,snapshot_id,method_id,method_version,parameters,sampling,result_id,created_at) VALUES (?,NULL,?,?,?,'1.0.0',?,?,?,?)",
    ).run(
      job,
      dataset,
      snapshot,
      'stats.descriptive',
      '{"fields":["value"]}',
      sampling,
      result,
      new Date().toISOString(),
    );
    db.prepare(
      "INSERT INTO analysis_results(id,job_id,dataset_id,snapshot_id,method_id,method_version,summary,metrics,tables_data,series_data,warnings,sampling,worker_version,created_at) VALUES (?,?,?,?,?,'1.0.0','{}','{}',?,?,'[]',?,'1.0.0',?)",
    ).run(
      result,
      job,
      dataset,
      snapshot,
      'stats.descriptive',
      tables,
      series,
      sampling,
      new Date().toISOString(),
    );
    await entry.repository.migrate();
    expect(db.prepare('SELECT tables_data,series_data FROM analysis_results').get()).toEqual({
      tables_data: tables,
      series_data: series,
    });
    const preview = await entry.repository.getResultPreview(result);
    expect(preview).toMatchObject({
      state: 'succeeded',
      provenance: null,
      parameters: { fields: ['value'] },
      tables: [{ totalRows: 407 }],
    });
    expect(preview!.tables[0]!.rows).toHaveLength(20);
    const page = await entry.repository.getResultPage(
      result,
      'table',
      'old',
      200,
      preview!.tables[0]!.nextCursor!,
    );
    expect(page!.items[0]).toEqual({ value: 20 });
    expect(page!.items.at(-1)).toEqual({ value: 219 });
    await entry.repository.close();
    entry.repository = new SqliteAnalysisRepository(entry.path);
    await entry.repository.migrate();
    expect(await entry.repository.getResultPreview(result)).toEqual(preview);
    expect(
      (await entry.platform.listMigrations())
        .filter((item) => item.pluginId === 'analytics')
        .map((item) => item.migrationId),
    ).toEqual(['001-initial', '002-result-lineage']);
  });

  it('reads every row beyond 10,000 in order and never selects legacy full blobs for preview or pages', async () => {
    const entry = await fixture();
    const rows = Array.from({ length: 10_003 }, (_, index) => ({
      index,
      value: index / 2,
      detail: 'x'.repeat(100),
    }));
    const { result } = await save(
      entry,
      [{ id: 'large', rows }],
      [
        {
          id: 'chart',
          type: 'bar',
          encoding: { xFields: ['index'], yFields: ['value'] },
          data: rows.slice(0, 1000),
        },
      ],
    );
    const preview = (await entry.repository.getResultPreview(result.id))!;
    expect(preview.tables[0]!.totalRows).toBe(rows.length);
    expect(preview.tables[0]!.rows).toHaveLength(20);
    expect(preview.series[0]!.data).toHaveLength(20);
    expect(preview.series[0]!.encoding).toEqual({ xFields: ['index'], yFields: ['value'] });
    expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(result)) / 100,
    );
    entry.db
      .prepare(
        "UPDATE analysis_results SET tables_data='INVALID_FULL_TABLE_BLOB',series_data='INVALID_FULL_SERIES_BLOB' WHERE id=?",
      )
      .run(result.id);
    expect(await entry.repository.getResultPreview(result.id)).toEqual(preview);
    await expect(entry.repository.getResult(result.id)).rejects.toThrow();
    const seen: number[] = [];
    let cursor: string | undefined;
    do {
      const page = (await entry.repository.getResultPage(
        result.id,
        'table',
        'large',
        200,
        cursor,
      ))!;
      expect(page.items.length).toBeLessThanOrEqual(200);
      seen.push(...page.items.map((row) => Number(row.index)));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(rows.map((row) => row.index));
    expect(new Set(seen).size).toBe(rows.length);
  });

  it('rejects malformed, past-end and cross-result/collection cursors and unbounded page sizes', async () => {
    const entry = await fixture();
    const { result } = await save(
      entry,
      [
        { id: 'a', rows: [{ value: 1 }, { value: 2 }] },
        { id: 'b', rows: [{ value: 3 }] },
      ],
      [{ id: 'a', type: 'bar', data: [{ value: 1 }] }],
    );
    const other = await save(entry, [{ id: 'a', rows: [{ value: 4 }] }]);
    const cursor = (await entry.repository.getResultPage(result.id, 'table', 'a', 1))!.nextCursor!;
    for (const [id, section, collection] of [
      [other.result.id, 'table', 'a'],
      [result.id, 'table', 'b'],
      [result.id, 'series', 'a'],
    ] as const)
      await expect(
        entry.repository.getResultPage(id, section, collection, 1, cursor),
      ).rejects.toMatchObject({ code: 'INVALID_CURSOR', status: 400 });
    const past = Buffer.from(
      JSON.stringify({ v: 1, resultId: result.id, section: 'table', collectionId: 'a', index: 99 }),
    ).toString('base64url');
    for (const invalid of ['', '!', cursor + '=', cursor.slice(1), 'a'.repeat(2049), past])
      await expect(
        entry.repository.getResultPage(result.id, 'table', 'a', 1, invalid),
      ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    for (const size of [0, -1, 201, 1.5, Infinity])
      await expect(
        entry.repository.getResultPage(result.id, 'table', 'a', size),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await entry.repository.getResultPage(result.id, 'table', 'absent')).toBeNull();
    expect(await entry.repository.getResultPreview(randomUUID())).toBeNull();
  });

  it('rolls back result rows, metadata, artifact references and success events together after a row write fails', async () => {
    const entry = await fixture();
    const input = {
      jobId: randomUUID(),
      datasetId: randomUUID(),
      snapshotId: randomUUID(),
      methodId: 'stats.descriptive',
      methodVersion: '1.0.0',
      parameters: { fields: ['value'] },
    };
    await entry.repository.createJobMetadata(input.jobId, input);
    const before = await entry.platform.listEvents(0, 100);
    entry.db.exec(
      "CREATE TRIGGER fail_result_row BEFORE INSERT ON analysis_result_rows WHEN NEW.row_index=3 BEGIN SELECT RAISE(ABORT,'fixture row write failed'); END",
    );
    const result: SaveAnalysisResultInput = {
      ...input,
      summary: {},
      metrics: {},
      tables: [{ id: 'test', rows: Array.from({ length: 8 }, (_, value) => ({ value })) }],
      series: [],
      artifacts: [
        {
          id: randomUUID(),
          kind: 'analysis.result',
          filename: 'result.json',
          contentType: 'application/json',
        },
      ],
      warnings: [],
      sampling: { applied: false, inputRows: 8, sampleRows: 8, seed: null },
      workerVersion: '1.0.0',
    };
    await expect(entry.repository.saveResult(result)).rejects.toThrow('fixture row write failed');
    for (const table of [
      'analysis_results',
      'analysis_result_collections',
      'analysis_result_rows',
      'analysis_artifacts',
    ])
      expect(entry.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({
        count: 0,
      });
    expect(await entry.repository.getJobMetadata(input.jobId)).toMatchObject({
      resultId: null,
      completedAt: null,
    });
    expect(await entry.platform.listEvents(0, 100)).toEqual(before);
    entry.db.exec('DROP TRIGGER fail_result_row');
    const saved = await entry.repository.saveResult(result);
    await expect(
      entry.repository.saveResult({ ...result, summary: { overwrite: true } }),
    ).resolves.toEqual(saved);
    expect((await entry.repository.getResultPreview(saved.id))!.tables[0]!.rows).toHaveLength(8);
  });

  it('rejects result identity changes and oversized pages without publishing conflicting input', async () => {
    const entry = await fixture();
    const { input } = await save(entry, [
      { id: 'test', rows: [{ value: 'x'.repeat(4 * 1024 * 1024) }] },
    ]);
    const resultId = (await entry.repository.getJobMetadata(input.jobId))!.resultId!;
    await expect(entry.repository.getResultPreview(resultId)).rejects.toMatchObject({
      code: 'RESOURCE_LIMIT_EXCEEDED',
      status: 413,
    });
    const jobId = randomUUID();
    await entry.repository.createJobMetadata(jobId, {
      ...input,
      snapshotId: input.snapshotId,
      parameters: { fields: ['value'] },
    });
    await expect(
      entry.repository.saveResult({ ...input, jobId, snapshotId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'INVALID_WORKER_RESULT' });
    expect(await entry.repository.getJobMetadata(jobId)).toMatchObject({ resultId: null });
  });

  it('compares empty and populated typed outlier tables while rejecting semantic input and sampling changes', async () => {
    const entry = await fixture();
    const columns = [{ name: 'value' }];
    const { input, result: left } = await save(entry, [
      { id: 'outlierSamples', columns, rows: [] },
    ]);
    const jobId = randomUUID();
    await entry.repository.createJobMetadata(jobId, {
      ...input,
      parameters: { fields: ['value'], threshold: 2 },
    });
    const right = await entry.repository.saveResult({
      ...input,
      jobId,
      tables: [{ id: 'outlierSamples', columns, rows: [{ value: 100 }] }],
    });
    const a = (await entry.repository.getResultPreview(left.id))!,
      b = (await entry.repository.getResultPreview(right.id))!;
    expect(compareAnalysisResults(a, b).changedParameters).toEqual(['threshold']);
    for (const changed of [
      { ...b, snapshotId: randomUUID() },
      { ...b, parameters: { fields: ['other'] } },
      { ...b, sampling: { ...b.sampling, applied: true } },
      { ...b, methodVersion: '2.0.0' },
    ])
      expect(() => compareAnalysisResults(a, changed)).toThrow();
  });
});
