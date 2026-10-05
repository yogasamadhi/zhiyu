import { createHash, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PlatformRepository, ArtifactStore } from '@zhiyun/platform-core';
import {
  AnalysisConflictError,
  AnalyticsUnavailableError,
  MethodCompatibilityError,
  MethodNotFoundError,
} from '../application/index.js';
import type {
  AnalysisJobService,
  AnalysisRecipeService,
  AnalyticsCatalog,
} from '../application/index.js';
import {
  AnalysisResultQueryError,
  type CreateAnalysisJobInput,
  type CreateAnalysisRecipeInput,
} from '../contracts/index.js';

export interface AnalyticsHttpDependencies {
  platform: PlatformRepository;
  artifactStore?: ArtifactStore;
  catalog: AnalyticsCatalog;
  recipes: AnalysisRecipeService;
  jobs: AnalysisJobService;
}

export async function registerAnalyticsHttp(
  app: FastifyInstance,
  dependencies: AnalyticsHttpDependencies,
): Promise<void> {
  app.get('/api/v2/analytics/methods', async (_request, reply) => {
    return send(reply, () => dependencies.catalog.listMethods());
  });

  app.get('/api/v2/analytics/recipes', async (request, reply) => {
    const query = request.query as { cursor?: string; limit?: string };
    return send(reply, () => dependencies.recipes.list(query.cursor, parseLimit(query.limit)));
  });

  app.post('/api/v2/analytics/recipes', async (request, reply) => {
    return send(reply, async () => {
      const key = requireIdempotencyKey(request);
      const recipe = await idempotentMutation(
        dependencies.platform,
        'analytics:create-recipe',
        key,
        request.body,
        201,
        () => dependencies.recipes.create(recipeInput(request.body)),
      );
      reply.code(201);
      return recipe;
    });
  });

  app.get('/api/v2/analytics/recipes/:recipeId', async (request, reply) => {
    return send(reply, async () => {
      const recipe = await dependencies.recipes.get(pathId(request, 'recipeId'));
      if (!recipe) throw new HttpProblem(404, 'NOT_FOUND', 'Analysis Recipe was not found');
      reply.header('etag', `"${recipe.revision}"`);
      return recipe;
    });
  });

  app.put('/api/v2/analytics/recipes/:recipeId', async (request, reply) => {
    return send(reply, async () => {
      const id = pathId(request, 'recipeId');
      const revision = requireRevision(request);
      const key = requireIdempotencyKey(request);
      const updated = await idempotentMutation(
        dependencies.platform,
        `analytics:update-recipe:${id}`,
        key,
        { revision, body: request.body },
        200,
        () => dependencies.recipes.update(id, revision, recipeInput(request.body)),
      );
      if (updated === null)
        throw new HttpProblem(404, 'NOT_FOUND', 'Analysis Recipe was not found');
      if (updated === 'revision-conflict') {
        throw new HttpProblem(412, 'PRECONDITION_FAILED', 'Analysis Recipe revision changed');
      }
      reply.header('etag', `"${updated.revision}"`);
      return updated;
    });
  });

  app.delete('/api/v2/analytics/recipes/:recipeId', async (request, reply) => {
    return send(reply, async () => {
      const id = pathId(request, 'recipeId');
      const revision = requireRevision(request);
      const key = requireIdempotencyKey(request);
      const deleted = await idempotentMutation(
        dependencies.platform,
        `analytics:delete-recipe:${id}`,
        key,
        { revision },
        200,
        () => dependencies.recipes.delete(id, revision),
      );
      if (deleted === false)
        throw new HttpProblem(404, 'NOT_FOUND', 'Analysis Recipe was not found');
      if (deleted === 'revision-conflict') {
        throw new HttpProblem(412, 'PRECONDITION_FAILED', 'Analysis Recipe revision changed');
      }
      return { deleted: true };
    });
  });

  app.get('/api/v2/analytics/jobs', async (request, reply) => {
    const query = request.query as { limit?: string };
    return send(reply, () => dependencies.jobs.list(parseLimit(query.limit)));
  });

  app.post('/api/v2/analytics/jobs', async (request, reply) => {
    return send(reply, async () => {
      const job = await dependencies.jobs.create(
        jobInput(request.body),
        requireIdempotencyKey(request),
      );
      reply.code(202);
      return job;
    });
  });

  app.get('/api/v2/analytics/jobs/:jobId', async (request, reply) => {
    return send(reply, async () => {
      const job = await dependencies.jobs.get(pathId(request, 'jobId'));
      if (!job) throw new HttpProblem(404, 'NOT_FOUND', 'Analysis Job was not found');
      return job;
    });
  });

  app.post('/api/v2/analytics/jobs/:jobId/cancel', async (request, reply) => {
    return send(reply, async () => {
      requireIdempotencyKey(request);
      const job = await dependencies.jobs.cancel(pathId(request, 'jobId'));
      if (!job) throw new HttpProblem(404, 'NOT_FOUND', 'Analysis Job was not found');
      reply.code(202);
      return job;
    });
  });

  app.post('/api/v2/analytics/jobs/:jobId/retry', async (request, reply) => {
    return send(reply, async () => {
      const job = await dependencies.jobs.retry(
        pathId(request, 'jobId'),
        requireIdempotencyKey(request),
      );
      reply.code(202);
      return job;
    });
  });

  app.get('/api/v2/analytics/results/:resultId', async (request, reply) => {
    return send(reply, async () => {
      const result = await dependencies.jobs.resultPreview(pathId(request, 'resultId'));
      if (!result) throw new HttpProblem(404, 'NOT_FOUND', 'Analysis Result was not found');
      reply.header('Cache-Control', 'no-store');
      return result;
    });
  });

  app.get(
    '/api/v2/analytics/results/:resultId/collections/:section/:collectionId',
    async (request, reply) =>
      send(reply, async () => {
        const section = pathId(request, 'section');
        if (section !== 'table' && section !== 'series')
          throw new HttpProblem(400, 'VALIDATION_ERROR', 'section must be table or series');
        const query = request.query as Record<string, unknown>;
        if (
          Object.keys(query).some((key) => !['limit', 'cursor'].includes(key)) ||
          (query.cursor !== undefined && typeof query.cursor !== 'string') ||
          (query.limit !== undefined && typeof query.limit !== 'string')
        )
          throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid result page query');
        const page = await dependencies.jobs.resultPage(
          pathId(request, 'resultId'),
          section,
          pathId(request, 'collectionId'),
          parseLimit(query.limit as string | undefined),
          query.cursor as string | undefined,
        );
        if (!page) throw new HttpProblem(404, 'NOT_FOUND', 'Result collection was not found');
        reply.header('Cache-Control', 'no-store');
        return page;
      }),
  );

  app.post('/api/v2/analytics/results/:resultId/branches', async (request, reply) =>
    send(reply, async () => {
      const body = request.body;
      if (!isObject(body) || Object.keys(body).length !== 1 || !isObject(body.parameters))
        throw new HttpProblem(400, 'VALIDATION_ERROR', 'Branch body must contain only parameters');
      const job = await dependencies.jobs.branch(
        pathId(request, 'resultId'),
        body.parameters,
        requireIdempotencyKey(request),
      );
      reply.code(202);
      return job;
    }),
  );

  app.get('/api/v2/analytics/results/:leftId/compare/:rightId', async (request, reply) =>
    send(reply, async () => {
      const comparison = await dependencies.jobs.compare(
        pathId(request, 'leftId'),
        pathId(request, 'rightId'),
      );
      reply.header('Cache-Control', 'no-store');
      return comparison;
    }),
  );

  app.post('/api/v2/analytics/results/:resultId/exports', async (request, reply) => {
    return send(reply, async () => {
      requireIdempotencyKey(request);
      const result = await dependencies.jobs.result(pathId(request, 'resultId'));
      if (!result) throw new HttpProblem(404, 'NOT_FOUND', 'Analysis Result was not found');
      if (!dependencies.artifactStore) return result;
      return idempotentMutation(
        dependencies.platform,
        `analytics:export:${result.id}`,
        requireIdempotencyKey(request),
        {},
        200,
        async () => {
          const store = dependencies.artifactStore!;
          const workspaceId = randomUUID();
          const filename = `analysis-${result.id}.json`;
          try {
            const workspace = await store.openWorkspace(workspaceId);
            await writeFile(await workspace.resolve(filename), JSON.stringify(result, null, 2));
            const stored = await store.commitWorkspaceFile(
              workspaceId,
              filename,
              `analytics-exports/${workspaceId}/${filename}`,
            );
            const artifact = await dependencies.platform.createArtifact({
              ownerPluginId: 'analytics',
              kind: 'analysis.export',
              filename,
              contentType: 'application/json',
              ...stored,
              metadata: { resultId: result.id, datasetId: result.datasetId },
            });
            return {
              ...result,
              artifacts: [
                ...result.artifacts,
                {
                  id: artifact.id,
                  filename: artifact.filename,
                  contentType: artifact.contentType,
                  kind: artifact.kind,
                },
              ],
            };
          } finally {
            await store.removeWorkspace(workspaceId);
          }
        },
      );
    });
  });
}

