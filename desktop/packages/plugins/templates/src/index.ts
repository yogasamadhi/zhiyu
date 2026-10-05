import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PluginDescriptor, RouteContribution } from '@zhiyun/kernel';
import type { PlatformRepository } from '@zhiyun/platform-core';

import {
  normalizeCrawlPlan,
  taskCreateSchema,
  type QualityPolicy,
  type TaskCreate,
  type CrawlPlanDefinition,
  type GeneratedBy,
  type TaskOrigin,
  type TaskTemplate,
} from '@zhiyun/shared';
import { getTaskTemplate, taskTemplateCatalog } from './catalog.js';
import {
  instantiateTaskTemplateDefinition,
  resolveTaskTemplateParameters,
} from './catalog-validation.js';

export const templateRoutes = [
  {
    operationId: 'listTaskTemplates',
    method: 'GET',
    path: '/api/v2/task-templates',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'getTaskTemplate',
    method: 'GET',
    path: '/api/v2/task-templates/{templateId}',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'instantiateTaskTemplate',
    method: 'POST',
    path: '/api/v2/task-templates/{templateId}/instantiate',
    requiredPermission: 'task.write',
  },
] as const satisfies readonly RouteContribution[];

export const templatesPlugin: PluginDescriptor = {
  id: 'templates',
  version: '1.0.0',
  dependencies: [{ id: 'collection', range: '^1.0.0' }],
  routes: templateRoutes,
  activate() {},
};

export interface TemplatesHttpDependencies {
  collection: {
    getTask(id: string): Promise<({ id: string } & Partial<TaskCreate>) | null>;
    deleteTask(id: string): Promise<boolean>;
    createTaskWithInitialRule(input: {
      taskId: string;
      ruleId: string;
      versionId: string;
      task: TaskCreate;
      definition: CrawlPlanDefinition;
      ruleName: string;
      generatedBy?: GeneratedBy;
      origin?: TaskOrigin;
      status?: 'draft' | 'ready';
    }): Promise<{ taskId: string; ruleId: string; versionId: string }>;
  };
  platform: PlatformRepository;
  protectTask(task: TaskCreate): Promise<TaskCreate>;
  verifyPreview(
    key: string,
    input: { task: TaskCreate; definition: CrawlPlanDefinition; limit: number },
  ): Promise<void>;
  quality?: { upsertPolicy(taskId: string, policy: QualityPolicy): Promise<QualityPolicy> };
}

