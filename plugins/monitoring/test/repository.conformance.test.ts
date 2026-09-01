import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformRepository } from '@zhiyun/platform-core';
import { openPostgresPlatformRepository } from '@zhiyun/storage-postgres-v1';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import type { MonitoringRepository } from '../src/contracts/index.js';
import { MonitoringService } from '../src/application/index.js';
import { defaultQualityPolicy } from '../src/domain/index.js';
import { monitoringPostgresMigration001 } from '../src/migrations/postgres/index.js';
import { monitoringSqliteMigration001 } from '../src/migrations/sqlite/index.js';
import { PostgresMonitoringRepository } from '../src/persistence/postgres/index.js';
import { SqliteMonitoringRepository } from '../src/persistence/sqlite/index.js';

interface Fixture {
  repository: MonitoringRepository;
  platform: PlatformRepository;
  dispose(): Promise<void>;
}

defineMonitoringConformance('SQLite', async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-monitoring-sqlite-'));
  const filePath = join(dataDirectory, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory,
    filePath,
    graphRevision: 'monitoring-test',
  });
  const repository = new SqliteMonitoringRepository(filePath);
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

defineMonitoringConformance('PostgreSQL', async () => {
  const database = await createTemporaryDatabase();
  const platform = await openPostgresPlatformRepository({
    connectionString: database.connectionString,
    graphRevision: 'monitoring-test',
  });
  const repository = new PostgresMonitoringRepository(database.connectionString);
  await repository.migrate();
  return {
    repository,
    platform,
    async dispose() {
      await repository.close();
      await platform.close();
      await database.drop();
    },
  };
});

describe('Monitoring forward migration lifecycle backfill', () => {
  it('backfills SQLite ever-nonempty and preserves an issue across unknown evaluations', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'zhiyun-monitoring-sqlite-upgrade-'));
    const filePath = join(dataDirectory, 'zhiyun.sqlite3');
    const platform = await openSqlitePlatformRepository({
      dataDirectory,
      filePath,
      graphRevision: 'monitoring-upgrade-test',
    });
    const sqlite = new Database(filePath);
    const openTaskId = randomUUID();
    const recoveredTaskId = randomUUID();
    try {
      sqlite.exec(monitoringSqliteMigration001);
      sqlite
        .prepare(
          `INSERT INTO plugin_migrations(
             plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
           ) VALUES ('monitoring','001-initial','1.0.0',?,?,0,'succeeded')`,
        )
        .run(sha256(monitoringSqliteMigration001), new Date().toISOString());
      insertLegacySqliteEvaluations(sqlite, openTaskId, recoveredTaskId);
      sqlite.close();
      const repository = new SqliteMonitoringRepository(filePath);
      try {
        await repository.migrate();
        expect(await repository.hasEverNonEmpty(openTaskId)).toBe(true);
        expect(await repository.hasOpenIssue(openTaskId)).toBe(true);
        expect(await repository.hasOpenIssue(recoveredTaskId)).toBe(false);
      } finally {
        await repository.close();
      }
    } finally {
      if (sqlite.open) sqlite.close();
      await platform.close();
      await rm(dataDirectory, { recursive: true, force: true });
    }
  });

  it('backfills PostgreSQL ever-nonempty and preserves an issue across unknown evaluations', async () => {
    const database = await createTemporaryDatabase();
    const platform = await openPostgresPlatformRepository({
      connectionString: database.connectionString,
      graphRevision: 'monitoring-upgrade-test',
    });
    const sql = postgres(database.connectionString, { max: 1 });
    const openTaskId = randomUUID();
    const recoveredTaskId = randomUUID();
    try {
      await sql.unsafe(monitoringPostgresMigration001);
      await sql`
        INSERT INTO plugin_migrations(
          plugin_id,migration_id,plugin_version,checksum,executed_at,duration_ms,result
        ) VALUES (
          'monitoring','001-initial','1.0.0',${sha256(monitoringPostgresMigration001)},
          ${new Date()},0,'succeeded'
        )
      `;
      await insertLegacyPostgresEvaluations(sql, openTaskId, recoveredTaskId);
      await sql.end();
      const repository = new PostgresMonitoringRepository(database.connectionString);
      try {
        await repository.migrate();
        expect(await repository.hasEverNonEmpty(openTaskId)).toBe(true);
        expect(await repository.hasOpenIssue(openTaskId)).toBe(true);
        expect(await repository.hasOpenIssue(recoveredTaskId)).toBe(false);
      } finally {
        await repository.close();
      }
    } finally {
      await sql.end().catch(() => undefined);
      await platform.close();
      await database.drop();
    }
  });
});

