import { afterEach, describe, expect, it } from 'vitest';
import { SqliteRepository } from '../src/index.js';

const repositories: SqliteRepository[] = [];

function repository() {
  const value = new SqliteRepository(':memory:');
  repositories.push(value);
  return value;
}

const taskInput = {
  name: 'Local fixture',
  startUrl: 'https://example.com/products',
  instruction: 'Get products',
  schedule: { mode: 'manual' as const, timezone: 'Asia/Shanghai', misfirePolicy: 'skip' as const },
  requestSettings: {
    headers: {},
    cookies: [],
    timeoutMs: 30_000,
    retries: 2,
    retryBackoffMs: 1_000,
    concurrency: 2,
    delayMs: 500,
    maxRequests: 100,
    maxRuntimeMs: 300_000,
    domainRateLimitPerMinute: 60,
    respectRobotsTxt: true,
    maxResponseBytes: 20 * 1024 * 1024,
    redirectLimit: 10,
  },
  browserSettings: { enabled: false, waitUntil: 'domcontentloaded' as const, actions: [] },
  pagination: { type: 'none' as const },
  outputSettings: { persistRecords: true },
  credentialBindings: {},
  datasetSettings: { mode: 'snapshot' as const, keyFields: [], detectRemoved: true },
  retentionPolicy: { runDays: null, maxRuns: null, artifactDays: null, logDays: null },
  networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
  outputBindings: [],
};

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((value) => value.close()));
});

