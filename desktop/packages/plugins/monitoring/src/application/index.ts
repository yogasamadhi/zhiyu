import type { DatasetStats, QualityEvaluation } from '@zhiyun/shared';
import type {
  MonitoringRepository,
  QualityNotification,
  QualityNotificationDraft,
} from '../contracts/index.js';
import {
  evaluateProfile,
  failedEvaluation,
  profileRecords,
  profileFieldChanges,
} from '../domain/index.js';
import type { RecordChange } from '@zhiyun/shared';

export interface MonitoringNotifier {
  issue(evaluation: QualityEvaluation, notification: QualityNotification): Promise<void>;
  recovered(evaluation: QualityEvaluation, notification: QualityNotification): Promise<void>;
}

export class MonitoringService {
  private readonly taskOperations = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: MonitoringRepository,
    private readonly notifier?: MonitoringNotifier,
  ) {}

  async evaluateSucceeded(input: {
    taskId: string;
    runId: string;
    datasetStats: DatasetStats;
    records:
      | AsyncIterable<{ data: Record<string, unknown> }>
      | Iterable<{ data: Record<string, unknown> }>;
    changes?:
      | AsyncIterable<Pick<RecordChange, 'type' | 'before' | 'after'>>
      | Iterable<Pick<RecordChange, 'type' | 'before' | 'after'>>;
  }): Promise<QualityEvaluation> {
    return this.runForTask(input.taskId, () => this.evaluateSucceededSerial(input));
  }

  private async evaluateSucceededSerial(input: {
    taskId: string;
    runId: string;
    datasetStats: DatasetStats;
    records:
      | AsyncIterable<{ data: Record<string, unknown> }>
      | Iterable<{ data: Record<string, unknown> }>;
    changes?:
      | AsyncIterable<Pick<RecordChange, 'type' | 'before' | 'after'>>
      | Iterable<Pick<RecordChange, 'type' | 'before' | 'after'>>;
  }): Promise<QualityEvaluation> {
    const existing = await this.repository.getEvaluationByRun(input.runId);
    if (existing) {
      await this.deliverPending(existing);
      return existing;
    }
    const [policy, everNonEmpty, openIssue] = await Promise.all([
      this.repository.getPolicy(input.taskId),
      this.repository.hasEverNonEmpty(input.taskId),
      this.repository.hasOpenIssue(input.taskId),
    ]);
    const profile = await profileRecords(input.records);
    const needsFieldChanges =
      policy.enabled &&
      policy.rules.some((rule) => rule.kind === 'field-value-change' && rule.enabled);
    if (needsFieldChanges && !input.changes)
      throw new Error('Field value monitoring requires the committed Run changes');
    const fieldChanges =
      needsFieldChanges && input.changes ? await profileFieldChanges(input.changes) : undefined;
    const baselines = await this.repository.listBaselineProfiles(input.taskId, policy.baselineRuns);
    const issues = evaluateProfile({
      profile,
      baselines,
      policy,
      datasetStats: input.datasetStats,
      everNonEmpty,
      ...(fieldChanges ? { fieldChanges } : {}),
    });
    const status =
      issues.length > 0
        ? ('warning' as const)
        : baselines.length + 1 >= policy.minimumBaselineRuns
          ? ('healthy' as const)
          : ('unknown' as const);
    const notification: QualityNotificationDraft | undefined =
      issues.length > 0
        ? {
            type: 'quality.issue.detected',
            severity: 'warning',
            payload: { taskId: input.taskId, runId: input.runId, status, issues },
          }
        : status === 'healthy' && policy.enabled && openIssue
          ? {
              type: 'quality.recovered',
              severity: 'info',
              payload: { taskId: input.taskId, runId: input.runId, status },
            }
          : undefined;
    const created = await this.repository.createEvaluation(
      {
        taskId: input.taskId,
        runId: input.runId,
        status,
        profile,
        issues,
      },
      notification,
    );
    await this.deliverPending(created);
    return created;
  }

  async recordFailed(input: {
    taskId: string;
    runId: string;
    error?: string | null;
  }): Promise<QualityEvaluation> {
    return this.runForTask(input.taskId, () => this.recordFailedSerial(input));
  }

  private async recordFailedSerial(input: {
    taskId: string;
    runId: string;
    error?: string | null;
  }): Promise<QualityEvaluation> {
    const existing = await this.repository.getEvaluationByRun(input.runId);
    if (existing) {
      await this.deliverPending(existing);
      return existing;
    }
    const policy = await this.repository.getPolicy(input.taskId);
    const issueEnabled =
      policy.enabled && policy.rules.some((rule) => rule.kind === 'run-failed' && rule.enabled);
    const evaluation = failedEvaluation(input, issueEnabled);
    const notification: QualityNotificationDraft | undefined =
      evaluation.issues.length > 0
        ? {
            type: 'quality.issue.detected',
            severity: 'error',
            payload: {
              taskId: input.taskId,
              runId: input.runId,
              status: evaluation.status,
              issues: evaluation.issues,
            },
          }
        : undefined;
    const created = await this.repository.createEvaluation(evaluation, notification);
    await this.deliverPending(created);
    return created;
  }

  private async deliverPending(evaluation: QualityEvaluation): Promise<void> {
    const notification = await this.repository.getPendingNotificationByRun(evaluation.runId);
    if (!notification) return;
    if (this.notifier) {
      if (notification.type === 'quality.issue.detected') {
        await this.notifier.issue(evaluation, notification);
      } else {
        if (evaluation.status !== 'healthy') return;
        await this.notifier.recovered(evaluation, notification);
      }
    }
    await this.repository.markNotificationDelivered(notification.eventId);
  }

  private runForTask<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.taskOperations.get(taskId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.taskOperations.set(taskId, tail);
    return result.finally(() => {
      if (this.taskOperations.get(taskId) === tail) this.taskOperations.delete(taskId);
    });
  }
}
