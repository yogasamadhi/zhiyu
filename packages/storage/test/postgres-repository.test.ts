import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresRepository } from '../src/index.js';

const repository = new PostgresRepository();
const taskIds: string[] = [];
const destinationIds: string[] = [];

const taskInput = {
  name: 'PostgreSQL conformance fixture',
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
    delayMs: 0,
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
  datasetSettings: { mode: 'snapshot' as const, keyFields: ['id'], detectRemoved: true },
  retentionPolicy: { runDays: null, maxRuns: null, artifactDays: null, logDays: null },
  networkPolicy: { allowPrivateNetworks: false, allowedHosts: [], allowedCidrs: [] },
  outputBindings: [],
};

beforeAll(async () => repository.migrate());

afterAll(async () => {
  for (const taskId of taskIds) await repository.deleteTask(taskId);
  for (const destinationId of destinationIds)
    await repository.deleteOutputDestination(destinationId);
  await repository.close();
});

describe('PostgreSQL repository conformance', () => {
  it('matches trend binding and preference-signal semantics (conformance)', async () => {
    const task = await repository.createTask({ ...taskInput, name: 'Trend binding fixture' });
    taskIds.push(task.id);
    const sourceKey = `conformance.${crypto.randomUUID()}`;
    await repository.upsertTrendSourceBinding({
      key: sourceKey,
      platform: 'hongguo',
      taskId: task.id,
      enabled: true,
      autoRefresh: true,
    });
    expect(await repository.getTrendSourceBinding(sourceKey)).toMatchObject({
      taskId: task.id,
      enabled: true,
    });

    const externalId = crypto.randomUUID();
    const targetKey = `bilibili:video:${externalId}`;
    const content = {
      platform: 'bilibili' as const,
      contentType: 'video' as const,
      externalId,
      title: 'PostgreSQL fixture video',
      url: `https://www.bilibili.com/video/${externalId}`,
      coverUrl: null,
      author: null,
      summary: 'Persisted content snapshot',
      tags: ['测试'],
      metadata: {},
    };
    const liked = await repository.upsertPreferenceSignal({ kind: 'like', content, targetKey });
    const repeated = await repository.upsertPreferenceSignal({ kind: 'like', content, targetKey });
    expect(repeated.id).toBe(liked.id);
    const completed = await repository.upsertPreferenceSignal({
      kind: 'completed',
      content,
      targetKey,
    });
    const disliked = await repository.upsertPreferenceSignal({
      kind: 'dislike',
      content,
      targetKey,
    });
    const stored = (await repository.listPreferenceSignals(undefined, 500)).items.filter(
      (signal) => signal.targetKey === targetKey,
    );
    expect(stored.map((signal) => signal.kind).sort()).toEqual(['completed', 'dislike']);
    expect(await repository.deletePreferenceSignal(completed.id)).toBe(true);
    expect(await repository.deletePreferenceSignal(disliked.id)).toBe(true);

    await repository.deleteTask(task.id);
    taskIds.splice(taskIds.indexOf(task.id), 1);
    expect((await repository.getTrendSourceBinding(sourceKey))?.taskId).toBeNull();
  });

  it('matches task, lock, Dataset and output-binding semantics (conformance)', async () => {
    const destination = await repository.createOutputDestination({
      name: 'Conformance webhook',
      type: 'webhook',
      config: { url: 'https://example.com/hook' },
      credentialRef: null,
      enabled: true,
    });
    destinationIds.push(destination.id);
    const task = await repository.createTask({
      ...taskInput,
      outputBindings: [destination.id],
    });
    taskIds.push(task.id);
    expect(task.revision).toBe(1);
    expect((await repository.getTask(task.id))?.outputBindings).toEqual([destination.id]);
    await repository.setSchedulingPaused(false);
    expect(await repository.getSchedulingPaused()).toBe(false);
    await repository.setSchedulingPaused(true);
    expect(await repository.getSchedulingPaused()).toBe(true);
    await repository.setSchedulingPaused(false);

    const updated = await repository.updateTask(task.id, { name: 'Updated' }, task.revision);
    expect(updated?.revision).toBe(2);
    await expect(
      repository.updateTask(task.id, { name: 'Stale' }, task.revision),
    ).resolves.toBeNull();

    const run = await repository.createRun(task.id);
    await expect(repository.createRun(task.id)).rejects.toThrow();
    const stats = await repository.projectDataset(task.id, run.id, task.datasetSettings, [
      { sourceUrl: 'https://example.com/1', data: { id: 1, name: 'A' } },
      { sourceUrl: 'https://example.com/2', data: { id: 2, name: 'B' } },
    ]);
    expect(stats).toMatchObject({ added: 2, current: 2 });
    const page = await repository.listDatasetRecords(task.id, undefined, 1);
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
    await repository.completeRun(run.id, task.id, {
      requestCount: 1,
      recordCount: 2,
      browserUsed: false,
      aiUsed: false,
      metadata: {},
      records: [],
    });

    expect((await repository.listEvents(0, 100)).items.length).toBeGreaterThan(0);
    expect(await repository.deleteOutputDestination(destination.id)).toBe(true);
    destinationIds.splice(destinationIds.indexOf(destination.id), 1);
    expect((await repository.getTask(task.id))?.outputBindings).toEqual([]);
  });

  it('atomically commits or rolls back Run snapshots and Dataset changes (conformance)', async () => {
    const task = await repository.createTask(taskInput);
    taskIds.push(task.id);
    const canceled = await repository.createRun(task.id);
    await repository.startRun(canceled.id, task.id);
    await repository.cancelRun(canceled.id);

    await expect(
      repository.commitRunSuccess(
        canceled.id,
        task.id,
        task.datasetSettings,
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
    expect((await repository.getRun(canceled.id))?.status).toBe('canceled');
    expect((await repository.listRecords(canceled.id, undefined, 10)).items).toEqual([]);
    expect((await repository.listDatasetRecords(task.id, undefined, 10)).items).toEqual([]);
    const eventTypes = (await repository.listEvents(0, 1_000)).items
      .filter((event) => event.aggregateId === task.id)
      .map((event) => event.type);
    expect(eventTypes).not.toContain('dataset.projected');

    const run = await repository.createRun(task.id);
    await repository.startRun(run.id, task.id);
    const stats = await repository.commitRunSuccess(
      run.id,
      task.id,
      task.datasetSettings,
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
    expect(await repository.getRun(run.id)).toMatchObject({
      status: 'succeeded',
      datasetStats: stats,
    });
    expect((await repository.listRecords(run.id, undefined, 10)).items).toHaveLength(1);

    const latest = await repository.createRun(task.id);
    await repository.completeRun(latest.id, task.id, {
      requestCount: 0,
      recordCount: 0,
      browserUsed: false,
      aiUsed: false,
      metadata: {},
      records: [],
    });
    const retention = await repository.applyRetention(task.id, {
      runDays: null,
      maxRuns: 1,
      artifactDays: null,
      logDays: null,
    });
    expect(retention).toMatchObject({ deletedRuns: 2, retainedReferencedRuns: 0 });
    expect(await repository.getRun(run.id)).toBeNull();
    expect((await repository.listDatasetRecords(task.id, undefined, 10)).items).toMatchObject([
      { data: { id: 1, name: 'A' }, firstRunId: null, lastRunId: null },
    ]);
  });

  it('paginates an actual Run snapshot Diff by stable record key (conformance)', async () => {
    const task = await repository.createTask(taskInput);
    taskIds.push(task.id);
    const firstRecords = [
      { sourceUrl: 'https://example.com/1', data: { id: 1, name: 'A' } },
      { sourceUrl: 'https://example.com/2', data: { id: 2, name: 'B' } },
    ];
    const first = await repository.createRun(task.id);
    await repository.startRun(first.id, task.id);
    await repository.commitRunSuccess(first.id, task.id, task.datasetSettings, firstRecords, {
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
    const second = await repository.createRun(task.id);
    await repository.startRun(second.id, task.id);
    await repository.commitRunSuccess(second.id, task.id, task.datasetSettings, secondRecords, {
      requestCount: 2,
      recordCount: 2,
      browserUsed: false,
      aiUsed: false,
      metadata: {},
      records: secondRecords,
    });

    const firstPage = await repository.diffRunRecords(task.id, first.id, second.id, undefined, 2);
    expect(firstPage.stats).toEqual({ added: 1, updated: 1, removed: 1 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPage = await repository.diffRunRecords(
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
});
