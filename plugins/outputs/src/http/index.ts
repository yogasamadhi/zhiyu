import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContribution } from '@zhiyun/kernel';
import { googleServiceAccountClientEmail, outputAdapter } from '@zhiyun/outputs';
import type { PlatformJobQueue } from '@zhiyun/platform-core';
import { outputDestinationSchema, stripOutputDestinationConfig } from '@zhiyun/shared';
import { enqueueOutputDelivery } from '../application/index.js';
import type { OutputDestination, OutputRepository } from '../contracts/index.js';

export interface OutputCredentialStore {
  put(kind: string, value: unknown): Promise<string>;
  resolve<T = unknown>(reference: string): Promise<T>;
  delete(reference: string): Promise<void>;
}

export const outputsRoutes = [
  {
    operationId: 'listOutputDestinations',
    method: 'GET',
    path: '/api/v2/output-destinations',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'createOutputDestination',
    method: 'POST',
    path: '/api/v2/output-destinations',
    requiredPermission: 'output.manage',
  },
  {
    operationId: 'getOutputDestination',
    method: 'GET',
    path: '/api/v2/output-destinations/{destinationId}',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'updateOutputDestination',
    method: 'PUT',
    path: '/api/v2/output-destinations/{destinationId}',
    requiredPermission: 'output.manage',
  },
  {
    operationId: 'deleteOutputDestination',
    method: 'DELETE',
    path: '/api/v2/output-destinations/{destinationId}',
    requiredPermission: 'output.manage',
  },
  {
    operationId: 'listDeliveryAttempts',
    method: 'GET',
    path: '/api/v2/delivery-attempts',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'retryDeliveryAttempt',
    method: 'POST',
    path: '/api/v2/delivery-attempts/{attemptId}/retry',
    requiredPermission: 'output.bind',
  },
  {
    operationId: 'testOutputDestination',
    method: 'POST',
    path: '/api/v2/output-destinations/{destinationId}/test',
    requiredPermission: 'output.manage',
  },
  {
    operationId: 'promptOutputCredential',
    method: 'POST',
    path: '/api/v2/output-destinations/{destinationId}/credential/prompt',
    requiredPermission: 'output.manage',
  },
  {
    operationId: 'listApiTokens',
    method: 'GET',
    path: '/api/v2/api-tokens',
    requiredPermission: 'output.manage',
  },
  {
    operationId: 'createApiToken',
    method: 'POST',
    path: '/api/v2/api-tokens',
    requiredPermission: 'output.manage',
  },
  {
    operationId: 'revokeApiToken',
    method: 'DELETE',
    path: '/api/v2/api-tokens/{tokenId}',
    requiredPermission: 'output.manage',
  },
] as const satisfies readonly RouteContribution[];

export interface OutputsHttpDependencies {
  repository: OutputRepository;
  credentialStore: OutputCredentialStore;
  jobs: PlatformJobQueue;
  promptCredential?(
    kind: 'output-webhook' | 'output-postgres' | 'output-google-sheets' | 'output-s3',
  ): Promise<{ reference: string } | { canceled: true }>;
  selectOutputDirectory?(): Promise<{ reference: string } | { canceled: true }>;
}

