import type {
  CrawlRun,
  DeliveryAttempt,
  OutputDestination,
  QualityEvaluation,
  QualityPolicy,
  TaskHealth,
} from '@zhiyun/contracts';

export const taskDetailSectionRoutePaths = [
  '/tasks/:id/quality',
  '/tasks/:id/analysis',
  '/tasks/:id/output',
  '/tasks/:id/runs',
] as const;

export type TaskDetailSection = 'overview' | 'quality' | 'analysis' | 'output' | 'runs';

export function resolveTaskDetailSection(pathname: string): TaskDetailSection {
  const section = pathname.replace(/\/+$/u, '').split('/').at(-1);
  return section === 'quality' ||
    section === 'analysis' ||
    section === 'output' ||
    section === 'runs'
    ? section
    : 'overview';
}

export interface TaskDetailCapabilities {
  canWrite: boolean;
  canRun: boolean;
  canBindOutput: boolean;
  canManageOutput: boolean;
  canAnalyze: boolean;
}

export function resolveTaskDetailCapabilities(
  identityEnabled: boolean,
  permissions: readonly string[],
): TaskDetailCapabilities {
  const allowed = (permission: string) => !identityEnabled || permissions.includes(permission);
  return {
    canWrite: allowed('task.write'),
    canRun: allowed('run.execute'),
    canBindOutput: allowed('output.bind'),
    canManageOutput: allowed('output.manage'),
    canAnalyze: allowed('analysis.write'),
  };
}

export type TaskDetailResource =
  'runs' | 'health' | 'policy' | 'evaluations' | 'destinations' | 'attempts';

export type TaskDetailResourceErrors = Partial<Record<TaskDetailResource, string>>;

export interface TaskDetailOptionalData {
  runs: CrawlRun[];
  health: TaskHealth | null;
  policy: QualityPolicy | null;
  evaluations: QualityEvaluation[];
  destinations: OutputDestination[];
  attempts: DeliveryAttempt[];
  errors: TaskDetailResourceErrors;
}

export interface TaskDetailOptionalClient {
  listTaskRuns(taskId: string, limit: number): Promise<{ items: CrawlRun[] }>;
  getTaskHealth(taskId: string): Promise<TaskHealth>;
  getTaskQualityPolicy(taskId: string): Promise<QualityPolicy>;
  listTaskQualityEvaluations(taskId: string, limit: number): Promise<QualityEvaluation[]>;
  listOutputDestinations(): Promise<OutputDestination[]>;
  listDeliveryAttempts(runId?: string): Promise<DeliveryAttempt[]>;
}

export async function loadTaskDetailOptionalData(
  client: TaskDetailOptionalClient,
  taskId: string,
): Promise<TaskDetailOptionalData> {
  const [runs, health, policy, evaluations, destinations] = await Promise.all([
    settle(() => client.listTaskRuns(taskId, 100)),
    settle(() => client.getTaskHealth(taskId)),
    settle(() => client.getTaskQualityPolicy(taskId)),
    settle(() => client.listTaskQualityEvaluations(taskId, 50)),
    settle(() => client.listOutputDestinations()),
  ]);
  const loadedRuns = runs.value?.items ?? [];
  const deliveryRun =
    loadedRuns.find((run) => run.deliveryStatus !== 'idle') ?? loadedRuns.at(0) ?? null;
  const attempts = deliveryRun
    ? await settle(() => client.listDeliveryAttempts(deliveryRun.id))
    : success<DeliveryAttempt[]>([]);
  return {
    runs: loadedRuns,
    health: health.value,
    policy: policy.value,
    evaluations: evaluations.value ?? [],
    destinations: destinations.value ?? [],
    attempts: attempts.value ?? [],
    errors: compactErrors({
      runs: runs.error,
      health: health.error,
      policy: policy.error,
      evaluations: evaluations.error,
      destinations: destinations.error,
      attempts: attempts.error,
    }),
  };
}

export function taskWorkspaceQuery(runs: readonly CrawlRun[]): string {
  const latestSucceeded = runs.find((run) => run.status === 'succeeded');
  const datasetId = stringMetadata(latestSucceeded, 'datasetId');
  const snapshotId = stringMetadata(latestSucceeded, 'datasetSnapshotId');
  return new URLSearchParams({
    ...(datasetId ? { datasetId } : {}),
    ...(snapshotId ? { snapshotId } : {}),
  }).toString();
}

export function taskSectionResourceErrors(
  section: TaskDetailSection,
  errors: TaskDetailResourceErrors,
): string[] {
  const resources: Record<TaskDetailSection, TaskDetailResource[]> = {
    overview: ['runs', 'health'],
    quality: ['health', 'policy', 'evaluations'],
    analysis: ['runs'],
    output: ['runs', 'destinations', 'attempts'],
    runs: ['runs'],
  };
  return resources[section].flatMap((resource) =>
    errors[resource] ? [`${resourceLabel(resource)}：${errors[resource]}`] : [],
  );
}

interface Settled<T> {
  value: T | null;
  error: string | null;
}

async function settle<T>(load: () => Promise<T>): Promise<Settled<T>> {
  try {
    return success(await load());
  } catch (reason) {
    return {
      value: null,
      error: reason instanceof Error ? reason.message : String(reason),
    };
  }
}

function success<T>(value: T): Settled<T> {
  return { value, error: null };
}

function compactErrors(input: Record<TaskDetailResource, string | null>): TaskDetailResourceErrors {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [TaskDetailResource, string] =>
      Boolean(entry[1]),
    ),
  );
}

function stringMetadata(run: CrawlRun | undefined, key: string): string {
  const value = run?.metadata[key];
  return typeof value === 'string' ? value : '';
}

function resourceLabel(resource: TaskDetailResource): string {
  return {
    runs: '运行历史',
    health: '健康度',
    policy: '质量策略',
    evaluations: '质量评估',
    destinations: '输出目的地',
    attempts: '投递记录',
  }[resource];
}
