import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformRepository } from '@zhiyun/platform-core';
import { normalizeCrawlPlan } from '@zhiyun/shared';
import { SqliteDatasetRepository, type DatasetRepository } from '@zhiyun/plugin-datasets';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { CollectionService } from '../src/application/index.js';
import type { CollectionRepository, CollectionTaskCreate } from '../src/contracts/index.js';
import { SqliteCollectionRepository } from '../src/persistence/sqlite/index.js';

interface Fixture {
  collection: CollectionRepository;
  datasets: DatasetRepository;
  platform: PlatformRepository;
  dispose(): Promise<void>;
}

const taskInput: CollectionTaskCreate = {
  name: 'Collection conformance fixture',
  startUrl: 'https://example.com/products',
  instruction: 'Collect products',
  schedule: { mode: 'manual', timezone: 'Asia/Shanghai', misfirePolicy: 'skip' },
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
  browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
  pagination: { type: 'none' },
  outputSettings: { persistRecords: true },
  credentialBindings: {},
  datasetSettings: { mode: 'snapshot', keyFields: ['id'], detectRemoved: true },
  retentionPolicy: { runDays: null, maxRuns: null, artifactDays: null, logDays: null },
  networkPolicy: { allowPrivateNetworks: false, allowedHosts: [], allowedCidrs: [] },
};

defineCollectionConformance('SQLite', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-collection-sqlite-'));
  const filePath = join(dataDirectory, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory,
    filePath,
    graphRevision: 'collection-test',
  });
  const datasets = new SqliteDatasetRepository(filePath);
  const collection = new SqliteCollectionRepository(filePath);
  await datasets.migrate();
  await collection.migrate();
  return {
    collection,
    datasets,
    platform,
    async dispose() {
      await collection.close();
      await datasets.close();
      await platform.close();
      await rm(dataDirectory, { recursive: true, force: true });
    },
  };
});