export async function registerTemplatesHttp(
  app: FastifyInstance,
  dependencies: TemplatesHttpDependencies,
): Promise<void> {
  app.get('/api/v2/task-templates', async () => taskTemplateCatalog);
  app.get('/api/v2/task-templates/:templateId', async (request, reply) => {
    const template = getTaskTemplate(pathId(request, 'templateId'));
    if (!template) return problem(reply, 404, 'NOT_FOUND', 'Task Template was not found');
    return template;
  });
  app.post('/api/v2/task-templates/:templateId/instantiate', async (request, reply) => {
    const template = getTaskTemplate(pathId(request, 'templateId'));
    if (!template) return problem(reply, 404, 'NOT_FOUND', 'Task Template was not found');
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !key) {
      return problem(reply, 400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key is required');
    }
    const body = object(request.body);
    const scope = `templates:instantiate:${template.id}`;
    const requestHash = createHash('sha256')
      .update(canonicalJson({ templateId: template.id, body }))
      .digest('hex');
    const reservation = await dependencies.platform.reserveIdempotency({
      scope,
      key,
      requestHash,
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    if (reservation.state === 'conflict' || reservation.state === 'pending') {
      return problem(
        reply,
        409,
        'IDEMPOTENCY_CONFLICT',
        reservation.state === 'pending'
          ? 'The original template instantiation is still pending'
          : 'Idempotency-Key was already used with a different request',
      );
    }
    if (reservation.state === 'completed') {
      reply.code(reservation.responseStatus);
      return reservation.responseBody;
    }
    let createdTaskId: string | null = null;
    try {
      const parameters = object(body.parameters);
      resolveTaskTemplateParameters(template, parameters);
      const unprotectedTask = body.task
        ? taskCreateSchema.parse(body.task)
        : instantiateTask(template, body);
      const task = await dependencies.protectTask(unprotectedTask);
      const definition = body.definition
        ? normalizeCrawlPlan(body.definition)
        : instantiateTaskTemplateDefinition(template, parameters);
      const saveAsDraft = body.saveAsDraft === true;
      const previewKey =
        typeof body.previewKey === 'string' && body.previewKey
          ? body.previewKey
          : saveAsDraft
            ? null
            : (() => {
                throw new Error('A successful previewKey is required');
              })();
      const limit = body.limit === undefined ? 10 : Number(body.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
        throw new Error('Preview limit must be between 1 and 10');
      }
      if (previewKey) {
        await dependencies.verifyPreview(previewKey, {
          task,
          definition,
          limit,
        });
      }
      const ids = {
        taskId: deterministicUuid(`template:${template.id}:${key}:task`),
        ruleId: deterministicUuid(`template:${template.id}:${key}:rule`),
        versionId: deterministicUuid(`template:${template.id}:${key}:version`),
      };
      const existing = await dependencies.collection.getTask(ids.taskId);
      const created = existing
        ? { taskId: existing.id }
        : await dependencies.collection.createTaskWithInitialRule({
            ...ids,
            task,
            ruleName: `${template.name}规则`,
            definition,
            generatedBy: 'system',
            origin: {
              kind: 'template',
              templateId: template.id,
              templateVersion: template.version,
            },
            status: saveAsDraft ? 'draft' : 'ready',
          });
      if (!existing) createdTaskId = created.taskId;
      if (template.qualityPolicy && dependencies.quality) {
        await dependencies.quality.upsertPolicy(created.taskId, template.qualityPolicy);
      }
      const detail = await dependencies.collection.getTask(created.taskId);
      if (!detail) throw new Error('Instantiated task could not be loaded');
      await dependencies.platform.completeIdempotency({
        scope,
        key,
        requestHash,
        responseStatus: 201,
        responseBody: detail,
      });
      reply.code(201);
      return detail;
    } catch (error) {
      if (createdTaskId) {
        await dependencies.collection.deleteTask(createdTaskId).catch(() => false);
      }
      await dependencies.platform
        .releaseIdempotency({ scope, key, requestHash })
        .catch(() => false);
      return problem(
        reply,
        400,
        'VALIDATION_ERROR',
        error instanceof Error ? error.message : 'Template parameters are invalid',
      );
    }
  });
}

function instantiateTask(template: TaskTemplate, body: Record<string, unknown>): TaskCreate {
  return taskCreateSchema.parse({
    ...template.taskDefaults,
    name: typeof body.name === 'string' && body.name.trim() ? body.name : template.name,
    startUrl: body.startUrl,
    instruction:
      typeof body.instruction === 'string' && body.instruction.trim()
        ? body.instruction
        : (template.taskDefaults.instruction ?? template.description),
    ...(body.schedule ? { schedule: body.schedule } : {}),
  });
}

function deterministicUuid(input: string): string {
  const hex = createHash('sha256').update(input).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function pathId(request: FastifyRequest, name: string): string {
  return String((request.params as Record<string, unknown>)[name] ?? '');
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function problem(reply: FastifyReply, status: number, code: string, detail: string) {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({
      type: `https://zhiyun.local/problems/${code.toLowerCase()}`,
      title: code,
      status,
      detail,
      instance: reply.request.url,
      code,
      traceId: String(reply.getHeader('x-trace-id') ?? ''),
    });
}

export { getTaskTemplate, taskTemplateCatalog } from './catalog.js';
export {
  instantiateTaskTemplateDefinition,
  resolveTaskTemplateParameters,
  validateTaskTemplateCatalog,
} from './catalog-validation.js';
