import { type Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { taskCreateSchema } from '@zhiyun/contracts';
import { recordExperience } from '@zhiyun/platform-core';
import { ownRuntimeEffect } from '@zhiyun/runtime-contracts';
import { AiConversationRetention } from './ai-conversation-retention.js';
import { createAssistantBusiness } from './assistant-business.js';
import {
  AiAssistanceService,
  AiProviderSettingsService,
  AnonymousBrowserWebSearch,
  AssistantService,
  CrawlerAssistantService,
  MutableAiProvider,
  PiAgentRuntime,
  RuleAnalysisCache,
  registerAiAssistanceHttp,
  registerAssistantHttp,
  type CollectionForAiPort,
} from './index.js';

export const inject = [
  'aiProvider',
  'commitCanonicalDraft',
  'crawler',
  'createExportArtifact',
  'credentials',
  'deterministicUuid',
  'draftFingerprint',
  'enqueueOutputDelivery',
  'enqueueRun',
  'executeProductExample',
  'exportRecordData',
  'hostCapabilities',
  'jobHandlers',
  'jobs',
  'outputsService',
  'productExampleDraft',
  'realtime',
  'resolveCollectionTaskSettings',
  'runtimeHost',
];
export const Config = Schema.object({});
function createServices(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const repositories = dependencies.repositories;
  const mutableAi = new MutableAiProvider(ctx.aiProvider, dependencies.aiOverride);
  const collectionForAi: CollectionForAiPort = {
    async getTask(id) {
      const task = await repositories.collection.getTask(id);
      if (!task) return null;
      const settings = await ctx.resolveCollectionTaskSettings(
        task.requestSettings,
        task.browserSettings,
        task.credentialBindings,
        ctx.credentials,
      );
      return { ...task, ...settings };
    },
    getRun: (id) => repositories.collection.getRun(id),
    async getRule(taskId, ruleId) {
      const rule = (await repositories.collection.listRules(taskId)).find(
        (candidate) => candidate.id === ruleId,
      );
      return rule ?? null;
    },
    async getActiveRule(taskId) {
      const active = await repositories.collection.getActiveRule(taskId);
      return active
        ? { activeVersionId: active.rule.activeVersionId, versions: [active.version] }
        : null;
    },
    createRuleVersion: (taskId, ruleId, definition, versionId, expectedActiveVersionId) =>
      repositories.collection.createRuleVersion(
        taskId,
        ruleId,
        definition,
        'ai',
        versionId,
        expectedActiveVersionId,
      ),
    createRepairProposal: (input) => repositories.collection.createRuleRepairProposal(input),
    listRepairProposals: (ruleId) => repositories.collection.listRuleRepairProposals(ruleId),
    markRepairProposalTested: (id, tested) =>
      repositories.collection.markRuleRepairProposalTested(id, tested),
    updateRepairProposal: (id, status) =>
      repositories.collection.updateRuleRepairProposal(id, status),
    createTaskWithInitialRule: (input) => repositories.collection.createTaskWithInitialRule(input),
  };
  const ruleCache = new RuleAnalysisCache(repositories.aiAssistance);
  const aiAssistance = new AiAssistanceService(collectionForAi, mutableAi, ctx.crawler, ruleCache);
  const assistantBusiness = createAssistantBusiness(ctx, aiAssistance);
  const crawlerAssistant = new CrawlerAssistantService({
    repository: repositories.aiAssistance,
    ruleCache,
    collection: collectionForAi,
    drafts: {
      get: (id) => repositories.collection.getDraft(id),
      async resolve(id) {
        const draft = await repositories.collection.getDraft(id);
        if (!draft) throw new Error('Collection draft was not found');
        const task = taskCreateSchema.parse({
          ...draft.task,
          name: draft.task.name || 'Draft',
          instruction: draft.task.instruction || 'Collect fields',
        });
        const settings = await ctx.resolveCollectionTaskSettings(
          task.requestSettings,
          task.browserSettings,
          task.credentialBindings,
          ctx.credentials,
        );
        return { ...task, ...settings };
      },
      async create(legacy, conversationId) {
        const now = new Date().toISOString();
        return repositories.collection.createDraft({
          id: ctx.deterministicUuid(`legacy-ai:${conversationId}`),
          revision: 1,
          taskId: null,
          taskRevision: null,
          exampleId: null,
          step: 1,
          mode: 'ai',
          task: {
            name: legacy.name,
            startUrl: legacy.startUrl ?? '',
            instruction: legacy.instruction,
            schedule: legacy.schedule,
            pagination: legacy.pagination,
            browserSettings: {
              enabled: legacy.browserEnabled,
              waitUntil: 'domcontentloaded',
              actions: [],
            },
            datasetSettings: {
              mode: legacy.datasetMode,
              keyFields: legacy.keyFields,
              detectRemoved: true,
            },
          },
          definition: legacy.rule,
          preview: null,
          status: 'editing',
          commitRun: null,
          result: null,
          createdAt: now,
          updatedAt: now,
        });
      },
      async patch(id, revision, patch) {
        const draft = await repositories.collection.getDraft(id);
        if (!draft || draft.revision !== revision || draft.status !== 'editing')
          throw new Error(
            'REVISION_CONFLICT: Manual edits changed this draft. Start a new AI turn to use the latest version.',
          );
        if (
          Object.keys(patch.task ?? {}).some(
            (key) => !['name', 'startUrl', 'instruction', 'pagination'].includes(key),
          )
        )
          throw new Error('INVALID_AI_PATCH: Advanced settings are owned by the manual draft');
        const next = { ...draft, ...patch, task: { ...draft.task, ...patch.task } };
        if (draft.exampleId) next.task.startUrl = draft.task.startUrl;
        if (ctx.draftFingerprint(next) !== ctx.draftFingerprint(draft)) next.preview = null;
        const result = await repositories.collection.updateDraft(next, revision);
        if (!result) throw new Error('REVISION_CONFLICT: Draft changed during AI editing');
        if (!result.taskId && (result.task.startUrl || result.task.instruction))
          await recordExperience(repositories.platform, {
            id: result.id,
            type: 'creation_started',
            taskId: ctx.deterministicUuid(`draft:${result.id}:task`),
            example: Boolean(result.exampleId),
          }).catch(() => undefined);
        return result;
      },
      async preview(id, revision, signal) {
        return assistantBusiness.previewDraft(id, revision, signal ?? AbortSignal.timeout(30000));
      },
      async commit(id, revision) {
        const draft = await repositories.collection.getDraft(id);
        if (!draft) throw new Error('Draft was not found');
        if (draft.status === 'committed' && draft.result) return { taskId: draft.result.taskId };
        if (draft.revision !== revision)
          throw new Error('REVISION_CONFLICT: Draft changed before submission');
        const result = await ctx.commitCanonicalDraft(
          {
            repository: repositories.collection,
            platform: repositories.platform,
            jobs: ctx.jobs,
            credentialStore: ctx.credentials,
            runtimeMode: ctx.hostCapabilities.metadata.mode,
            bindings: {
              list: (taskId) => repositories.outputs.listTaskBindings(taskId),
              replace: (taskId, ids) => ctx.outputsService.bindTask(taskId, ids),
              clear: async (taskId) => {
                await ctx.outputsService.clearCollectionTask(taskId);
              },
            },
          },
          draft,
          false,
        );
        return { taskId: result.result!.taskId };
      },
    },
    agent: new PiAgentRuntime(() => mutableAi.current()),
    provider: () => mutableAi.current(),
    providerConfigured: () => mutableAi.configured(),
    crawler: ctx.crawler,
    search: new AnonymousBrowserWebSearch(),
    jobs: ctx.jobs,
    realtime: {
      publish: async (type, payload) => {
        const record =
          typeof payload.conversationId === 'string'
            ? await repositories.aiAssistance.getAssistantRecord(
                `session:${payload.conversationId}`,
              )
            : null;
        ctx.realtime.publish(type, { ...payload, audienceUserId: record?.value.ownerId ?? null });
      },
    },
  });
  const assistant = new AssistantService({
    repository: repositories.aiAssistance,
    crawler: crawlerAssistant,
    agent: new PiAgentRuntime(() => mutableAi.current()),
    business: assistantBusiness,
    jobs: ctx.jobs,
    configured: () => mutableAi.configured(),
    publish: (type, payload) => ctx.realtime.publish(type, payload),
    enabled: process.env.ZHIYUN_ASSISTANT_ENABLED !== 'false',
  });
  const providerSettings = new AiProviderSettingsService({
    repository: repositories.aiAssistance,
    provider: mutableAi,
    credentials: ctx.credentials,
    mode: ctx.hostCapabilities.metadata.mode,
    headlessConfigured:
      ctx.hostCapabilities.metadata.mode === 'headless' && ctx.aiProvider.name !== 'mock',
    onUsage: async (usage) => {
      await repositories.platform
        .appendEvent({
          type: 'ai.request.completed',
          producerPluginId: 'ai-assistance',
          aggregateType: usage.taskId ? 'task' : 'runtime',
          aggregateId: usage.taskId ?? ctx.hostCapabilities.metadata.runtimeId,
          payload: { ...usage },
        })
        .catch(() => undefined);
    },
    ...(ctx.hostCapabilities.promptCredential
      ? {
          promptCredential: () => ctx.hostCapabilities.promptCredential!('ai-api-key'),
        }
      : {}),
  });
  return {
    mutableAi,
    collectionForAi,
    ruleCache,
    aiAssistance,
    assistantBusiness,
    crawlerAssistant,
    assistant,
    providerSettings,
  };
}
export type RuntimeServices = ReturnType<typeof createServices>;
type Services = RuntimeServices;
declare module '@deepseek-ai/cordis' {
  interface Context {
    mutableAi: Services['mutableAi'];
    collectionForAi: Services['collectionForAi'];
    ruleCache: Services['ruleCache'];
    aiAssistance: Services['aiAssistance'];
    assistantBusiness: Services['assistantBusiness'];
    crawlerAssistant: Services['crawlerAssistant'];
    assistant: Services['assistant'];
    providerSettings: Services['providerSettings'];
  }
}
export async function apply(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const repositories = dependencies.repositories;
  const repository = repositories.aiAssistance;
  ctx.effect(() => () => ctx.runtimeHost.closeRepository(repository), 'ai-assistance-storage');
  await repository.migrate();
  const services = createServices(ctx);
  ctx.provide('ai-assistance.service', services.aiAssistance);
  const { aiAssistance, crawlerAssistant, assistant, providerSettings } = services;
  ctx.provide('mutableAi', services.mutableAi);
  ctx.provide('collectionForAi', services.collectionForAi);
  ctx.provide('ruleCache', services.ruleCache);
  ctx.provide('aiAssistance', services.aiAssistance);
  ctx.provide('assistantBusiness', services.assistantBusiness);
  ctx.provide('crawlerAssistant', services.crawlerAssistant);
  ctx.provide('assistant', services.assistant);
  ctx.provide('providerSettings', services.providerSettings);
  {
    ctx.effect(
      () =>
        ctx.jobHandlers.register({
          type: 'ai.assistant.turn',
          ownerPluginId: 'ai-assistance',
          resourceClass: 'io',
          handler: assistant.createTurnHandler(),
        }),
      'job-handler',
    );
    ctx.effect(
      () =>
        ctx.jobHandlers.register({
          type: 'ai.assistant.browser',
          ownerPluginId: 'ai-assistance',
          resourceClass: 'browser-heavy',
          handler: assistant.createBrowserHandler(),
        }),
      'job-handler',
    );
    ctx.effect(
      () =>
        ctx.jobHandlers.register({
          type: 'ai.conversation.turn',
          ownerPluginId: 'ai-assistance',
          resourceClass: 'browser-heavy',
          handler: crawlerAssistant.createTurnJobHandler(),
        }),
      'job-handler',
    );
  }
  ctx.effect(
    () =>
      ctx.runtimeHost.routes.register('ai-assistance', async (app) => {
        {
          await registerAssistantHttp(app, assistant, repositories.platform);
          await registerAiAssistanceHttp(app, {
            service: aiAssistance,
            platform: repositories.platform,
            crawlerAssistant,
            providerSettings,
          });
        }
      }),
    'ai-assistance-http',
  );
  ownRuntimeEffect(ctx, new AiConversationRetention(repositories.aiAssistance), 'ai-retention');
  ctx.on('runtime/before-jobs', async () => {
    await providerSettings.initialize();
    await repositories.aiAssistance.failInterruptedTurns();
    await assistant.recover();
  });
}
export default { inject, Config, apply };
