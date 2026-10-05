import { describe, expect, it } from 'vitest';
import {
  defaultQualityPolicy,
  evaluateProfile,
  MonitoringService,
  profileRecords,
} from '../src/index.js';
import type { QualityEvaluation, QualityPolicy, TaskHealth } from '@zhiyun/shared';
import type {
  MonitoringRepository,
  QualityNotification,
  QualityNotificationDraft,
} from '../src/contracts/index.js';

describe('monitoring quality evaluation', () => {
  it('profiles fields without materializing all records', async () => {
    async function* records() {
      yield { data: { id: 1, name: 'A' } };
      yield { data: { id: 2, name: null } };
    }
    await expect(profileRecords(records())).resolves.toMatchObject({
      recordCount: 2,
      fields: { name: { present: 2, nulls: 1 } },
    });
  });

  it('detects an empty result after prior non-empty runs', () => {
    const issues = evaluateProfile({
      profile: { recordCount: 0, fields: {} },
      baselines: [{ recordCount: 10, fields: {} }],
      policy: defaultQualityPolicy,
    });
    expect(issues.some((issue) => issue.kind === 'empty-result')).toBe(true);
  });

  it('detects record drops and field/type/null anomalies after a baseline is ready', () => {
    const baseline = {
      recordCount: 100,
      fields: {
        name: { present: 100, nulls: 0, types: { string: 100 } },
        price: { present: 100, nulls: 0, types: { number: 100 } },
      },
    };
    const issues = evaluateProfile({
      profile: {
        recordCount: 20,
        fields: { price: { present: 20, nulls: 20, types: { string: 20 } } },
      },
      baselines: [baseline, baseline, baseline],
      policy: defaultQualityPolicy,
    });
    expect(issues.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining([
        'record-count-drop',
        'field-missing',
        'null-rate-spike',
        'type-change',
      ]),
    );
  });

  it('treats an exact 50% record-count drop as reaching the default threshold', () => {
    const baseline = { recordCount: 100, fields: {} };
    const issues = evaluateProfile({
      profile: { recordCount: 50, fields: {} },
      baselines: [baseline, baseline, baseline],
      policy: defaultQualityPolicy,
    });

    expect(issues).toContainEqual(expect.objectContaining({ kind: 'record-count-drop' }));
  });

  it('remembers a prior non-empty result after it falls out of the rolling baseline', () => {
    const empty = { recordCount: 0, fields: {} };
    const issues = evaluateProfile({
      profile: empty,
      baselines: [empty, empty, empty, empty, empty],
      policy: defaultQualityPolicy,
      everNonEmpty: true,
    });

    expect(issues).toContainEqual(expect.objectContaining({ kind: 'empty-result' }));
  });

  it('honors per-task field presence and null-rate delta thresholds', () => {
    const baseline = {
      recordCount: 10,
      fields: {
        optional: { present: 8, nulls: 1, types: { string: 8 } },
      },
    };
    const policy = {
      ...defaultQualityPolicy,
      rules: defaultQualityPolicy.rules.map((rule) => {
        if (rule.kind === 'field-missing') {
          return { ...rule, baselineThreshold: 0.75, threshold: 0.3 };
        }
        if (rule.kind === 'null-rate-spike') {
          return { ...rule, threshold: 0.5, deltaThreshold: 0.1 };
        }
        return rule;
      }),
    };
    const issues = evaluateProfile({
      profile: {
        recordCount: 10,
        fields: { optional: { present: 2, nulls: 2, types: { string: 2 } } },
      },
      baselines: [baseline, baseline, baseline],
      policy,
    });

    expect(issues.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining(['field-missing', 'null-rate-spike']),
    );
  });

  it('does not notify twice when the same run job is retried', async () => {
    const evaluations = new Map<string, QualityEvaluation>();
    const pending = new Map<string, QualityNotification>();
    const repository = {
      getEvaluationByRun: async (runId: string) => evaluations.get(runId) ?? null,
      getPolicy: async () => defaultQualityPolicy,
      getHealth: async (taskId: string) => ({
        taskId,
        status: 'unknown' as const,
        latestRunId: null,
        issues: [],
        baselineReady: false,
        updatedAt: null,
      }),
      listBaselineProfiles: async () => [],
      createEvaluation: async (
        input: Omit<QualityEvaluation, 'id' | 'createdAt'>,
        notification?: QualityNotificationDraft,
      ) => {
        const evaluation = {
          ...input,
          id: 'evaluation-1',
          createdAt: new Date().toISOString(),
        };
        evaluations.set(input.runId, evaluation);
        if (notification) {
          pending.set(input.runId, {
            ...notification,
            eventId: 'event-1',
            evaluationId: evaluation.id,
            taskId: input.taskId,
            runId: input.runId,
            occurredAt: evaluation.createdAt,
          });
        }
        return evaluation;
      },
      getPendingNotificationByRun: async (runId: string) => pending.get(runId) ?? null,
      markNotificationDelivered: async (eventId: string) => {
        for (const [runId, notification] of pending) {
          if (notification.eventId === eventId) pending.delete(runId);
        }
      },
    } as unknown as MonitoringRepository;
    let notifications = 0;
    const service = new MonitoringService(repository, {
      issue: async () => {
        notifications += 1;
      },
      recovered: async () => undefined,
    });

    await service.recordFailed({ taskId: 'task-1', runId: 'run-1', error: 'failed' });
    await service.recordFailed({ taskId: 'task-1', runId: 'run-1', error: 'failed' });
    expect(notifications).toBe(1);
  });

  it.each([
    {
      name: 'the quality policy is disabled',
      policy: { ...defaultQualityPolicy, enabled: false },
    },
    {
      name: 'the run-failed rule is disabled',
      policy: {
        ...defaultQualityPolicy,
        rules: defaultQualityPolicy.rules.map((rule) =>
          rule.kind === 'run-failed' ? { ...rule, enabled: false } : rule,
        ),
      },
    },
  ] satisfies Array<{ name: string; policy: QualityPolicy }>)(
    'keeps failed health without creating an issue or notification when $name',
    async ({ policy }) => {
      let notifications = 0;
      const service = new MonitoringService(
        {
          getEvaluationByRun: async () => null,
          getPolicy: async () => policy,
          createEvaluation: async (input: Omit<QualityEvaluation, 'id' | 'createdAt'>) => ({
            ...input,
            id: 'evaluation-1',
            createdAt: new Date().toISOString(),
          }),
          getPendingNotificationByRun: async () => null,
          markNotificationDelivered: async () => undefined,
        } as unknown as MonitoringRepository,
        {
          issue: async () => {
            notifications += 1;
          },
          recovered: async () => undefined,
        },
      );

      await expect(
        service.recordFailed({ taskId: 'task-1', runId: 'run-1', error: 'failed' }),
      ).resolves.toMatchObject({ status: 'failing', issues: [] });
      expect(notifications).toBe(0);
    },
  );

  it('does not recover an open issue while the successful health is still unknown', async () => {
    let currentHealth: TaskHealth = {
      taskId: 'task-1',
      status: 'failing',
      latestRunId: 'failed-run',
      issues: [],
      baselineReady: false,
      updatedAt: new Date().toISOString(),
    };
    let recoveries = 0;
    const service = new MonitoringService(
      {
        getEvaluationByRun: async () => null,
        getPolicy: async () => defaultQualityPolicy,
        getHealth: async () => currentHealth,
        hasEverNonEmpty: async () => false,
        hasOpenIssue: async () => true,
        listBaselineProfiles: async () => [],
        createEvaluation: async (input: Omit<QualityEvaluation, 'id' | 'createdAt'>) => {
          currentHealth = {
            ...currentHealth,
            status: input.status,
            latestRunId: input.runId,
            issues: input.issues,
          };
          return {
            ...input,
            id: 'evaluation-1',
            createdAt: new Date().toISOString(),
          };
        },
        getPendingNotificationByRun: async () => null,
        markNotificationDelivered: async () => undefined,
      } as unknown as MonitoringRepository,
      {
        issue: async () => undefined,
        recovered: async () => {
          recoveries += 1;
        },
      },
    );

    await service.evaluateSucceeded({
      taskId: 'task-1',
      runId: 'successful-run',
      datasetStats: { added: 0, updated: 0, removed: 0, unchanged: 1, current: 1 },
      records: [{ data: { id: 1 } }],
    });
    expect(currentHealth.status).toBe('unknown');
    expect(recoveries).toBe(0);
  });

  it('recovers an open issue once when the successful health becomes healthy', async () => {
    let evaluation: QualityEvaluation | null = null;
    let pending: QualityNotification | null = null;
    let openIssue = true;
    let recoveries = 0;
    const repository = {
      getEvaluationByRun: async (runId: string) =>
        evaluation?.runId === runId ? evaluation : null,
      getPolicy: async () => ({ ...defaultQualityPolicy, minimumBaselineRuns: 1 }),
      getHealth: async (taskId: string): Promise<TaskHealth> => ({
        taskId,
        status: evaluation?.status ?? 'unknown',
        latestRunId: evaluation?.runId ?? null,
        issues: evaluation?.issues ?? [],
        baselineReady: evaluation !== null,
        updatedAt: evaluation?.createdAt ?? null,
      }),
      hasEverNonEmpty: async () => false,
      hasOpenIssue: async () => openIssue,
      listBaselineProfiles: async () => [],
      createEvaluation: async (
        input: Omit<QualityEvaluation, 'id' | 'createdAt'>,
        notification?: QualityNotificationDraft,
      ) => {
        evaluation = {
          ...input,
          id: 'healthy-evaluation',
          createdAt: new Date().toISOString(),
        };
        if (notification) {
          pending = {
            ...notification,
            eventId: 'recovery-event',
            evaluationId: evaluation.id,
            taskId: input.taskId,
            runId: input.runId,
            occurredAt: evaluation.createdAt,
          };
          openIssue = notification.type !== 'quality.recovered';
        }
        return evaluation;
      },
      getPendingNotificationByRun: async () => pending,
      markNotificationDelivered: async () => {
        pending = null;
      },
    } as unknown as MonitoringRepository;
    const service = new MonitoringService(repository, {
      issue: async () => undefined,
      recovered: async () => {
        recoveries += 1;
      },
    });
    const input = {
      taskId: 'task-1',
      runId: 'successful-run',
      datasetStats: { added: 0, updated: 0, removed: 0, unchanged: 1, current: 1 },
      records: [{ data: { id: 1 } }],
    };

    await expect(service.evaluateSucceeded(input)).resolves.toMatchObject({ status: 'healthy' });
    await expect(service.evaluateSucceeded(input)).resolves.toMatchObject({ status: 'healthy' });
    expect(recoveries).toBe(1);
  });

  it('keeps successful health unknown until the minimum baseline is established', async () => {
    const evaluations: QualityEvaluation[] = [];
    const repository = {
      getEvaluationByRun: async (runId: string) =>
        evaluations.find((evaluation) => evaluation.runId === runId) ?? null,
      getPolicy: async () => defaultQualityPolicy,
      getHealth: async (taskId: string) => ({
        taskId,
        status: evaluations.at(-1)?.status ?? 'unknown',
        latestRunId: evaluations.at(-1)?.runId ?? null,
        issues: [],
        baselineReady: evaluations.length >= defaultQualityPolicy.minimumBaselineRuns,
        updatedAt: null,
      }),
      hasEverNonEmpty: async () => evaluations.some((value) => value.profile.recordCount > 0),
      hasOpenIssue: async () => false,
      listBaselineProfiles: async () => evaluations.map((evaluation) => evaluation.profile),
      createEvaluation: async (input: Omit<QualityEvaluation, 'id' | 'createdAt'>) => {
        const evaluation = {
          ...input,
          id: `evaluation-${evaluations.length + 1}`,
          createdAt: new Date().toISOString(),
        };
        evaluations.push(evaluation);
        return evaluation;
      },
      getPendingNotificationByRun: async () => null,
      markNotificationDelivered: async () => undefined,
    } as unknown as MonitoringRepository;
    const service = new MonitoringService(repository);
    const evaluate = (runId: string) =>
      service.evaluateSucceeded({
        taskId: 'task-1',
        runId,
        datasetStats: { added: 1, updated: 0, removed: 0, unchanged: 0, current: 1 },
        records: [{ data: { id: 1 } }],
      });

    await expect(evaluate('run-1')).resolves.toMatchObject({ status: 'unknown' });
    await expect(evaluate('run-2')).resolves.toMatchObject({ status: 'unknown' });
    await expect(evaluate('run-3')).resolves.toMatchObject({ status: 'healthy' });
  });
});