describe('SQLite desktop repository conformance', () => {
  it('migrates, versions tasks and commits domain events', async () => {
    const storage = repository();
    await storage.migrate();
    const task = await storage.createTask(taskInput);
    expect(task.revision).toBe(1);
    const updated = await storage.updateTask(task.id, { name: 'Updated' }, 1);
    expect(updated?.revision).toBe(2);
    await expect(storage.updateTask(task.id, { name: 'Stale' }, 1)).resolves.toBeNull();
    const events = await storage.listEvents(0, 10);
    expect(events.items.map((event) => event.type)).toEqual(['task.created', 'task.updated']);
  });

  it('enforces one queued or running Run per task and recovers interrupted work', async () => {
    const storage = repository();
    await storage.migrate();
    const task = await storage.createTask(taskInput);
    const run = await storage.createRun(task.id);
    await expect(storage.createRun(task.id)).rejects.toThrow();
    expect(await storage.startRun(run.id, task.id)).toBe(true);
    expect(await storage.recoverInterruptedRuns()).toBe(1);
    expect((await storage.getRun(run.id))?.metadata.errorCode).toBe('RUNTIME_INTERRUPTED');
    expect((await storage.getTask(task.id))?.status).toBe('failed');
  });

  it('persists cron schedules through the scheduler conformance table', async () => {
    const storage = repository();
    await storage.migrate();
    const task = await storage.createTask(taskInput);
    const scheduled = await storage.updateTask(
      task.id,
      {
        schedule: {
          mode: 'cron',
          cron: '*/15 * * * *',
          timezone: 'Asia/Shanghai',
          misfirePolicy: 'run-once',
        },
      },
      1,
    );
    expect(await storage.listScheduledTasks()).toEqual([
      {
        id: task.id,
        schedule: {
          mode: 'cron',
          cron: '*/15 * * * *',
          timezone: 'Asia/Shanghai',
          misfirePolicy: 'run-once',
        },
        lastTriggeredAt: null,
        updatedAt: expect.any(String),
      },
    ]);
    const triggeredAt = '2026-08-28T00:00:00.000Z';
    await storage.markScheduleTriggered(task.id, triggeredAt);
    expect((await storage.listScheduledTasks())[0]?.lastTriggeredAt).toBe(triggeredAt);
    expect(await storage.getSchedulingPaused()).toBe(false);
    await storage.setSchedulingPaused(true);
    expect(await storage.getSchedulingPaused()).toBe(true);
    await storage.setSchedulingPaused(false);
    expect(await storage.getSchedulingPaused()).toBe(false);
    await storage.updateTask(
      task.id,
      { schedule: { mode: 'manual', timezone: 'Asia/Shanghai', misfirePolicy: 'skip' } },
      scheduled!.revision,
    );
    expect(await storage.listScheduledTasks()).toEqual([]);
  });

  it('persists idempotency, runtime jobs and artifacts', async () => {
    const storage = repository();
    await storage.migrate();
    const task = await storage.createTask(taskInput);
    const run = await storage.createRun(task.id);
    await storage.putIdempotency('scope', 'key', 'fingerprint', { runId: run.id });
    expect(await storage.getIdempotency('scope', 'key')).toEqual({
      fingerprint: 'fingerprint',
      response: { runId: run.id },
    });
    await storage.enqueueRuntimeJob({ id: 'job-1', taskId: task.id, runId: run.id });
    expect((await storage.claimRuntimeJob())?.id).toBe('job-1');
    await storage.finishRuntimeJob('job-1');
    const artifact = await storage.putArtifact({
      runId: run.id,
      format: 'json',
      filename: 'data.json',
      contentType: 'application/json',
      size: 2,
      storageKey: 'storage-key',
    });
    expect((await storage.getArtifact(artifact.id))?.storageKey).toBe('storage-key');
  });

  it('persists trend bindings and repairs a binding after its task is deleted', async () => {
    const storage = repository();
    await storage.migrate();
    const firstTask = await storage.createTask(taskInput);
    const first = await storage.upsertTrendSourceBinding({
      key: 'hongguo.latest',
      platform: 'hongguo',
      taskId: firstTask.id,
      enabled: true,
      autoRefresh: true,
    });
    expect(first.taskId).toBe(firstTask.id);
    expect(await storage.listTrendSourceBindings()).toHaveLength(1);

    await storage.deleteTask(firstTask.id);
    expect((await storage.getTrendSourceBinding('hongguo.latest'))?.taskId).toBeNull();

    const replacement = await storage.createTask({ ...taskInput, name: 'Replacement trend task' });
    const repaired = await storage.upsertTrendSourceBinding({
      key: 'hongguo.latest',
      platform: 'hongguo',
      taskId: replacement.id,
      enabled: false,
      autoRefresh: false,
    });
    expect(repaired).toMatchObject({
      taskId: replacement.id,
      enabled: false,
      autoRefresh: false,
    });
  });

  it('keeps completed preference evidence while replacing like with dislike idempotently', async () => {
    const storage = repository();
    await storage.migrate();
    const content = {
      platform: 'fanqie' as const,
      contentType: 'novel' as const,
      externalId: 'book-42',
      title: 'Fixture novel',
      url: 'https://fanqienovel.com/page/42',
      coverUrl: null,
      author: 'Fixture author',
      summary: 'Snapshot survives source changes',
      tags: ['悬疑'],
      metadata: { readCount: 42 },
    };
    const targetKey = 'fanqie:novel:book-42';
    const liked = await storage.upsertPreferenceSignal({ kind: 'like', content, targetKey });
    const repeated = await storage.upsertPreferenceSignal({ kind: 'like', content, targetKey });
    expect(repeated.id).toBe(liked.id);
    const completed = await storage.upsertPreferenceSignal({
      kind: 'completed',
      content,
      targetKey,
    });
    await storage.upsertPreferenceSignal({ kind: 'dislike', content, targetKey });

    const page = await storage.listPreferenceSignals(undefined, 10);
    expect(page.items.map((signal) => signal.kind).sort()).toEqual(['completed', 'dislike']);
    expect(page.items.find((signal) => signal.kind === 'completed')?.id).toBe(completed.id);
    expect(page.items[0]?.content.summary).toBe('Snapshot survives source changes');

    expect(await storage.deletePreferenceSignal(completed.id)).toBe(true);
    expect(await storage.clearPreferenceSignals()).toBe(1);
    expect((await storage.listPreferenceSignals()).items).toEqual([]);
  });

  it('projects snapshot, upsert and append Dataset changes (conformance)', async () => {
    const storage = repository();
    await storage.migrate();
    const task = await storage.createTask(taskInput);
    const first = await storage.createRun(task.id);
    await storage.startRun(first.id, task.id);
    const firstStats = await storage.projectDataset(
      task.id,
      first.id,
      { mode: 'snapshot', keyFields: ['id'], detectRemoved: true },
      [
        { sourceUrl: 'https://example.com/1', data: { id: 1, name: 'A' } },
        { sourceUrl: 'https://example.com/2', data: { id: 2, name: 'B' } },
      ],
    );
    expect(firstStats).toMatchObject({ added: 2, current: 2 });
    await storage.completeRun(first.id, task.id, {
      requestCount: 1,
      recordCount: 2,
      browserUsed: false,
      aiUsed: false,
      metadata: {},
      records: [],
    });

    const second = await storage.createRun(task.id);
    await storage.startRun(second.id, task.id);
    const secondStats = await storage.projectDataset(
      task.id,
      second.id,
      { mode: 'snapshot', keyFields: ['id'], detectRemoved: true },
      [
        { sourceUrl: 'https://example.com/1', data: { id: 1, name: 'A changed' } },
        { sourceUrl: 'https://example.com/3', data: { id: 3, name: 'C' } },
      ],
    );
    expect(secondStats).toMatchObject({ added: 1, updated: 1, removed: 1, current: 2 });
    const changes = await storage.listRecordChanges(task.id, undefined, 20, second.id);
    expect(changes.items.map((change) => change.type).sort()).toEqual([
      'added',
      'removed',
      'updated',
    ]);
    await storage.completeRun(second.id, task.id, {
      requestCount: 1,
      recordCount: 2,
      browserUsed: false,
      aiUsed: false,
      metadata: {},
      records: [],
    });

    const third = await storage.createRun(task.id);
    await storage.startRun(third.id, task.id);
    const appendStats = await storage.projectDataset(
      task.id,
      third.id,
      { mode: 'append', keyFields: ['id'], detectRemoved: false },
      [{ sourceUrl: 'https://example.com/1', data: { id: 1, name: 'A changed' } }],
    );
    expect(appendStats.added).toBe(1);
    expect(appendStats.removed).toBe(0);
  });

  it('atomically commits or rolls back a successful Run and Dataset projection (conformance)', async () => {
    const storage = repository();
    await storage.migrate();
    const task = await storage.createTask(taskInput);
    const canceled = await storage.createRun(task.id);
    await storage.startRun(canceled.id, task.id);
    await storage.cancelRun(canceled.id);

    await expect(
      storage.commitRunSuccess(
        canceled.id,
        task.id,
        { mode: 'snapshot', keyFields: ['id'], detectRemoved: true },
        [{ sourceUrl: 'https://example.com/late', data: { id: 'late' } }],
        {
          requestCount: 1,
          recordCount: 1,
          browserUsed: false,
          aiUsed: false,
          metadata: {},
          records: [{ sourceUrl: 'https://example.com/late', data: { id: 'late' } }],
        },
      ),
    ).rejects.toThrow('no longer completable');

    expect((await storage.getRun(canceled.id))?.status).toBe('canceled');
    expect((await storage.listRecords(canceled.id, undefined, 10)).items).toEqual([]);
    expect((await storage.listDatasetRecords(task.id, undefined, 10)).items).toEqual([]);
    const eventTypes = (await storage.listEvents(0, 100)).items.map((event) => event.type);
    expect(eventTypes).not.toContain('dataset.projected');
    expect(eventTypes).not.toContain('run.succeeded');

    const run = await storage.createRun(task.id);
    await storage.startRun(run.id, task.id);
    const stats = await storage.commitRunSuccess(
      run.id,
      task.id,
      { mode: 'snapshot', keyFields: ['id'], detectRemoved: true },
      [{ sourceUrl: 'https://example.com/1', data: { id: 1, name: 'A' } }],
      {
        requestCount: 1,
        recordCount: 1,
        browserUsed: false,
        aiUsed: false,
        metadata: { warnings: [] },
        records: [{ sourceUrl: 'https://example.com/1', data: { id: 1, name: 'A' } }],
      },
    );
    expect(stats).toMatchObject({ added: 1, current: 1 });
    expect(await storage.getRun(run.id)).toMatchObject({
      status: 'succeeded',
      datasetStats: stats,
    });
    expect((await storage.listRecords(run.id, undefined, 10)).items).toHaveLength(1);
  });

  it('paginates an actual Run snapshot Diff by stable record key (conformance)', async () => {
    const storage = repository();
    await storage.migrate();
    const task = await storage.createTask({
      ...taskInput,
      datasetSettings: { mode: 'snapshot', keyFields: ['id'], detectRemoved: true },
    });
    const firstRecords = [
      { sourceUrl: 'https://example.com/1', data: { id: 1, name: 'A' } },
      { sourceUrl: 'https://example.com/2', data: { id: 2, name: 'B' } },
    ];
    const first = await storage.createRun(task.id);
    await storage.startRun(first.id, task.id);
    await storage.commitRunSuccess(first.id, task.id, task.datasetSettings, firstRecords, {
      requestCount: 2,
      recordCount: 2,
      browserUsed: false,
      aiUsed: false,
      metadata: {},
      records: firstRecords,
    });
    const secondRecords = [
      { sourceUrl: 'https://example.com/1', data: { id: 1, name: 'A changed' } },
      { sourceUrl: 'https://example.com/3', data: { id: 3, name: 'C' } },
    ];
    const second = await storage.createRun(task.id);
    await storage.startRun(second.id, task.id);
    await storage.commitRunSuccess(second.id, task.id, task.datasetSettings, secondRecords, {
      requestCount: 2,
      recordCount: 2,
      browserUsed: false,
      aiUsed: false,
      metadata: {},
      records: secondRecords,
    });

    const firstPage = await storage.diffRunRecords(task.id, first.id, second.id, undefined, 2);
    expect(firstPage.stats).toEqual({ added: 1, updated: 1, removed: 1 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPage = await storage.diffRunRecords(
      task.id,
      first.id,
      second.id,
      firstPage.nextCursor!,
      2,
    );
    expect([...firstPage.items, ...secondPage.items].map((item) => item.type).sort()).toEqual([
      'added',
      'removed',
      'updated',
    ]);
  });

  it('applies explicit retention without deleting the current Dataset projection (conformance)', async () => {
    const storage = repository();
    await storage.migrate();
    const task = await storage.createTask(taskInput);
    const first = await storage.createRun(task.id);
    await storage.startRun(first.id, task.id);
    await storage.commitRunSuccess(
      first.id,
      task.id,
      task.datasetSettings,
      [{ sourceUrl: 'https://example.com/retained', data: { id: 'retained' } }],
      {
        requestCount: 1,
        recordCount: 1,
        browserUsed: false,
        aiUsed: false,
        metadata: {},
        records: [],
      },
    );
    await storage.putArtifact({
      runId: first.id,
      format: 'json',
      filename: 'old.json',
      contentType: 'application/json',
      size: 2,
      storageKey: 'old-artifact',
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await storage.createRun(task.id);
    await storage.startRun(second.id, task.id);
    await storage.completeRun(second.id, task.id, {
      requestCount: 1,
      recordCount: 0,
      browserUsed: false,
      aiUsed: false,
      metadata: {},
      records: [],
    });
    const result = await storage.applyRetention(task.id, {
      runDays: null,
      maxRuns: 1,
      artifactDays: null,
      logDays: null,
    });
    expect(result).toMatchObject({ deletedRuns: 1, deletedArtifacts: 1 });
    expect(result.artifactStorageKeys).toEqual(['old-artifact']);
    expect(await storage.getRun(first.id)).toBeNull();
    expect(await storage.getRun(second.id)).not.toBeNull();
    expect((await storage.listDatasetRecords(task.id, undefined, 10)).items).toMatchObject([
      { data: { id: 'retained' }, firstRunId: null, lastRunId: null },
    ]);
  });
});
