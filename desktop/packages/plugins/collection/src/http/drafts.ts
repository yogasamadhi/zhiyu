import { recordExperience } from '@zhiyun/platform-core';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { validateCrawlPlan } from '@zhiyun/extraction';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RouteContribution } from '@zhiyun/kernel';
import {
  normalizeCrawlPlan,
  taskCreateSchema,
  taskUpdateSchema,
  previewInspectionSchema,
  browserActionCacheSummarySchema,
  type CollectionDraft,
} from '@zhiyun/shared';
import {
  executeProductExample,
  productExampleDraft,
  productExampleUrl,
} from '../domain/example.js';
import {
  HttpProblem,
  canonicalJson,
  deterministicUuid,
  idempotentMutation,
  enqueueRun,
  protectTaskCredentials,
  requireIdempotencyKey,
  requireRevision,
  send,
  type CollectionHttpDependencies,
} from './index.js';

export const draftRoutes = [
  {
    operationId: 'startDraftLoginSession',
    method: 'POST',
    path: '/api/v2/collection-drafts/{draftId}/browser-session/login',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'listCollectionDrafts',
    method: 'GET',
    path: '/api/v2/collection-drafts',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'createCollectionDraft',
    method: 'POST',
    path: '/api/v2/collection-drafts',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'getCollectionDraft',
    method: 'GET',
    path: '/api/v2/collection-drafts/{draftId}',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'updateCollectionDraft',
    method: 'PATCH',
    path: '/api/v2/collection-drafts/{draftId}',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'deleteCollectionDraft',
    method: 'DELETE',
    path: '/api/v2/collection-drafts/{draftId}',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'previewCollectionDraft',
    method: 'POST',
    path: '/api/v2/collection-drafts/{draftId}/preview',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'commitCollectionDraft',
    method: 'POST',
    path: '/api/v2/collection-drafts/{draftId}/commit',
    requiredPermission: 'task.write',
  },
  {
    operationId: 'createExampleDraft',
    method: 'POST',
    path: '/api/v2/examples/{exampleId}/drafts',
    requiredPermission: 'task.write',
  },
] as const satisfies readonly RouteContribution[];
const patchSchema = z
  .object({
    step: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    mode: z.enum(['manual', 'ai', 'template']).optional(),
    task: taskUpdateSchema
      .extend({
        name: z.string().max(120).optional(),
        startUrl: z.union([taskCreateSchema.shape.startUrl, z.literal('')]).optional(),
        instruction: z.string().max(2000).optional(),
      })
      .optional(),
    definition: z.unknown().optional(),
    actor: z.enum(['manual', 'ai']).default('manual'),
  })
  .strict();

