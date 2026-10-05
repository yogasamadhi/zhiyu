import { z } from 'zod';
import { validateCrawlPlan } from '@zhiyun/extraction';
import { draftRoutes, registerDraftHttp } from './drafts.js';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContribution } from '@zhiyun/kernel';
import type { PlatformJobQueue, PlatformRepository } from '@zhiyun/platform-core';
import type { CredentialStore, HostCapabilities } from '@zhiyun/contracts';
import {
  normalizeCrawlPlan,
  buildRunDiagnostics,
  inspectionStepInputSchema,
  ruleDefinitionInputSchema,
  scheduleSchema,
  taskCreateSchema,
  taskUpdateSchema,
  type GeneratedBy,
  type BrowserActionCacheBinding,
  type CrawlPlanDefinition,
  type InspectionElementSelection,
  type InspectionStepInput,
  type InspectionStepResult,
  type TaskCreate,
  type TaskCredentialBindings,
  type TaskUpdate,
} from '@zhiyun/shared';
import { previewSchedule } from '../application/index.js';
import type { CollectionRepository, CollectionTaskDetail } from '../contracts/index.js';

export const collectionRoutes = [
  ...draftRoutes,
  {
    operationId: 'previewSchedule',
    method: 'POST',
    path: '/api/v2/schedules/preview',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'previewInitialRule',
    method: 'POST',
    path: '/api/v2/rules/preview',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'createTaskWithInitialRule',
    method: 'POST',
    path: '/api/v2/tasks/initialize',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'listTasks',
    method: 'GET',
    path: '/api/v2/tasks',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'createTask',
    method: 'POST',
    path: '/api/v2/tasks',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'getTask',
    method: 'GET',
    path: '/api/v2/tasks/{taskId}',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'updateTask',
    method: 'PUT',
    path: '/api/v2/tasks/{taskId}',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'deleteTask',
    method: 'DELETE',
    path: '/api/v2/tasks/{taskId}',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'listRules',
    method: 'GET',
    path: '/api/v2/tasks/{taskId}/rules',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'testRule',
    method: 'POST',
    path: '/api/v2/tasks/{taskId}/rules/test',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'createRule',
    method: 'POST',
    path: '/api/v2/tasks/{taskId}/rules',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'createRuleVersion',
    method: 'POST',
    path: '/api/v2/tasks/{taskId}/rules/{ruleId}/versions',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'diffRuleVersions',
    method: 'GET',
    path: '/api/v2/tasks/{taskId}/rules/{ruleId}/diff',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'rollbackRuleVersion',
    method: 'POST',
    path: '/api/v2/tasks/{taskId}/rules/{ruleId}/rollback',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'listRuleRepairProposals',
    method: 'GET',
    path: '/api/v2/tasks/{taskId}/rules/{ruleId}/repair-proposals',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'startTaskLoginSession',
    method: 'POST',
    path: '/api/v2/tasks/{taskId}/browser-session/login',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'promptTaskCredential',
    method: 'POST',
    path: '/api/v2/tasks/{taskId}/credentials/{kind}',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'deleteTaskCredential',
    method: 'DELETE',
    path: '/api/v2/tasks/{taskId}/credentials/{kind}',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'listRuns',
    method: 'GET',
    path: '/api/v2/tasks/{taskId}/runs',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'createRun',
    method: 'POST',
    path: '/api/v2/tasks/{taskId}/runs',
    requiredPermission: 'run.execute',
  },
  {
    operationId: 'getRun',
    method: 'GET',
    path: '/api/v2/runs/{runId}',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'cancelRun',
    method: 'POST',
    path: '/api/v2/runs/{runId}/cancel',
    requiredPermission: 'run.execute',
  },
  {
    operationId: 'retryRun',
    method: 'POST',
    path: '/api/v2/runs/{runId}/retry',
    requiredPermission: 'run.execute',
  },
  {
    operationId: 'listRunLogs',
    method: 'GET',
    path: '/api/v2/runs/{runId}/logs',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'listRunRequests',
    method: 'GET',
    path: '/api/v2/runs/{runId}/requests',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'getRunDiagnostics',
    method: 'GET',
    path: '/api/v2/runs/{runId}/diagnostics',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'clearRunDiagnostics',
    method: 'DELETE',
    path: '/api/v2/runs/{runId}/diagnostics',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'createInspectionSession',
    method: 'POST',
    path: '/api/v2/inspection-sessions',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'getInspectionScreenshot',
    method: 'GET',
    path: '/api/v2/inspection-sessions/{sessionId}/screenshot',
    requiredPermission: 'workspace.read',
  },
  {
    operationId: 'interactWithInspection',
    method: 'POST',
    path: '/api/v2/inspection-sessions/{sessionId}/actions',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'selectInspectionElement',
    method: 'POST',
    path: '/api/v2/inspection-sessions/{sessionId}/select',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'closeInspectionSession',
    method: 'DELETE',
    path: '/api/v2/inspection-sessions/{sessionId}',
    requiredPermission: 'task.write',
  },
] as const satisfies readonly RouteContribution[];

export interface CollectionTaskBindingsPort {
  list(taskId: string): Promise<string[]>;
  replace(taskId: string, destinationIds: readonly string[]): Promise<void>;
  clear(taskId: string): Promise<void>;
}

