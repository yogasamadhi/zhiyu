import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalArtifactStore } from '@zhiyun/artifact-store';
import { JobHandlerRegistry, type PlatformRepository } from '@zhiyun/platform-core';
import {
  CollectionBatchCleanup,
  CollectionService,
  SqliteCollectionRepository,
  createCollectionJobHandler,
  registerCollectionHttp,
  type CollectionTask,
} from '@zhiyun/plugin-collection';
import { SqliteDatasetRepository } from '@zhiyun/plugin-datasets';
import { LocalPlatformJobQueue } from '@zhiyun/queue-local-v1';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import {
  normalizeCrawlPlan,
  taskCreateSchema,
  type CrawlRun,
  type CrawlerService,
} from '@zhiyun/contracts';

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0).reverse()) await dispose();
});
const fingerprint = 'f'.repeat(64);
const credentials = {
  put: async () => '',
  resolve: async <T>() => undefined as T,
  delete: async () => undefined,
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-crawl-cleanup-'));
  const filePath = join(directory, 'zhiyun.sqlite3');
  let platform!: PlatformRepository;
  let collection!: SqliteCollectionRepository;
  let datasets!: SqliteDatasetRepository;
  let jobs!: LocalPlatformJobQueue;
  let cleanup!: CollectionBatchCleanup;
  const handlers = new JobHandlerRegistry();
  const artifacts = new LocalArtifactStore(directory);
  const releases: Array<() => void> = [];
  const apps: ReturnType<typeof Fastify>[] = [];
  async function open() {
    platform = await openSqlitePlatformRepository({
      dataDirectory: directory,
      filePath,
      graphRevision: 'cleanup-fixture',
    });
    collection = new SqliteCollectionRepository(filePath);
    datasets = new SqliteDatasetRepository(filePath);
    await collection.migrate();
    await datasets.migrate();
    jobs = new LocalPlatformJobQueue(platform, handlers, { leaseMs: 750, pollIntervalMs: 60_000 });
    cleanup = new CollectionBatchCleanup({ repository: collection, datasets, jobs, artifacts }, 20);
  }
  await artifacts.initialize();
  await open();
  disposals.push(async () => {
    for (const release of releases) release();
    for (const app of apps) await app.close();
    await cleanup.close();
    await jobs.close();
    await artifacts.close();
    await collection.close();
    await datasets.close();
    await platform.close();
    await rm(directory, { recursive: true, force: true });
  });
  const task = await collection.createTask(
    taskCreateSchema.parse({
      name: 'Cleanup fixture',
      startUrl: 'https://fixture.invalid/items',
      instruction: 'fixture',
      datasetSettings: { mode: 'snapshot', keyFields: ['id'], detectRemoved: true },
    }),
  );
  await collection.createRule(
    task.id,
    'fixture',
    normalizeCrawlPlan({
      type: 'json',
      container: '$.items[*]',
      fields: { id: { path: '$.id', dataType: 'string' } },
    }),
    'human',
  );
  const old = await datasets.commitRunRecords({
    sourceTaskId: task.id,
    sourceRunId: randomUUID(),
    settings: task.datasetSettings,
    records: [{ sourceUrl: task.startUrl, data: { id: 'old' } }],
  });
  const workspace = await artifacts.openWorkspace('cleanup-unrelated');
  await writeFile(await workspace.resolve('keep.txt'), 'keep-unrelated');
  await artifacts.commitWorkspaceFile(
    'cleanup-unrelated',
    'keep.txt',
    'datasets/cleanup-unrelated/keep.txt',
  );
  await artifacts.removeWorkspace('cleanup-unrelated');

  async function seed(run: CrawlRun, owner: CollectionTask = task) {
    const writer = new CollectionService(collection, datasets).createBatchWriter({
      runId: run.id,
      taskId: owner.id,
      fingerprint,
      artifacts,
      settings: owner.datasetSettings,
      dedupe: { strategy: 'hash', fields: [] },
      maxRecords: 100,
      signal: new AbortController().signal,
    });
    await writer.begin();
    await writer.write({
      requestId: 'a'.repeat(64),
      sequence: 0,
      records: [{ sourceUrl: owner.startUrl, data: { id: 'pending' } }],
    });
  }
  async function enqueue(run: CrawlRun, extra = {}) {
    return jobs.enqueue({
      id: run.id,
      ownerPluginId: 'collection',
      type: 'collection.crawl.execute',
      resourceClass: 'browser-heavy',
      payload: { taskId: run.taskId, runId: run.id },
      maxAttempts: 2,
      ...extra,
    });
  }
  async function app() {
    const app = Fastify();
    apps.push(app);
    await registerCollectionHttp(app, {
      repository: collection,
      platform,
      jobs,
      batches: cleanup,
      credentialStore: credentials,
      runtimeMode: 'headless',
    });
    await app.ready();
    return app;
  }
  async function assertClean(
    run: CrawlRun,
    owner: CollectionTask = task,
    runFingerprint = fingerprint,
  ) {
    expect(await collection.getCrawlCleanup(run.id)).toBeNull();
    expect(await collection.listCrawlSessionOwners()).not.toContainEqual(
      expect.objectContaining({ runId: run.id }),
    );
    await expect(
      readFile(join(directory, 'artifacts', 'collection-batches', run.id, 'anything')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const batchOwners = await readdir(join(directory, 'artifacts', 'collection-batches')).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return [];
      },
    );
    expect(batchOwners).not.toContain(run.id);
    const workspaces = await readdir(join(directory, 'job-workspaces'));
    expect(workspaces).not.toContain(`collection-${run.id}`);
    const empty = await datasets.beginIngestion({
      sourceTaskId: owner.id,
      sourceRunId: run.id,
      fingerprint: runFingerprint,
      settings: owner.datasetSettings,
      dedupe: { strategy: 'hash', fields: [] },
    });
    expect(empty.acceptedCount).toBe(0);
    await datasets.discardIngestion(run.id);
    expect(
      await readFile(
        await artifacts.resolveArtifact('datasets/cleanup-unrelated/keep.txt'),
        'utf8',
      ),
    ).toBe('keep-unrelated');
    expect(await datasets.getSnapshot(old.snapshot.id)).toEqual(old.snapshot);
  }
  return {
    directory,
    task,
    old,
    artifacts,
    handlers,
    releases,
    seed,
    enqueue,
    app,
    assertClean,
    get collection() {
      return collection;
    },
    get datasets() {
      return datasets;
    },
    get jobs() {
      return jobs;
    },
    get platform() {
      return platform;
    },
    get cleanup() {
      return cleanup;
    },
    async restart() {
      await cleanup.close();
      await jobs.close();
      await collection.close();
      await datasets.close();
      await platform.close();
      await open();
    },
  };
}

