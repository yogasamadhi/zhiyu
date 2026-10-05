import { createHash } from 'node:crypto';
import { z, ZodError } from 'zod';
import {
  cleaningApplyInputSchema,
  cleaningPreviewInputSchema,
  cleaningRecipeInputSchema,
  cleaningSelectInputSchema,
} from '@zhiyun/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContribution } from '@zhiyun/kernel';
import type { PlatformRepository } from '@zhiyun/platform-core';
import { DatasetCleaningError, type DatasetCleaningService } from '../application/cleaning.js';
import { DatasetCleaningConflictError } from '../contracts/cleaning.js';

export const datasetCleaningRoutes = [
  {
    operationId: 'previewDatasetCleaning',
    method: 'POST',
    path: '/api/v2/datasets/{datasetId}/cleaning/preview',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'saveDatasetCleaningRecipe',
    method: 'POST',
    path: '/api/v2/datasets/{datasetId}/cleaning/recipes',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'listDatasetCleaningRecipes',
    method: 'GET',
    path: '/api/v2/datasets/{datasetId}/cleaning/recipes',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'getDatasetCleaningRecipe',
    method: 'GET',
    path: '/api/v2/datasets/{datasetId}/cleaning/recipes/{recipeId}',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'applyDatasetCleaning',
    method: 'POST',
    path: '/api/v2/datasets/{datasetId}/cleaning/sessions',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'listDatasetCleaningSessions',
    method: 'GET',
    path: '/api/v2/datasets/{datasetId}/cleaning/sessions',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'getDatasetCleaningSession',
    method: 'GET',
    path: '/api/v2/datasets/{datasetId}/cleaning/sessions/{sessionId}',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'selectDatasetCleaningStep',
    method: 'POST',
    path: '/api/v2/datasets/{datasetId}/cleaning/sessions/{sessionId}/selection',
    requiredPermission: 'task.write',
  },
] as const satisfies readonly RouteContribution[];

