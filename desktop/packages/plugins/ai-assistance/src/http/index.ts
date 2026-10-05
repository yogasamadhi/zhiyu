import { assistantRoutes } from './assistant.js';
import { z } from 'zod';
export * from './assistant.js';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContribution } from '@zhiyun/kernel';
import type { PlatformRepository } from '@zhiyun/platform-core';
import { normalizeCrawlPlan, taskCreateSchema } from '@zhiyun/contracts';
import type { AiAssistanceServiceContract } from '../contracts/index.js';
import type { CrawlerAssistantService } from '../application/crawler-assistant.js';
import type { AiProviderSettingsService } from '../application/provider-settings.js';
import { redactAiSensitiveText } from '../domain/index.js';

export const aiAssistanceRoutes = [
  ...assistantRoutes,
  {
    operationId: 'clearRuleCache',
    method: 'POST',
    path: '/api/v2/rules/cache/clear',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'analyzeDraftTaskRule',
    method: 'POST',
    path: '/api/v2/rules/analyze',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'analyzeTaskRule',
    method: 'POST',
    path: '/api/v2/tasks/{taskId}/rule-analysis',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'explainRunFailure',
    method: 'POST',
    path: '/api/v2/runs/{runId}/explain-failure',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'extractTaskWithAi',
    method: 'POST',
    path: '/api/v2/tasks/{taskId}/ai/extract',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'extractDraftTaskWithAi',
    method: 'POST',
    path: '/api/v2/rules/ai-extract',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'createRuleRepairProposal',
    method: 'POST',
    path: '/api/v2/tasks/{taskId}/rules/{ruleId}/repair-proposals',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'testRuleRepairProposal',
    method: 'POST',
    path: '/api/v2/tasks/{taskId}/rules/{ruleId}/repair-proposals/{proposalId}/test',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'applyRuleRepairProposal',
    method: 'POST',
    path: '/api/v2/tasks/{taskId}/rules/{ruleId}/repair-proposals/{proposalId}/apply',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'rejectRuleRepairProposal',
    method: 'POST',
    path: '/api/v2/tasks/{taskId}/rules/{ruleId}/repair-proposals/{proposalId}/reject',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'listCrawlerAssistantConversations',
    method: 'GET',
    path: '/api/v2/crawler-assistant/conversations',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'createCrawlerAssistantConversation',
    method: 'POST',
    path: '/api/v2/crawler-assistant/conversations',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'getCrawlerAssistantConversation',
    method: 'GET',
    path: '/api/v2/crawler-assistant/conversations/{id}',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'deleteCrawlerAssistantConversation',
    method: 'DELETE',
    path: '/api/v2/crawler-assistant/conversations/{id}',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'listCrawlerAssistantMessages',
    method: 'GET',
    path: '/api/v2/crawler-assistant/conversations/{id}/messages',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'postCrawlerAssistantMessage',
    method: 'POST',
    path: '/api/v2/crawler-assistant/conversations/{id}/messages',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'selectCrawlerAssistantSite',
    method: 'POST',
    path: '/api/v2/crawler-assistant/conversations/{id}/site-selection',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'testCrawlerAssistantDraft',
    method: 'POST',
    path: '/api/v2/crawler-assistant/conversations/{id}/draft/test',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'commitCrawlerAssistantDraft',
    method: 'POST',
    path: '/api/v2/crawler-assistant/conversations/{id}/commit',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'cancelCrawlerAssistantTurn',
    method: 'POST',
    path: '/api/v2/crawler-assistant/turns/{id}/cancel',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'retryCrawlerAssistantTurn',
    method: 'POST',
    path: '/api/v2/crawler-assistant/turns/{id}/retry',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'getAiProviderSettings',
    method: 'GET',
    path: '/api/v2/ai/provider',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'updateAiProviderSettings',
    method: 'PUT',
    path: '/api/v2/ai/provider',
    requiredPermission: 'output.manage',
  },
  {
    operationId: 'promptAiProviderCredential',
    method: 'POST',
    path: '/api/v2/ai/provider/credential/prompt',
    requiredPermission: 'output.manage',
  },
  {
    operationId: 'deleteAiProviderCredential',
    method: 'DELETE',
    path: '/api/v2/ai/provider/credential',
    requiredPermission: 'output.manage',
  },
  {
    operationId: 'testAiProviderSettings',
    method: 'POST',
    path: '/api/v2/ai/provider/test',
    requiredPermission: 'output.manage',
  },
] as const satisfies readonly RouteContribution[];

