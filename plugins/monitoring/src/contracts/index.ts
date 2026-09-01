import type { QualityEvaluation, QualityPolicy, QualityProfile, TaskHealth } from '@zhiyun/shared';

export type QualityNotificationType = 'quality.issue.detected' | 'quality.recovered';

export interface QualityNotificationDraft {
  type: QualityNotificationType;
  severity: 'info' | 'warning' | 'error';
  payload: Record<string, unknown>;
}

export interface QualityNotification extends QualityNotificationDraft {
  eventId: string;
  evaluationId: string;
  taskId: string;
  runId: string;
  occurredAt: string;
}

export interface MonitoringRepository {
  migrate(): Promise<void>;
  close(): Promise<void>;
  getPolicy(taskId: string): Promise<QualityPolicy>;
  upsertPolicy(taskId: string, policy: QualityPolicy): Promise<QualityPolicy>;
  getEvaluationByRun(runId: string): Promise<QualityEvaluation | null>;
  createEvaluation(
    input: Omit<QualityEvaluation, 'id' | 'createdAt'>,
    notification?: QualityNotificationDraft,
  ): Promise<QualityEvaluation>;
  hasEverNonEmpty(taskId: string): Promise<boolean>;
  hasOpenIssue(taskId: string): Promise<boolean>;
  getPendingNotificationByRun(runId: string): Promise<QualityNotification | null>;
  markNotificationDelivered(eventId: string): Promise<void>;
  listEvaluations(taskId: string, limit?: number): Promise<QualityEvaluation[]>;
  listBaselineProfiles(taskId: string, limit: number): Promise<QualityProfile[]>;
  getHealth(taskId: string): Promise<TaskHealth>;
  getHealthMany(taskIds: readonly string[]): Promise<TaskHealth[]>;
  deleteTask(taskId: string): Promise<void>;
}
