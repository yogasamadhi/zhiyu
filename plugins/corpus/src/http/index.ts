import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PlatformRepository } from '@zhiyun/platform-core';
import {
  CorpusBuildError,
  CorpusConflictError,
  CorpusUnavailableError,
} from '../application/index.js';
import type {
  CorpusBuildService,
  CorpusRecipeService,
  CorpusService,
} from '../application/index.js';
import type {
  CreateCorpusBuildInput,
  CreateCorpusInput,
  CreateCorpusRecipeInput,
} from '../contracts/index.js';

export interface CorpusHttpDependencies {
  corpora: CorpusService;
  recipes: CorpusRecipeService;
  builds: CorpusBuildService;
  platform: PlatformRepository;
}

export async function registerCorpusHttp(
  app: FastifyInstance,
  dependencies: CorpusHttpDependencies,
): Promise<void> {
  app.get('/api/v2/corpora', async (request, reply) => {
    const query = request.query as { cursor?: string; limit?: string };
    return send(reply, () => dependencies.corpora.list(query.cursor, parseLimit(query.limit)));
  });

  app.post('/api/v2/corpora', async (request, reply) => {
    return send(reply, async () => {
      const corpus = await idempotentMutation(
        dependencies.platform,
        'corpus:create',
        requireIdempotencyKey(request),
        request.body,
        201,
        () => dependencies.corpora.create(corpusInput(request.body)),
      );
      reply.code(201).header('etag', `"${corpus.revision}"`);
      return corpus;
    });
  });

  app.get('/api/v2/corpora/:corpusId', async (request, reply) => {
    return send(reply, async () => {
      const corpus = await dependencies.corpora.get(pathId(request, 'corpusId'));
      if (!corpus) throw new HttpProblem(404, 'NOT_FOUND', 'Corpus was not found');
      reply.header('etag', `"${corpus.revision}"`);
      return corpus;
    });
  });

  app.put('/api/v2/corpora/:corpusId', async (request, reply) => {
    return send(reply, async () => {
      const id = pathId(request, 'corpusId');
      const revision = requireRevision(request);
      const updated = await idempotentMutation(
        dependencies.platform,
        `corpus:update:${id}`,
        requireIdempotencyKey(request),
        { revision, body: request.body },
        200,
        () => dependencies.corpora.update(id, revision, corpusInput(request.body)),
      );
      if (updated === null) throw new HttpProblem(404, 'NOT_FOUND', 'Corpus was not found');
      if (updated === 'revision-conflict') {
        throw new HttpProblem(412, 'PRECONDITION_FAILED', 'Corpus revision changed');
      }
      reply.header('etag', `"${updated.revision}"`);
      return updated;
    });
  });

  app.delete('/api/v2/corpora/:corpusId', async (request, reply) => {
    return send(reply, async () => {
      const id = pathId(request, 'corpusId');
      const revision = requireRevision(request);
      const deleted = await idempotentMutation(
        dependencies.platform,
        `corpus:delete:${id}`,
        requireIdempotencyKey(request),
        { revision },
        200,
        () => dependencies.corpora.delete(id, revision),
      );
      if (deleted === false) throw new HttpProblem(404, 'NOT_FOUND', 'Corpus was not found');
      if (deleted === 'revision-conflict') {
        throw new HttpProblem(412, 'PRECONDITION_FAILED', 'Corpus revision changed');
      }
      return { deleted: true };
    });
  });

  app.get('/api/v2/corpora/:corpusId/recipes', async (request, reply) => {
    return send(reply, () => dependencies.recipes.list(pathId(request, 'corpusId')));
  });

  app.post('/api/v2/corpora/:corpusId/recipes', async (request, reply) => {
    return send(reply, async () => {
      const corpusId = pathId(request, 'corpusId');
      const recipe = await idempotentMutation(
        dependencies.platform,
        `corpus:create-recipe:${corpusId}`,
        requireIdempotencyKey(request),
        request.body,
        201,
        () => dependencies.recipes.create(corpusId, recipeInput(request.body)),
      );
      reply.code(201).header('etag', `"${recipe.revision}"`);
      return recipe;
    });
  });

  app.put('/api/v2/corpora/:corpusId/recipes/:recipeId', async (request, reply) => {
    return send(reply, async () => {
      const corpusId = pathId(request, 'corpusId');
      const recipeId = pathId(request, 'recipeId');
      const revision = requireRevision(request);
      const updated = await idempotentMutation(
        dependencies.platform,
        `corpus:update-recipe:${recipeId}`,
        requireIdempotencyKey(request),
        { revision, body: request.body },
        200,
        () => dependencies.recipes.update(corpusId, recipeId, revision, recipeInput(request.body)),
      );
      if (updated === null) throw new HttpProblem(404, 'NOT_FOUND', 'Corpus Recipe was not found');
      if (updated === 'revision-conflict') {
        throw new HttpProblem(412, 'PRECONDITION_FAILED', 'Corpus Recipe revision changed');
      }
      reply.header('etag', `"${updated.revision}"`);
      return updated;
    });
  });

  app.delete('/api/v2/corpora/:corpusId/recipes/:recipeId', async (request, reply) => {
    return send(reply, async () => {
      const corpusId = pathId(request, 'corpusId');
      const recipeId = pathId(request, 'recipeId');
      const revision = requireRevision(request);
      const deleted = await idempotentMutation(
        dependencies.platform,
        `corpus:delete-recipe:${recipeId}`,
        requireIdempotencyKey(request),
        { revision },
        200,
        () => dependencies.recipes.delete(corpusId, recipeId, revision),
      );
      if (deleted === false) {
        throw new HttpProblem(404, 'NOT_FOUND', 'Corpus Recipe was not found');
      }
      if (deleted === 'revision-conflict') {
        throw new HttpProblem(412, 'PRECONDITION_FAILED', 'Corpus Recipe revision changed');
      }
      return { deleted: true };
    });
  });

  app.post('/api/v2/corpora/:corpusId/builds', async (request, reply) => {
    return send(reply, async () => {
      const build = await dependencies.builds.create(
        pathId(request, 'corpusId'),
        buildInput(request.body),
        requireIdempotencyKey(request),
      );
      reply.code(202);
      return build;
    });
  });

  app.get('/api/v2/corpus-builds', async (request, reply) => {
    const query = request.query as { corpusId?: string; limit?: string };
    return send(reply, () => dependencies.builds.list(query.corpusId, parseLimit(query.limit)));
  });

  app.get('/api/v2/corpus-builds/:buildId', async (request, reply) => {
    return send(reply, async () => {
      const build = await dependencies.builds.get(pathId(request, 'buildId'));
      if (!build) throw new HttpProblem(404, 'NOT_FOUND', 'Corpus Build was not found');
      return build;
    });
  });

  app.post('/api/v2/corpus-builds/:buildId/cancel', async (request, reply) => {
    return send(reply, async () => {
      requireIdempotencyKey(request);
      const build = await dependencies.builds.cancel(pathId(request, 'buildId'));
      if (!build) throw new HttpProblem(404, 'NOT_FOUND', 'Corpus Build was not found');
      reply.code(202);
      return build;
    });
  });

  app.post('/api/v2/corpus-builds/:buildId/retry', async (request, reply) => {
    return send(reply, async () => {
      const build = await dependencies.builds.retry(
        pathId(request, 'buildId'),
        requireIdempotencyKey(request),
      );
      reply.code(202);
      return build;
    });
  });

  app.get('/api/v2/corpora/:corpusId/versions', async (request, reply) => {
    const query = request.query as { limit?: string };
    return send(reply, () =>
      dependencies.builds.listVersions(pathId(request, 'corpusId'), parseLimit(query.limit)),
    );
  });

  app.get('/api/v2/corpora/:corpusId/versions/:versionId', async (request, reply) => {
    return send(reply, async () => {
      const version = await dependencies.builds.getVersion(pathId(request, 'versionId'));
      if (!version || version.corpusId !== pathId(request, 'corpusId')) {
        throw new HttpProblem(404, 'NOT_FOUND', 'Corpus Version was not found');
      }
      return version;
    });
  });

  app.post('/api/v2/corpora/:corpusId/versions/:versionId/exports', async (request, reply) => {
    return send(reply, async () => {
      requireIdempotencyKey(request);
      const version = await dependencies.builds.getVersion(pathId(request, 'versionId'));
      if (!version || version.corpusId !== pathId(request, 'corpusId')) {
        throw new HttpProblem(404, 'NOT_FOUND', 'Corpus Version was not found');
      }
      return { versionId: version.id, artifacts: version.artifacts };
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
  let detail = 'Corpus request failed';
  if (error instanceof HttpProblem) ({ status, code, message: detail } = error);
  else if (error instanceof CorpusUnavailableError) {
    status = 503;
    code = error.code;
    detail = error.message;
  } else if (error instanceof CorpusConflictError) {
    status = 409;
    code = error.code;
    detail = error.message;
  } else if (error instanceof CorpusBuildError) {
    status = 422;
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
    throw new CorpusConflictError('Idempotency-Key was already used with another request');
  }
  if (reservation.state === 'pending') {
    throw new CorpusConflictError('The original idempotent mutation is still pending');
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

function corpusInput(value: unknown): CreateCorpusInput {
  if (!isObject(value)) throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid Corpus body');
  return value as unknown as CreateCorpusInput;
}

function recipeInput(value: unknown): CreateCorpusRecipeInput {
  if (!isObject(value)) throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid Recipe body');
  return value as unknown as CreateCorpusRecipeInput;
}

function buildInput(value: unknown): CreateCorpusBuildInput {
  if (!isObject(value)) throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid Build body');
  return value as unknown as CreateCorpusBuildInput;
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
  const match = typeof value === 'string' ? /^"?(\d+)"?$/.exec(value) : null;
  if (!match) throw new HttpProblem(428, 'PRECONDITION_REQUIRED', 'If-Match is required');
  return Number(match[1]);
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid list limit');
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