export interface AiAssistanceHttpDependencies {
  service: AiAssistanceServiceContract;
  platform: PlatformRepository;
  crawlerAssistant?: CrawlerAssistantService;
  providerSettings?: AiProviderSettingsService;
}

export async function registerAiAssistanceHttp(
  app: FastifyInstance,
  dependencies: AiAssistanceHttpDependencies,
): Promise<void> {
  app.post('/api/v2/rules/analyze', async (request, reply) =>
    send(reply, async () => {
      const body = isObject(request.body) ? request.body : {};
      return dependencies.service.analyzeDraftTaskRule(taskCreateSchema.parse(body.task), {
        useAi: body.useAi !== false,
        forceBrowser: body.forceBrowser === true,
        ...(body.cacheScope !== undefined
          ? { cacheScope: z.string().uuid().parse(body.cacheScope) }
          : {}),
      });
    }),
  );
  app.post('/api/v2/tasks/:taskId/rule-analysis', async (request, reply) =>
    send(reply, async () => {
      const body = isObject(request.body) ? request.body : {};
      return dependencies.service.analyzeTaskRule(pathId(request, 'taskId'), {
        useAi: body.useAi !== false,
        forceBrowser: body.forceBrowser === true,
      });
    }),
  );
  app.post('/api/v2/rules/cache/clear', async (request, reply) =>
    send(reply, async () => {
      const input = z
        .object({ taskId: z.string().uuid().optional(), cacheScope: z.string().uuid().optional() })
        .strict()
        .refine(
          (value) => Boolean(value.taskId) !== Boolean(value.cacheScope),
          'Choose one task or draft cache scope',
        )
        .parse(request.body);
      const target = input.taskId ? { taskId: input.taskId } : { cacheScope: input.cacheScope! };
      return idempotentMutation(
        dependencies.platform,
        'ai-assistance:clear-rule-cache',
        requireIdempotencyKey(request),
        target,
        200,
        () => dependencies.service.clearRuleCache(target),
      );
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
  app.post('/api/v2/rules/ai-extract', async (request, reply) =>
    send(reply, async () => {
      const body = isObject(request.body) ? request.body : {};
      return dependencies.service.extractDraftTask(taskCreateSchema.parse(body.task), {
        definition: normalizeCrawlPlan(body.definition),
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

  if (dependencies.crawlerAssistant) {
    const assistant = dependencies.crawlerAssistant;
    app.get('/api/v2/crawler-assistant/conversations', async (request, reply) =>
      send(reply, () => {
        const query = isObject(request.query) ? request.query : {};
        return assistant.listConversations(
          typeof query.cursor === 'string' ? query.cursor : undefined,
          typeof query.limit === 'string' ? Number(query.limit) : undefined,
        );
      }),
    );
    app.post('/api/v2/crawler-assistant/conversations', async (request, reply) =>
      send(reply, async () => {
        const body = isObject(request.body) ? request.body : {};
        const result = await idempotentMutation(
          dependencies.platform,
          'crawler-assistant:create-conversation',
          requireIdempotencyKey(request),
          body,
          201,
          () =>
            assistant.createConversation(
              typeof body.title === 'string' ? body.title.slice(0, 120) : undefined,
              typeof body.collectionDraftId === 'string' ? body.collectionDraftId : undefined,
            ),
        );
        reply.code(201).header('etag', revisionEtag(result.draft.revision));
        return result;
      }),
    );
    app.get('/api/v2/crawler-assistant/conversations/:id', async (request, reply) =>
      send(reply, async () => {
        const result = await assistant.getConversation(pathId(request, 'id'));
        if (result.draft) reply.header('etag', revisionEtag(result.draft.revision));
        return result;
      }),
    );
    app.delete('/api/v2/crawler-assistant/conversations/:id', async (request, reply) =>
      send(reply, async () => {
        const query = isObject(request.query) ? request.query : {};
        const archive = query.archive === 'true';
        return idempotentMutation(
          dependencies.platform,
          `crawler-assistant:${archive ? 'archive' : 'delete'}:${pathId(request, 'id')}`,
          requireIdempotencyKey(request),
          { archive },
          200,
          async () =>
            archive
              ? assistant.archiveConversation(pathId(request, 'id'))
              : { deleted: await assistant.deleteConversation(pathId(request, 'id')) },
        );
      }),
    );
    app.get('/api/v2/crawler-assistant/conversations/:id/messages', async (request, reply) =>
      send(reply, async () => (await assistant.getConversation(pathId(request, 'id'))).messages),
    );
    app.post('/api/v2/crawler-assistant/conversations/:id/messages', async (request, reply) =>
      send(reply, async () => {
        const body = objectBody(request.body);
        if (
          typeof body.content !== 'string' ||
          !body.content.trim() ||
          body.content.length > 8_000
        ) {
          throw new HttpProblem(400, 'VALIDATION_ERROR', 'Message content is required');
        }
        const result = await idempotentMutation(
          dependencies.platform,
          `crawler-assistant:message:${pathId(request, 'id')}`,
          requireIdempotencyKey(request),
          body,
          202,
          () => assistant.postMessage(pathId(request, 'id'), body.content as string),
        );
        reply.code(202);
        return result;
      }),
    );
    app.post('/api/v2/crawler-assistant/conversations/:id/site-selection', async (request, reply) =>
      send(reply, async () => {
        const body = objectBody(request.body);
        if (typeof body.url !== 'string')
          throw new HttpProblem(400, 'VALIDATION_ERROR', 'URL is required');
        const revision = requireIfMatch(request);
        const result = await idempotentMutation(
          dependencies.platform,
          `crawler-assistant:site-selection:${pathId(request, 'id')}`,
          requireIdempotencyKey(request),
          { ...body, revision },
          202,
          () => assistant.selectSite(pathId(request, 'id'), body.url as string, revision),
        );
        reply.code(202).header('etag', revisionEtag(result.draft.revision));
        return result;
      }),
    );
    app.post('/api/v2/crawler-assistant/conversations/:id/draft/test', async (request, reply) =>
      send(reply, async () => {
        const revision = requireIfMatch(request);
        const result = await idempotentMutation(
          dependencies.platform,
          `crawler-assistant:test:${pathId(request, 'id')}`,
          requireIdempotencyKey(request),
          { revision },
          200,
          () => assistant.testDraft(pathId(request, 'id'), revision),
        );
        reply.header('etag', revisionEtag(result.revision));
        return result;
      }),
    );
    app.post('/api/v2/crawler-assistant/conversations/:id/commit', async (request, reply) =>
      send(reply, async () => {
        const revision = requireIfMatch(request);
        return idempotentMutation(
          dependencies.platform,
          `crawler-assistant:commit:${pathId(request, 'id')}`,
          requireIdempotencyKey(request),
          { revision },
          201,
          async () => {
            const result = await assistant.commit(pathId(request, 'id'), revision);
            reply.code(result.replayed ? 200 : 201);
            return result;
          },
        );
      }),
    );
    app.post('/api/v2/crawler-assistant/turns/:id/cancel', async (request, reply) =>
      send(reply, () =>
        idempotentMutation(
          dependencies.platform,
          `crawler-assistant:cancel:${pathId(request, 'id')}`,
          requireIdempotencyKey(request),
          {},
          200,
          () => assistant.cancelTurn(pathId(request, 'id')),
        ),
      ),
    );
    app.post('/api/v2/crawler-assistant/turns/:id/retry', async (request, reply) =>
      send(reply, async () => {
        const result = await idempotentMutation(
          dependencies.platform,
          `crawler-assistant:retry:${pathId(request, 'id')}`,
          requireIdempotencyKey(request),
          {},
          202,
          () => assistant.retryTurn(pathId(request, 'id')),
        );
        reply.code(202);
        return result;
      }),
    );
  }

  if (dependencies.providerSettings) {
    const settings = dependencies.providerSettings;
    app.get('/api/v2/ai/provider', async (_request, reply) =>
      send(reply, async () => {
        const result = await settings.view();
        reply.header('etag', revisionEtag(result.revision));
        return result;
      }),
    );
    app.put('/api/v2/ai/provider', async (request, reply) =>
      send(reply, async () => {
        const body = objectBody(request.body);
        if (typeof body.providerId !== 'string' || typeof body.model !== 'string') {
          throw new HttpProblem(400, 'VALIDATION_ERROR', 'Provider and model are required');
        }
        const revision = requireIfMatch(request);
        const result = await idempotentMutation(
          dependencies.platform,
          'ai-provider:update',
          requireIdempotencyKey(request),
          { providerId: body.providerId, model: body.model, revision },
          200,
          () =>
            settings.update(
              { providerId: body.providerId as string, model: body.model as string },
              revision,
            ),
        );
        reply.header('etag', revisionEtag(result.revision));
        return result;
      }),
    );
    app.post('/api/v2/ai/provider/credential/prompt', async (request, reply) =>
      send(reply, async () => {
        const result = await idempotentMutation(
          dependencies.platform,
          'ai-provider:credential-prompt',
          requireIdempotencyKey(request),
          { revision: requireIfMatch(request) },
          200,
          () => settings.promptCredential(requireIfMatch(request)),
        );
        if ('revision' in result) reply.header('etag', revisionEtag(result.revision));
        return result;
      }),
    );
    app.delete('/api/v2/ai/provider/credential', async (request, reply) =>
      send(reply, async () => {
        const revision = requireIfMatch(request);
        const result = await idempotentMutation(
          dependencies.platform,
          'ai-provider:credential-delete',
          requireIdempotencyKey(request),
          { revision },
          200,
          () => settings.deleteCredential(revision),
        );
        reply.header('etag', revisionEtag(result.revision));
        return result;
      }),
    );
    app.post('/api/v2/ai/provider/test', async (request, reply) =>
      send(reply, () => {
        const body = objectBody(request.body);
        if (typeof body.providerId !== 'string' || typeof body.model !== 'string') {
          throw new HttpProblem(400, 'VALIDATION_ERROR', 'Provider and model are required');
        }
        return idempotentMutation(
          dependencies.platform,
          'ai-provider:test',
          requireIdempotencyKey(request),
          body,
          200,
          () =>
            settings.test({
              providerId: body.providerId as string,
              model: body.model as string,
            }),
        );
      }),
    );
  }
}

async function send(reply: FastifyReply, operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    const message = redactAiSensitiveText(
      error instanceof Error ? error.message : 'AI Assistance request failed',
    );
    const status =
      error instanceof HttpProblem
        ? error.status
        : message.includes('not found')
          ? 404
          : /already reviewed|must be tested|No candidate/.test(message)
            ? 409
            : /stale|If-Match|revision/.test(message)
              ? 412
              : /not configured|AI_PROVIDER_NOT_CONFIGURED|read-only/.test(message)
                ? 503
                : 422;
    const code =
      error instanceof HttpProblem
        ? error.code
        : status === 404
          ? 'NOT_FOUND'
          : status === 409
            ? 'CONFLICT'
            : status === 412
              ? 'PRECONDITION_FAILED'
              : status === 503
                ? 'AI_PROVIDER_UNAVAILABLE'
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

function requireIfMatch(request: FastifyRequest): number {
  const value = request.headers['if-match'];
  if (typeof value !== 'string') {
    throw new HttpProblem(428, 'PRECONDITION_REQUIRED', 'If-Match is required');
  }
  const match = value.match(/^(?:W\/)?"?(\d+)"?$/);
  const revision = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(revision) || revision < 1) {
    throw new HttpProblem(400, 'VALIDATION_ERROR', 'If-Match must contain a Draft revision');
  }
  return revision;
}

function revisionEtag(revision: number): string {
  return `"${revision}"`;
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