export function draftFingerprint(
  draft: Pick<CollectionDraft, 'task' | 'definition' | 'exampleId'>,
) {
  const {
    name: _name,
    schedule: _schedule,
    outputBindings: _bindings,
    outputSettings: _output,
    retentionPolicy: _retention,
    ...collection
  } = draft.task;
  void [_name, _schedule, _bindings, _output, _retention];
  return createHash('sha256')
    .update(canonicalJson({ collection, definition: draft.definition, exampleId: draft.exampleId }))
    .digest('hex');
}
export async function registerDraftHttp(app: FastifyInstance, deps: CollectionHttpDependencies) {
  const read = async (request: FastifyRequest) => {
    const id = (request.params as { draftId: string }).draftId;
    const draft = await deps.repository.getDraft(id);
    if (!draft) throw new HttpProblem(404, 'NOT_FOUND', 'Draft was not found');
    return draft;
  };
  const check = (request: FastifyRequest, draft: CollectionDraft) => {
    if (requireRevision(request) !== draft.revision)
      throw new HttpProblem(
        412,
        'REVISION_CONFLICT',
        'This draft changed. Reload the latest version before applying your changes.',
      );
  };
  const respond = (reply: FastifyReply, draft: CollectionDraft) => {
    reply.header('ETag', `"${draft.revision}"`);
    return draft;
  };
  const save = async (draft: CollectionDraft) => {
    const updated = await deps.repository.updateDraft(draft, draft.revision);
    if (!updated)
      throw new HttpProblem(
        412,
        'REVISION_CONFLICT',
        'Another edit changed this draft. Your changes were not applied.',
      );
    return updated;
  };
  const create = async (
    request: FastifyRequest,
    reply: FastifyReply,
    exampleId: 'products' | null,
  ) => {
    const id = deterministicUuid(
      `draft:${exampleId ?? 'manual'}:${requireIdempotencyKey(request)}`,
    );
    const existing = await deps.repository.getDraft(id);
    if (existing) return respond(reply, existing);
    const body = z
      .object({
        taskId: z.string().uuid().optional(),
        mode: z.enum(['manual', 'ai', 'template']).default('manual'),
      })
      .strict()
      .parse(request.body ?? {});
    const original = body.taskId ? await deps.repository.getTask(body.taskId) : null;
    if (body.taskId && !original) throw new HttpProblem(404, 'NOT_FOUND', 'Task was not found');
    const sample = exampleId ? productExampleDraft() : null;
    const task =
      sample?.task ??
      (original
        ? taskCreateSchema.parse({
            ...original,
            outputBindings: (await deps.bindings?.list(original.id)) ?? [],
          })
        : {});
    const timestamp = new Date().toISOString();
    const draft: CollectionDraft = {
      id,
      revision: 1,
      taskId: original?.id ?? null,
      taskRevision: original?.revision ?? null,
      exampleId: original?.origin.kind === 'example' ? original.origin.exampleId : exampleId,
      step: 1,
      mode: body.mode,
      task,
      definition: sample?.definition ?? original?.activeRule?.version.definition ?? null,
      preview: null,
      status: 'editing',
      commitRun: null,
      result: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const created = await deps.repository.createDraft(draft);
    reply.code(201);
    return respond(reply, created);
  };
  app.get('/api/v2/collection-drafts', async (_request, reply) =>
    send(reply, async () => ({ items: await deps.repository.listDrafts(), nextCursor: null })),
  );
  app.post('/api/v2/collection-drafts', async (request, reply) =>
    send(reply, async () =>
      respond(
        reply.code(201),
        await idempotentMutation(
          deps.platform,
          'collection:create-draft',
          requireIdempotencyKey(request),
          request.body ?? {},
          201,
          () => create(request, reply, null),
        ),
      ),
    ),
  );
  app.post('/api/v2/examples/:exampleId/drafts', async (request, reply) =>
    send(reply, async () => {
      if ((request.params as { exampleId: string }).exampleId !== 'products')
        throw new HttpProblem(404, 'NOT_FOUND', 'Built-in example was not found');
      const result = await idempotentMutation(
        deps.platform,
        'collection:create-example',
        requireIdempotencyKey(request),
        request.body ?? {},
        201,
        () => create(request, reply, 'products'),
      );
      return respond(reply.code(201), result);
    }),
  );
  app.get('/api/v2/collection-drafts/:draftId', async (request, reply) =>
    send(reply, async () => respond(reply, await read(request))),
  );
  app.patch('/api/v2/collection-drafts/:draftId', async (request, reply) =>
    send(reply, async () => {
      const updated = await idempotentMutation(
        deps.platform,
        `collection:update-draft:${(request.params as { draftId: string }).draftId}`,
        requireIdempotencyKey(request),
        { revision: requireRevision(request), body: request.body },
        200,
        async () => {
          const draft = await read(request);
          check(request, draft);
          if (draft.status !== 'editing')
            throw new HttpProblem(
              409,
              'DRAFT_SUBMITTED',
              'This draft is being submitted or was already submitted',
            );
          const patch = patchSchema.parse(request.body);
          let taskPatch = patch.task;
          if (patch.actor === 'ai' && taskPatch) {
            const allowed = ['name', 'startUrl', 'instruction', 'pagination'];
            if (Object.keys(taskPatch).some((key) => !allowed.includes(key)))
              throw new HttpProblem(
                400,
                'INVALID_AI_PATCH',
                'AI cannot modify protected or advanced task settings',
              );
          }
          if (taskPatch)
            taskPatch = await protectTaskCredentials(
              taskPatch,
              deps,
              draft.task.credentialBindings,
            );
          const next: CollectionDraft = {
            ...draft,
            step: patch.step ?? draft.step,
            mode: patch.mode ?? draft.mode,
            task: { ...draft.task, ...taskPatch },
            definition:
              patch.definition === undefined
                ? draft.definition
                : patch.definition === null
                  ? null
                  : normalizeCrawlPlan(patch.definition),
          };
          if (next.exampleId) {
            next.task.startUrl = productExampleUrl;
            next.task.outputBindings = [];
            next.task.schedule = taskCreateSchema.shape.schedule.parse(undefined);
          }
          if (draftFingerprint(next) !== draftFingerprint(draft)) next.preview = null;
          const updated = await save(next);
          if (!updated.taskId && (updated.task.startUrl || updated.task.instruction))
            await recordExperience(deps.platform, {
              id: updated.id,
              type: 'creation_started',
              taskId: deterministicUuid(`draft:${updated.id}:task`),
              example: Boolean(updated.exampleId),
            }).catch(() => undefined);
          return updated;
        },
      );
      return respond(reply, updated);
    }),
  );
  app.delete('/api/v2/collection-drafts/:draftId', async (request, reply) =>
    send(reply, async () => {
      await idempotentMutation(
        deps.platform,
        `collection:delete-draft:${(request.params as { draftId: string }).draftId}`,
        requireIdempotencyKey(request),
        { revision: requireRevision(request) },
        204,
        async () => {
          const draft = await read(request);
          check(request, draft);
          if (!(await deps.repository.deleteDraft(draft.id, draft.revision)))
            throw new HttpProblem(409, 'DRAFT_SUBMITTED', 'A submitted draft cannot be deleted');
          return null;
        },
      );
      reply.code(204);
      return undefined;
    }),
  );
  app.post('/api/v2/collection-drafts/:draftId/browser-session/login', async (request, reply) =>
    send(reply, () =>
      idempotentMutation(
        deps.platform,
        `collection:draft-login:${(request.params as { draftId: string }).draftId}`,
        requireIdempotencyKey(request),
        { revision: requireRevision(request), body: request.body ?? {} },
        200,
        async () => {
          const draft = await read(request);
          check(request, draft);
          if (draft.status !== 'editing' || draft.exampleId)
            throw new HttpProblem(
              409,
              'LOGIN_UNAVAILABLE',
              'Login requires an editable website draft',
            );
          if (!deps.createLoginSession)
            throw new HttpProblem(
              409,
              'CAPABILITY_UNAVAILABLE',
              'Controlled login is unavailable. Use protected manual credentials.',
            );
          const body = z
            .object({ loginUrl: z.string().url().optional() })
            .strict()
            .parse(request.body ?? {});
          const url = body.loginUrl ?? draft.task.startUrl;
          if (!url) throw new HttpProblem(422, 'URL_REQUIRED', 'Choose a website before login');
          const login = await deps.createLoginSession(url);
          if ('canceled' in login) return { canceled: true };
          const current = await deps.repository.getDraft(draft.id);
          if (!current || current.revision !== draft.revision || current.status !== 'editing') {
            await deps.credentialStore.delete(login.reference).catch(() => undefined);
            throw new HttpProblem(
              412,
              'REVISION_CONFLICT',
              'Draft changed during login. Retry from the latest draft.',
            );
          }
          try {
            const updated = await save({
              ...draft,
              preview: null,
              task: {
                ...draft.task,
                credentialBindings: {
                  ...draft.task.credentialBindings,
                  browserStorageStateRef: login.reference,
                },
                browserSettings: {
                  waitUntil: 'domcontentloaded',
                  actions: [],
                  ...draft.task.browserSettings,
                  enabled: true,
                },
              },
            });
            const old = draft.task.credentialBindings?.browserStorageStateRef;
            const task = draft.taskId ? await deps.repository.getTask(draft.taskId) : null;
            if (
              old &&
              old !== login.reference &&
              task?.credentialBindings.browserStorageStateRef !== old
            )
              await deps.credentialStore.delete(old).catch(() => undefined);
            reply.header('ETag', `"${updated.revision}"`);
            return { canceled: false, draft: updated };
          } catch (error) {
            await deps.credentialStore.delete(login.reference).catch(() => undefined);
            throw error;
          }
        },
      ),
    ),
  );
  app.post('/api/v2/collection-drafts/:draftId/preview', async (request, reply) =>
    send(reply, async () =>
      respond(
        reply,
        await idempotentMutation(
          deps.platform,
          `collection:preview-draft:${(request.params as { draftId: string }).draftId}`,
          requireIdempotencyKey(request),
          { revision: requireRevision(request) },
          200,
          async () => {
            const draft = await read(request);
            check(request, draft);
            if (draft.status !== 'editing')
              throw new HttpProblem(409, 'DRAFT_SUBMITTED', 'Draft is already submitted');
            if (!draft.definition)
              throw new HttpProblem(400, 'RULE_REQUIRED', 'Choose fields before previewing');
            const task = taskCreateSchema.parse({
              ...draft.task,
              name: draft.task.name || 'Preview',
              instruction: draft.task.instruction || 'Collect selected fields',
            });
            const timestamp = new Date().toISOString();
            const result = draft.exampleId
              ? executeProductExample(draft.exampleId, draft.definition, 10, true)
              : await deps.previewRule?.(
                  {
                    ...task,
                    id: draft.id,
                    status: 'draft',
                    origin: { kind: 'manual' },
                    revision: draft.revision,
                    createdAt: draft.createdAt,
                    updatedAt: timestamp,
                    activeRule: null,
                  },
                  draft.definition,
                  10,
                  {
                    scope: `draft:${draft.id}`,
                    ruleVersion: `preview:${draftFingerprint(draft)}`,
                    configuration: task.datasetSettings,
                  },
                );
            const records = z
              .object({
                records: z.array(
                  z.object({
                    data: z.record(z.string(), z.unknown()),
                    sourceUrl: z.string(),
                    inspection: previewInspectionSchema.optional(),
                  }),
                ),
              })
              .parse(result).records;
            const cache = z
              .object({
                metadata: z.object({ actionCache: browserActionCacheSummarySchema.optional() }),
              })
              .safeParse(result);
            if (!records.length)
              throw new HttpProblem(
                422,
                'EMPTY_PREVIEW',
                'No records were found. Check the page and extraction fields.',
              );
            const updated = await save({
              ...draft,
              preview: {
                fingerprint: draftFingerprint(draft),
                records,
                createdAt: timestamp,
                ...(cache.success && cache.data.metadata.actionCache
                  ? { actionCache: cache.data.metadata.actionCache }
                  : {}),
              },
            });
            await recordExperience(deps.platform, {
              id: `${draft.id}:${draftFingerprint(draft)}`,
              type: 'preview_completed',
              taskId: draft.taskId ?? deterministicUuid(`draft:${draft.id}:task`),
              example: Boolean(draft.exampleId),
            }).catch(() => undefined);
            return updated;
          },
        ),
      ),
    ),
  );
  app.post('/api/v2/collection-drafts/:draftId/commit', async (request, reply) =>
    send(reply, async () => {
      requireIdempotencyKey(request);
      const draft = await read(request);
      const { run } = z
        .object({ run: z.boolean().default(true) })
        .strict()
        .parse(request.body ?? {});
      if (draft.status === 'committed') {
        if (draft.commitRun !== run)
          throw new HttpProblem(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Draft was submitted with different run settings',
          );
        return respond(reply, draft);
      }
      check(request, draft);
      return respond(reply, await commitCanonicalDraft(deps, draft, run));
    }),
  );
}

export async function commitCanonicalDraft(
  deps: CollectionHttpDependencies,
  initial: CollectionDraft,
  run: boolean,
): Promise<CollectionDraft> {
  let draft = initial;
  const save = async (value: CollectionDraft) => {
    const updated = await deps.repository.updateDraft(value, value.revision);
    if (!updated) throw new HttpProblem(412, 'REVISION_CONFLICT', 'Draft changed while saving');
    return updated;
  };
  const task = taskCreateSchema.parse(draft.task);
  if (draft.definition) validateCrawlPlan(draft.definition);
  if (!draft.definition || !draft.preview || draft.preview.fingerprint !== draftFingerprint(draft))
    throw new HttpProblem(
      409,
      'SUCCESSFUL_PREVIEW_REQUIRED',
      'Preview the current fields before saving',
    );
  if (
    draft.preview.records.some((row) =>
      ['ambiguous_link', 'ambiguous_record'].includes(row.inspection?.detail?.status ?? ''),
    )
  )
    throw new HttpProblem(
      422,
      'AMBIGUOUS_DETAIL_RELATION',
      'Choose one detail link and one detail record per list item, then preview again',
    );
  if (draft.status === 'editing' && draft.taskId) {
    const original = await deps.repository.getTask(draft.taskId);
    if (!original) throw new HttpProblem(404, 'NOT_FOUND', 'Task was deleted');
    if (original.revision !== draft.taskRevision)
      throw new HttpProblem(
        412,
        'REVISION_CONFLICT',
        'Task changed since this draft was opened. Create a new editing draft to merge your changes.',
      );
  }
  if (draft.status === 'editing')
    draft = await save({ ...draft, status: 'committing', commitRun: run });
  else if (draft.commitRun !== run)
    throw new HttpProblem(409, 'IDEMPOTENCY_CONFLICT', 'Submission settings changed');
  const taskId = draft.taskId ?? deterministicUuid(`draft:${draft.id}:task`);
  const ruleId = deterministicUuid(`draft:${draft.id}:rule`);
  const versionId = deterministicUuid(`draft:${draft.id}:version`);
  if (!draft.taskId) {
    await deps.repository.createTaskWithInitialRule({
      taskId,
      ruleId,
      versionId,
      task: { ...task, outputBindings: [] },
      definition: draft.definition!,
      ruleName: task.name,
      origin: draft.exampleId
        ? { kind: 'example', exampleId: draft.exampleId }
        : { kind: draft.mode === 'ai' ? 'ai' : 'manual' },
      status: 'ready',
    });
  } else {
    const current = await deps.repository.getTask(taskId);
    if (!current) throw new HttpProblem(404, 'NOT_FOUND', 'Task was deleted');
    if (current.revision === draft.taskRevision) {
      const { outputBindings: _bindings, ...update } = task;
      void _bindings;
      if (!(await deps.repository.updateTask(taskId, update, current.revision)))
        throw new HttpProblem(412, 'REVISION_CONFLICT', 'Task changed while saving');
    } else if (
      canonicalJson(taskCreateSchema.parse({ ...current, outputBindings: task.outputBindings })) !==
      canonicalJson(task)
    )
      throw new HttpProblem(412, 'REVISION_CONFLICT', 'Task changed since this draft was opened');
    if (current.activeRule)
      await deps.repository.createRuleVersion(
        taskId,
        current.activeRule.rule.id,
        draft.definition!,
        'human',
        versionId,
      );
    else
      await deps.repository.createRule(taskId, task.name, draft.definition!, 'human', {
        ruleId,
        versionId,
      });
  }
  await deps.bindings?.replace(taskId, draft.exampleId ? [] : task.outputBindings);
  const runId = run ? deterministicUuid(`draft:${draft.id}:run`) : null;
  if (runId) {
    const committedTask = await deps.repository.getTask(taskId);
    await deps.repository.createRun(taskId, runId, {
      expectedTaskRevision: committedTask?.revision,
      expectedRuleVersionId: versionId,
    });
    await enqueueRun(deps.jobs, runId, taskId);
  }
  const latest = await deps.repository.getDraft(draft.id);
  if (latest?.status === 'committed') return latest;
  return save({ ...draft, status: 'committed', result: { taskId, runId } });
}