export interface CollectionTaskCleanupPort {
  clearTask(taskId: string): Promise<void>;
}

export interface CollectionInspectionPort {
  create(task: CollectionTaskDetail): Promise<{ id: string; url: string; expiresAt: string }>;
  screenshot(id: string): Promise<{ url: string; image: string; width: number; height: number }>;
  action(
    id: string,
    input: { type: 'click' | 'scroll' | 'refresh'; x?: number; y?: number; deltaY?: number },
  ): Promise<{ url: string }>;
  step(id: string, input: InspectionStepInput): Promise<InspectionStepResult>;
  select(id: string, x: number, y: number): Promise<InspectionElementSelection | null>;
  close(id: string): Promise<boolean>;
}

export interface CollectionHttpDependencies {
  repository: CollectionRepository;
  platform: PlatformRepository;
  jobs: PlatformJobQueue;
  bindings?: CollectionTaskBindingsPort;
  cleanup?: readonly CollectionTaskCleanupPort[];
  batches?: {
    reconcileRun(runId: string): Promise<void>;
    reconcileTask(taskId: string): Promise<void>;
  };
  credentialStore: CredentialStore;
  runtimeMode: 'desktop' | 'headless';
  promptCredential?: HostCapabilities['promptCredential'];
  createLoginSession?: HostCapabilities['createLoginSession'];
  inspection?: CollectionInspectionPort;
  previewRule?(
    task: CollectionTaskDetail,
    definition: CrawlPlanDefinition,
    limit: number,
    cacheBinding?: BrowserActionCacheBinding,
  ): Promise<unknown>;
}