export async function registerDatasetCleaningHttp(
  app: FastifyInstance,
  service: DatasetCleaningService | undefined,
  platform: PlatformRepository,
) {
  const requireService = () => {
    if (!service)
      throw new DatasetCleaningError('ANALYTICS_UNAVAILABLE', 'Cleaning is unavailable', 503);
    return service;
  };
  const prefix = '/api/v2/datasets/:datasetId/cleaning';
  const send = async (
    request: FastifyRequest,
    reply: FastifyReply,
    operation: () => Promise<unknown>,
  ) => {
    try {
      return await operation();
    } catch (error) {
      const status =
        error instanceof ZodError
          ? 400
          : error instanceof DatasetCleaningConflictError
            ? 409
            : error instanceof DatasetCleaningError
              ? error.status
              : error instanceof Error && error.message.startsWith('ANALYTICS_UNAVAILABLE:')
                ? 503
                : 500;
      const code =
        error instanceof ZodError
          ? 'VALIDATION_ERROR'
          : error instanceof DatasetCleaningConflictError
            ? 'REVISION_CONFLICT'
            : error instanceof DatasetCleaningError
              ? error.code
              : status === 503
                ? 'ANALYTICS_UNAVAILABLE'
                : 'CLEANING_FAILED';
      return reply
        .code(status)
        .type('application/problem+json')
        .send({
          type: `https://zhiyun.dev/problems/${code.toLowerCase().replaceAll('_', '-')}`,
          title: code,
          status,
          code,
          detail:
            error instanceof ZodError
              ? 'Invalid cleaning parameters'
              : error instanceof Error
                ? error.message
                : 'Cleaning request failed',
          traceId: request.id,
          instance: request.routeOptions.url,
        });
    }
  };
  app.post(`${prefix}/preview`, async (request, reply) =>
    send(request, reply, () =>
      withAbort(request, reply, (signal) =>
        requireService().preview(
          pathId(request, 'datasetId'),
          cleaningPreviewInputSchema.parse(request.body),
          signal,
        ),
      ),
    ),
  );
  app.get(`${prefix}/recipes`, async (request, reply) =>
    send(request, reply, () => requireService().listRecipes(pathId(request, 'datasetId'))),
  );
  app.get(`${prefix}/recipes/:recipeId`, async (request, reply) =>
    send(request, reply, () => {
      const { versionId } = z
        .object({ versionId: z.uuid().optional() })
        .strict()
        .parse(request.query);
      return requireService().getRecipe(
        pathId(request, 'datasetId'),
        pathId(request, 'recipeId'),
        versionId,
      );
    }),
  );
  app.post(`${prefix}/recipes`, async (request, reply) =>
    send(request, reply, async () => {
      const datasetId = pathId(request, 'datasetId'),
        body = cleaningRecipeInputSchema.parse(request.body);
      if ((body.recipeId === undefined) !== (body.expectedRevision === undefined))
        throw new DatasetCleaningError(
          'VALIDATION_ERROR',
          'Recipe edits require the expected revision',
        );
      const result = await mutate(
        platform,
        request,
        `datasets:cleaning:recipe:${datasetId}`,
        body,
        () => requireService().saveRecipe(datasetId, body),
      );
      reply.code(201);
      return result;
    }),
  );
  app.get(`${prefix}/sessions`, async (request, reply) =>
    send(request, reply, () => requireService().listSessions(pathId(request, 'datasetId'))),
  );
  app.get(`${prefix}/sessions/:sessionId`, async (request, reply) =>
    send(request, reply, () =>
      requireService().getSession(pathId(request, 'datasetId'), pathId(request, 'sessionId')),
    ),
  );
  app.post(`${prefix}/sessions`, async (request, reply) =>
    send(request, reply, async () => {
      const datasetId = pathId(request, 'datasetId'),
        body = cleaningApplyInputSchema.parse(request.body);
      const result = await mutate(
        platform,
        request,
        `datasets:cleaning:apply:${datasetId}`,
        body,
        () =>
          withAbort(request, reply, (signal) => requireService().apply(datasetId, body, signal)),
      );
      reply.code(201);
      return result;
    }),
  );
  app.post(`${prefix}/sessions/:sessionId/selection`, async (request, reply) =>
    send(request, reply, async () => {
      const datasetId = pathId(request, 'datasetId'),
        sessionId = pathId(request, 'sessionId'),
        body = cleaningSelectInputSchema.parse(request.body);
      return mutate(
        platform,
        request,
        `datasets:cleaning:select:${sessionId}`,
        { datasetId, ...body },
        () =>
          requireService().selectStep(
            datasetId,
            sessionId,
            body.selectedStep,
            body.expectedRevision,
          ),
      );
    }),
  );
}

function pathId(request: FastifyRequest, name: string) {
  return z.uuid().parse((request.params as Record<string, unknown>)[name]);
}

async function mutate<T>(
  platform: PlatformRepository,
  request: FastifyRequest,
  scope: string,
  body: unknown,
  operation: () => Promise<T>,
): Promise<T> {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || !key || key.length > 200)
    throw new DatasetCleaningError('PRECONDITION_REQUIRED', 'Idempotency-Key is required', 428);
  const requestHash = createHash('sha256').update(canonical(body)).digest('hex');
  const reservation = await platform.reserveIdempotency({
    scope,
    key,
    requestHash,
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
  if (reservation.state === 'completed') return reservation.responseBody as T;
  if (reservation.state !== 'reserved')
    throw new DatasetCleaningError(
      'IDEMPOTENCY_CONFLICT',
      'Idempotent cleaning request conflicts',
      409,
    );
  let response: T;
  try {
    response = await operation();
  } catch (error) {
    await platform.releaseIdempotency({ scope, key, requestHash });
    throw error;
  }
  await platform.completeIdempotency({
    scope,
    key,
    requestHash,
    responseStatus: request.routeOptions.url?.endsWith('/selection') ? 200 : 201,
    responseBody: response,
  });
  return response;
}

async function withAbort<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => {
    if (!reply.raw.writableEnded) controller.abort();
  };
  request.raw.once('aborted', abort);
  reply.raw.once('close', abort);
  try {
    return await operation(controller.signal);
  } finally {
    request.raw.removeListener('aborted', abort);
    reply.raw.removeListener('close', abort);
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
