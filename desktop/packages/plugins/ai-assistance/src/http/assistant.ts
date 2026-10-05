import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RouteContribution } from '@zhiyun/kernel';
import type { PlatformRepository } from '@zhiyun/platform-core';
import {
  assistantActionSchema,
  assistantCapabilitiesSchema,
  assistantContextSchema,
  assistantCreateSchema,
  assistantDetailSchema,
  assistantLessonEventSchema,
  assistantLessonSchema,
  assistantPatchSchema,
  assistantTurnSchema,
  assistantMessageInputSchema,
  assistantConversationSchema,
} from '@zhiyun/contracts';
import { AssistantProblem, type AssistantService } from '../application/assistant.js';
import { assistantLessons } from '../knowledge/index.js';
import type { AssistantActor } from '../contracts/index.js';

const prepareSchema = z
  .object({
    kind: z.enum([
      'create_example',
      'save',
      'save_and_run',
      'run',
      'schedule',
      'retry_output',
      'export',
    ]),
    parameters: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
const emptySchema = z.object({}).strict();
const specs = [
  ['GET', '/capabilities', 'getAssistantCapabilities', null, assistantCapabilitiesSchema, false],
  [
    'GET',
    '/conversations',
    'listAssistantConversations',
    null,
    z.object({ items: z.array(assistantConversationSchema), nextCursor: z.string().nullable() }),
    false,
  ],
  [
    'POST',
    '/conversations',
    'createAssistantConversation',
    assistantCreateSchema,
    assistantDetailSchema,
    false,
  ],
  ['GET', '/conversations/{id}', 'getAssistantConversation', null, assistantDetailSchema, false],
  [
    'PATCH',
    '/conversations/{id}',
    'updateAssistantConversation',
    assistantPatchSchema,
    assistantDetailSchema,
    true,
  ],
  [
    'DELETE',
    '/conversations/{id}',
    'deleteAssistantConversation',
    null,
    z.object({ deleted: z.boolean() }),
    true,
  ],
  [
    'GET',
    '/conversations/{id}/messages',
    'listAssistantMessages',
    null,
    assistantDetailSchema,
    false,
  ],
  [
    'POST',
    '/conversations/{id}/messages',
    'postAssistantMessage',
    assistantMessageInputSchema,
    z.object({ turn: assistantTurnSchema }),
    false,
  ],
  [
    'PUT',
    '/conversations/{id}/context',
    'updateAssistantContext',
    assistantContextSchema,
    assistantDetailSchema,
    true,
  ],
  [
    'POST',
    '/conversations/{id}/actions',
    'prepareAssistantAction',
    prepareSchema,
    assistantActionSchema,
    false,
  ],
  [
    'POST',
    '/turns/{id}/cancel',
    'cancelAssistantTurn',
    emptySchema,
    z.object({ canceled: z.boolean() }),
    false,
  ],
  [
    'POST',
    '/turns/{id}/retry',
    'retryAssistantTurn',
    emptySchema,
    z.object({ turn: assistantTurnSchema }),
    false,
  ],
  ['GET', '/actions/{id}', 'getAssistantAction', null, assistantActionSchema, false],
  [
    'POST',
    '/actions/{id}/execute',
    'executeAssistantAction',
    emptySchema,
    assistantActionSchema,
    true,
  ],
  ['GET', '/lessons', 'listAssistantLessons', null, z.array(assistantLessonSchema), false],
  [
    'POST',
    '/conversations/{id}/lesson-progress',
    'updateAssistantLesson',
    assistantLessonEventSchema,
    assistantDetailSchema,
    true,
  ],
] as const;
export const assistantRoutes: readonly RouteContribution[] = specs.map(
  ([method, path, operationId]) => ({
    method,
    path: `/api/v2/assistant${path}`,
    operationId,
    requiredPermission: 'workspace.read',
  }),
);
export function assistantOpenApiPaths() {
  const paths: Record<string, Record<string, Record<string, unknown>>> = {};
  for (const [method, path, operationId, input, output, revision] of specs) {
    const parameters: unknown[] = path.includes('{id}')
      ? [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }]
      : [];
    if (method !== 'GET')
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: { type: 'string' },
      });
    if (revision)
      parameters.push({
        name: 'If-Match',
        in: 'header',
        required: true,
        schema: { type: 'string' },
      });
    if (operationId === 'listAssistantConversations')
      parameters.push(
        { name: 'cursor', in: 'query', schema: { type: 'string' } },
        { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
      );
    if (operationId === 'listAssistantMessages')
      parameters.push({ name: 'before', in: 'query', schema: { type: 'integer', minimum: 1 } });
    if (operationId === 'listAssistantLessons')
      parameters.push({ name: 'language', in: 'query', schema: { enum: ['zh', 'en'] } });
    const json = (schema: z.ZodType) => {
      const { $schema, ...result } = z.toJSONSchema(schema);
      void $schema;
      return result;
    };
    const status =
      operationId === 'createAssistantConversation'
        ? '201'
        : operationId === 'postAssistantMessage'
          ? '202'
          : '200';
    (paths[`/api/v2/assistant${path}`] ??= {})[method.toLowerCase()] = {
      operationId,
      tags: ['Assistant'],
      parameters,
      ...(input
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: json(input) } },
            },
          }
        : {}),
      responses: {
        [status]: {
          description: 'Success',
          content: { 'application/json': { schema: json(output) } },
        },
        default: {
          description: 'RFC 7807 problem',
          content: { 'application/problem+json': { schema: { type: 'object' } } },
        },
      },
    };
  }
  return paths;
}
export function assistantActor(request: FastifyRequest): AssistantActor {
  const value = request as FastifyRequest & {
    workspacePrincipal?: { userId?: string };
    workspacePermissions?: readonly string[];
  };
  return {
    id: value.workspacePrincipal?.userId ?? 'local-workspace',
    permissions:
      value.workspacePermissions ??
      (value.workspacePrincipal
        ? []
        : [
            'workspace.read',
            'workspace.manage',
            'task.write',
            'run.execute',
            'analysis.write',
            'output.bind',
            'output.manage',
          ]),
  };
}
function uuid(value: string) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function registerAssistantHttp(
  app: FastifyInstance,
  service: AssistantService,
  platform: PlatformRepository,
) {
  for (const [method, path, operationId, schema, , needsRevision] of specs) {
    app.route({
      method,
      url: `/api/v2/assistant${path.replaceAll('{id}', ':id')}`,
      handler: async (request, reply) => {
        const actor = assistantActor(request);
        try {
          const id = (request.params as { id?: string }).id ?? '';
          const query = request.query as {
            cursor?: string;
            limit?: string;
            before?: string;
            language?: string;
          };
          const body = schema ? schema.parse(request.body ?? {}) : {};
          const revision = needsRevision
            ? Number(String(request.headers['if-match'] ?? '').replaceAll('"', ''))
            : 0;
          if (needsRevision && (!Number.isInteger(revision) || revision < 1))
            throw new AssistantProblem(428, 'PRECONDITION_REQUIRED', 'If-Match is required');
          const key = request.headers['idempotency-key'];
          if (method !== 'GET' && (typeof key !== 'string' || !key || key.length > 200))
            throw new AssistantProblem(428, 'PRECONDITION_REQUIRED', 'Idempotency-Key is required');
          const deterministicId = uuid(`${actor.id}:${operationId}:${id}:${String(key)}`);
          const operation = async (): Promise<unknown> => {
            switch (operationId) {
              case 'getAssistantCapabilities':
                return service.capabilities(actor);
              case 'listAssistantConversations':
                return service.list(
                  actor,
                  query.cursor,
                  query.limit ? z.coerce.number().int().min(1).max(100).parse(query.limit) : 30,
                );
              case 'createAssistantConversation':
                return service.create(actor, body, deterministicId);
              case 'getAssistantConversation':
                return service.detail(actor, id);
              case 'updateAssistantConversation':
                return service.patch(actor, id, revision, body);
              case 'deleteAssistantConversation':
                return service.remove(actor, id, revision);
              case 'listAssistantMessages':
                return service.detail(
                  actor,
                  id,
                  query.before ? z.coerce.number().int().positive().parse(query.before) : undefined,
                );
              case 'postAssistantMessage':
                return service.post(
                  actor,
                  id,
                  (body as { content: string }).content,
                  deterministicId,
                  assistantMessageInputSchema.parse(body).costBudget,
                );
              case 'updateAssistantContext':
                return service.context(actor, id, revision, body);
              case 'prepareAssistantAction': {
                const value = prepareSchema.parse(body);
                return service.prepareAction(actor, id, value.kind, value.parameters);
              }
              case 'cancelAssistantTurn':
                return service.cancel(actor, id);
              case 'retryAssistantTurn':
                return service.retry(actor, id);
              case 'getAssistantAction':
                return service.action(actor, id);
              case 'executeAssistantAction':
                return service.execute(actor, id, revision);
              case 'listAssistantLessons':
                return assistantLessons(query.language === 'en' ? 'en' : 'zh');
              case 'updateAssistantLesson':
                return service.lesson(actor, id, revision, body);
            }
          };
          const status =
            operationId === 'createAssistantConversation'
              ? 201
              : operationId === 'postAssistantMessage'
                ? 202
                : 200;
          let result: unknown;
          if (method === 'GET' || operationId === 'executeAssistantAction')
            result = await operation();
          else {
            const scope = `assistant:${actor.id}:${operationId}:${id}`;
            const requestHash = createHash('sha256')
              .update(JSON.stringify({ body, revision }))
              .digest('hex');
            const reservation = await platform.reserveIdempotency({
              scope,
              key: String(key),
              requestHash,
              expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
            });
            if (reservation.state === 'completed') result = reservation.responseBody;
            else if (reservation.state !== 'reserved')
              throw new AssistantProblem(
                409,
                'IDEMPOTENCY_CONFLICT',
                'This request is already running or has different parameters.',
              );
            else {
              try {
                result = await operation();
                await platform.completeIdempotency({
                  scope,
                  key: String(key),
                  requestHash,
                  responseStatus: status,
                  responseBody: result,
                });
              } catch (error) {
                await platform.releaseIdempotency({ scope, key: String(key), requestHash });
                throw error;
              }
            }
          }
          const value = result as
            | {
                conversation?: { revision: number; context: { revision: number } };
                revision?: number;
              }
            | undefined;
          const nextRevision =
            operationId === 'updateAssistantContext'
              ? value?.conversation?.context.revision
              : (value?.conversation?.revision ?? value?.revision);
          if (nextRevision) reply.header('ETag', `"${nextRevision}"`);
          return reply.code(status).send(result);
        } catch (error) {
          const status =
            error instanceof AssistantProblem
              ? error.status
              : error instanceof z.ZodError
                ? 400
                : 422;
          const code =
            error instanceof AssistantProblem
              ? error.code
              : error instanceof z.ZodError
                ? 'VALIDATION_ERROR'
                : 'ASSISTANT_ERROR';
          return reply
            .code(status)
            .type('application/problem+json')
            .send({
              type: `urn:zhiyun:problem:${code}`,
              title: code,
              status,
              code,
              detail: error instanceof Error ? error.message : String(error),
              instance: request.url.split('?')[0],
              traceId: request.id,
            });
        }
      },
    });
  }
}
