import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { qualityPolicySchema, qualityRuleSchema, type QualityIssue } from '@zhiyun/shared';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { SqliteDatasetRepository } from '@zhiyun/plugin-datasets';
import {
  MonitoringService,
  SqliteMonitoringRepository,
  evaluateProfile,
  profileRecords,
  profileFieldChanges,
} from '../src/index.js';

type Kind = 'field-value-change' | 'record-count-drop' | 'null-rate-spike';
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-monitoring-rules-'));
  const path = join(directory, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory: directory,
    filePath: path,
    graphRevision: 'monitoring-rules-test',
  });
  const datasets = new SqliteDatasetRepository(path);
  const repository = new SqliteMonitoringRepository(path);
  await datasets.migrate();
  await repository.migrate();
  return {
    directory,
    path,
    platform,
    datasets,
    repository,
    async close() {
      await this.repository.close();
      await datasets.close();
      await platform.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

afterEach(() => vi.useRealTimers());
describe('conditional monitoring on committed local changes and SQLite state', () => {
  it.each<Kind>(['field-value-change', 'record-count-drop', 'null-rate-spike'])(
    '%s preserves consecutive counts, cooldown, aggregation and run trace across a reopen',
    async (kind) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const f = await fixture();
      const taskId = crypto.randomUUID();
      const notifications: string[] = [];
      let recovering = 0;
      let generation = 0;
      const policy = qualityPolicySchema.parse({
        baselineRuns: 1,
        minimumBaselineRuns: 1,
        rules: [
          {
            kind,
            fields: kind === 'record-count-drop' ? [] : ['price', 'secret'],
            excludeFields: ['secret'],
            threshold: kind === 'record-count-drop' ? 4 : kind === 'field-value-change' ? 0.5 : 0.1,
            thresholdMode: kind === 'record-count-drop' ? 'absolute' : 'percentage',
            consecutiveRuns: 2,
            cooldownSeconds: 60,
            aggregationSeconds: 3600,
          },
        ],
      });
      try {
        await f.repository.upsertPolicy(taskId, policy);
        const rows = (level: number) =>
          Array.from({ length: kind === 'record-count-drop' ? 20 - level : 20 }, (_, index) => ({
            id: index,
            price:
              kind === 'null-rate-spike' && index < level
                ? null
                : kind === 'field-value-change'
                  ? index + level
                  : index,
            secret: `SENSITIVE-VALUE-${generation}-${index}`,
          }));
        const evaluate = async (level: number) => {
          generation += 1;
          vi.setSystemTime(Date.now() + 1000);
          const runId = crypto.randomUUID();
          const committed = await f.datasets.commitRunRecords({
            sourceTaskId: taskId,
            sourceRunId: runId,
            settings: { mode: 'snapshot', keyFields: ['id'], detectRemoved: true },
            records: rows(level).map((data) => ({ sourceUrl: 'http://127.0.0.1/fixture', data })),
          });
          async function* changes() {
            let cursor: string | undefined;
            do {
              const page = await f.datasets.listChanges(committed.dataset.id, cursor, 7, runId);
              yield* page.items;
              cursor = page.nextCursor ?? undefined;
            } while (cursor);
          }
          async function* records() {
            let cursor: string | undefined;
            do {
              const page = await f.datasets.listRunRecords(runId, cursor, 7);
              yield* page.items;
              cursor = page.nextCursor ?? undefined;
            } while (cursor);
          }
          const service = new MonitoringService(f.repository, {
            issue: async (_evaluation, notification) => {
              notifications.push(notification.eventId);
            },
            recovered: async () => {
              recovering += 1;
            },
          });
          const evaluation = await service.evaluateSucceeded({
            taskId,
            runId,
            datasetStats: committed.stats,
            records: records(),
            changes: changes(),
          });
          return { evaluation, service, runId };
        };
        await evaluate(0);
        const levels =
          kind === 'record-count-drop'
            ? [1, 5, 10, 15, 20]
            : kind === 'null-rate-spike'
              ? [1, 4, 7, 10, 13]
              : [0, 1, 2, 3, 4];
        expect((await evaluate(levels[0]!)).evaluation.issues).toEqual([]);
        const first = await evaluate(levels[1]!);
        expect(first.evaluation.issues.map((issue) => issue.kind)).toEqual([kind]);
        expect(notifications).toHaveLength(0);
        await f.repository.close();
        f.repository = new SqliteMonitoringRepository(f.path);
        await f.repository.migrate();
        const second = await evaluate(levels[2]!);
        expect(second.evaluation.issues).toHaveLength(1);
        expect(notifications).toHaveLength(1);
        await expect(
          second.service.evaluateSucceeded({
            taskId,
            runId: second.runId,
            datasetStats: { added: 0, updated: 0, removed: 0, unchanged: 0, current: 0 },
            records: [],
          }),
        ).resolves.toEqual(second.evaluation);
        expect(notifications).toHaveLength(1);
        await evaluate(levels[3]!);
        expect(notifications).toHaveLength(1);
        let alerts = await f.repository.listAlerts(taskId);
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({
          occurrenceCount: 3,
          notificationCount: 1,
          suppressedCount: 2,
          status: 'open',
        });
        expect(alerts[0]!.runs.map((run) => run.reason)).toEqual([
          'cooldown',
          'ready',
          'consecutive',
        ]);
        vi.setSystemTime(Date.now() + 61_000);
        const fourth = await evaluate(levels[4]!);
        expect(notifications).toHaveLength(2);
        alerts = await f.repository.listAlerts(taskId);
        expect(alerts[0]).toMatchObject({
          occurrenceCount: 4,
          notificationCount: 2,
          lastRunId: fourth.runId,
        });
        expect(new Set(alerts[0]!.runs.map((run) => run.runId)).size).toBe(4);
        const events = await f.platform.listEvents(0, 1000);
        expect(events.map((event) => event.type)).toContain('quality.issue.detected');
        const quality = events.filter((event) => event.type === 'quality.issue.detected');
        expect(quality).toHaveLength(2);
        expect(JSON.stringify(quality)).not.toContain('SENSITIVE-VALUE');
        expect(JSON.stringify(quality)).not.toContain('price');
        expect(events.filter((event) => event.type === 'monitoring.alert.created')).toHaveLength(1);
        expect(events.filter((event) => event.type === 'monitoring.alert.updated')).toHaveLength(3);
        if (kind === 'field-value-change')
          expect(alerts[0]!.latestIssue.metadata).toMatchObject({
            updated: 20,
            total: 20,
            added: 0,
            removed: 0,
          });
        await evaluate(kind === 'field-value-change' ? levels[4]! : 0);
        expect(recovering).toBe(1);
        expect((await f.repository.listAlerts(taskId))[0]!.status).toBe('resolved');
        expect(await f.repository.dismissAlert(crypto.randomUUID(), alerts[0]!.id)).toBeNull();
        await f.repository.dismissAlert(taskId, alerts[0]!.id);
        await f.repository.dismissAlert(taskId, alerts[0]!.id);
        const deleted = (await f.platform.listEvents(0, 1000)).filter(
          (event) => event.type === 'monitoring.alert.deleted',
        );
        expect(deleted).toEqual([
          expect.objectContaining({
            payload: expect.objectContaining({ runId: fourth.runId, alertId: alerts[0]!.id }),
          }),
        ]);
        expect((await f.repository.listAlerts(taskId))[0]!.runs).toHaveLength(4);
        await f.repository.deleteTask(taskId);
        expect(await f.repository.listAlerts(taskId)).toEqual([]);
      } finally {
        await f.close();
      }
    },
  );

  it('filters added, updated and removed values without retaining values and handles literal prototype names', async () => {
    const changes = await profileFieldChanges([
      {
        type: 'added',
        before: null,
        after: JSON.parse('{"__proto__":"SENSITIVE","value":1,"noise":1}') as Record<
          string,
          unknown
        >,
      },
      {
        type: 'updated',
        before: { value: { a: 1, b: 2 }, noise: 1 },
        after: { value: { b: 2, a: 1 }, noise: 2 },
      },
      { type: 'updated', before: { value: null }, after: {} },
      { type: 'removed', before: { value: 3 }, after: null },
    ]);
    expect(changes.value).toEqual({ added: 1, updated: 1, removed: 1, total: 3 });
    expect(Object.hasOwn(changes, '__proto__')).toBe(true);
    expect(JSON.stringify(changes)).not.toContain('SENSITIVE');
    const profile = await profileRecords([
      { data: JSON.parse('{"__proto__":"x","constructor":1}') as Record<string, unknown> },
    ]);
    expect(profile.fields.constructor).toMatchObject({ present: 1 });
    expect(Object.hasOwn(profile.fields, '__proto__')).toBe(true);
    const policy = qualityPolicySchema.parse({
      baselineRuns: 1,
      minimumBaselineRuns: 1,
      rules: [
        {
          kind: 'field-value-change',
          fields: ['value', 'noise'],
          excludeFields: ['noise'],
          thresholdMode: 'absolute',
          threshold: 3,
        },
      ],
    });
    expect(
      evaluateProfile({
        profile: { recordCount: 4, fields: {} },
        baselines: [{ recordCount: 4, fields: {} }],
        policy,
        fieldChanges: changes,
      }),
    ).toEqual([
      expect.objectContaining({
        kind: 'field-value-change',
        field: 'value',
        metadata: expect.objectContaining({ added: 1, updated: 1, removed: 1 }),
      }),
    ]);
  });

  it('validates threshold units and accounts for missing fields as nulls in explicit conditional rules', () => {
    for (const invalid of [
      { kind: 'record-count-drop', threshold: 2 },
      { kind: 'record-count-drop', threshold: 1.5, thresholdMode: 'absolute' },
      { kind: 'run-failed', thresholdMode: 'absolute' },
      { kind: 'field-value-change', fields: ['x', 'x'] },
      { kind: 'null-rate-spike', consecutiveRuns: 0 },
      { kind: 'field-value-change', cooldownSeconds: 604801 },
    ])
      expect(qualityRuleSchema.safeParse(invalid).success).toBe(false);
    expect(
      qualityPolicySchema.safeParse({
        rules: [{ kind: 'record-count-drop' }, { kind: 'record-count-drop' }],
      }).success,
    ).toBe(false);
    const policy = qualityPolicySchema.parse({
      baselineRuns: 1,
      minimumBaselineRuns: 1,
      rules: [
        { kind: 'null-rate-spike', fields: ['price'], thresholdMode: 'absolute', threshold: 40 },
      ],
    });
    const common = {
      baselines: [
        { recordCount: 100, fields: { price: { present: 100, nulls: 0, types: { number: 100 } } } },
      ],
      policy,
    };
    expect(
      evaluateProfile({
        ...common,
        profile: {
          recordCount: 100,
          fields: { price: { present: 77, nulls: 20, types: { number: 57, null: 20 } } },
        },
      }),
    ).toEqual([expect.objectContaining({ kind: 'null-rate-spike', actual: 0.43 })]);
    expect(
      evaluateProfile({
        ...common,
        profile: {
          recordCount: 100,
          fields: { price: { present: 80, nulls: 19, types: { number: 61, null: 19 } } },
        },
      }),
    ).toEqual([]);
  });

  it('includes exact percentage and absolute boundaries while rejecting smaller changes and zero changes', () => {
    const profile = (nulls: number, count = 20) => ({
      recordCount: count,
      fields: { price: { present: count, nulls, types: { number: count - nulls, null: nulls } } },
    });
    const policy = (
      kind: Kind,
      threshold: number,
      mode: 'percentage' | 'absolute' = 'percentage',
    ) =>
      qualityPolicySchema.parse({
        baselineRuns: 1,
        minimumBaselineRuns: 1,
        rules: [{ kind, fields: ['price'], threshold, thresholdMode: mode }],
      });
    for (const mode of ['percentage', 'absolute'] as const) {
      const configured = policy('null-rate-spike', mode === 'percentage' ? 0.1 : 2, mode);
      expect(
        evaluateProfile({ profile: profile(3), baselines: [profile(1)], policy: configured }),
      ).toHaveLength(1);
      expect(
        evaluateProfile({ profile: profile(2), baselines: [profile(1)], policy: configured }),
      ).toEqual([]);
      expect(
        evaluateProfile({
          profile: profile(1),
          baselines: [profile(1)],
          policy: policy('null-rate-spike', 0, mode),
        }),
      ).toEqual([]);
    }
    const drop = policy('record-count-drop', 0.1);
    expect(
      evaluateProfile({ profile: profile(0, 18), baselines: [profile(0)], policy: drop }),
    ).toHaveLength(1);
    expect(
      evaluateProfile({ profile: profile(0, 19), baselines: [profile(0)], policy: drop }),
    ).toEqual([]);
    expect(
      evaluateProfile({
        profile: profile(0),
        baselines: [profile(0)],
        policy: policy('record-count-drop', 0),
      }),
    ).toEqual([]);
    expect(
      evaluateProfile({
        profile: profile(0, 16),
        baselines: [profile(0, 100), profile(0), profile(0)],
        policy: policy('record-count-drop', 4, 'absolute'),
      }),
    ).toEqual([expect.objectContaining({ actual: 16, expected: 20 })]);
    for (const total of [0, 1, 2])
      expect(
        evaluateProfile({
          profile: profile(0),
          baselines: [profile(0)],
          policy: policy('field-value-change', 0.1),
          fieldChanges: { price: { added: 0, updated: total, removed: 0, total } },
        }),
      ).toHaveLength(total === 2 ? 1 : 0);
    expect(
      evaluateProfile({
        profile: profile(3),
        baselines: [profile(1)],
        policy: policy('null-rate-spike', 0.1000000001),
      }),
    ).toEqual([]);
  });

  it('resolves recovered fields independently, resets interrupted streaks and preserves cooldown when aggregation expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const f = await fixture();
    const taskId = crypto.randomUUID();
    const policy = qualityPolicySchema.parse({
      baselineRuns: 1,
      minimumBaselineRuns: 1,
      rules: [
        {
          kind: 'null-rate-spike',
          fields: ['a', 'b'],
          thresholdMode: 'absolute',
          threshold: 1,
          consecutiveRuns: 2,
          cooldownSeconds: 60,
          aggregationSeconds: 10,
        },
      ],
    });
    const evaluate = async (fields: string[], elapsed = 1000) => {
      vi.setSystemTime(Date.now() + elapsed);
      const issues: QualityIssue[] = fields.map((field) => ({
        kind: 'null-rate-spike',
        field,
        severity: 'warning',
        message: 'Null condition',
        actual: 0.5,
        expected: 0,
        metadata: {},
      }));
      const runId = crypto.randomUUID();
      await f.repository.createEvaluation(
        {
          taskId,
          runId,
          status: fields.length ? 'warning' : 'healthy',
          profile: { recordCount: 2, fields: {} },
          issues,
        },
        fields.length
          ? {
              type: 'quality.issue.detected',
              severity: 'warning',
              payload: { taskId, runId, issues },
            }
          : undefined,
      );
      return runId;
    };
    try {
      await f.repository.upsertPolicy(taskId, policy);
      const first = await evaluate(['a', 'b']);
      expect(await f.repository.getPendingNotificationByRun(first)).toBeNull();
      const ready = await evaluate(['a', 'b']);
      expect(await f.repository.getPendingNotificationByRun(ready)).not.toBeNull();
      const partial = await evaluate(['b']);
      let alerts = await f.repository.listAlerts(taskId);
      const recoveredA = alerts.find((alert) => alert.field === 'a')!;
      expect(recoveredA).toMatchObject({
        status: 'resolved',
        occurrenceCount: 2,
        lastRunId: ready,
      });
      expect(alerts.find((alert) => alert.field === 'b')).toMatchObject({
        status: 'open',
        occurrenceCount: 3,
        lastRunId: partial,
      });
      expect(
        (await f.platform.listEvents(0, 1000)).filter(
          (event) => event.type === 'monitoring.alert.resolved',
        ),
      ).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ alertId: recoveredA.id, runId: partial }),
        }),
      ]);
      const returned = await evaluate(['a', 'b']);
      expect(await f.repository.getPendingNotificationByRun(returned)).toBeNull();
      alerts = await f.repository.listAlerts(taskId);
      expect(
        alerts.find((alert) => alert.field === 'a' && alert.status === 'open')!.runs[0]!.reason,
      ).toBe('consecutive');
      const expired = await evaluate(['a', 'b'], 11_000);
      expect(await f.repository.getPendingNotificationByRun(expired)).toBeNull();
      alerts = await f.repository.listAlerts(taskId);
      for (const field of ['a', 'b'])
        expect(
          alerts.find((alert) => alert.field === field && alert.firstRunId === expired),
        ).toMatchObject({
          occurrenceCount: 1,
          runs: [expect.objectContaining({ reason: 'cooldown', runId: expired })],
        });
      const cooled = await evaluate(['a', 'b'], 61_000);
      expect(await f.repository.getPendingNotificationByRun(cooled)).not.toBeNull();
      await evaluate([]);
      expect(
        (await f.repository.listAlerts(taskId)).every((alert) => alert.status === 'resolved'),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('starts a new streak after threshold or baseline changes but preserves it when field selection is only reordered', async () => {
    const f = await fixture();
    const taskId = crypto.randomUUID();
    let policy = qualityPolicySchema.parse({
      baselineRuns: 1,
      minimumBaselineRuns: 1,
      rules: [
        {
          kind: 'field-value-change',
          fields: ['a', 'b'],
          excludeFields: ['noise', 'secret'],
          thresholdMode: 'percentage',
          threshold: 0.2,
          consecutiveRuns: 2,
          aggregationSeconds: 3600,
        },
      ],
    });
    const evaluate = async () => {
      const runId = crypto.randomUUID();
      const issues: QualityIssue[] = [
        {
          kind: 'field-value-change',
          field: 'a',
          severity: 'warning',
          message: 'Field changed',
          actual: 1,
          expected: 0.2,
          metadata: {},
        },
      ];
      await f.repository.createEvaluation(
        { taskId, runId, status: 'warning', profile: { recordCount: 2, fields: {} }, issues },
        { type: 'quality.issue.detected', severity: 'warning', payload: { taskId, runId, issues } },
      );
      return runId;
    };
    try {
      await f.repository.upsertPolicy(taskId, policy);
      expect(await f.repository.getPendingNotificationByRun(await evaluate())).toBeNull();
      policy.rules[0]!.fields.reverse();
      policy.rules[0]!.excludeFields!.reverse();
      await f.repository.upsertPolicy(taskId, policy);
      expect(await f.repository.getPendingNotificationByRun(await evaluate())).not.toBeNull();
      for (const change of ['threshold', 'baseline'] as const) {
        policy = qualityPolicySchema.parse(
          change === 'threshold'
            ? { ...policy, rules: [{ ...policy.rules[0]!, threshold: 0.3 }] }
            : { ...policy, baselineRuns: 2 },
        );
        await f.repository.upsertPolicy(taskId, policy);
        const changed = await evaluate();
        expect(await f.repository.getPendingNotificationByRun(changed)).toBeNull();
        const alerts = await f.repository.listAlerts(taskId);
        expect(alerts.filter((alert) => alert.status === 'open')).toEqual([
          expect.objectContaining({
            firstRunId: changed,
            occurrenceCount: 1,
            runs: [expect.objectContaining({ reason: 'consecutive' })],
          }),
        ]);
        expect(await f.repository.getPendingNotificationByRun(await evaluate())).not.toBeNull();
      }
    } finally {
      await f.close();
    }
  });

  it('rolls back evaluation, consecutive state, alert, occurrence and outbox together on a row failure', async () => {
    const f = await fixture();
    const database = new Database(f.path);
    const taskId = crypto.randomUUID(),
      runId = crypto.randomUUID();
    const policy = qualityPolicySchema.parse({
      rules: [{ kind: 'run-failed', consecutiveRuns: 1 }],
    });
    try {
      await f.repository.upsertPolicy(taskId, policy);
      database.exec(
        "CREATE TRIGGER fail_monitoring_occurrence BEFORE INSERT ON quality_alert_runs BEGIN SELECT RAISE(ABORT,'owned occurrence failure'); END;",
      );
      const service = new MonitoringService(f.repository);
      await expect(
        service.recordFailed({ taskId, runId, error: 'SENSITIVE-FAILURE' }),
      ).rejects.toThrow('owned occurrence failure');
      expect(await f.repository.getEvaluationByRun(runId)).toBeNull();
      expect(await f.repository.listAlerts(taskId)).toEqual([]);
      expect(database.prepare('SELECT COUNT(*) AS count FROM quality_rule_state').get()).toEqual({
        count: 0,
      });
      expect(
        (await f.platform.listEvents(0, 1000)).filter((event) => event.payload.runId === runId),
      ).toEqual([]);
      database.exec('DROP TRIGGER fail_monitoring_occurrence');
      await service.recordFailed({ taskId, runId, error: 'SENSITIVE-FAILURE' });
      const notifications = (await f.platform.listEvents(0, 1000)).filter(
        (event) => event.type === 'quality.issue.detected',
      );
      expect(JSON.stringify(notifications)).not.toContain('SENSITIVE-FAILURE');
    } finally {
      database.close();
      await f.close();
    }
  });
});
