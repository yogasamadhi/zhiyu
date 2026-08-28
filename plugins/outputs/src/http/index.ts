import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContribution } from '@zhiyun/kernel';
import type { PlatformJobQueue } from '@zhiyun/platform-core';
import { enqueueOutputDelivery } from '../application/index.js';
import type { OutputRepository } from '../contracts/index.js';

export interface OutputCredentialStore {
  put(kind: string, value: unknown): Promise<string>;
  resolve<T = unknown>(reference: string): Promise<T>;
  delete(reference: string): Promise<void>;
}

export const outputsRoutes = [
  { operationId: 'listOutputDestinations', method: 'GET', path: '/api/v2/output-destinations' },
  { operationId: 'createOutputDestination', method: 'POST', path: '/api/v2/output-destinations' },
  {
    operationId: 'getOutputDestination',
    method: 'GET',
    path: '/api/v2/output-destinations/{destinationId}',
  },
  {
    operationId: 'updateOutputDestination',
    method: 'PUT',
    path: '/api/v2/output-destinations/{destinationId}',
  },
  {
    operationId: 'deleteOutputDestination',
    method: 'DELETE',
    path: '/api/v2/output-destinations/{destinationId}',
  },
  { operationId: 'listDeliveryAttempts', method: 'GET', path: '/api/v2/delivery-attempts' },
  {
    operationId: 'retryDeliveryAttempt',
    method: 'POST',
    path: '/api/v2/delivery-attempts/{attemptId}/retry',
  },
  {
    operationId: 'testOutputDestination',
    method: 'POST',
    path: '/api/v2/output-destinations/{destinationId}/test',
  },
  {
    operationId: 'promptOutputCredential',
    method: 'POST',
    path: '/api/v2/output-destinations/{destinationId}/credential/prompt',
  },
  { operationId: 'listApiTokens', method: 'GET', path: '/api/v2/api-tokens' },
  { operationId: 'createApiToken', method: 'POST', path: '/api/v2/api-tokens' },
  { operationId: 'revokeApiToken', method: 'DELETE', path: '/api/v2/api-tokens/{tokenId}' },
] as const satisfies readonly RouteContribution[];

export interface OutputsHttpDependencies {
  repository: OutputRepository;
  credentialStore: OutputCredentialStore;
  jobs: PlatformJobQueue;
  promptCredential?(
    kind: 'output-webhook' | 'output-postgres',
  ): Promise<{ reference: string } | { canceled: true }>;
}