export async function registerOutputsHttp(
  app: FastifyInstance,
  dependencies: OutputsHttpDependencies,
): Promise<void> {
  app.get('/api/v2/output-destinations', async (_request, reply) =>
    send(reply, async () =>
      (await dependencies.repository.listDestinations()).map(publicDestinationView),
    ),
  );
  app.get('/api/v2/output-destinations/:destinationId', async (request, reply) =>
    send(reply, async () => {
      const destination = await dependencies.repository.getDestination(
        pathId(request, 'destinationId'),
      );
      if (!destination) throw new HttpProblem(404, 'NOT_FOUND', 'Output Destination was not found');
      return publicDestinationView(destination);
    }),
  );
  app.post('/api/v2/output-destinations', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const input = destinationInput(request.body);
      const config =
        input.type === 'google-sheets'
          ? sanitizeGoogleSheetsConfig(
              input.config,
              input.credential === undefined ? undefined : serviceAccountEmail(input.credential),
            )
          : input.config;
      const credentialRef =
        input.credential === undefined
          ? null
          : await dependencies.credentialStore.put(
              outputCredentialKind(input.type),
              input.credential,
            );
      try {
        const destination = await dependencies.repository.createDestination({
          name: input.name,
          type: input.type,
          config,
          credentialRef,
          enabled: input.enabled,
        });
        reply.code(201);
        return publicDestinationView(destination);
      } catch (error) {
        if (credentialRef) {
          await dependencies.credentialStore.delete(credentialRef).catch(() => undefined);
        }
        throw error;
      }
    }),
  );
  app.put('/api/v2/output-destinations/:destinationId', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const body = objectBody(request.body);
      const id = pathId(request, 'destinationId');
      const current = await dependencies.repository.getDestination(id);
      if (!current) throw new HttpProblem(404, 'NOT_FOUND', 'Output Destination was not found');
      const parsed = outputDestinationSchema.safeParse({
        ...current,
        ...(body.name !== undefined
          ? { name: typeof body.name === 'string' ? body.name.trim() : body.name }
          : {}),
        ...(body.config !== undefined ? { config: body.config } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        updatedAt: new Date().toISOString(),
      });
      if (!parsed.success) {
        throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid Output Destination input');
      }
      const updated = await dependencies.repository.updateDestination(id, {
        name: parsed.data.name.trim(),
        config:
          parsed.data.type === 'google-sheets'
            ? sanitizeGoogleSheetsConfig(parsed.data.config)
            : parsed.data.config,
        enabled: parsed.data.enabled,
      });
      if (!updated)
        throw new HttpProblem(409, 'CONFLICT', 'Output Destination changed concurrently');
      return publicDestinationView(updated);
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
      const credential = destination.credentialRef
        ? await dependencies.credentialStore.resolve(destination.credentialRef)
        : {};
      try {
        await outputAdapter(destination).test({ destination, credential });
      } catch (error) {
        throw new HttpProblem(
          422,
          'EXPORT_ERROR',
          error instanceof Error ? error.message : 'Output connection test failed',
        );
      }
      return { ok: true, destinationId: destination.id };
    }),
  );
  app.post('/api/v2/output-destinations/:destinationId/credential/prompt', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const id = pathId(request, 'destinationId');
      const destination = await dependencies.repository.getDestination(id);
      if (!destination) throw new HttpProblem(404, 'NOT_FOUND', 'Output Destination was not found');
      const prompted =
        destination.type === 'local-directory'
          ? dependencies.selectOutputDirectory
            ? await dependencies.selectOutputDirectory()
            : undefined
          : dependencies.promptCredential
            ? await dependencies.promptCredential(outputPromptKind(destination.type))
            : undefined;
      if (!prompted) {
        throw new HttpProblem(
          409,
          'CONFLICT',
          destination.type === 'local-directory'
            ? 'Host directory selector is unavailable'
            : 'Host credential prompt is unavailable',
        );
      }
      if ('canceled' in prompted) return { ...publicDestinationView(destination), canceled: true };
      let promptedConfig: Record<string, unknown> | undefined;
      if (destination.type === 'google-sheets') {
        try {
          promptedConfig = sanitizeGoogleSheetsConfig(
            destination.config,
            serviceAccountEmail(await dependencies.credentialStore.resolve(prompted.reference)),
          );
        } catch (error) {
          await dependencies.credentialStore.delete(prompted.reference).catch(() => undefined);
          throw error;
        }
      }
      const updated = await dependencies.repository.updateDestination(id, {
        credentialRef: prompted.reference,
        ...(promptedConfig ? { config: promptedConfig } : {}),
      });
      if (!updated) {
        await dependencies.credentialStore.delete(prompted.reference).catch(() => undefined);
        throw new HttpProblem(409, 'CONFLICT', 'Output Destination changed concurrently');
      }
      if (destination.credentialRef && destination.credentialRef !== prompted.reference) {
        await dependencies.credentialStore.delete(destination.credentialRef).catch(() => undefined);
      }
      return { ...publicDestinationView(updated), canceled: false };
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
  const timestamp = new Date().toISOString();
  const parsed = outputDestinationSchema.safeParse({
    id: randomUUID(),
    name: typeof body.name === 'string' ? body.name.trim() : body.name,
    type: body.type,
    config: body.config,
    credentialRef: null,
    enabled: body.enabled,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  if (!parsed.success) {
    throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid Output Destination input');
  }
  return {
    name: parsed.data.name.trim(),
    type: parsed.data.type,
    config: parsed.data.config,
    enabled: parsed.data.enabled,
    ...(body.credential !== undefined && body.credential !== null
      ? { credential: body.credential }
      : {}),
  };
}

function outputCredentialKind(type: OutputDestination['type']): string {
  return type === 'google-sheets' ? 'output-google-sheets' : `output-${type}`;
}

function serviceAccountEmail(value: unknown): string {
  try {
    return googleServiceAccountClientEmail(value);
  } catch (error) {
    throw new HttpProblem(
      400,
      'VALIDATION_ERROR',
      error instanceof Error ? error.message : 'Invalid Google service-account credential',
    );
  }
}

function sanitizeGoogleSheetsConfig(
  config: Record<string, unknown>,
  clientEmail?: string,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {
    spreadsheetId: config.spreadsheetId,
    sheetName: config.sheetName,
    mode: config.mode,
    columns: config.columns,
  };
  if (Array.isArray(config.fields)) safe.fields = config.fields;
  if (typeof config.includeSourceUrl === 'boolean') {
    safe.includeSourceUrl = config.includeSourceUrl;
  }
  const visibleEmail =
    clientEmail ??
    (typeof config.clientEmail === 'string' && config.clientEmail.includes('@')
      ? config.clientEmail
      : undefined);
  if (visibleEmail) safe.clientEmail = visibleEmail;
  return safe;
}

function publicDestinationView(destination: OutputDestination): OutputDestination {
  return {
    ...destination,
    config: stripOutputDestinationConfig(destination.type, destination.config),
  } as OutputDestination;
}

function outputPromptKind(
  type: Exclude<OutputDestination['type'], 'local-directory'>,
): 'output-webhook' | 'output-postgres' | 'output-google-sheets' | 'output-s3' {
  if (type === 'webhook') return 'output-webhook';
  if (type === 'postgres') return 'output-postgres';
  if (type === 'google-sheets') return 'output-google-sheets';
  return 'output-s3';
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
