import { z } from 'zod';
import {
  taskCreateSchema,
  scheduleSchema,
  type AssistantAction,
  type CollectionDraft,
  type AssistantResource,
} from '@zhiyun/contracts';
import { recordExperience } from '@zhiyun/platform-core';
import {
  AssistantProblem,
  type AiAssistanceService,
  type AssistantBusinessPort,
  type AssistantActor,
} from '@zhiyun/plugin-ai-assistance';
import {
  commitCanonicalDraft,
  deterministicUuid,
  draftFingerprint,
  productExampleDraft,
  executeProductExample,
  resolveCollectionTaskSettings,
  enqueueRun,
} from '@zhiyun/plugin-collection';
import { createExportArtifact, exportRecordData } from '@zhiyun/plugin-datasets';
import { enqueueOutputDelivery } from '@zhiyun/plugin-outputs';
import { rolePermissions } from '@zhiyun/plugin-identity';
import type { Level2RuntimeDependencies } from './level2.js';

export function createAssistantBusiness(
  deps: Level2RuntimeDependencies,
  ai: AiAssistanceService,
): AssistantBusinessPort {
  const r = deps.repositories;
  const missing = () =>
    new AssistantProblem(404, 'NOT_FOUND', 'The referenced resource no longer exists');
  const outputSummary = async (ids: string[]) =>
    Promise.all(
      ids.map(async (id) => {
        const destination = await r.outputs.getDestination(id);
        return { id, name: destination?.name ?? id, updatedAt: destination?.updatedAt ?? null };
      }),
    );
  const read = async (resource: AssistantResource) => {
    if (resource.kind === 'draft') {
      const draft = await r.collection.getDraft(resource.id);
      if (!draft) throw missing();
      return {
        resource: { ...resource, label: draft.task.name || '采集草稿 / Collection draft' },
        revision: draft.revision,
        summary: {
          taskId: draft.taskId,
          outputs: await outputSummary(draft.task.outputBindings ?? []),
          status: draft.status,
          name: draft.task.name,
          url: draft.task.startUrl,
          fields: draft.definition?.list.rule.fields,
          schedule: draft.task.schedule,
          scope: {
            pagination: draft.task.pagination,
            maxRequests: draft.task.requestSettings?.maxRequests,
          },
          preview: draft.preview
            ? { createdAt: draft.preview.createdAt, records: draft.preview.records.slice(0, 10) }
            : null,
        },
      };
    }
    if (resource.kind === 'dataset') {
      const dataset = await r.datasets.getDataset(resource.id);
      if (!dataset) throw missing();
      const page = await r.datasets.listRecords(dataset.id, undefined, 10);
      return {
        resource,
        revision: dataset.schemaVersion,
        summary: {
          taskId: dataset.sourceTaskId,
          datasetId: dataset.id,
          recordCount: dataset.currentCount,
          updatedAt: dataset.updatedAt,
          fields: [...new Set(page.items.flatMap((row) => Object.keys(row.data)))],
          sample: page.items.map((row) => row.data),
          sampled: true,
        },
      };
    }
    const run = resource.kind === 'run' ? await r.collection.getRun(resource.id) : null;
    if (resource.kind === 'run' && !run) throw missing();
    const task = await r.collection.getTask(run?.taskId ?? resource.id);
    if (!task) throw missing();
    const latestRun = run ?? (await r.collection.listRuns(task.id))[0];
    const dataset = await r.datasets.getDatasetBySourceTask(task.id);
    const deliveries = latestRun ? await r.outputs.listDeliveryAttempts(latestRun.id) : [];
    return {
      resource: { ...resource, label: task.name },
      revision: task.revision,
      summary: {
        taskId: task.id,
        outputs: await outputSummary(await r.outputs.listTaskBindings(task.id)),
        datasetId: dataset?.id ?? null,
        name: task.name,
        url: task.startUrl,
        ruleVersionId: task.activeRule?.version.id,
        fields: task.activeRule?.version.definition.list.rule.fields,
        schedule: task.schedule,
        scope: { pagination: task.pagination, maxRequests: task.requestSettings.maxRequests },
        run: latestRun
          ? {
              id: latestRun.id,
              status: latestRun.status,
              phase: latestRun.phase,
              error: latestRun.error,
              errorCode: latestRun.errorCode,
            }
          : null,
        deliveries: deliveries.map((delivery) => ({
          id: delivery.id,
          status: delivery.status,
          attempt: delivery.attempt,
          error: delivery.error,
        })),
        recordCount: dataset?.currentCount ?? null,
      },
    };
  };
  const getDraft = (id: string) => r.collection.getDraft(id);
  const create = async (id: string, taskId?: string): Promise<CollectionDraft> => {
    const existing = await getDraft(id);
    if (existing) return existing;
    const task = taskId ? await r.collection.getTask(taskId) : null;
    if (taskId && !task) throw missing();
    const example = task ? null : productExampleDraft();
    return r.collection.createDraft({
      id,
      revision: 1,
      taskId: task?.id ?? null,
      taskRevision: task?.revision ?? null,
      exampleId: task
        ? task.origin.kind === 'example'
          ? task.origin.exampleId
          : null
        : 'products',
      step: 2,
      mode: 'ai',
      task: task ? taskCreateSchema.parse(task) : example!.task,
      definition: task?.activeRule?.version.definition ?? example!.definition,
      preview: null,
      status: 'editing',
      commitRun: null,
      result: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  };
  const previewDraft: AssistantBusinessPort['previewDraft'] = async (id, revision, signal) => {
    const draft = await getDraft(id);
    if (!draft || !draft.definition) throw missing();
    if (draft.revision !== revision || draft.status !== 'editing')
      throw new AssistantProblem(412, 'REVISION_CONFLICT', 'Draft changed before preview');
    const task = taskCreateSchema.parse({
      ...draft.task,
      name: draft.task.name || 'Preview',
      instruction: draft.task.instruction || 'Collect fields',
    });
    const settings = await resolveCollectionTaskSettings(
      task.requestSettings,
      task.browserSettings,
      task.credentialBindings,
      deps.credentialStore,
    );
    const result = draft.exampleId
      ? executeProductExample(draft.exampleId, draft.definition, 10, true)
      : await deps.crawler.crawl({
          url: task.startUrl,
          plan: draft.definition,
          cacheBinding: {
            scope: `draft:${draft.id}`,
            taskVersion: draft.revision,
            configuration: task.datasetSettings,
          },
          requestSettings: settings.requestSettings,
          browserSettings: settings.browserSettings,
          pagination: task.pagination,
          networkPolicy: task.networkPolicy,
          previewLimit: 10,
          signal,
        });
    signal.throwIfAborted();
    if (!result.records.length)
      throw new AssistantProblem(
        422,
        'EMPTY_PREVIEW',
        'No records were found. Check the source and fields.',
      );
    const updated = await r.collection.updateDraft(
      {
        ...draft,
        preview: {
          fingerprint: draftFingerprint(draft),
          records: result.records.slice(0, 10),
          createdAt: new Date().toISOString(),
        },
      },
      revision,
    );
    if (!updated)
      throw new AssistantProblem(412, 'REVISION_CONFLICT', 'Draft changed during preview');
    await recordExperience(r.platform, {
      id: `${id}:${draftFingerprint(draft)}`,
      taskId: draft.taskId ?? deterministicUuid(`draft:${id}:task`),
      type: 'preview_completed',
      example: Boolean(draft.exampleId),
    });
    return updated;
  };
  const execute = async (
    action: AssistantAction,
    actor: AssistantActor,
  ): Promise<Record<string, unknown>> => {
    const target = action.resource;
    if (!target) throw missing();
    if (action.kind === 'save' || action.kind === 'save_and_run') {
      const draft = await getDraft(target.id);
      if (!draft) throw missing();
      if (draft.status === 'editing' && draft.revision !== action.expectedRevision)
        throw new AssistantProblem(412, 'REVISION_CONFLICT', 'Draft changed before saving');
      const result = await commitCanonicalDraft(
        {
          repository: r.collection,
          platform: r.platform,
          jobs: deps.jobs,
          credentialStore: deps.credentialStore,
          runtimeMode: deps.host.metadata.mode,
          bindings: {
            list: (id) => r.outputs.listTaskBindings(id),
            replace: (id, ids) => r.outputs.replaceTaskBindings(id, ids),
            clear: async (id) => {
              await r.outputs.clearTaskBindings(id);
            },
          },
        },
        draft,
        action.kind === 'save_and_run',
      );
      return { ...result.result!, href: `/tasks/${result.result!.taskId}` };
    }
    if (action.kind === 'run') {
      const runId = deterministicUuid(`assistant-run:${action.id}`);
      await r.collection.createRun(target.id, runId, {
        expectedTaskRevision: action.expectedRevision,
        expectedRuleVersionId: action.parameters._activeRuleVersion,
      });
      await enqueueRun(deps.jobs, runId, target.id);
      return { taskId: target.id, runId, href: `/runs/${runId}` };
    }
    if (action.kind === 'schedule') {
      const task = await r.collection.getTask(target.id);
      if (!task) throw missing();
      if (task.origin.kind === 'example')
        throw new AssistantProblem(
          422,
          'EXAMPLE_MANUAL_ONLY',
          'Bundled examples use manual execution',
        );
      const updated = await r.collection.updateTask(
        target.id,
        { schedule: scheduleSchema.parse(action.parameters.schedule) },
        action.expectedRevision!,
      );
      if (!updated)
        throw new AssistantProblem(412, 'REVISION_CONFLICT', 'Task changed before schedule update');
      return { taskId: target.id, revision: updated.revision, href: `/tasks/${target.id}` };
    }
    if (action.kind === 'apply_repair') {
      const value = z
        .object({ ruleId: z.string(), proposalId: z.string() })
        .parse(action.parameters);
      const result = await ai.applyRepairProposal(
        target.id,
        value.ruleId,
        value.proposalId,
        deterministicUuid(`assistant-repair:${action.id}`),
        String(action.parameters._activeRuleVersion),
      );
      return { taskId: target.id, ruleVersionId: result.id, href: `/tasks/${target.id}` };
    }
    if (action.kind === 'retry_output') {
      const delivery = (await r.outputs.listDeliveryAttempts()).find(
        (entry) => entry.id === action.parameters.deliveryId && entry.taskId === target.id,
      );
      if (!delivery) throw missing();
      if (delivery.status !== 'failed')
        throw new AssistantProblem(409, 'DELIVERY_NOT_FAILED', 'This delivery is not failed');
      const updated = await r.outputs.updateDeliveryAttempt(delivery.id, {
        status: 'pending',
        attempt: delivery.attempt + 1,
        error: null,
        nextAttemptAt: null,
      });
      if (!updated) throw missing();
      await enqueueOutputDelivery(deps.jobs, updated);
      return { deliveryId: delivery.id, href: `/runs/${delivery.runId}` };
    }
    if (action.kind === 'export') {
      const dataset = await r.datasets.getDataset(target.id);
      if (!dataset) throw missing();
      const value = z
        .object({ format: z.enum(['csv', 'json', 'xlsx']), fields: z.array(z.string()).optional() })
        .parse(action.parameters);
      const artifact = await r.datasets.withConsistentSnapshotRead(dataset.id, (snapshot) => {
        if (
          action.parameters._datasetUpdatedAt !== snapshot.dataset.updatedAt ||
          action.expectedRevision !== snapshot.dataset.schemaVersion
        )
          throw new AssistantProblem(412, 'REVISION_CONFLICT', 'Dataset changed before export');
        return createExportArtifact(
          { platform: r.platform, artifactStore: deps.artifactStore },
          {
            artifactId: deterministicUuid(`assistant-export:${action.id}`),
            ownerId: dataset.id,
            kind: 'dataset',
            body: {
              format: value.format,
              ...(value.fields ? { fields: value.fields } : {}),
              filename: `dataset-${dataset.id}`,
            },
            records: exportRecordData(snapshot.records),
            metadata: { datasetId: dataset.id, assistantActionId: action.id, ownerId: actor.id },
          },
        );
      });
      await recordExperience(r.platform, {
        id: artifact.id,
        taskId: dataset.sourceTaskId,
        type: 'export_completed',
        example: (await r.collection.getTask(dataset.sourceTaskId))?.origin.kind === 'example',
      });
      return {
        artifactId: artifact.id,
        filename: artifact.filename,
        href: `/datasets/${dataset.id}`,
      };
    }
    throw new AssistantProblem(400, 'ACTION_UNSUPPORTED', 'Unsupported business action');
  };
  const recoverAction: AssistantBusinessPort['recoverAction'] = async (action) => {
    const target = action.resource;
    if (!target) return null;
    if (['save', 'save_and_run'].includes(action.kind)) {
      const draft = await getDraft(target.id);
      if (draft?.status === 'committing')
        return execute(action, { id: 'recovery', permissions: [] });
      return draft?.result ? { ...draft.result, href: `/tasks/${draft.result.taskId}` } : null;
    }
    if (action.kind === 'run') {
      const run = await r.collection.getRun(deterministicUuid(`assistant-run:${action.id}`));
      if (!run) return null;
      if (run.status === 'queued') await enqueueRun(deps.jobs, run.id, run.taskId);
      return { taskId: run.taskId, runId: run.id, href: `/runs/${run.id}` };
    }
    if (action.kind === 'export') {
      const artifact = await r.platform.getArtifact(
        deterministicUuid(`assistant-export:${action.id}`),
      );
      return artifact
        ? { artifactId: artifact.id, filename: artifact.filename, href: `/datasets/${target.id}` }
        : null;
    }
    if (action.kind === 'schedule') {
      const task = await r.collection.getTask(target.id);
      return task &&
        task.revision === action.expectedRevision! + 1 &&
        JSON.stringify(task.schedule) === JSON.stringify(action.parameters.schedule)
        ? { taskId: task.id, revision: task.revision, href: `/tasks/${task.id}` }
        : null;
    }
    if (action.kind === 'apply_repair') {
      const rule = (await r.collection.listRules(target.id)).find(
        (item) => item.id === action.parameters.ruleId,
      );
      const version = rule?.versions.find(
        (item) => item.id === deterministicUuid(`assistant-repair:${action.id}`),
      );
      if (!version) return null;
      await r.collection.updateRuleRepairProposal(String(action.parameters.proposalId), 'applied');
      return { taskId: target.id, ruleVersionId: version.id, href: `/tasks/${target.id}` };
    }
    if (action.kind === 'retry_output') {
      const delivery = (await r.outputs.listDeliveryAttempts()).find(
        (item) => item.id === action.parameters.deliveryId,
      );
      if (!delivery || delivery.attempt !== Number(action.parameters._attempt) + 1) return null;
      if (delivery.status === 'pending') await enqueueOutputDelivery(deps.jobs, delivery);
      return { deliveryId: delivery.id, href: `/runs/${delivery.runId}` };
    }
    return null;
  };
  return {
    recoverAction,
    read,
    getDraft,
    createExample: (id) => create(deterministicUuid(`assistant-example:${id}`)),
    draftForTask: (taskId, id) => create(deterministicUuid(`assistant-edit:${id}`), taskId),
    previewDraft,
    execute,
    async patchDraft(id, revision, patch) {
      const draft = await getDraft(id);
      if (!draft) throw missing();
      if (draft.revision !== revision || draft.status !== 'editing')
        throw new AssistantProblem(412, 'REVISION_CONFLICT', 'Draft changed');
      const next = {
        ...draft,
        task: { ...draft.task, ...patch.task },
        definition: patch.definition === undefined ? draft.definition : patch.definition,
      };
      if (draftFingerprint(next) !== draftFingerprint(draft)) next.preview = null;
      const result = await r.collection.updateDraft(next, revision);
      if (!result) throw new AssistantProblem(412, 'REVISION_CONFLICT', 'Draft changed');
      return result;
    },
    async prepareRepair(resource, signal) {
      const view = await read(resource);
      const taskId = String(view.summary.taskId);
      const active = await r.collection.getActiveRule(taskId);
      if (!active) throw missing();
      const run =
        resource.kind === 'run'
          ? await r.collection.getRun(resource.id)
          : (await r.collection.listRuns(taskId))[0];
      signal.throwIfAborted();
      const proposal = await ai.createRepairProposal(
        taskId,
        active.rule.id,
        {
          runId: run?.id ?? null,
          error: run?.error ?? 'Check missing fields and current page structure',
        },
        signal,
      );
      signal.throwIfAborted();
      const tested = await ai.testRepairProposal(taskId, active.rule.id, proposal.id, signal);
      signal.throwIfAborted();
      return {
        resource: { kind: 'task', id: taskId },
        revision: view.revision!,
        parameters: { ruleId: active.rule.id, proposalId: proposal.id },
        summary: proposal.explanation,
        preview: { records: tested.records.slice(0, 10), createdAt: new Date().toISOString() },
      };
    },
    async verifyLesson(conversation, activity, reference) {
      if (activity === 'example') {
        const draft = conversation.collectionDraftId
          ? await getDraft(conversation.collectionDraftId)
          : null;
        return draft?.exampleId === 'products' ? draft.id : null;
      }
      if (activity === 'run') {
        const resource = conversation.context.resource;
        if (!resource || resource.kind !== 'task') return null;
        const runs = await r.collection.listRuns(resource.id);
        return runs.find((run) => run.status === 'succeeded')?.id ?? null;
      }
      if (activity === 'export') {
        const actions = await r.aiAssistance.listAssistantRecords('action', conversation.id);
        const action = actions.find(
          (row) =>
            row.value.kind === 'export' &&
            row.value.status === 'succeeded' &&
            (!reference || row.value.id === reference),
        );
        const artifactId = (action?.value.result as { artifactId?: string } | undefined)
          ?.artifactId;
        return artifactId && (await r.platform.getArtifact(artifactId)) ? artifactId : null;
      }
      return null;
    },
    async resolveActor(actor) {
      if (!deps.identity) return actor;
      const user = await deps.identity.repository.findUserById(actor.id);
      if (!user || user.disabled)
        throw new AssistantProblem(403, 'FORBIDDEN', 'Account unavailable');
      return { id: user.id, permissions: rolePermissions[user.role] };
    },
    controlledLogin: Boolean(deps.host.createLoginSession),
    async recordLearning(conversationId, type, reference) {
      await recordExperience(r.platform, {
        id: `${conversationId}:${reference}`,
        type,
        taskId: `assistant-learning:${conversationId}`,
      });
    },
    async recordAttempt(conversationId, context) {
      if (context.intent !== 'collect' || (context.resource && context.resource.kind !== 'draft'))
        return;
      const draftId = context.resource?.id ?? deterministicUuid(`legacy-ai:${conversationId}`);
      const draft = await getDraft(draftId);
      if (draft?.exampleId || draft?.taskId) return;
      await recordExperience(r.platform, {
        id: `assistant:${conversationId}`,
        taskId: deterministicUuid(`draft:${draftId}:task`),
        type: 'creation_started',
      });
    },
  };
}