export async function registerOutputsHttp(
  app: FastifyInstance,
  dependencies: OutputsHttpDependencies,
): Promise<void> {
  app.get('/api/v2/output-destinations', async (_request, reply) =>
    send(reply, () => dependencies.repository.listDestinations()),
  );
  app.get('/api/v2/output-destinations/:destinationId', async (request, reply) =>
    send(reply, async () => {
      const destination = await dependencies.repository.getDestination(
        pathId(request, 'destinationId'),
      );
      if (!destination) throw new HttpProblem(404, 'NOT_FOUND', 'Output Destination was not found');
      return destination;
    }),
  );
  app.post('/api/v2/output-destinations', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const input = destinationInput(request.body);
      const credentialRef = input.credential
        ? await dependencies.credentialStore.put(`output-${input.type}`, input.credential)
        : null;
      const destination = await dependencies.repository.createDestination({
        name: input.name,
        type: input.type,
        config: input.config,
        credentialRef,
        enabled: input.enabled,
      });
      reply.code(201);
      return destination;
    }),
  );
  app.put('/api/v2/output-destinations/:destinationId', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const body = objectBody(request.body);
      const updated = await dependencies.repository.updateDestination(
        pathId(request, 'destinationId'),
        {
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(isObject(body.config) ? { config: body.config } : {}),
          ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        },
      );
      if (!updated) throw new HttpProblem(404, 'NOT_FOUND', 'Output Destination was not found');
      return updated;
    }),
  );
  app.delete('/api/v2/output-destinations/:destinationId', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const id = pathId(request, 'destinationId');
      const destination = await dependencies.repository.getDestination(id);
      if (!destination || !(await dependencies.repository.deleteDestination(id))) {
        throw new HttpProblem(404, 'NOT_FOUND', 'Output Destination was not found');
      }
      if (destination.credentialRef) {
        await dependencies.credentialStore.delete(destination.credentialRef).catch(() => undefined);
      }
      reply.code(204);
      return undefined;
    }),
  );
  app.post('/api/v2/output-destinations/:destinationId/test', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const destination = await dependencies.repository.getDestination(
        pathId(request, 'destinationId'),
      );
      if (!destination) throw new HttpProblem(404, 'NOT_FOUND', 'Output Destination was not found');
      if (!destination.enabled)
        throw new HttpProblem(409, 'CONFLICT', 'Output Destination is disabled');
      if (destination.credentialRef)
        await dependencies.credentialStore.resolve(destination.credentialRef);
      return { ok: true, destinationId: destination.id };
    }),
  );
  app.post('/api/v2/output-destinations/:destinationId/credential/prompt', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const id = pathId(request, 'destinationId');
      const destination = await dependencies.repository.getDestination(id);
      if (!destination) throw new HttpProblem(404, 'NOT_FOUND', 'Output Destination was not found');
      if (!dependencies.promptCredential) {
        throw new HttpProblem(409, 'CONFLICT', 'Host credential prompt is unavailable');
      }
      const prompted = await dependencies.promptCredential(
        destination.type === 'webhook' ? 'output-webhook' : 'output-postgres',
      );
      if ('canceled' in prompted) return { ...destination, canceled: true };
      const updated = await dependencies.repository.updateDestination(id, {
        credentialRef: prompted.reference,
      });
      return { ...updated, canceled: false };
    }),
  );
  app.get('/api/v2/delivery-attempts', async (request, reply) =>
    send(reply, () =>
      dependencies.repository.listDeliveryAttempts((request.query as { runId?: string }).runId),
    ),
  );
  app.post('/api/v2/delivery-attempts/:attemptId/retry', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const id = pathId(request, 'attemptId');
      const attempt = (await dependencies.repository.listDeliveryAttempts()).find(
        (candidate) => candidate.id === id,
      );
      if (!attempt) throw new HttpProblem(404, 'NOT_FOUND', 'Delivery Attempt was not found');
      const updated = await dependencies.repository.updateDeliveryAttempt(id, {
        status: 'pending',
        attempt: attempt.attempt + 1,
        error: null,
        nextAttemptAt: null,
      });
      if (updated) await enqueueOutputDelivery(dependencies.jobs, updated);
      reply.code(202);
      return updated;
    }),
  );
  app.get('/api/v2/api-tokens', async (_request, reply) =>
    send(reply, () => dependencies.repository.listApiTokens()),
  );
  app.post('/api/v2/api-tokens', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const body = objectBody(request.body);
      if (
        typeof body.name !== 'string' ||
        !Array.isArray(body.taskIds) ||
        body.taskIds.some((id) => typeof id !== 'string') ||
        !Number.isInteger(body.rateLimitPerMinute) ||
        Number(body.rateLimitPerMinute) < 1 ||
        Number(body.rateLimitPerMinute) > 10_000
      ) {
        throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid API Token input');
      }
      const token = randomBytes(32).toString('base64url');
      const created = await dependencies.repository.createApiToken({
        name: body.name,
        taskIds: body.taskIds as string[],
        rateLimitPerMinute: Number(body.rateLimitPerMinute),
        expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
        tokenHash: createHash('sha256').update(token).digest('hex'),
      });
      reply.code(201);
      return { ...created, token };
    }),
  );
  app.delete('/api/v2/api-tokens/:tokenId', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      if (!(await dependencies.repository.revokeApiToken(pathId(request, 'tokenId')))) {
        throw new HttpProblem(404, 'NOT_FOUND', 'API Token was not found');
      }
      reply.code(204);
      return undefined;
    }),
  );
}

function destinationInput(value: unknown) {
  const body = objectBody(value);
  if (
    typeof body.name !== 'string' ||
    !body.name.trim() ||
    (body.type !== 'webhook' && body.type !== 'postgres') ||
    !isObject(body.config) ||
    typeof body.enabled !== 'boolean'
  ) {
    throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid Output Destination input');
  }
  return {
    name: body.name.trim(),
    type: body.type as 'webhook' | 'postgres',
    config: body.config,
    enabled: body.enabled,
    credential: isObject(body.credential) ? body.credential : undefined,
  };
}

async function send(reply: FastifyReply, operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    const status = error instanceof HttpProblem ? error.status : 500;
    const code = error instanceof HttpProblem ? error.code : 'INTERNAL_ERROR';
    const detail = error instanceof Error ? error.message : 'Output request failed';
    return reply
      .code(status)
      .type('application/problem+json')
      .send({
        type: `https://zhiyun.dev/problems/${code.toLowerCase().replaceAll('_', '-')}`,
        title: code,
        status,
        code,
        detail,
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

function pathId(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || !value)
    throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid ID');
  return value;
}

function requireIdempotencyKey(request: FastifyRequest): void {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !value || value.length > 200) {
    throw new HttpProblem(428, 'PRECONDITION_REQUIRED', 'Idempotency-Key is required');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