describe('durable Collection batch cleanup with LocalQueue', () => {
  it.each(['cancel', 'task-change'] as const)(
    'keeps completion recovery subject to %s without fetching again',
    async (action) => {
      const f = await fixture();
      const run = await f.collection.createRun(f.task.id);
      const crawl = vi.fn(async (input: Parameters<CrawlerService['crawl']>[0]) => {
        const batch = await input.onBatch!({
          requestId: 'b'.repeat(64),
          sequence: 0,
          records: [{ sourceUrl: f.task.startUrl, data: { id: 'pending' } }],
        });
        return {
          records: [],
          metadata: {
            recordCount: batch.totalCount,
            requestCount: 1,
            browserUsed: false,
            aiUsed: false,
          },
        };
      });
      f.handlers.register({
        ownerPluginId: 'collection',
        type: 'collection.crawl.execute',
        resourceClass: 'browser-heavy',
        handler: createCollectionJobHandler({
          repository: f.collection,
          service: new CollectionService(f.collection, f.datasets),
          artifacts: f.artifacts,
          credentialStore: credentials,
          crawler: { crawl },
        }),
      });
      vi.spyOn(f.datasets, 'commitIngestion').mockRejectedValueOnce(
        new Error('temporary fixture failure'),
      );
      await f.enqueue(run, { maxAttempts: 1 });
      await f.jobs.dispatchOnce();
      await f.cleanup.sweep();
      const session = (await f.collection.listCrawlSessionOwners()).find(
        (row) => row.runId === run.id,
      )!;
      const job = (await f.jobs.get(run.id))!;
      expect(job.state).toBe('queued');
      if (action === 'cancel') {
        const app = await f.app();
        const response = await app.inject({
          method: 'POST',
          url: `/api/v2/runs/${run.id}/cancel`,
          headers: { 'idempotency-key': randomUUID() },
        });
        expect(response.statusCode).toBe(202);
        expect(response.json()).toMatchObject({ status: 'canceled' });
        expect(await f.jobs.get(run.id)).toMatchObject({ state: 'canceled', attempt: 1 });
      } else {
        expect(
          await f.collection.updateTask(
            f.task.id,
            { name: 'Changed after completed input' },
            f.task.revision,
          ),
        ).toBeTruthy();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(job.availableAt).getTime() + 1);
        await f.jobs.dispatchOnce();
        await f.cleanup.sweep();
        expect(await f.collection.getRun(run.id)).toMatchObject({
          status: 'failed',
          errorCode: 'VALIDATION_ERROR',
        });
        expect(await f.jobs.get(run.id)).toMatchObject({
          state: 'failed',
          attempt: 2,
          maxAttempts: 2,
        });
      }
      expect(crawl).toHaveBeenCalledTimes(1);
      await f.assertClean(run, f.task, session.fingerprint);
      expect(
        (await f.datasets.listRecords(f.old.dataset.id)).items.map((row) => row.data.id),
      ).toEqual(['old']);
      expect(await f.datasets.listSnapshots(f.old.dataset.id)).toHaveLength(1);
    },
  );

  it.each(['before_projection', 'after_projection', 'after_run', 'before_job_ack'] as const)(
    'finishes the same exhausted job from durable input at %s without crawling or projecting twice',
    async (point) => {
      const f = await fixture();
      const run = await f.collection.createRun(f.task.id);
      const crawl = vi.fn(async (input: Parameters<CrawlerService['crawl']>[0]) => {
        const batch = await input.onBatch!({
          requestId: 'b'.repeat(64),
          sequence: 0,
          records: [{ sourceUrl: f.task.startUrl, data: { id: 'pending' } }],
        });
        return {
          records: [],
          metadata: {
            recordCount: batch.totalCount,
            requestCount: 1,
            browserUsed: false,
            aiUsed: false,
          },
        };
      });
      f.handlers.register({
        ownerPluginId: 'collection',
        type: 'collection.crawl.execute',
        resourceClass: 'browser-heavy',
        handler: createCollectionJobHandler({
          repository: f.collection,
          service: new CollectionService(f.collection, f.datasets),
          artifacts: f.artifacts,
          credentialStore: credentials,
          crawler: { crawl },
        }),
      });
      const project = f.datasets.commitIngestion.bind(f.datasets);
      if (point === 'before_projection')
        vi.spyOn(f.datasets, 'commitIngestion').mockRejectedValueOnce(
          new Error('temporary projection failure'),
        );
      if (point === 'after_projection')
        vi.spyOn(f.datasets, 'commitIngestion').mockImplementationOnce(async (...args) => {
          await project(...args);
          throw new Error('projection acknowledgement lost');
        });
      if (point === 'after_run') {
        const complete = f.collection.completeRun.bind(f.collection);
        vi.spyOn(f.collection, 'completeRun').mockImplementationOnce(async (...args) => {
          await complete(...args);
          throw new Error('run acknowledgement lost');
        });
      }
      if (point === 'before_job_ack')
        vi.spyOn(f.platform, 'completeJob').mockRejectedValueOnce(
          new Error('job acknowledgement lost'),
        );
      await f.enqueue(run, { maxAttempts: 1 });
      await f.jobs.dispatchOnce();
      expect(await f.jobs.get(run.id)).toMatchObject({
        state: 'failed',
        attempt: 1,
        maxAttempts: 1,
      });
      expect(await f.collection.getRun(run.id)).toMatchObject({
        status:
          point === 'before_projection' || point === 'after_projection' ? 'queued' : 'succeeded',
      });
      if (point === 'before_projection' || point === 'after_projection')
        expect(
          (await f.collection.listCrawlSessionOwners()).find((row) => row.runId === run.id),
        ).toBeTruthy();
      else expect(await f.collection.getCrawlCleanup(run.id)).toMatchObject({ reason: 'terminal' });
      await f.cleanup.sweep();
      const pending = (await f.jobs.get(run.id))!;
      expect(pending).toMatchObject({
        state: 'queued',
        attempt: 1,
        maxAttempts: 2,
        phase: 'recovering-completion',
      });
      await f.cleanup.sweep();
      expect(await f.jobs.get(run.id)).toMatchObject({ attempt: 1, maxAttempts: 2 });
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(pending.availableAt).getTime() + 1);
      await f.jobs.dispatchOnce();
      await f.cleanup.sweep();
      expect(await f.jobs.get(run.id)).toMatchObject({
        state: 'succeeded',
        attempt: 2,
        maxAttempts: 2,
      });
      const completed = (await f.collection.getRun(run.id))!;
      expect(completed).toMatchObject({
        status: 'succeeded',
        recordCount: 1,
        requestCount: 1,
        datasetStats: { added: 1, updated: 0, unchanged: 0, removed: 1 },
      });
      expect(crawl).toHaveBeenCalledTimes(1);
      expect(
        (await f.datasets.listRecords(f.old.dataset.id)).items.map((row) => row.data.id),
      ).toEqual(['pending']);
      expect(await f.datasets.listSnapshots(f.old.dataset.id)).toHaveLength(2);
      expect(await f.collection.getCrawlCleanup(run.id)).toBeNull();
      expect(await readdir(join(f.directory, 'artifacts', 'collection-batches'))).toEqual([]);
      expect(await f.datasets.getSnapshot(f.old.snapshot.id)).toEqual(f.old.snapshot);
    },
  );

  it('keeps retrying Runs pollable and cancels retained batches without another dispatch', async () => {
    const f = await fixture();
    const run = await f.collection.createRun(f.task.id);
    f.handlers.register({
      ownerPluginId: 'collection',
      type: 'collection.crawl.execute',
      resourceClass: 'browser-heavy',
      handler: createCollectionJobHandler({
        repository: f.collection,
        service: new CollectionService(f.collection, f.datasets),
        artifacts: f.artifacts,
        credentialStore: credentials,
        crawler: {
          crawl: async (input) => {
            await input.onBatch!({
              requestId: 'b'.repeat(64),
              sequence: 0,
              records: [{ sourceUrl: f.task.startUrl, data: { id: 'pending' } }],
            });
            throw new Error('temporary fixture upstream failure');
          },
        },
      }),
    });
    await f.enqueue(run);
    await f.jobs.dispatchOnce();
    expect(await f.jobs.get(run.id)).toMatchObject({ state: 'queued', attempt: 1 });
    expect(await f.collection.getRun(run.id)).toMatchObject({
      status: 'queued',
      phase: 'retrying',
      finishedAt: null,
    });
    const session = (await f.collection.listCrawlSessionOwners()).find(
      (row) => row.runId === run.id,
    )!;
    await f.cleanup.sweep();
    expect(await f.collection.getCrawlCleanup(run.id)).toBeNull();
    expect(await readdir(join(f.directory, 'artifacts', 'collection-batches', run.id))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}\.json$/)]),
    );
    const app = await f.app();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v2/runs/${run.id}/retry`,
          headers: { 'idempotency-key': randomUUID() },
        })
      ).statusCode,
    ).toBe(409);
    const canceled = await app.inject({
      method: 'POST',
      url: `/api/v2/runs/${run.id}/cancel`,
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(canceled.statusCode).toBe(202);
    expect(canceled.json()).toMatchObject({ status: 'canceled' });
    expect(await f.jobs.get(run.id)).toMatchObject({ state: 'canceled', attempt: 1 });
    await f.assertClean(run, f.task, session.fingerprint);
    expect(
      (await f.datasets.listRecords(f.old.dataset.id)).items.map((row) => row.data.id),
    ).toEqual(['old']);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/v2/runs/${run.id}/cancel`,
          headers: { 'idempotency-key': randomUUID() },
        })
      ).statusCode,
    ).toBe(202);
    await f.assertClean(run, f.task, session.fingerprint);
  });

  it('deletes every queued Run of the selected Task while preserving another Task and stale revisions', async () => {
    const f = await fixture();
    const firstRun = await f.collection.createRun(f.task.id);
    await f.collection.failRun(firstRun.id, f.task.id, 'historical fixture', 'CRAWLER_ERROR');
    const runs = [firstRun, await f.collection.createRun(f.task.id)];
    for (const run of runs) {
      await f.seed(run);
      await f.enqueue(run);
    }
    const otherTask = await f.collection.createTask(
      taskCreateSchema.parse({
        name: 'Other task',
        startUrl: 'https://fixture.invalid/other',
        instruction: 'other',
      }),
    );
    const other = await f.collection.createRun(otherTask.id);
    await f.seed(other, otherTask);
    await f.enqueue(other);
    const app = await f.app();
    const stale = await app.inject({
      method: 'DELETE',
      url: `/api/v2/tasks/${f.task.id}`,
      headers: { 'if-match': '"99"', 'idempotency-key': randomUUID() },
    });
    expect(stale.statusCode).toBe(412);
    expect(await f.collection.listCrawlCleanup()).toEqual([]);
    expect(await f.collection.getRun(runs[0]!.id)).toBeTruthy();
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v2/tasks/${f.task.id}`,
      headers: { 'if-match': `"${f.task.revision}"`, 'idempotency-key': randomUUID() },
    });
    expect(removed.statusCode).toBe(204);
    for (const run of runs) {
      expect(await f.jobs.get(run.id)).toMatchObject({ state: 'canceled' });
      expect(await f.collection.getRun(run.id)).toBeNull();
      await f.assertClean(run);
    }
    expect(await f.jobs.get(other.id)).toMatchObject({ state: 'queued' });
    expect(await readdir(join(f.directory, 'artifacts', 'collection-batches', other.id))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}\.json$/)]),
    );
    expect(await f.collection.getRun(other.id)).toBeTruthy();
  });

  it.each(['cancel', 'delete'] as const)(
    'waits for a live writer during %s, even after its lease has expired',
    async (action) => {
      const f = await fixture();
      const run = await f.collection.createRun(f.task.id);
      await f.seed(run);
      await f.enqueue(run);
      const entered = deferred();
      const release = deferred();
      f.releases.push(release.resolve);
      let aborted = false;
      let lateWriteCompleted = false;
      f.handlers.register({
        ownerPluginId: 'collection',
        type: 'collection.crawl.execute',
        resourceClass: 'browser-heavy',
        handler: async (context) => {
          await f.collection.startRun(run.id, f.task.id);
          context.signal.addEventListener('abort', () => {
            aborted = true;
          });
          entered.resolve();
          await release.promise;
          // A delayed IO write must finish before its workspace is reclaimed.
          await writeFile(
            join(f.directory, 'job-workspaces', `collection-${run.id}`, 'late.txt'),
            'late-fixture-write',
          );
          lateWriteCompleted = true;
        },
      });
      const dispatch = f.jobs.dispatchOnce();
      await entered.promise;
      const app = await f.app();
      const response = await app.inject(
        action === 'cancel'
          ? {
              method: 'POST',
              url: `/api/v2/runs/${run.id}/cancel`,
              headers: { 'idempotency-key': randomUUID() },
            }
          : {
              method: 'DELETE',
              url: `/api/v2/tasks/${f.task.id}`,
              headers: { 'if-match': `"${f.task.revision}"`, 'idempotency-key': randomUUID() },
            },
      );
      expect(response.statusCode).toBe(action === 'cancel' ? 202 : 204);
      expect(await f.jobs.get(run.id)).toMatchObject({ state: 'canceling' });
      expect(await f.collection.getCrawlCleanup(run.id)).toMatchObject({
        reason: action === 'cancel' ? 'canceled' : 'deleted',
      });
      await f.cleanup.start();
      await expect.poll(() => aborted, { timeout: 2_000 }).toBe(true);
      await f.platform.recoverExpiredJobs(new Date(Date.now() + 60_000).toISOString());
      expect(await f.jobs.get(run.id)).toMatchObject({ state: 'canceled', leaseOwner: null });
      await f.cleanup.sweep();
      expect(await readdir(join(f.directory, 'artifacts', 'collection-batches', run.id))).toEqual(
        expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}\.json$/)]),
      );
      release.resolve();
      await dispatch;
      expect(lateWriteCompleted).toBe(true);
      await expect.poll(() => f.collection.getCrawlCleanup(run.id), { timeout: 2_000 }).toBeNull();
      await f.assertClean(run);
    },
  );

  it('recovers deletion committed before file cleanup after reopening SQLite and LocalQueue', async () => {
    const f = await fixture();
    const run = await f.collection.createRun(f.task.id);
    await f.seed(run);
    await f.enqueue(run);
    expect(await f.collection.deleteTask(f.task.id, f.task.revision + 1)).toBe(false);
    expect(await f.collection.getCrawlCleanup(run.id)).toBeNull();
    expect(await f.collection.deleteTask(f.task.id, f.task.revision)).toBe(true);
    expect(await f.collection.getRun(run.id)).toBeNull();
    await f.restart();
    expect(await f.collection.getCrawlCleanup(run.id)).toMatchObject({ reason: 'deleted' });
    await f.cleanup.start();
    expect(await f.jobs.get(run.id)).toMatchObject({ state: 'canceled' });
    await f.assertClean(run);
  });

  it('persists a fixed cleanup error and retries IO failure with backoff after restart', async () => {
    const f = await fixture();
    const run = await f.collection.createRun(f.task.id);
    await f.seed(run);
    await f.enqueue(run);
    await f.collection.requestRunCancellation(run.id);
    const remove = vi
      .spyOn(f.artifacts, 'removeArtifactDirectory')
      .mockRejectedValueOnce(new Error('fixture-private-io-detail'));
    await f.cleanup.reconcileRun(run.id);
    const intent = await f.collection.getCrawlCleanup(run.id);
    expect(intent).toMatchObject({ attempts: 1, errorCode: 'COLLECTION_CLEANUP_FAILED' });
    expect(JSON.stringify(intent)).not.toContain('fixture-private-io-detail');
    await f.cleanup.sweep();
    expect(remove).toHaveBeenCalledTimes(1);
    await f.restart();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(intent!.availableAt).getTime() + 1);
    await f.cleanup.start();
    await f.assertClean(run);
  });

  it('reclaims an exhausted queue failure but retains an unfinished projection summary', async () => {
    const f = await fixture();
    const failed = await f.collection.createRun(f.task.id);
    await f.seed(failed);
    await f.enqueue(failed, { maxAttempts: 1 });
    await f.collection.startRun(failed.id, f.task.id);
    await f.platform.claimJob({
      jobId: failed.id,
      workerId: 'fixture-worker',
      resourceClasses: ['browser-heavy'],
      leaseMs: 1_000,
    });
    await f.platform.startJob(failed.id, 'fixture-worker', 1_000);
    await f.platform.failJob(failed.id, 'fixture-worker', {
      code: 'JOB_INTERRUPTED',
      message: 'fixture',
      retryable: false,
    });
    await f.cleanup.sweep();
    const recoverable = await f.collection.createRun(f.task.id);
    await f.seed(recoverable);
    await f.enqueue(recoverable, { maxAttempts: 1 });
    await f.collection.startRun(recoverable.id, f.task.id);
    await f.collection.saveCrawlResult(recoverable.id, fingerprint, {
      recordCount: 1,
      requestCount: 1,
      browserUsed: false,
      aiUsed: false,
      durationMs: 1,
      warnings: [],
      urls: [],
    });
    await f.datasets.commitIngestion(recoverable.id, fingerprint);
    for (const run of [recoverable]) {
      await f.platform.claimJob({
        jobId: run.id,
        workerId: 'fixture-worker',
        resourceClasses: ['browser-heavy'],
        leaseMs: 1_000,
      });
      await f.platform.startJob(run.id, 'fixture-worker', 1_000);
      await f.platform.failJob(run.id, 'fixture-worker', {
        code: 'JOB_INTERRUPTED',
        message: 'fixture',
        retryable: false,
      });
    }
    await f.cleanup.sweep();
    expect(await f.collection.getRun(failed.id)).toMatchObject({
      status: 'failed',
      errorCode: 'COLLECTION_JOB_TERMINATED',
    });
    await f.assertClean(failed);
    expect(await f.collection.getRun(recoverable.id)).toMatchObject({
      status: 'queued',
      phase: 'retrying',
    });
    expect(await f.jobs.get(recoverable.id)).toMatchObject({ state: 'queued', maxAttempts: 2 });
    expect(await f.collection.getCrawlCleanup(recoverable.id)).toBeNull();
    expect(await f.collection.getCrawlResult(recoverable.id, fingerprint)).toMatchObject({
      recordCount: 1,
    });
    expect(
      await readdir(join(f.directory, 'artifacts', 'collection-batches', recoverable.id)),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}\.json$/)]));
  });

  it.each(['owner', 'payload'] as const)(
    'does not cancel or clean a conflicting job %s',
    async (conflict) => {
      const f = await fixture();
      const run = await f.collection.createRun(f.task.id);
      await f.seed(run);
      await f.enqueue(
        run,
        conflict === 'owner'
          ? { ownerPluginId: 'outputs', type: 'outputs.deliver' }
          : { payload: { runId: run.id, taskId: randomUUID() } },
      );
      await f.collection.requestRunCancellation(run.id);
      await f.cleanup.reconcileRun(run.id);
      expect(await f.jobs.get(run.id)).toMatchObject({ state: 'queued' });
      expect(await f.collection.getCrawlCleanup(run.id)).toMatchObject({ reason: 'canceled' });
      expect(await readdir(join(f.directory, 'artifacts', 'collection-batches', run.id))).toEqual(
        expect.arrayContaining([expect.stringMatching(/^[a-f0-9]{64}\.json$/)]),
      );
      await expect(
        f.collection.requestCrawlCleanup(run.id, randomUUID(), 'deleted'),
      ).rejects.toThrow('owner mismatch');
    },
  );

  it('reclaims more than one keyset page of deleted Run workspaces', async () => {
    const f = await fixture();
    const runs: CrawlRun[] = [];
    for (let index = 0; index < 105; index++) {
      const run = await f.collection.createRun(f.task.id);
      runs.push(run);
      await f.enqueue(run);
      await f.artifacts.openWorkspace(`collection-${run.id}`);
      await f.collection.failRun(run.id, f.task.id, 'historical fixture', 'CRAWLER_ERROR');
    }
    await f.collection.deleteTask(f.task.id);
    await f.cleanup.sweep();
    expect(await f.collection.listCrawlCleanup()).toEqual([]);
    for (const run of runs) expect(await f.jobs.get(run.id)).toMatchObject({ state: 'canceled' });
    expect(await readdir(join(f.directory, 'job-workspaces'))).toEqual([]);
    expect(await f.datasets.getSnapshot(f.old.snapshot.id)).toEqual(f.old.snapshot);
  });
});