async function send(reply: FastifyReply, operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    const problem = toProblem(error);
    return reply
      .code(problem.status)
      .type('application/problem+json')
      .send({
        ...problem,
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

function toProblem(error: unknown) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let detail = 'Analytics request failed';
  if (error instanceof HttpProblem || error instanceof AnalysisResultQueryError)
    ({ status, code, message: detail } = error);
  else if (error instanceof AnalyticsUnavailableError) {
    status = 503;
    code = error.code;
    detail = error.message;
  } else if (error instanceof MethodNotFoundError) {
    status = 404;
    code = error.code;
    detail = error.message;
  } else if (error instanceof MethodCompatibilityError) {
    status = 422;
    code = error.code;
    detail = error.message;
  } else if (error instanceof AnalysisConflictError) {
    status = 409;
    code = error.code;
    detail = error.message;
  } else if (error instanceof Error) detail = error.message;
  return {
    type: `https://zhiyun.dev/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    title: code,
    status,
    code,
    detail,
  };
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
  if (reservation.state === 'conflict') {
    throw new AnalysisConflictError('Idempotency-Key was already used with another request');
  }
  if (reservation.state === 'pending') {
    throw new AnalysisConflictError('The original idempotent mutation is still pending');
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

function recipeInput(value: unknown): CreateAnalysisRecipeInput {
  if (!isObject(value)) throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid Recipe body');
  return value as unknown as CreateAnalysisRecipeInput;
}

function jobInput(value: unknown): CreateAnalysisJobInput {
  if (!isObject(value)) throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid Job body');
  return value as unknown as CreateAnalysisJobInput;
}

function pathId(request: FastifyRequest, name: string): string {
  const params = request.params as Record<string, unknown>;
  if (typeof params[name] !== 'string')
    throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid ID');
  return params[name];
}

function requireIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !value || value.length > 200) {
    throw new HttpProblem(400, 'VALIDATION_ERROR', 'Idempotency-Key is required');
  }
  return value;
}

function requireRevision(request: FastifyRequest): number {
  const value = request.headers['if-match'];
  const matched = typeof value === 'string' ? /^"([1-9]\d*)"$/.exec(value) : null;
  if (!matched) throw new HttpProblem(428, 'PRECONDITION_REQUIRED', 'If-Match is required');
  return Number(matched[1]);
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d{0,2}$/.test(value))
    throw new HttpProblem(400, 'VALIDATION_ERROR', 'limit must be between 1 and 200');
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw new HttpProblem(400, 'VALIDATION_ERROR', 'limit must be between 1 and 200');
  }
  return parsed;
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

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