function defineMonitoringConformance(name: string, create: () => Promise<Fixture>): void {
  describe(`${name} MonitoringRepository conformance`, () => {
    let fixture: Fixture;

    beforeAll(async () => {
      fixture = await create();
    });

    afterAll(async () => {
      if (fixture) await fixture.dispose();
    });

    it('records its forward-only migration and returns intelligent defaults', async () => {
      expect(await fixture.platform.listMigrations()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pluginId: 'monitoring',
            migrationId: '001-initial',
            pluginVersion: '1.0.0',
          }),
          expect.objectContaining({
            pluginId: 'monitoring',
            migrationId: '002-durable-notifications',
            pluginVersion: '1.1.0',
          }),
        ]),
      );
      expect(await fixture.repository.getPolicy(randomUUID())).toEqual(defaultQualityPolicy);
    });

    it('persists policies, profiles, issues and idempotent run evaluations', async () => {
      const taskId = randomUUID();
      const runId = randomUUID();
      const policy = await fixture.repository.upsertPolicy(taskId, {
        ...defaultQualityPolicy,
        minimumBaselineRuns: 1,
      });
      expect(await fixture.repository.getPolicy(taskId)).toEqual(policy);

      const input = {
        taskId,
        runId,
        status: 'warning' as const,
        profile: {
          recordCount: 20,
          fields: { title: { present: 20, nulls: 12, types: { string: 20 } } },
        },
        issues: [
          {
            kind: 'null-rate-spike' as const,
            severity: 'warning' as const,
            message: 'title null rate changed',
            field: 'title',
            actual: 0.6,
            expected: 0,
            metadata: {},
          },
        ],
      };
      const created = await fixture.repository.createEvaluation(input);
      expect(await fixture.repository.createEvaluation(input)).toEqual(created);
      expect(await fixture.repository.getEvaluationByRun(runId)).toEqual(created);
      expect(await fixture.repository.getEvaluationByRun(randomUUID())).toBeNull();
      expect(await fixture.repository.listEvaluations(taskId)).toEqual([created]);
      expect(await fixture.repository.listBaselineProfiles(taskId, 5)).toEqual([input.profile]);
      expect(await fixture.repository.getHealth(taskId)).toMatchObject({
        status: 'warning',
        latestRunId: runId,
        baselineReady: true,
      });
      expect(await fixture.repository.getHealthMany([taskId, taskId])).toHaveLength(1);
    });

    it('removes all task-owned monitoring state during task cleanup', async () => {
      const taskId = randomUUID();
      await fixture.repository.upsertPolicy(taskId, defaultQualityPolicy);
      await fixture.repository.createEvaluation({
        taskId,
        runId: randomUUID(),
        status: 'healthy',
        profile: { recordCount: 1, fields: {} },
        issues: [],
      });
      await fixture.repository.deleteTask(taskId);
      expect(await fixture.repository.listEvaluations(taskId)).toEqual([]);
      expect(await fixture.repository.getHealth(taskId)).toMatchObject({ status: 'unknown' });
    });

    it('reports successful runs as unknown until enough baseline runs exist', async () => {
      const taskId = randomUUID();
      await fixture.repository.createEvaluation({
        taskId,
        runId: randomUUID(),
        status: 'healthy',
        profile: { recordCount: 1, fields: {} },
        issues: [],
      });
      expect(await fixture.repository.getHealth(taskId)).toMatchObject({
        status: 'unknown',
        baselineReady: false,
      });
    });

    it('promotes unknown successful profiles into the baseline and enables statistics', async () => {
      const taskId = randomUUID();
      const service = new MonitoringService(fixture.repository);
      const evaluate = (count: number) =>
        service.evaluateSucceeded({
          taskId,
          runId: randomUUID(),
          datasetStats: { added: count, updated: 0, removed: 0, unchanged: 0, current: count },
          records: Array.from({ length: count }, () => ({ data: { title: 'value' } })),
        });
      expect((await evaluate(10)).status).toBe('unknown');
      expect((await evaluate(10)).status).toBe('unknown');
      expect((await evaluate(10)).status).toBe('healthy');
      expect(await fixture.repository.listBaselineProfiles(taskId, 5)).toHaveLength(3);
      expect(await fixture.repository.getHealth(taskId)).toMatchObject({
        status: 'healthy',
        baselineReady: true,
      });
      expect(await evaluate(4)).toMatchObject({
        status: 'warning',
        issues: [expect.objectContaining({ kind: 'record-count-drop' })],
      });
    });

    it('keeps failed health failing when quality issues are disabled', async () => {
      const taskId = randomUUID();
      await fixture.repository.upsertPolicy(taskId, {
        ...defaultQualityPolicy,
        enabled: false,
      });
      await fixture.repository.createEvaluation({
        taskId,
        runId: randomUUID(),
        status: 'failing',
        profile: { recordCount: 0, fields: {} },
        issues: [],
      });
      expect(await fixture.repository.getHealth(taskId)).toMatchObject({
        status: 'failing',
        issues: [],
      });
      expect(await fixture.repository.listBaselineProfiles(taskId, 5)).toEqual([]);
    });

    it('retries a notifier failure from the persisted evaluation with one stable event ID', async () => {
      const taskId = randomUUID();
      const runId = randomUUID();
      const observedEventIds: string[] = [];
      let failuresRemaining = 1;
      const service = new MonitoringService(fixture.repository, {
        async issue(_evaluation, notification) {
          observedEventIds.push(notification.eventId);
          if (failuresRemaining > 0) {
            failuresRemaining -= 1;
            throw new Error('injected notifier failure');
          }
        },
        recovered: async () => undefined,
      });

      await expect(service.recordFailed({ taskId, runId, error: 'failed' })).rejects.toThrow(
        'injected notifier failure',
      );
      const evaluation = await fixture.repository.getEvaluationByRun(runId);
      const pending = await fixture.repository.getPendingNotificationByRun(runId);
      const qualityEvents = (await fixture.platform.listEvents(0, 10_000)).filter(
        (event) => event.type === 'quality.issue.detected' && event.payload.runId === runId,
      );
      expect(evaluation).toMatchObject({ status: 'failing' });
      expect(pending).toMatchObject({
        eventId: qualityEvents[0]?.id,
        evaluationId: evaluation?.id,
        taskId,
        runId,
      });
      expect(qualityEvents).toHaveLength(1);

      await expect(service.recordFailed({ taskId, runId, error: 'failed' })).resolves.toEqual(
        evaluation,
      );
      expect(observedEventIds).toEqual([qualityEvents[0]?.id, qualityEvents[0]?.id]);
      expect(await fixture.repository.getPendingNotificationByRun(runId)).toBeNull();
      expect(
        (await fixture.platform.listEvents(0, 10_000)).filter(
          (event) => event.type === 'quality.issue.detected' && event.payload.runId === runId,
        ),
      ).toHaveLength(1);
    });

    it('retains the ever-nonempty lifecycle beyond the rolling baseline window', async () => {
      const taskId = randomUUID();
      const service = new MonitoringService(fixture.repository);
      const evaluate = (count: number) =>
        service.evaluateSucceeded({
          taskId,
          runId: randomUUID(),
          datasetStats: { added: count, updated: 0, removed: 0, unchanged: 0, current: count },
          records: Array.from({ length: count }, () => ({ data: { title: 'value' } })),
        });

      await evaluate(1);
      for (let index = 0; index < 6; index += 1) {
        await expect(evaluate(0)).resolves.toMatchObject({
          status: 'warning',
          issues: expect.arrayContaining([expect.objectContaining({ kind: 'empty-result' })]),
        });
      }
      expect(await fixture.repository.hasEverNonEmpty(taskId)).toBe(true);
    });

    it('keeps an issue open through unknown runs and recovers only when health is healthy', async () => {
      const taskId = randomUUID();
      const service = new MonitoringService(fixture.repository);
      await service.recordFailed({ taskId, runId: randomUUID(), error: 'failed' });
      expect(await fixture.repository.hasOpenIssue(taskId)).toBe(true);
      const evaluate = (runId: string) =>
        service.evaluateSucceeded({
          taskId,
          runId,
          datasetStats: { added: 0, updated: 0, removed: 0, unchanged: 1, current: 1 },
          records: [{ data: { title: 'value' } }],
        });

      await expect(evaluate(randomUUID())).resolves.toMatchObject({ status: 'unknown' });
      await expect(evaluate(randomUUID())).resolves.toMatchObject({ status: 'unknown' });
      expect(await fixture.repository.hasOpenIssue(taskId)).toBe(true);
      const healthyRunId = randomUUID();
      await expect(evaluate(healthyRunId)).resolves.toMatchObject({ status: 'healthy' });
      expect(await fixture.repository.hasOpenIssue(taskId)).toBe(false);
      expect(
        (await fixture.platform.listEvents(0, 10_000)).filter(
          (event) => event.type === 'quality.recovered' && event.payload.taskId === taskId,
        ),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ runId: healthyRunId, status: 'healthy' }),
        }),
      ]);
    });

    it('serializes concurrent evaluations so an open issue recovers exactly once', async () => {
      const taskId = randomUUID();
      await fixture.repository.upsertPolicy(taskId, {
        ...defaultQualityPolicy,
        minimumBaselineRuns: 1,
      });
      const service = new MonitoringService(fixture.repository);
      await service.recordFailed({ taskId, runId: randomUUID(), error: 'failed' });
      const evaluate = (runId: string) =>
        service.evaluateSucceeded({
          taskId,
          runId,
          datasetStats: { added: 0, updated: 0, removed: 0, unchanged: 1, current: 1 },
          records: [{ data: { title: 'value' } }],
        });
      const runIds = [randomUUID(), randomUUID()];

      await expect(Promise.all(runIds.map(evaluate))).resolves.toEqual([
        expect.objectContaining({ status: 'healthy' }),
        expect.objectContaining({ status: 'healthy' }),
      ]);
      expect(
        (await fixture.platform.listEvents(0, 10_000)).filter(
          (event) => event.type === 'quality.recovered' && event.payload.taskId === taskId,
        ),
      ).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ runId: runIds[0] }) }),
      ]);
    });

    it('retries a persisted recovery event even after a newer run becomes warning', async () => {
      const taskId = randomUUID();
      await fixture.repository.upsertPolicy(taskId, {
        ...defaultQualityPolicy,
        minimumBaselineRuns: 1,
      });
      let recoveryFailuresRemaining = 1;
      const recoveryEventIds: string[] = [];
      const service = new MonitoringService(fixture.repository, {
        issue: async () => undefined,
        async recovered(_evaluation, notification) {
          recoveryEventIds.push(notification.eventId);
          if (recoveryFailuresRemaining > 0) {
            recoveryFailuresRemaining -= 1;
            throw new Error('injected recovery notifier failure');
          }
        },
      });
      await service.recordFailed({ taskId, runId: randomUUID(), error: 'failed' });
      const recoveryRunId = randomUUID();
      const recoveryInput = {
        taskId,
        runId: recoveryRunId,
        datasetStats: { added: 1, updated: 0, removed: 0, unchanged: 0, current: 1 },
        records: [{ data: { title: 'value' } }],
      };
      await expect(service.evaluateSucceeded(recoveryInput)).rejects.toThrow(
        'injected recovery notifier failure',
      );
      const pending = await fixture.repository.getPendingNotificationByRun(recoveryRunId);

      await expect(
        service.evaluateSucceeded({
          taskId,
          runId: randomUUID(),
          datasetStats: { added: 0, updated: 0, removed: 1, unchanged: 0, current: 0 },
          records: [],
        }),
      ).resolves.toMatchObject({ status: 'warning' });
      expect(await fixture.repository.getHealth(taskId)).toMatchObject({ status: 'warning' });

      await expect(service.evaluateSucceeded(recoveryInput)).resolves.toMatchObject({
        status: 'healthy',
      });
      expect(recoveryEventIds).toEqual([pending?.eventId, pending?.eventId]);
      expect(await fixture.repository.getPendingNotificationByRun(recoveryRunId)).toBeNull();
      expect(await fixture.repository.getHealth(taskId)).toMatchObject({ status: 'warning' });
    });
  });
}