export async function registerCollectionHttp(
  app: FastifyInstance,
  dependencies: CollectionHttpDependencies,
): Promise<void> {
  await registerDraftHttp(app, dependencies);
  app.post('/api/v2/schedules/preview', async (request, reply) =>
    send(reply, async () => {
      const parsed = scheduleSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid schedule');
      }
      try {
        return { nextRuns: previewSchedule(parsed.data, 5) };
      } catch (error) {
        throw new HttpProblem(
          400,
          'VALIDATION_ERROR',
          error instanceof Error ? error.message : 'Invalid schedule',
        );
      }
    }),
  );
  app.get('/api/v2/tasks', async (request, reply) =>
    send(reply, async () => {
      const query = z
        .object({
          cursor: z.string().optional(),
          limit: z.string().optional(),
          query: z.string().max(500).optional(),
          status: z.enum(['draft', 'ready', 'running', 'succeeded', 'failed', 'paused']).optional(),
          sort: z.enum(['name', 'updatedAt', 'createdAt']).optional(),
          direction: z.enum(['asc', 'desc']).optional(),
          includeManaged: z.enum(['true', 'false']).optional(),
        })
        .parse(request.query);
      const page = await dependencies.repository.listTasks(query.cursor, parseLimit(query.limit), {
        ...(query.query ? { query: query.query } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.sort ? { sort: query.sort } : {}),
        ...(query.direction ? { direction: query.direction } : {}),
        ...(query.includeManaged ? { includeManaged: query.includeManaged === 'true' } : {}),
      });
      return {
        ...page,
        items: await Promise.all(page.items.map((task) => taskView(task, dependencies.bindings))),
      };
    }),
  );
  app.post('/api/v2/inspection-sessions', async (request, reply) =>
    send(reply, async () => {
      if (!dependencies.inspection) {
        throw new HttpProblem(503, 'BROWSER_MISSING', 'Browser inspection is unavailable');
      }
      const body = objectBody(request.body);
      if (typeof body.draftId === 'string') {
        const draft = await dependencies.repository.getDraft(body.draftId);
        if (!draft) throw new HttpProblem(404, 'NOT_FOUND', 'Draft was not found');
        if (draft.exampleId)
          throw new HttpProblem(
            400,
            'EXAMPLE_INSPECTION_UNAVAILABLE',
            'Use the built-in example fields and preview',
          );
        const config = taskCreateSchema.parse({
          ...draft.task,
          name: draft.task.name || 'Inspection',
          instruction: draft.task.instruction || 'Select fields',
        });
        reply.code(201);
        return dependencies.inspection.create({
          ...config,
          id: draft.id,
          revision: draft.revision,
          origin: { kind: 'manual' },
          status: 'draft',
          activeRule: null,
          createdAt: draft.createdAt,
          updatedAt: draft.updatedAt,
        });
      }
      if (typeof body.taskId !== 'string') {
        throw new HttpProblem(400, 'VALIDATION_ERROR', 'taskId is required');
      }
      const task = await dependencies.repository.getTask(body.taskId);
      if (!task) throw new HttpProblem(404, 'NOT_FOUND', 'Collection Task was not found');
      reply.code(201);
      return dependencies.inspection.create(task);
    }),
  );
  app.get('/api/v2/inspection-sessions/:sessionId/screenshot', async (request, reply) =>
    send(reply, () => requireInspection(dependencies).screenshot(pathId(request, 'sessionId'))),
  );
  app.post('/api/v2/inspection-sessions/:sessionId/actions', async (request, reply) =>
    send(reply, async () => {
      const body = objectBody(request.body);
      if ('stepIndex' in body || 'action' in body) {
        const parsed = inspectionStepInputSchema.safeParse(body);
        if (!parsed.success) {
          throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid browser action step');
        }
        return requireInspection(dependencies).step(pathId(request, 'sessionId'), parsed.data);
      }
      if (body.type !== 'click' && body.type !== 'scroll' && body.type !== 'refresh') {
        throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid inspection action');
      }
      const x = numberValue(body.x);
      const y = numberValue(body.y);
      const deltaY = numberValue(body.deltaY);
      return requireInspection(dependencies).action(pathId(request, 'sessionId'), {
        type: body.type,
        ...(x === undefined ? {} : { x }),
        ...(y === undefined ? {} : { y }),
        ...(deltaY === undefined ? {} : { deltaY }),
      });
    }),
  );
  app.post('/api/v2/inspection-sessions/:sessionId/select', async (request, reply) =>
    send(reply, async () => {
      const body = objectBody(request.body);
      const x = numberValue(body.x);
      const y = numberValue(body.y);
      if (x === undefined || y === undefined) {
        throw new HttpProblem(400, 'VALIDATION_ERROR', 'x and y are required');
      }
      const selected = await requireInspection(dependencies).select(
        pathId(request, 'sessionId'),
        x,
        y,
      );
      if (!selected) throw new HttpProblem(404, 'NOT_FOUND', 'No element exists at this point');
      return selected;
    }),
  );
  app.delete('/api/v2/inspection-sessions/:sessionId', async (request, reply) =>
    send(reply, async () => {
      const closed = await requireInspection(dependencies).close(pathId(request, 'sessionId'));
      if (!closed) throw new HttpProblem(404, 'NOT_FOUND', 'Inspection session was not found');
      reply.code(204);
      return undefined;
    }),
  );
  app.post('/api/v2/rules/preview', async (request, reply) =>
    send(reply, async () => {
      if (!dependencies.previewRule) {
        throw new HttpProblem(501, 'CAPABILITY_UNAVAILABLE', 'Rule preview is not configured');
      }
      const key = requireIdempotencyKey(request);
      const input = initialRuleInput(request.body);
      const previewInput = { task: input.task, definition: input.definition, limit: input.limit };
      return idempotentMutation(
        dependencies.platform,
        'collection:preview-initial-rule',
        key,
        previewInput,
        200,
        async () => {
          const { outputBindings: _outputBindings, ...task } = input.task;
          void _outputBindings;
          const timestamp = new Date().toISOString();
          const result = await dependencies.previewRule?.(
            {
              ...task,
              id: deterministicUuid(`initial-preview:${key}`),
              status: 'draft',
              origin: { kind: 'manual' },
              revision: 0,
              createdAt: timestamp,
              updatedAt: timestamp,
              activeRule: null,
            },
            input.definition,
            input.limit,
          );
          return {
            ...(isObject(result) ? result : { result }),
            previewKey: key,
          };
        },
      );
    }),
  );
  app.post('/api/v2/tasks/initialize', async (request, reply) =>
    send(reply, async () => {
      const body = objectBody(request.body);
      const input = initialRuleInput(body);
      const runAfterCreate = body.runAfterCreate === true;
      const saveAsDraft = body.saveAsDraft === true;
      if (saveAsDraft && runAfterCreate) {
        throw new HttpProblem(
          400,
          'VALIDATION_ERROR',
          'A draft cannot be run until its current rule passes preview',
        );
      }
      const previewKey =
        body.previewKey === undefined ? null : stringValue(body.previewKey, 'previewKey');
      if (!saveAsDraft) {
        if (!previewKey) {
          throw new HttpProblem(
            409,
            'SUCCESSFUL_PREVIEW_REQUIRED',
            'A successful preview is required before creating a ready task',
          );
        }
        await verifyInitialRulePreview(dependencies.platform, previewKey, input);
      }
      const creationKey = requireIdempotencyKey(request);
      const result = await idempotentMutation(
        dependencies.platform,
        'collection:create-task-with-initial-rule',
        creationKey,
        { ...input, previewKey, runAfterCreate, saveAsDraft },
        201,
        async () => {
          const { outputBindings, ...collectionTask } = await protectTaskCredentials(
            input.task,
            dependencies,
          );
          const ids = {
            taskId: deterministicUuid(`manual:${creationKey}:task`),
            ruleId: deterministicUuid(`manual:${creationKey}:rule`),
            versionId: deterministicUuid(`manual:${creationKey}:version`),
          };
          await dependencies.repository.createTaskWithInitialRule({
            ...ids,
            task: { ...collectionTask, outputBindings: [] },
            ruleName: input.ruleName,
            definition: input.definition,
            generatedBy: 'human',
            origin: { kind: 'manual' },
            status: saveAsDraft ? 'draft' : 'ready',
          });
          await dependencies.bindings?.replace(ids.taskId, outputBindings);
          const task = await dependencies.repository.getTask(ids.taskId);
          if (!task) throw new Error('Initial task creation did not persist the task');
          const run = runAfterCreate ? await dependencies.repository.createRun(ids.taskId) : null;
          if (run) await enqueueRun(dependencies.jobs, run.id, ids.taskId);
          return { task: await taskView(task, dependencies.bindings), run };
        },
      );
      reply.code(201);
      return result;
    }),
  );
  app.post('/api/v2/tasks', async (request, reply) =>
    send(reply, async () => {
      const input = taskCreateSchema.parse(request.body);
      const task = await idempotentMutation(
        dependencies.platform,
        'collection:create-task',
        requireIdempotencyKey(request),
        input,
        201,
        async () => {
          const { outputBindings, ...collectionInput } = await protectTaskCredentials(
            input,
            dependencies,
          );
          const created = await dependencies.repository.createTask(collectionInput);
          await dependencies.bindings?.replace(created.id, outputBindings);
          return created;
        },
      );
      reply.code(201).header('etag', `"${task.revision}"`);
      return taskView(task, dependencies.bindings);
    }),
  );
  app.get('/api/v2/tasks/:taskId', async (request, reply) =>
    send(reply, async () => {
      const task = await dependencies.repository.getTask(pathId(request, 'taskId'));
      if (!task) throw new HttpProblem(404, 'NOT_FOUND', 'Collection Task was not found');
      reply.header('etag', `"${task.revision}"`);
      return taskView(task, dependencies.bindings);
    }),
  );
  app.put('/api/v2/tasks/:taskId', async (request, reply) =>
    send(reply, async () => {
      const id = pathId(request, 'taskId');
      const input = taskUpdateSchema.parse(request.body);
      const revision = requireRevision(request);
      const updated = await idempotentMutation(
        dependencies.platform,
        `collection:update-task:${id}`,
        requireIdempotencyKey(request),
        { revision, input },
        200,
        async () => {
          const current = await dependencies.repository.getTask(id);
          if (!current) throw new HttpProblem(404, 'NOT_FOUND', 'Collection Task was not found');
          const { outputBindings, ...collectionInput } = await protectTaskCredentials(
            input,
            dependencies,
            current.credentialBindings,
          );
          const result = await dependencies.repository.updateTask(id, collectionInput, revision);
          if (result) {
            if (outputBindings) await dependencies.bindings?.replace(id, outputBindings);
            await deleteCredentialRefs(
              dependencies.credentialStore,
              current.credentialBindings,
              result.credentialBindings,
            );
          }
          return result;
        },
      );
      if (!updated) throw new HttpProblem(412, 'PRECONDITION_FAILED', 'Task revision changed');
      reply.header('etag', `"${updated.revision}"`);
      return taskView(updated, dependencies.bindings);
    }),
  );
  app.delete('/api/v2/tasks/:taskId', async (request, reply) =>
    send(reply, async () => {
      const id = pathId(request, 'taskId');
      const task = await dependencies.repository.getTask(id);
      if (!task) throw new HttpProblem(404, 'NOT_FOUND', 'Collection Task was not found');
      if (task.revision !== requireRevision(request)) {
        throw new HttpProblem(412, 'PRECONDITION_FAILED', 'Task revision changed');
      }
      requireIdempotencyKey(request);
      await dependencies.bindings?.clear(id);
      for (const cleanup of dependencies.cleanup ?? []) await cleanup.clearTask(id);
      if (!(await dependencies.repository.deleteTask(id, task.revision)))
        throw new HttpProblem(412, 'PRECONDITION_FAILED', 'Task revision changed');
      await dependencies.batches?.reconcileTask(id);
      await deleteCredentialRefs(dependencies.credentialStore, task.credentialBindings);
      reply.code(204);
      return undefined;
    }),
  );
  app.get('/api/v2/tasks/:taskId/rules', async (request, reply) =>
    send(reply, () => dependencies.repository.listRules(pathId(request, 'taskId'))),
  );
  app.post('/api/v2/tasks/:taskId/rules/test', async (request, reply) =>
    send(reply, async () => {
      const body = objectBody(request.body);
      if (!dependencies.previewRule) {
        throw new HttpProblem(501, 'CAPABILITY_UNAVAILABLE', 'Rule preview is not configured');
      }
      const task = await dependencies.repository.getTask(pathId(request, 'taskId'));
      if (!task) throw new HttpProblem(404, 'NOT_FOUND', 'Collection Task was not found');
      const limit = body.limit === undefined ? 10 : Number(body.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
        throw new HttpProblem(400, 'VALIDATION_ERROR', 'Preview limit must be between 1 and 10');
      }
      return dependencies.previewRule(task, normalizeCrawlPlan(body.definition), limit);
    }),
  );
  app.post('/api/v2/tasks/:taskId/rules', async (request, reply) =>
    send(reply, async () => {
      const body = objectBody(request.body);
      if (typeof body.name !== 'string' || !body.name.trim()) {
        throw new HttpProblem(400, 'VALIDATION_ERROR', 'Rule name is required');
      }
      const taskId = pathId(request, 'taskId');
      const input = {
        name: body.name.trim(),
        definition: ruleDefinitionInputSchema.parse(body.definition),
        generatedBy: generatedBy(body.generatedBy),
      };
      validateCrawlPlan(normalizeCrawlPlan(input.definition));
      const created = await idempotentMutation(
        dependencies.platform,
        `collection:create-rule:${taskId}`,
        requireIdempotencyKey(request),
        input,
        201,
        () =>
          dependencies.repository.createRule(
            taskId,
            input.name,
            input.definition,
            input.generatedBy,
          ),
      );
      reply.code(201);
      return created;
    }),
  );
  app.post('/api/v2/tasks/:taskId/rules/:ruleId/versions', async (request, reply) =>
    send(reply, async () => {
      const body = objectBody(request.body);
      const taskId = pathId(request, 'taskId');
      const ruleId = pathId(request, 'ruleId');
      const input = {
        definition: ruleDefinitionInputSchema.parse(body.definition),
        generatedBy: generatedBy(body.generatedBy),
      };
      validateCrawlPlan(normalizeCrawlPlan(input.definition));
      const version = await idempotentMutation(
        dependencies.platform,
        `collection:create-rule-version:${ruleId}`,
        requireIdempotencyKey(request),
        input,
        201,
        () =>
          dependencies.repository.createRuleVersion(
            taskId,
            ruleId,
            input.definition,
            input.generatedBy,
          ),
      );
      if (!version) throw new HttpProblem(404, 'NOT_FOUND', 'Rule was not found');
      reply.code(201);
      return version;
    }),
  );
  app.get('/api/v2/tasks/:taskId/rules/:ruleId/diff', async (request, reply) =>
    send(reply, async () => {
      const taskId = pathId(request, 'taskId');
      const ruleId = pathId(request, 'ruleId');
      const query = request.query as { from?: string; to?: string };
      const from = positiveInteger(query.from, 'from');
      const to = positiveInteger(query.to, 'to');
      const rule = (await dependencies.repository.listRules(taskId)).find(
        (candidate) => candidate.id === ruleId,
      );
      const before = rule?.versions.find((version) => version.version === from);
      const after = rule?.versions.find((version) => version.version === to);
      if (!before || !after) {
        throw new HttpProblem(404, 'NOT_FOUND', 'Rule version was not found');
      }
      return {
        from: before,
        to: after,
        changes: definitionDiff(before.definition, after.definition),
      };
    }),
  );
  app.post('/api/v2/tasks/:taskId/rules/:ruleId/rollback', async (request, reply) =>
    send(reply, async () => {
      const taskId = pathId(request, 'taskId');
      const ruleId = pathId(request, 'ruleId');
      const body = objectBody(request.body);
      const version = positiveInteger(body.version, 'version');
      const rule = (await dependencies.repository.listRules(taskId)).find(
        (candidate) => candidate.id === ruleId,
      );
      const target = rule?.versions.find((candidate) => candidate.version === version);
      if (!target) throw new HttpProblem(404, 'NOT_FOUND', 'Rule version was not found');
      const created = await idempotentMutation(
        dependencies.platform,
        `collection:rollback-rule:${ruleId}`,
        requireIdempotencyKey(request),
        { version },
        201,
        () => dependencies.repository.createRuleVersion(taskId, ruleId, target.definition, 'human'),
      );
      reply.code(201);
      return created;
    }),
  );
  app.get('/api/v2/tasks/:taskId/rules/:ruleId/repair-proposals', async (request, reply) =>
    send(reply, () => dependencies.repository.listRuleRepairProposals(pathId(request, 'ruleId'))),
  );
  app.post('/api/v2/tasks/:taskId/browser-session/login', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const id = pathId(request, 'taskId');
      const task = await dependencies.repository.getTask(id);
      if (!task) throw new HttpProblem(404, 'NOT_FOUND', 'Collection Task was not found');
      if (!dependencies.createLoginSession) {
        throw new HttpProblem(409, 'CONFLICT', 'Controlled login is unavailable');
      }
      const body = request.body === undefined ? {} : objectBody(request.body);
      const loginUrl = typeof body.loginUrl === 'string' ? body.loginUrl : task.startUrl;
      const result = await dependencies.createLoginSession(loginUrl);
      if ('canceled' in result) return result;
      const updated = await dependencies.repository.updateTask(
        id,
        {
          credentialBindings: {
            ...task.credentialBindings,
            browserStorageStateRef: result.reference,
          },
          browserSettings: { ...task.browserSettings, enabled: true },
        },
        task.revision,
      );
      if (!updated) {
        await dependencies.credentialStore.delete(result.reference).catch(() => undefined);
        throw new HttpProblem(412, 'PRECONDITION_FAILED', 'Task changed during login');
      }
      await deleteCredentialRefs(
        dependencies.credentialStore,
        task.credentialBindings,
        updated.credentialBindings,
      );
      return { canceled: false, reference: result.reference, task: updated };
    }),
  );
  app.post('/api/v2/tasks/:taskId/credentials/:kind', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const id = pathId(request, 'taskId');
      const kind = credentialKind(pathId(request, 'kind'));
      const body = objectBody(request.body);
      if (!Number.isInteger(body.revision) || Number(body.revision) < 1) {
        throw new HttpProblem(400, 'VALIDATION_ERROR', 'Task revision is required');
      }
      const task = await dependencies.repository.getTask(id);
      if (!task) throw new HttpProblem(404, 'NOT_FOUND', 'Collection Task was not found');
      if (task.revision !== body.revision) {
        throw new HttpProblem(412, 'PRECONDITION_FAILED', 'Task revision changed');
      }
      if (!dependencies.promptCredential) {
        throw new HttpProblem(409, 'CONFLICT', 'Host credential prompt is unavailable');
      }
      const prompted = await dependencies.promptCredential(hostCredentialKind[kind]);
      if ('canceled' in prompted) return prompted;
      const updated = await dependencies.repository.updateTask(
        id,
        {
          credentialBindings: {
            ...task.credentialBindings,
            [credentialBindingKey[kind]]: prompted.reference,
          },
        },
        task.revision,
      );
      if (!updated) {
        await dependencies.credentialStore.delete(prompted.reference).catch(() => undefined);
        throw new HttpProblem(412, 'PRECONDITION_FAILED', 'Task changed during credential input');
      }
      await deleteCredentialRefs(
        dependencies.credentialStore,
        task.credentialBindings,
        updated.credentialBindings,
      );
      return { canceled: false, task: updated };
    }),
  );
  app.delete('/api/v2/tasks/:taskId/credentials/:kind', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const id = pathId(request, 'taskId');
      const kind = credentialKind(pathId(request, 'kind'));
      const body = objectBody(request.body);
      if (!Number.isInteger(body.revision) || Number(body.revision) < 1) {
        throw new HttpProblem(400, 'VALIDATION_ERROR', 'Task revision is required');
      }
      const task = await dependencies.repository.getTask(id);
      if (!task) throw new HttpProblem(404, 'NOT_FOUND', 'Collection Task was not found');
      if (task.revision !== body.revision) {
        throw new HttpProblem(412, 'PRECONDITION_FAILED', 'Task revision changed');
      }
      const bindings = { ...task.credentialBindings };
      delete bindings[credentialBindingKey[kind]];
      const updated = await dependencies.repository.updateTask(
        id,
        { credentialBindings: bindings },
        task.revision,
      );
      if (!updated) throw new HttpProblem(412, 'PRECONDITION_FAILED', 'Task revision changed');
      await deleteCredentialRefs(
        dependencies.credentialStore,
        task.credentialBindings,
        updated.credentialBindings,
      );
      return updated;
    }),
  );
  app.get('/api/v2/tasks/:taskId/runs', async (request, reply) =>
    send(reply, async () => ({
      items: await dependencies.repository.listRuns(pathId(request, 'taskId')),
      nextCursor: null,
    })),
  );
  app.post('/api/v2/tasks/:taskId/runs', async (request, reply) =>
    send(reply, async () => {
      const taskId = pathId(request, 'taskId');
      const run = await idempotentMutation(
        dependencies.platform,
        `collection:create-run:${taskId}`,
        requireIdempotencyKey(request),
        {},
        202,
        async () => {
          if (!(await dependencies.repository.getActiveRule(taskId))) {
            throw new HttpProblem(409, 'CONFLICT', 'Task does not have an active Rule');
          }
          const created = await dependencies.repository.createRun(taskId);
          await enqueueRun(dependencies.jobs, created.id, taskId);
          return created;
        },
      );
      reply.code(202);
      return { runId: run.id, status: run.status };
    }),
  );
  app.get('/api/v2/runs/:runId', async (request, reply) =>
    send(reply, async () => {
      const run = await dependencies.repository.getRun(pathId(request, 'runId'));
      if (!run) throw new HttpProblem(404, 'NOT_FOUND', 'Collection Run was not found');
      return run;
    }),
  );
  app.post('/api/v2/runs/:runId/cancel', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const id = pathId(request, 'runId');
      const run = await dependencies.repository.requestRunCancellation(id);
      if (!run) throw new HttpProblem(404, 'NOT_FOUND', 'Collection Run was not found');
      if (dependencies.batches) await dependencies.batches.reconcileRun(id);
      else {
        const job = await dependencies.jobs.get(id);
        if (
          job?.ownerPluginId === 'collection' &&
          job.type === 'collection.crawl.execute' &&
          job.payload.runId === id &&
          job.payload.taskId === run.taskId
        )
          await dependencies.jobs.cancel(id);
      }
      reply.code(202);
      return (await dependencies.repository.getRun(id)) ?? run;
    }),
  );
  app.post('/api/v2/runs/:runId/retry', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const original = await dependencies.repository.getRun(pathId(request, 'runId'));
      if (!original) throw new HttpProblem(404, 'NOT_FOUND', 'Collection Run was not found');
      if (!['failed', 'canceled'].includes(original.status)) {
        throw new HttpProblem(409, 'CONFLICT', 'Only failed or canceled Runs can be retried');
      }
      const run = await dependencies.repository.createRun(original.taskId);
      await enqueueRun(dependencies.jobs, run.id, run.taskId);
      reply.code(202);
      return { runId: run.id, status: run.status };
    }),
  );
  app.get('/api/v2/runs/:runId/logs', async (request, reply) =>
    send(reply, async () => {
      const query = request.query as { cursor?: string; limit?: string };
      const items = await dependencies.repository.listRunLogs(
        pathId(request, 'runId'),
        query.cursor ? Number(query.cursor) : undefined,
        parseLimit(query.limit),
      );
      return { items, nextCursor: items.at(-1)?.sequence ? String(items.at(-1)!.sequence) : null };
    }),
  );
  app.get('/api/v2/runs/:runId/requests', async (request, reply) =>
    send(reply, () => {
      const query = request.query as { cursor?: string; limit?: string };
      return dependencies.repository.listRunRequests(
        pathId(request, 'runId'),
        query.cursor,
        parseLimit(query.limit),
      );
    }),
  );
  app.get('/api/v2/runs/:runId/diagnostics', async (request, reply) =>
    send(reply, async () => {
      const run = await dependencies.repository.getRun(pathId(request, 'runId'));
      if (!run) throw new HttpProblem(404, 'NOT_FOUND', 'Collection Run was not found');
      const logs = await dependencies.repository.getRunDiagnosticLogs(run.id);
      reply.header('Cache-Control', 'no-store');
      return buildRunDiagnostics(run, logs.items, logs.stepCount);
    }),
  );
  app.delete('/api/v2/runs/:runId/diagnostics', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const run = await dependencies.repository.getRun(pathId(request, 'runId'));
      if (!run) throw new HttpProblem(404, 'NOT_FOUND', 'Collection Run was not found');
      if (['queued', 'running'].includes(run.status))
        throw new HttpProblem(
          409,
          'CONFLICT',
          'Finish or cancel the run before clearing diagnostics',
        );
      return {
        runId: run.id,
        deletedSteps: await dependencies.repository.clearRunDiagnostics(run.id),
      };
    }),
  );
}