function defineCollectionConformance(name: string, create: () => Promise<Fixture>): void {
  describe(`${name} CollectionRepository conformance`, () => {
    let fixture: Fixture;

    beforeAll(async () => {
      fixture = await create();
    });

    afterAll(async () => {
      if (fixture) await fixture.dispose();
    });

    it('records its forward-only migration and owns Collection tables', async () => {
      expect(await fixture.platform.listMigrations()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: 'collection',
            migrationId: '001-initial',
            pluginVersion: '1.0.0',
          }),
        ]),
      );
    });

    it('versions tasks with optimistic concurrency and keyset pagination', async () => {
      const task = await fixture.collection.createTask(taskInput);
      expect(task).toMatchObject({ revision: 1, status: 'draft' });
      expect('outputBindings' in task).toBe(false);
      const updated = await fixture.collection.updateTask(
        task.id,
        { name: 'Updated collection task' },
        1,
      );
      expect(updated).toMatchObject({ name: 'Updated collection task', revision: 2 });
      await expect(
        fixture.collection.updateTask(task.id, { name: 'Stale update' }, 1),
      ).resolves.toBeNull();
      await fixture.collection.createTask({ ...taskInput, name: 'Pagination fixture' });
      const page = await fixture.collection.listTasks(undefined, 1);
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).toEqual(expect.any(String));
    });

    it('owns rules, versions, schedules and repair proposals', async () => {
      const task = await fixture.collection.createTask(taskInput);
      const scheduled = await fixture.collection.updateTask(
        task.id,
        {
          schedule: {
            mode: 'cron',
            cron: '*/15 * * * *',
            timezone: 'Asia/Shanghai',
            misfirePolicy: 'run-once',
          },
        },
        task.revision,
      );
      expect(scheduled?.revision).toBe(2);
      expect(await fixture.collection.listScheduledTasks()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: task.id,
            schedule: expect.objectContaining({ cron: '*/15 * * * *' }),
          }),
        ]),
      );

      const created = await fixture.collection.createRule(
        task.id,
        'Products',
        {
          type: 'json',
          container: '$.items',
          fields: { id: { path: '$.id', dataType: 'string' } },
        },
        'human',
      );
      expect(created.version).toMatchObject({ version: 1, generatedBy: 'human' });
      const second = await fixture.collection.createRuleVersion(
        task.id,
        created.rule.id,
        {
          type: 'json',
          container: '$.items',
          fields: {
            id: { path: '$.id', dataType: 'string' },
            title: { path: '$.title', dataType: 'string' },
          },
        },
        'ai',
      );
      expect(second?.version).toBe(2);
      expect((await fixture.collection.getActiveRule(task.id))?.version.id).toBe(second?.id);
      const stableVersionId = crypto.randomUUID();
      const third = await fixture.collection.createRuleVersion(
        task.id,
        created.rule.id,
        second!.definition,
        'ai',
        stableVersionId,
        second!.id,
      );
      expect(third?.id).toBe(stableVersionId);
      expect(
        await fixture.collection.createRuleVersion(
          task.id,
          created.rule.id,
          second!.definition,
          'ai',
          stableVersionId,
          second!.id,
        ),
      ).toEqual(third);
      expect(
        await fixture.collection.createRuleVersion(
          task.id,
          created.rule.id,
          second!.definition,
          'human',
          crypto.randomUUID(),
          second!.id,
        ),
      ).toBeNull();
      expect((await fixture.collection.getActiveRule(task.id))?.version.id).toBe(stableVersionId);
      const proposal = await fixture.collection.createRuleRepairProposal({
        taskId: task.id,
        ruleId: created.rule.id,
        runId: null,
        definition: second!.definition,
        explanation: 'Add the title field',
      });
      expect(await fixture.collection.markRuleRepairProposalTested(proposal.id)).toMatchObject({
        status: 'pending',
        testedAt: expect.any(String),
      });
    });

    it('atomically and idempotently creates an AI Task with its initial Rule', async () => {
      const taskId = randomUUID();
      const ruleId = randomUUID();
      const versionId = randomUUID();
      const input = {
        taskId,
        ruleId,
        versionId,
        task: { ...taskInput, outputBindings: [] },
        ruleName: 'AI initial rule',
        definition: normalizeCrawlPlan({
          type: 'json' as const,
          container: '$.items',
          fields: { id: { path: '$.id', dataType: 'string' as const } },
        }),
      };
      await expect(fixture.collection.createTaskWithInitialRule(input)).resolves.toEqual({
        taskId,
        ruleId,
        versionId,
      });
      await expect(fixture.collection.createTaskWithInitialRule(input)).resolves.toEqual({
        taskId,
        ruleId,
        versionId,
      });
      expect(await fixture.collection.getTask(taskId)).toMatchObject({
        id: taskId,
        status: 'ready',
        activeRule: {
          rule: { id: ruleId, activeVersionId: versionId },
          version: { id: versionId, generatedBy: 'ai', version: 1 },
        },
      });
      expect(await fixture.collection.listRules(taskId)).toHaveLength(1);
    });

    it('atomically persists an untested Task draft together with its first Rule', async () => {
      const taskId = randomUUID();
      const ruleId = randomUUID();
      const versionId = randomUUID();
      await fixture.collection.createTaskWithInitialRule({
        taskId,
        ruleId,
        versionId,
        task: { ...taskInput, outputBindings: [] },
        ruleName: 'Untested draft rule',
        definition: normalizeCrawlPlan({
          type: 'json' as const,
          container: '$.items',
          fields: { id: { path: '$.id', dataType: 'string' as const } },
        }),
        generatedBy: 'human',
        origin: { kind: 'manual' },
        status: 'draft',
      });
      expect(await fixture.collection.getTask(taskId)).toMatchObject({
        status: 'draft',
        origin: { kind: 'manual' },
        activeRule: {
          rule: { id: ruleId, activeVersionId: versionId },
          version: { generatedBy: 'human', version: 1 },
        },
      });
    });

    it('enforces one active Run and records progress diagnostics', async () => {
      const task = await fixture.collection.createTask(taskInput);
      const run = await fixture.collection.createRun(task.id, undefined, {
        expectedTaskRevision: task.revision,
      });
      expect((await fixture.collection.getRun(run.id))?.metadata).toEqual({
        expectedTaskRevision: task.revision,
      });
      await expect(fixture.collection.createRun(task.id)).rejects.toThrow();
      expect(await fixture.collection.startRun(run.id, task.id)).toBe(true);
      expect(await fixture.collection.startRun(run.id, task.id)).toBe(false);
      expect(await fixture.collection.startRun(run.id, task.id, true)).toBe(true);
      await fixture.collection.appendRunLog({
        runId: run.id,
        level: 'warn',
        phase: 'fetching',
        message: 'Slow response',
        url: 'https://example.com/products',
        errorCode: null,
        metadata: { progress: 0.5 },
      });
      await fixture.collection.appendRunRequest({
        runId: run.id,
        url: 'https://example.com/products',
        kind: 'list',
        status: 'succeeded',
        statusCode: 200,
        durationMs: 25,
        errorCode: null,
        error: null,
      });
      expect(await fixture.collection.listRunLogs(run.id)).toEqual([
        expect.objectContaining({ sequence: 1, phase: 'fetching' }),
      ]);
      expect((await fixture.collection.listRunRequests(run.id)).items).toHaveLength(1);
      expect(await fixture.collection.cancelRun(run.id)).toMatchObject({ status: 'canceled' });
    });

    it('persists a successful Run through the Dataset contract', async () => {
      const task = await fixture.collection.createTask(taskInput);
      const run = await fixture.collection.createRun(task.id, undefined, {
        scheduled: true,
        misfire: true,
        expectedTaskRevision: task.revision,
      });
      await fixture.collection.startRun(run.id, task.id);
      const service = new CollectionService(fixture.collection, fixture.datasets);
      const completed = await service.persistRun({
        runId: run.id,
        taskId: task.id,
        records: [{ sourceUrl: 'https://example.com/1', data: { id: 1, title: 'A' } }],
        requestCount: 1,
        browserUsed: false,
        aiUsed: false,
        metadata: { fixture: true },
      });
      expect(completed).toMatchObject({
        status: 'succeeded',
        datasetStats: { added: 1, current: 1 },
        metadata: {
          scheduled: true,
          misfire: true,
          expectedTaskRevision: task.revision,
          fixture: true,
          datasetProjectionReused: false,
          datasetId: expect.any(String),
          datasetSnapshotId: expect.any(String),
        },
      });
    });

    it('recovers idempotently after Dataset commit but before Run completion', async () => {
      const task = await fixture.collection.createTask(taskInput);
      const run = await fixture.collection.createRun(task.id);
      await fixture.collection.startRun(run.id, task.id);
      await fixture.collection.markRunPersisting(run.id, task.id);
      const records = [{ sourceUrl: 'https://example.com/2', data: { id: 2, title: 'B' } }];
      const committed = await fixture.datasets.commitRunRecords({
        sourceTaskId: task.id,
        sourceRunId: run.id,
        settings: task.datasetSettings,
        records,
      });
      expect(committed.reused).toBe(false);

      const service = new CollectionService(fixture.collection, fixture.datasets);
      const recovered = await service.persistRun({
        runId: run.id,
        taskId: task.id,
        records,
        requestCount: 1,
        browserUsed: false,
        aiUsed: false,
        metadata: { recovery: true },
      });
      expect(recovered).toMatchObject({
        status: 'succeeded',
        metadata: { recovery: true, datasetProjectionReused: true },
      });
      expect(
        (await fixture.datasets.listSnapshots(committed.dataset.id)).filter(
          (snapshot) => snapshot.sourceRunId === run.id,
        ),
      ).toHaveLength(1);
      const eventTypes = (await fixture.platform.listEvents(0, 10_000)).map(({ type }) => type);
      expect(eventTypes).toEqual(
        expect.arrayContaining(['dataset.projected', 'collection.run.succeeded']),
      );
    });
  });
}