function insertLegacySqliteEvaluations(
  sqlite: Database.Database,
  openTaskId: string,
  recoveredTaskId: string,
): void {
  const insert = sqlite.prepare(
    `INSERT INTO quality_evaluations(id,task_id,run_id,status,profile,issues,created_at)
     VALUES (?,?,?,?,?,?,?)`,
  );
  const profile = JSON.stringify({ recordCount: 1, fields: {} });
  const emptyProfile = JSON.stringify({ recordCount: 0, fields: {} });
  const issues = JSON.stringify([legacyIssue()]);
  const first = '2026-01-01T00:00:00.000Z';
  const second = '2026-01-01T00:01:00.000Z';
  const third = '2026-01-01T00:02:00.000Z';
  insert.run(randomUUID(), openTaskId, randomUUID(), 'warning', profile, issues, first);
  insert.run(randomUUID(), openTaskId, randomUUID(), 'unknown', emptyProfile, '[]', second);
  insert.run(randomUUID(), recoveredTaskId, randomUUID(), 'warning', profile, issues, first);
  insert.run(randomUUID(), recoveredTaskId, randomUUID(), 'healthy', profile, '[]', second);
  insert.run(randomUUID(), recoveredTaskId, randomUUID(), 'unknown', emptyProfile, '[]', third);
}