export async function enqueueRun(jobs: PlatformJobQueue, runId: string, taskId: string) {
  await jobs.enqueue({
    id: runId,
    ownerPluginId: 'collection',
    type: 'collection.crawl.execute',
    resourceClass: 'browser-heavy',
    payload: { taskId, runId },
    maxAttempts: 2,
  });
}

export async function taskView(
  task: object & { id: string },
  bindings: CollectionTaskBindingsPort | undefined,
) {
  return { ...task, outputBindings: (await bindings?.list(task.id)) ?? [] };
}

export async function idempotentMutation<T>(
  platform: PlatformRepository,
  scope: string,
  key: string,
  body: unknown,
  responseStatus: number,
  operation: () => Promise<T>,
): Promise<T> {
  const requestHash = createHash('sha256').update(canonicalJson(body)).digest('hex');
  let reservation = await platform.reserveIdempotency({
    scope,
    key,
    requestHash,
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
  for (let probe = 0; reservation.state === 'pending' && probe < 40; probe++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    reservation = await platform.reserveIdempotency({
      scope,
      key,
      requestHash,
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
  }
  if (reservation.state === 'conflict' || reservation.state === 'pending') {
    throw new HttpProblem(409, 'IDEMPOTENCY_CONFLICT', 'Idempotent mutation conflicts');
  }
  if (reservation.state === 'completed') return reservation.responseBody as T;
  try {
    const response = await operation();
    await platform.completeIdempotency({
      scope,
      key,
      requestHash,
      responseStatus,
      responseBody: response,
    });
    return response;
  } catch (error) {
    await platform.releaseIdempotency({ scope, key, requestHash });
    throw error;
  }
}

export async function send(
  reply: FastifyReply,
  operation: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    const status = error instanceof HttpProblem ? error.status : 400;
    const code = error instanceof HttpProblem ? error.code : 'VALIDATION_ERROR';
    const detail = error instanceof Error ? error.message : 'Collection request failed';
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

export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function pathId(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string' || !value)
    throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid ID');
  return value;
}

export function requireIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || !value || value.length > 200) {
    throw new HttpProblem(428, 'PRECONDITION_REQUIRED', 'Idempotency-Key is required');
  }
  return value;
}

export function requireRevision(request: FastifyRequest): number {
  const value = request.headers['if-match'];
  const match = typeof value === 'string' ? /^"([1-9]\d*)"$/.exec(value) : null;
  if (!match) throw new HttpProblem(428, 'PRECONDITION_REQUIRED', 'If-Match is required');
  return Number(match[1]);
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000) {
    throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid list limit');
  }
  return parsed;
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new HttpProblem(400, 'VALIDATION_ERROR', `${name} must be a positive integer`);
  }
  return parsed;
}

function definitionDiff(
  before: unknown,
  after: unknown,
  path = '',
): Array<{ path: string; before: unknown; after: unknown }> {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (isObject(before) && isObject(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      definitionDiff(before[key], after[key], `${path}/${key}`),
    );
  }
  return [{ path: path || '/', before, after }];
}

function generatedBy(value: unknown): GeneratedBy {
  if (value === undefined) return 'human';
  if (value === 'human' || value === 'ai' || value === 'system') return value;
  throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid generatedBy value');
}

const credentialBindingKey = {
  secretHeaders: 'secretHeadersRef',
  cookies: 'cookiesRef',
  proxy: 'proxyRef',
} as const;

const hostCredentialKind = {
  secretHeaders: 'task-secret-headers',
  cookies: 'task-cookies',
  proxy: 'task-proxy',
} as const;

function credentialKind(value: string): keyof typeof credentialBindingKey {
  if (value === 'secretHeaders' || value === 'cookies' || value === 'proxy') return value;
  throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid credential kind');
}

export type TaskCredentialProtectionDependencies = Pick<
  CollectionHttpDependencies,
  'credentialStore' | 'runtimeMode'
>;

export async function protectTaskCredentials<T extends TaskCreate | TaskUpdate>(
  input: T,
  dependencies: TaskCredentialProtectionDependencies,
  currentBindings: TaskCredentialBindings = {},
): Promise<T> {
  const bindings: TaskCredentialBindings = { ...currentBindings, ...input.credentialBindings };
  const protectedInput: TaskCreate | TaskUpdate = { ...input };
  const sensitiveHeaderNames = new Set(['authorization', 'cookie', 'proxy-authorization']);
  const containsSensitiveHeader = Object.keys(input.requestSettings?.headers ?? {}).some((name) =>
    sensitiveHeaderNames.has(name.toLowerCase()),
  );
  if (
    dependencies.runtimeMode === 'desktop' &&
    (containsSensitiveHeader ||
      Boolean(input.requestSettings?.cookies.length) ||
      Boolean(input.requestSettings?.proxy) ||
      Boolean(input.browserSettings?.storageState))
  ) {
    throw new HttpProblem(
      422,
      'CREDENTIAL_ERROR',
      'Desktop credentials must be entered in a Host-owned secure window',
    );
  }
  if (input.requestSettings) {
    const secretHeaders: Record<string, string> = {};
    const publicHeaders = Object.fromEntries(
      Object.entries(input.requestSettings.headers).filter(([name, value]) => {
        if (sensitiveHeaderNames.has(name.toLowerCase())) {
          secretHeaders[name] = value;
          return false;
        }
        return true;
      }),
    );
    if (Object.keys(secretHeaders).length) {
      bindings.secretHeadersRef = await dependencies.credentialStore.put(
        'task-secret-headers',
        secretHeaders,
      );
    }
    if (input.requestSettings.cookies.length) {
      bindings.cookiesRef = await dependencies.credentialStore.put(
        'task-cookies',
        input.requestSettings.cookies,
      );
    }
    if (input.requestSettings.proxy) {
      bindings.proxyRef = await dependencies.credentialStore.put(
        'task-proxy',
        input.requestSettings.proxy,
      );
    }
    const requestSettings = { ...input.requestSettings };
    delete requestSettings.proxy;
    protectedInput.requestSettings = { ...requestSettings, headers: publicHeaders, cookies: [] };
  }
  if (input.browserSettings?.storageState) {
    bindings.browserStorageStateRef = await dependencies.credentialStore.put(
      'browser-storage-state',
      input.browserSettings.storageState,
    );
    const browserSettings = { ...input.browserSettings };
    delete browserSettings.storageState;
    protectedInput.browserSettings = browserSettings;
  }
  protectedInput.credentialBindings = bindings;
  return protectedInput as T;
}

async function deleteCredentialRefs(
  store: CredentialStore,
  bindings: TaskCredentialBindings,
  except: TaskCredentialBindings = {},
): Promise<void> {
  const retained = new Set(Object.values(except).filter(Boolean));
  await Promise.all(
    Object.values(bindings)
      .filter((reference): reference is string => Boolean(reference) && !retained.has(reference))
      .map((reference) => store.delete(reference).catch(() => undefined)),
  );
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new HttpProblem(400, 'VALIDATION_ERROR', 'Invalid request body');
  return value;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function requireInspection(dependencies: CollectionHttpDependencies): CollectionInspectionPort {
  if (!dependencies.inspection) {
    throw new HttpProblem(503, 'BROWSER_MISSING', 'Browser inspection is unavailable');
  }
  return dependencies.inspection;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function initialRuleInput(value: unknown): {
  task: TaskCreate;
  definition: CrawlPlanDefinition;
  ruleName: string;
  limit: number;
} {
  const body = objectBody(value);
  const task = taskCreateSchema.parse(body.task);
  const definition = normalizeCrawlPlan(body.definition);
  validateCrawlPlan(definition);
  const ruleName =
    typeof body.ruleName === 'string' && body.ruleName.trim()
      ? body.ruleName.trim().slice(0, 200)
      : 'Default rule';
  const limit = body.limit === undefined ? 10 : Number(body.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new HttpProblem(400, 'VALIDATION_ERROR', 'Preview limit must be between 1 and 10');
  }
  return { task, definition, ruleName, limit };
}

export async function verifyInitialRulePreview(
  platform: PlatformRepository,
  previewKey: string,
  input: { task: TaskCreate; definition: CrawlPlanDefinition; limit: number },
): Promise<void> {
  const requestHash = createHash('sha256')
    .update(canonicalJson({ task: input.task, definition: input.definition, limit: input.limit }))
    .digest('hex');
  const reservation = await platform.reserveIdempotency({
    scope: 'collection:preview-initial-rule',
    key: previewKey,
    requestHash,
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  });
  if (reservation.state !== 'completed') {
    throw new HttpProblem(
      409,
      'SUCCESSFUL_PREVIEW_REQUIRED',
      'The current task and rule must pass preview before they can be saved and run',
    );
  }
}

export function deterministicUuid(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value || value.length > 200) {
    throw new HttpProblem(400, 'VALIDATION_ERROR', `${name} is required`);
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
