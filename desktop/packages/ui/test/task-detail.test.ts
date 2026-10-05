import { describe, expect, it } from 'vitest';
import type { CrawlRun, DeliveryAttempt } from '@zhiyun/contracts';
import {
  loadTaskDetailOptionalData,
  resolveTaskDetailCapabilities,
  resolveTaskDetailSection,
  taskDetailSectionRoutePaths,
  taskSectionResourceErrors,
  taskWorkspaceQuery,
  type TaskDetailOptionalClient,
} from '../src/task-detail.js';

describe('task detail model', () => {
  it('uses explicit section routes that cannot consume edit or dataset pages', () => {
    expect(taskDetailSectionRoutePaths).toEqual([
      '/tasks/:id/quality',
      '/tasks/:id/analysis',
      '/tasks/:id/output',
      '/tasks/:id/runs',
    ]);
    expect(taskDetailSectionRoutePaths).not.toContain('/tasks/:id/:section');
    expect(resolveTaskDetailSection('/tasks/task-1')).toBe('overview');
    expect(resolveTaskDetailSection('/tasks/task-1/quality/')).toBe('quality');
    expect(resolveTaskDetailSection('/tasks/task-1/edit')).toBe('overview');
    expect(resolveTaskDetailSection('/tasks/task-1/dataset')).toBe('overview');
  });

  it('keeps successful optional resources when another task-detail API fails', async () => {
    const recentIdle = run('run-1', 'idle');
    const recentDelivery = run('run-2', 'failed');
    const attempt = { id: 'attempt-1' } as DeliveryAttempt;
    let requestedAttemptRun = '';
    const client = {
      listTaskRuns: async () => ({ items: [recentIdle, recentDelivery] }),
      getTaskHealth: async () => Promise.reject(new Error('monitoring unavailable')),
      getTaskQualityPolicy: async () => Promise.reject(new Error('policy unavailable')),
      listTaskQualityEvaluations: async () => [],
      listOutputDestinations: async () => [],
      listDeliveryAttempts: async (runId?: string) => {
        requestedAttemptRun = runId ?? '';
        return [attempt];
      },
    } as TaskDetailOptionalClient;

    await expect(loadTaskDetailOptionalData(client, 'task-1')).resolves.toMatchObject({
      runs: [recentIdle, recentDelivery],
      health: null,
      policy: null,
      evaluations: [],
      destinations: [],
      attempts: [attempt],
      errors: {
        health: 'monitoring unavailable',
        policy: 'policy unavailable',
      },
    });
    expect(requestedAttemptRun).toBe('run-2');
  });

  it('resolves with safe defaults even when every optional API is unavailable', async () => {
    const unavailable = async () => Promise.reject(new Error('offline'));
    const client = {
      listTaskRuns: unavailable,
      getTaskHealth: unavailable,
      getTaskQualityPolicy: unavailable,
      listTaskQualityEvaluations: unavailable,
      listOutputDestinations: unavailable,
      listDeliveryAttempts: unavailable,
    } as unknown as TaskDetailOptionalClient;
    const loaded = await loadTaskDetailOptionalData(client, 'task-1');
    expect(loaded).toMatchObject({
      runs: [],
      health: null,
      policy: null,
      evaluations: [],
      destinations: [],
      attempts: [],
    });
    expect(Object.keys(loaded.errors).sort()).toEqual([
      'destinations',
      'evaluations',
      'health',
      'policy',
      'runs',
    ]);
    expect(taskSectionResourceErrors('quality', loaded.errors)).toHaveLength(3);
  });

  it('prefills analysis and corpus workspaces from the latest successful run', () => {
    const failed = run('run-failed', 'idle', 'failed');
    const succeeded = run('run-ok', 'succeeded', 'succeeded', {
      datasetId: 'dataset-id',
      datasetSnapshotId: 'snapshot-id',
    });
    expect(taskWorkspaceQuery([failed, succeeded])).toBe(
      'datasetId=dataset-id&snapshotId=snapshot-id',
    );
  });

  it('matches viewer, editor and administrator action boundaries', () => {
    expect(resolveTaskDetailCapabilities(true, ['workspace.read'])).toEqual({
      canWrite: false,
      canRun: false,
      canBindOutput: false,
      canManageOutput: false,
      canAnalyze: false,
    });
    expect(
      resolveTaskDetailCapabilities(true, [
        'workspace.read',
        'task.write',
        'run.execute',
        'analysis.write',
        'output.bind',
      ]),
    ).toEqual({
      canWrite: true,
      canRun: true,
      canBindOutput: true,
      canManageOutput: false,
      canAnalyze: true,
    });
    expect(resolveTaskDetailCapabilities(false, [])).toEqual({
      canWrite: true,
      canRun: true,
      canBindOutput: true,
      canManageOutput: true,
      canAnalyze: true,
    });
  });
});

function run(
  id: string,
  deliveryStatus: CrawlRun['deliveryStatus'],
  status: CrawlRun['status'] = 'succeeded',
  metadata: Record<string, unknown> = {},
): CrawlRun {
  return {
    id,
    taskId: 'task-1',
    status,
    startedAt: null,
    finishedAt: null,
    requestCount: 0,
    recordCount: 0,
    browserUsed: false,
    aiUsed: false,
    error: null,
    errorCode: null,
    phase: status,
    progress: status === 'succeeded' ? 1 : 0,
    cancelRequestedAt: null,
    datasetStats: { added: 0, updated: 0, removed: 0, unchanged: 0, current: 0 },
    deliveryStatus,
    warningCount: 0,
    metadata,
    createdAt: '2026-08-31T00:00:00.000Z',
  };
}
