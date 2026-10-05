import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import {
  taskCreateSchema,
  buildRunDiagnostics,
  normalizeCrawlPlan,
  emitDiagnosticStep,
  type DiagnosticStep,
} from '@zhiyun/shared';
import type { PlatformJobQueue, JobExecutionContext } from '@zhiyun/platform-core';
import { SqliteDatasetRepository } from '@zhiyun/plugin-datasets';
import { LocalArtifactStore } from '@zhiyun/artifact-store';
import { CollectionService, createCollectionJobHandler } from '../src/application/index.js';
import { SqliteCollectionRepository } from '../src/persistence/sqlite/index.js';
import { registerCollectionHttp } from '../src/http/index.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-run-diagnostics-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'zhiyun.sqlite3');
  const artifacts = new LocalArtifactStore(directory);
  await artifacts.initialize();
  cleanups.push(() => artifacts.close());
  const platform = await openSqlitePlatformRepository({
    dataDirectory: directory,
    filePath,
    graphRevision: 'diagnostics-test',
  });
  cleanups.push(() => platform.close());
  const repository = new SqliteCollectionRepository(filePath);
  cleanups.push(() => repository.close());
  await repository.migrate();
  const datasets = new SqliteDatasetRepository(filePath);
  cleanups.push(() => datasets.close());
  await datasets.migrate();
  const app = Fastify();
  cleanups.push(() => app.close());
  await registerCollectionHttp(app, {
    repository,
    platform,
    jobs: {} as PlatformJobQueue,
    credentialStore: {
      put: async () => '',
      resolve: async <T>() => undefined as T,
      delete: async () => undefined,
    },
    runtimeMode: 'headless',
  });
  await app.ready();
  const task = await repository.createTask(
    taskCreateSchema.parse({
      name: 'Diagnostic fixture',
      startUrl: 'https://fixture.invalid/private-marker',
      instruction: 'fixture',
    }),
  );
  return { repository, app, task, datasets, artifacts };
}
const step: DiagnosticStep = {
  kind: 'selector',
  target: 'list',
  status: 'failed',
  startedAt: '2026-10-03T07:00:00.000Z',
  durationMs: 1,
  fieldIndex: 0,
  matchedCount: 0,
  errorCode: 'SELECTOR_UNMATCHED',
};
describe('run-scoped diagnostic export and cleanup', () => {
  it('persists the real Dataset write step and preserves its Snapshot when diagnostics are cleared', async () => {
    const { repository, datasets, app, task, artifacts } = await fixture();
    const rule = await repository.createRule(
      task.id,
      'fixture',
      normalizeCrawlPlan({
        type: 'css',
        container: 'article',
        fields: { name: { selector: 'h2' } },
      }),
      'human',
    );
    const run = await repository.createRun(task.id);
    const handler = createCollectionJobHandler({
      repository,
      artifacts,
      service: new CollectionService(repository, datasets),
      credentialStore: {
        put: async () => '',
        resolve: async <T>() => undefined as T,
        delete: async () => undefined,
      },
      crawler: {
        crawl: async (input) => {
          expect(input.cacheBinding).toMatchObject({
            scope: `task:${task.id}`,
            taskVersion: task.revision,
            ruleVersion: rule.version.id,
          });
          await emitDiagnosticStep(input.onDiagnostic, {
            ...step,
            kind: 'extraction',
            status: 'succeeded',
            errorCode: undefined,
            recordCount: 1,
          });
          const committed = await input.onBatch!({
            requestId: 'a'.repeat(64),
            sequence: 0,
            records: [{ sourceUrl: task.startUrl, data: { name: 'Sample' } }],
          });
          return {
            records: [],
            metadata: {
              requestCount: 1,
              recordCount: committed.totalCount,
              browserUsed: false,
              aiUsed: false,
              actionCache: {
                stages: 1,
                hitStages: 1,
                storedStages: 0,
                bypassedStages: 0,
                providerCalls: 0,
                reasons: { matched: 1 },
              },
            },
          };
        },
      },
    });
    const context = {
      job: { id: run.id, payload: { taskId: task.id, runId: run.id }, attempt: 1, maxAttempts: 1 },
      signal: new AbortController().signal,
      progress: async () => undefined,
      persisting: async () => undefined,
    } as unknown as JobExecutionContext;
    await handler(context);
    const completed = (await repository.getRun(run.id))!;
    expect(completed.status).toBe('succeeded');
    expect(completed.metadata.actionCache).toEqual({
      stages: 1,
      hitStages: 1,
      storedStages: 0,
      bypassedStages: 0,
      providerCalls: 0,
      reasons: { matched: 1 },
    });
    const report = (
      await app.inject({ method: 'GET', url: `/api/v2/runs/${run.id}/diagnostics` })
    ).json();
    expect(report.run.ruleVersionId).toBe(rule.version.id);
    expect(report.steps).toContainEqual(
      expect.objectContaining({
        kind: 'write',
        target: 'dataset',
        writtenCount: 1,
        status: 'succeeded',
      }),
    );
    const records = await datasets.listRunRecords(run.id);
    const snapshot = await datasets.getSnapshot(String(completed.metadata.datasetSnapshotId));
    expect(records.items).toHaveLength(1);
    await app.inject({
      method: 'DELETE',
      url: `/api/v2/runs/${run.id}/diagnostics`,
      headers: { 'idempotency-key': 'clean-complete' },
    });
    expect(await datasets.listRunRecords(run.id)).toEqual(records);
    expect(await datasets.getSnapshot(String(completed.metadata.datasetSnapshotId))).toEqual(
      snapshot,
    );
    expect(await repository.getRun(run.id)).toEqual(completed);
  });

  it('does not change the job or its persisted records when only diagnostic storage fails', async () => {
    const { repository, datasets, task, artifacts } = await fixture();
    await repository.createRule(
      task.id,
      'fixture',
      normalizeCrawlPlan({
        type: 'css',
        container: 'article',
        fields: { name: { selector: 'h2' } },
      }),
      'human',
    );
    const original = repository.appendRunLog.bind(repository);
    vi.spyOn(repository, 'appendRunLog').mockImplementation(async (entry) => {
      if (entry.phase === 'diagnostic') throw new Error('diagnostic-storage-marker');
      return original(entry);
    });
    const run = await repository.createRun(task.id);
    const handler = createCollectionJobHandler({
      repository,
      artifacts,
      service: new CollectionService(repository, datasets),
      credentialStore: {
        put: async () => '',
        resolve: async <T>() => undefined as T,
        delete: async () => undefined,
      },
      crawler: {
        crawl: async (input) => {
          await input.onDiagnostic?.(step);
          const committed = await input.onBatch!({
            requestId: 'b'.repeat(64),
            sequence: 0,
            records: [{ sourceUrl: task.startUrl, data: { name: 'Sample' } }],
          });
          return {
            records: [],
            metadata: {
              requestCount: 1,
              recordCount: committed.totalCount,
              browserUsed: false,
              aiUsed: false,
            },
          };
        },
      },
    });
    await handler({
      job: { id: run.id, payload: { taskId: task.id, runId: run.id }, attempt: 1, maxAttempts: 1 },
      signal: new AbortController().signal,
      progress: async () => undefined,
      persisting: async () => undefined,
    } as unknown as JobExecutionContext);
    expect((await repository.getRun(run.id))?.status).toBe('succeeded');
    expect((await datasets.listRunRecords(run.id)).items[0]?.data).toEqual({ name: 'Sample' });
    expect((await repository.getRunDiagnosticLogs(run.id)).items).toEqual([]);
  });

  it('identifies an actual failed Dataset write without exporting its error message', async () => {
    const { repository, datasets, app, task, artifacts } = await fixture();
    await repository.createRule(
      task.id,
      'fixture',
      normalizeCrawlPlan({
        type: 'css',
        container: 'article',
        fields: { name: { selector: 'h2' } },
      }),
      'human',
    );
    vi.spyOn(datasets, 'commitIngestion').mockRejectedValue(new Error('private-write-marker'));
    const run = await repository.createRun(task.id);
    const handler = createCollectionJobHandler({
      repository,
      artifacts,
      service: new CollectionService(repository, datasets),
      credentialStore: {
        put: async () => '',
        resolve: async <T>() => undefined as T,
        delete: async () => undefined,
      },
      crawler: {
        crawl: async (input) => {
          await input.onBatch!({
            requestId: 'c'.repeat(64),
            sequence: 0,
            records: [{ sourceUrl: task.startUrl, data: { name: 'Sample' } }],
          });
          return {
            records: [],
            metadata: { requestCount: 1, recordCount: 1, browserUsed: false, aiUsed: false },
          };
        },
      },
    });
    await expect(
      handler({
        job: {
          id: run.id,
          payload: { taskId: task.id, runId: run.id },
          attempt: 1,
          maxAttempts: 1,
        },
        signal: new AbortController().signal,
        progress: async () => undefined,
        persisting: async () => undefined,
      } as unknown as JobExecutionContext),
    ).rejects.toThrow('private-write-marker');
    expect(await repository.getRun(run.id)).toMatchObject({
      status: 'queued',
      phase: 'retrying',
      finishedAt: null,
    });
    const session = (await repository.listCrawlSessionOwners()).find(
      (row) => row.runId === run.id,
    )!;
    expect(await repository.getCrawlResult(run.id, session.fingerprint)).toMatchObject({
      recordCount: 1,
      requestCount: 1,
    });
    const response = await app.inject({ method: 'GET', url: `/api/v2/runs/${run.id}/diagnostics` });
    expect(response.json().steps).toContainEqual(
      expect.objectContaining({ kind: 'write', status: 'failed', errorCode: 'WRITE_ERROR' }),
    );
    expect(response.body).not.toContain('private-write-marker');
  });

  it('bounds stored steps, does not affect execution state, and cleans only the selected run', async () => {
    const { repository, app, task } = await fixture();
    const first = await repository.createRun(task.id);
    const otherTask = await repository.createTask({ ...task, name: 'Other run fixture' });
    const second = await repository.createRun(otherTask.id);
    for (const run of [first, second]) {
      await repository.startRun(run.id, run.taskId);
      await repository.appendRunLog({
        runId: run.id,
        level: 'info',
        phase: 'list',
        message: 'normal log private-marker',
        url: task.startUrl,
        errorCode: null,
        metadata: { progress: 0.5 },
      });
    }
    const before = await repository.getRun(first.id);
    for (let i = 0; i < 300; i++)
      await repository.appendRunLog({
        runId: first.id,
        level: 'info',
        phase: 'diagnostic',
        message: 'selector',
        url: null,
        errorCode: step.errorCode!,
        metadata: { diagnostic: step, ruleVersionId: task.id },
      });
    await repository.appendRunLog({
      runId: second.id,
      level: 'info',
      phase: 'diagnostic',
      message: 'selector',
      url: null,
      errorCode: null,
      metadata: { diagnostic: step },
    });
    expect(await repository.getRun(first.id)).toEqual(before);
    expect(
      (await repository.listRunLogs(first.id, 0, 1000)).filter((log) => log.phase === 'diagnostic'),
    ).toHaveLength(256);
    const blocked = await app.inject({
      method: 'DELETE',
      url: `/api/v2/runs/${first.id}/diagnostics`,
      headers: { 'idempotency-key': 'clear-running' },
    });
    expect(blocked.statusCode).toBe(409);
    await repository.failRun(first.id, task.id, 'private-marker', 'CRAWLER_ERROR');
    const response = await app.inject({
      method: 'GET',
      url: `/api/v2/runs/${first.id}/diagnostics`,
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      truncated: true,
      stepCount: 300,
      run: { id: first.id, ruleVersionId: task.id, errorCode: 'SELECTOR_UNMATCHED' },
    });
    expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(64 * 1024);
    expect(response.body).not.toContain('private-marker');
    expect(response.body).not.toContain(second.id);
    const runBeforeClear = await repository.getRun(first.id);
    const otherBefore = await repository.getRunDiagnosticLogs(second.id);
    const missingKey = await app.inject({
      method: 'DELETE',
      url: `/api/v2/runs/${first.id}/diagnostics`,
    });
    expect(missingKey.statusCode).toBe(428);
    const cleared = await app.inject({
      method: 'DELETE',
      url: `/api/v2/runs/${first.id}/diagnostics`,
      headers: { 'idempotency-key': 'clear-first' },
    });
    expect(cleared.json()).toEqual({ runId: first.id, deletedSteps: 256 });
    expect(
      (await app.inject({ method: 'GET', url: `/api/v2/runs/${first.id}/diagnostics` })).json(),
    ).toMatchObject({ available: false, stepCount: 0, steps: [] });
    expect(await repository.getRun(first.id)).toEqual(runBeforeClear);
    expect(await repository.getRunDiagnosticLogs(second.id)).toEqual(otherBefore);
    expect(
      (await repository.listRunLogs(first.id)).some(
        (log) => log.message === 'normal log private-marker',
      ),
    ).toBe(true);
    const unknown = await app.inject({
      method: 'GET',
      url: `/api/v2/runs/${crypto.randomUUID()}/diagnostics`,
    });
    expect(unknown.statusCode).toBe(404);
    expect(buildRunDiagnostics(first, otherBefore.items).available).toBe(false);
  });
});
