import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContribution } from '@zhiyun/kernel';
import { qualityPolicySchema } from '@zhiyun/shared';
import { MonitoringCursorError, type MonitoringRepository } from '../contracts/index.js';

export const monitoringRoutes = [
  {
    operationId: 'getTaskQualityPolicy',
    method: 'GET',
    path: '/api/v2/tasks/{taskId}/quality-policy',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'updateTaskQualityPolicy',
    method: 'PUT',
    path: '/api/v2/tasks/{taskId}/quality-policy',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'getTaskHealth',
    method: 'GET',
    path: '/api/v2/tasks/{taskId}/health',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'listTaskQualityEvaluations',
    method: 'GET',
    path: '/api/v2/tasks/{taskId}/quality-evaluations',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'listTaskHealth',
    method: 'GET',
    path: '/api/v2/task-health',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'listTaskMonitoringAlerts',
    method: 'GET',
    path: '/api/v2/tasks/{taskId}/monitoring-alerts',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'listTaskMonitoringAlertRuns',
    method: 'GET',
    path: '/api/v2/tasks/{taskId}/monitoring-alerts/{alertId}/runs',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'dismissTaskMonitoringAlert',
    method: 'DELETE',
    path: '/api/v2/tasks/{taskId}/monitoring-alerts/{alertId}',
    requiredPermission: 'task.write',
  },
] as const satisfies readonly RouteContribution[];

export interface MonitoringHttpDependencies {
  repository: MonitoringRepository;
  tasks: { getTask(id: string): Promise<unknown | null> };
}

export async function registerMonitoringHttp(
  app: FastifyInstance,
  dependencies: MonitoringHttpDependencies,
): Promise<void> {
  app.get('/api/v2/tasks/:taskId/monitoring-alerts', async (request, reply) =>
    send(reply, async () => {
      const taskId = pathId(request, 'taskId');
      await requireTask(dependencies, taskId);
      const cursor = (request.query as Record<string, unknown>).cursor;
      if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0))
        throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid monitoring cursor');
      return dependencies.repository.listAlertsPage(
        taskId,
        cursor as string | undefined,
        queryLimit(request),
      );
    }),
  );
  app.get('/api/v2/tasks/:taskId/monitoring-alerts/:alertId/runs', async (request, reply) =>
    send(reply, async () => {
      const taskId = pathId(request, 'taskId');
      await requireTask(dependencies, taskId);
      const cursor = (request.query as Record<string, unknown>).cursor;
      if (cursor !== undefined && (typeof cursor !== 'string' || cursor.length === 0))
        throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid monitoring cursor');
      const page = await dependencies.repository.listAlertRuns(
        taskId,
        pathId(request, 'alertId'),
        cursor as string | undefined,
        queryLimit(request),
      );
      if (!page) throw new HttpProblem(404, 'NOT_FOUND', 'Monitoring alert was not found');
      return page;
    }),
  );
  app.delete('/api/v2/tasks/:taskId/monitoring-alerts/:alertId', async (request, reply) =>
    send(reply, async () => {
      requireIdempotency(request);
      const taskId = pathId(request, 'taskId');
      await requireTask(dependencies, taskId);
      const alert = await dependencies.repository.dismissAlert(taskId, pathId(request, 'alertId'));
      if (!alert) throw new HttpProblem(404, 'NOT_FOUND', 'Monitoring alert was not found');
      return alert;
    }),
  );
  app.get('/api/v2/tasks/:taskId/quality-policy', async (request, reply) =>
    send(reply, async () => {
      const taskId = pathId(request, 'taskId');
      await requireTask(dependencies, taskId);
      return dependencies.repository.getPolicy(taskId);
    }),
  );
  app.put('/api/v2/tasks/:taskId/quality-policy', async (request, reply) =>
    send(reply, async () => {
      requireIdempotency(request);
      const taskId = pathId(request, 'taskId');
      await requireTask(dependencies, taskId);
      const parsed = qualityPolicySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new HttpProblem(
          400,
          'VALIDATION_ERROR',
          'Invalid quality policy',
          parsed.error.flatten(),
        );
      }
      return dependencies.repository.upsertPolicy(taskId, parsed.data);
    }),
  );
  app.get('/api/v2/tasks/:taskId/health', async (request, reply) =>
    send(reply, async () => {
      const taskId = pathId(request, 'taskId');
      await requireTask(dependencies, taskId);
      return dependencies.repository.getHealth(taskId);
    }),
  );
  app.get('/api/v2/tasks/:taskId/quality-evaluations', async (request, reply) =>
    send(reply, async () => {
      const taskId = pathId(request, 'taskId');
      await requireTask(dependencies, taskId);
      const raw = (request.query as { limit?: string }).limit;
      const limit = raw ? Number(raw) : 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
        throw new HttpProblem(400, 'VALIDATION_ERROR', 'limit must be between 1 and 500');
      }
      return dependencies.repository.listEvaluations(taskId, limit);
    }),
  );
  app.get('/api/v2/task-health', async (request, reply) =>
    send(reply, async () => {
      const raw = (request.query as { taskIds?: string }).taskIds ?? '';
      const taskIds = [
        ...new Set(
          raw
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean),
        ),
      ];
      if (taskIds.length > 100) {
        throw new HttpProblem(400, 'VALIDATION_ERROR', 'At most 100 task IDs are allowed');
      }
      return dependencies.repository.getHealthMany(taskIds);
    }),
  );
}

async function requireTask(dependencies: MonitoringHttpDependencies, taskId: string) {
  if (!(await dependencies.tasks.getTask(taskId))) {
    throw new HttpProblem(404, 'NOT_FOUND', 'Collection Task was not found');
  }
}

function pathId(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || !value)
    throw new HttpProblem(400, 'VALIDATION_ERROR', `Missing ${name}`);
  return value;
}

function requireIdempotency(request: FastifyRequest): void {
  if (!request.headers['idempotency-key']) {
    throw new HttpProblem(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
  }
}

function queryLimit(request: FastifyRequest): number {
  const raw = (request.query as Record<string, unknown>).limit;
  const value =
    raw === undefined ? 50 : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < 1 || value > 500)
    throw new HttpProblem(400, 'VALIDATION_ERROR', 'limit must be between 1 and 500');
  return value;
}

async function send(reply: FastifyReply, action: () => Promise<unknown>) {
  try {
    return await action();
  } catch (error) {
    const problem =
      error instanceof MonitoringCursorError
        ? new HttpProblem(400, 'VALIDATION_ERROR', error.message)
        : error;
    if (problem instanceof HttpProblem) {
      return reply
        .code(problem.status)
        .type('application/problem+json')
        .send({
          type: `https://zhiyun.local/problems/${problem.code.toLowerCase()}`,
          title: problem.code,
          status: problem.status,
          detail: problem.message,
          instance: reply.request.url,
          code: problem.code,
          traceId: String(reply.getHeader('x-trace-id') ?? ''),
          ...(problem.errors ? { errors: problem.errors } : {}),
        });
    }
    throw error;
  }
}

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly errors?: unknown,
  ) {
    super(message);
  }
}
