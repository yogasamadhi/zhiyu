import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContribution } from '@zhiyun/kernel';
import type { PlatformRepository } from '@zhiyun/platform-core';
import { normalizeCrawlPlan } from '@zhiyun/contracts';
import type { AiAssistanceServiceContract } from '../contracts/index.js';

export const aiAssistanceRoutes = [
  {
    operationId: 'analyzeTaskRule',
    method: 'POST',
    path: '/api/v2/tasks/{taskId}/rule-analysis',
  },
  {
    operationId: 'explainRunFailure',
    method: 'POST',
    path: '/api/v2/runs/{runId}/explain-failure',
  },
  { operationId: 'extractTaskWithAi', method: 'POST', path: '/api/v2/tasks/{taskId}/ai/extract' },
  {
    operationId: 'createRuleRepairProposal',
    method: 'POST',
    path: '/api/v2/tasks/{taskId}/rules/{ruleId}/repair-proposals',
  },
  {
    operationId: 'testRuleRepairProposal',
    method: 'POST',
    path: '/api/v2/tasks/{taskId}/rules/{ruleId}/repair-proposals/{proposalId}/test',
  },
  {
    operationId: 'applyRuleRepairProposal',
    method: 'POST',
    path: '/api/v2/tasks/{taskId}/rules/{ruleId}/repair-proposals/{proposalId}/apply',
  },
  {
    operationId: 'rejectRuleRepairProposal',
    method: 'POST',
    path: '/api/v2/tasks/{taskId}/rules/{ruleId}/repair-proposals/{proposalId}/reject',
  },
] as const satisfies readonly RouteContribution[];

export interface AiAssistanceHttpDependencies {
  service: AiAssistanceServiceContract;
  platform: PlatformRepository;
}

export async function registerAiAssistanceHttp(
  app: FastifyInstance,
  dependencies: AiAssistanceHttpDependencies,
): Promise<void> {
  app.post('/api/v2/tasks/:taskId/rule-analysis', async (request, reply) =>
    send(reply, async () => {
      const body = isObject(request.body) ? request.body : {};
      return dependencies.service.analyzeTaskRule(pathId(request, 'taskId'), {
        useAi: body.useAi !== false,
        forceBrowser: body.forceBrowser === true,
      });
    }),
  );
  app.post('/api/v2/runs/:runId/explain-failure', async (request, reply) =>
    send(reply, async () => ({
      explanation: await dependencies.service.explainRunFailure(pathId(request, 'runId')),
      persisted: false,
    })),
  );
  app.post('/api/v2/tasks/:taskId/ai/extract', async (request, reply) =>
    send(reply, async () => {
      const body = isObject(request.body) ? request.body : {};
      return dependencies.service.extractTask(pathId(request, 'taskId'), {
        ...(body.definition ? { definition: normalizeCrawlPlan(body.definition) } : {}),
        ...(typeof body.instruction === 'string' ? { instruction: body.instruction } : {}),
      });
    }),
  );
  app.post('/api/v2/tasks/:taskId/rules/:ruleId/repair-proposals', async (request, reply) =>
    send(reply, async () => {
      const body = objectBody(request.body);
      if (typeof body.error !== 'string' || !body.error.trim() || body.error.length > 4_000) {
        throw new HttpProblem(400, 'VALIDATION_ERROR', 'Repair error is required');
      }
      const input = {
        error: body.error,
        runId: typeof body.runId === 'string' ? body.runId : null,
      };
      const result = await idempotentMutation(
        dependencies.platform,
        `ai-assistance:create-repair:${pathId(request, 'ruleId')}`,
        requireIdempotencyKey(request),
        input,
        201,
        () =>
          dependencies.service.createRepairProposal(
            pathId(request, 'taskId'),
            pathId(request, 'ruleId'),
            input,
          ),
      );
      reply.code(201);
      return result;
    }),
  );
  app.post(
    '/api/v2/tasks/:taskId/rules/:ruleId/repair-proposals/:proposalId/test',
    async (request, reply) =>
      send(reply, () =>
        dependencies.service.testRepairProposal(
          pathId(request, 'taskId'),
          pathId(request, 'ruleId'),
          pathId(request, 'proposalId'),
        ),
      ),
  );
  app.post(
    '/api/v2/tasks/:taskId/rules/:ruleId/repair-proposals/:proposalId/apply',
    async (request, reply) =>
      send(reply, async () => {
        const taskId = pathId(request, 'taskId');
        const ruleId = pathId(request, 'ruleId');
        const proposalId = pathId(request, 'proposalId');
        const version = await idempotentMutation(
          dependencies.platform,
          `ai-assistance:apply-repair:${proposalId}`,
          requireIdempotencyKey(request),
          {},
          201,
          () => dependencies.service.applyRepairProposal(taskId, ruleId, proposalId),
        );
        reply.code(201);
        return version;
      }),
  );
  app.post(
    '/api/v2/tasks/:taskId/rules/:ruleId/repair-proposals/:proposalId/reject',
    async (request, reply) =>
      send(reply, () =>
        dependencies.service.rejectRepairProposal(
          pathId(request, 'taskId'),
          pathId(request, 'ruleId'),
          pathId(request, 'proposalId'),
        ),
      ),
  );
}

async function send(reply: FastifyReply, operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI Assistance request failed';
    const status =
      error instanceof HttpProblem
        ? error.status
        : message.includes('not found')
          ? 404
          : /already reviewed|must be tested|No candidate/.test(message)
            ? 409
            : 422;
    const code =
      error instanceof HttpProblem
        ? error.code
        : status === 404
          ? 'NOT_FOUND'
          : status === 409
            ? 'CONFLICT'
            : 'AI_ERROR';
    return reply
      .code(status)
      .type('application/problem+json')
      .send({
        type: `https://zhiyun.dev/problems/${code.toLowerCase().replaceAll('_', '-')}`,
        title: code,
        status,
        code,
        detail: message,
        instance: reply.request.routeOptions.url || reply.request.url.split('?')[0],
        traceId: reply.request.id,
      });
  }
}

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid request body');
  return value;
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !value || value.length > 200) {
    throw new HttpProblem(428, 'PRECONDITION_REQUIRED', 'Idempotency-Key is required');
  }
  return value;
}

async function idempotentMutation<T>(
  platform: PlatformRepository,
  scope: string,
  key: string,
  body: unknown,
  responseStatus: number,
  operation: () => Promise<T>,
): Promise<T> {
  const requestHash = createHash('sha256').update(canonicalJson(body)).digest('hex');
  const reservation = await platform.reserveIdempotency({
    scope,
    key,
    requestHash,
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
  if (reservation.state === 'conflict' || reservation.state === 'pending') {
    throw new HttpProblem(409, 'IDEMPOTENCY_CONFLICT', 'Idempotent mutation conflicts');
  }
  if (reservation.state === 'completed') return reservation.responseBody as T;
  const response = await operation();
  await platform.completeIdempotency({
    scope,
    key,
    requestHash,
    responseStatus,
    responseBody: response,
  });
  return response;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function pathId(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || !value) throw new Error(`Invalid ${name}`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
