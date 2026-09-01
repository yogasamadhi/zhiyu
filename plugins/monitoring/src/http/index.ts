import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContribution } from '@zhiyun/kernel';
import { qualityPolicySchema } from '@zhiyun/shared';
import type { MonitoringRepository } from '../contracts/index.js';

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
] as const satisfies readonly RouteContribution[];

export interface MonitoringHttpDependencies {
  repository: MonitoringRepository;
  tasks: { getTask(id: string): Promise<unknown | null> };
}

export async function registerMonitoringHttp(
  app: FastifyInstance,
  dependencies: MonitoringHttpDependencies,
): Promise<void> {
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

async function send(reply: FastifyReply, action: () => Promise<unknown>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof HttpProblem) {
      return reply
        .code(error.status)
        .type('application/problem+json')
        .send({
          type: `https://zhiyun.local/problems/${error.code.toLowerCase()}`,
          title: error.code,
          status: error.status,
          detail: error.message,
          instance: reply.request.url,
          code: error.code,
          traceId: String(reply.getHeader('x-trace-id') ?? ''),
          ...(error.errors ? { errors: error.errors } : {}),
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