async function insertLegacyPostgresEvaluations(
  sql: ReturnType<typeof postgres>,
  openTaskId: string,
  recoveredTaskId: string,
): Promise<void> {
  const profile = { recordCount: 1, fields: {} };
  const emptyProfile = { recordCount: 0, fields: {} };
  const issues = [legacyIssue()];
  const insert = async (
    taskId: string,
    status: 'unknown' | 'healthy' | 'warning',
    selectedProfile: typeof profile,
    selectedIssues: typeof issues | [],
    createdAt: Date,
  ) => {
    await sql`
      INSERT INTO quality_evaluations(id,task_id,run_id,status,profile,issues,created_at)
      VALUES (
        ${randomUUID()},${taskId},${randomUUID()},${status},${sql.json(selectedProfile)},
        ${sql.json(selectedIssues)},${createdAt}
      )
    `;
  };
  const first = new Date('2026-01-01T00:00:00.000Z');
  const second = new Date('2026-01-01T00:01:00.000Z');
  const third = new Date('2026-01-01T00:02:00.000Z');
  await insert(openTaskId, 'warning', profile, issues, first);
  await insert(openTaskId, 'unknown', emptyProfile, [], second);
  await insert(recoveredTaskId, 'warning', profile, issues, first);
  await insert(recoveredTaskId, 'healthy', profile, [], second);
  await insert(recoveredTaskId, 'unknown', emptyProfile, [], third);
}

function legacyIssue() {
  return {
    kind: 'empty-result',
    severity: 'warning',
    message: 'empty',
    field: null,
    actual: 0,
    expected: 1,
    metadata: {},
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function createTemporaryDatabase(): Promise<{
  connectionString: string;
  drop(): Promise<void>;
}> {
  const baseConnectionString =
    process.env.DATABASE_URL ?? 'postgresql://zhiyun:zhiyun@localhost:45432/zhiyun';
  const databaseName = `zhiyun_monitoring_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(baseConnectionString);
  adminUrl.pathname = '/postgres';
  const admin = postgres(adminUrl.toString(), { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  await admin.end();
  const databaseUrl = new URL(baseConnectionString);
  databaseUrl.pathname = `/${databaseName}`;
  return {
    connectionString: databaseUrl.toString(),
    async drop() {
      const cleanup = postgres(adminUrl.toString(), { max: 1 });
      await cleanup`
        SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname=${databaseName} AND pid<>pg_backend_pid()
      `;
      await cleanup.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await cleanup.end();
    },
  };
}
