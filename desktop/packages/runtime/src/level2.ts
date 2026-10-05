import { createAssistantBusiness } from './assistant-business.js';
import { MutableAnalyticsWorker } from './analytics-worker-adapter.js';
import { AiConversationRetention } from './ai-conversation-retention.js';
import { deliverLocalMonitoringNotification } from './local-notifications.js';
import { taskCreateSchema } from '@zhiyun/contracts';
import { recordExperience } from '@zhiyun/platform-core';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { AnalyticsWorkerClient } from '@zhiyun/analytics-worker-client';
import type {
  AiProvider,
  CrawlerService,
  CredentialStore,
  HostCapabilities,
  SchedulingEnvironment,
} from '@zhiyun/contracts';
import { preferenceImportSchema } from '@zhiyun/contracts';
import type {
  ArtifactStore,
  JobHandlerRegistry,
  PlatformJobQueue,
  PlatformRepository,
} from '@zhiyun/platform-core';
import {
  TREND_SOURCE_CATALOG,
  buildPreferenceProfile,
  contentResolver,
  matchPreferenceTags,
  normalizeTrendRecords,
  preferenceContentFromResolved,
  sourceCatalogEntry,
} from '@zhiyun/preferences';
import { resolveProductGraph } from '@zhiyun/product-profiles';
import {
  AiAssistanceService,
  AssistantService,
  registerAssistantHttp,
  AiProviderSettingsService,
  AnonymousBrowserWebSearch,
  CrawlerAssistantService,
  MutableAiProvider,
  RuleAnalysisCache,
  PiAgentRuntime,
  registerAiAssistanceHttp,
  type AiConversationRepository,
  type CollectionForAiPort,
} from '@zhiyun/plugin-ai-assistance';
import {
  AnalysisJobService,
  AnalysisRecipeService,
  AnalyticsCatalog,
  createAnalysisJobHandler,
  registerAnalyticsHttp,
  type AnalysisRepository,
} from '@zhiyun/plugin-analytics';
import {
  CollectionScheduler,
  CollectionService,
  CollectionBatchCleanup,
  createCollectionJobHandler,
  resolveCollectionTaskSettings,
  registerCollectionHttp,
  commitCanonicalDraft,
  draftFingerprint,
  deterministicUuid,
  protectTaskCredentials,
  verifyInitialRulePreview,
  type CollectionRepository,
} from '@zhiyun/plugin-collection';
import {
  CorpusBuildService,
  CorpusUnavailableError,
  CorpusRecipeService,
  CorpusService,
  createCorpusBuildHandler,
  registerCorpusHttp,
  previewCorpus,
  type CorpusRepository,
} from '@zhiyun/plugin-corpus';
import {
  DatasetSnapshotService,
  DatasetCleaningService,
  registerDatasetsHttp,
  type DatasetRepository,
} from '@zhiyun/plugin-datasets';
import {
  IdentityError,
  IdentityService,
  registerIdentityHttp,
  rolePermissions,
  type IdentityPrincipal,
  type IdentityRepository,
  type IdentityServiceOptions,
} from '@zhiyun/plugin-identity';
import {
  OutputAttemptReplay,
  OutputEventNotificationOutbox,
  OutputsService,
  PlatformOutputArtifactStore,
  createEventNotificationJobHandler,
  createOutputDeliveryJobHandler,
  destinationReceivesRunData,
  enqueueOutputEventNotifications,
  enqueueOutputDelivery,
  registerOutputsHttp,
  type OutputRepository,
} from '@zhiyun/plugin-outputs';
import {
  MonitoringEvaluationOutbox,
  MonitoringService,
  createMonitoringEvaluationJobHandler,
  enqueueMonitoringEvaluation,
  registerMonitoringHttp,
  type MonitoringRepository,
} from '@zhiyun/plugin-monitoring';
import {
  PreferencesHttpError,
  PreferencesService,
  registerPreferencesHttp,
  type PreferencesRepository,
} from '@zhiyun/plugin-preferences';
import {
  RecruitmentDigestScheduler,
  RecruitmentService,
  registerRecruitmentHttp,
  type RecruitmentRepository,
} from '@zhiyun/plugin-recruitment';
import { registerTemplatesHttp } from '@zhiyun/plugin-templates';
import {
  buildRuntimeGateway,
  RealtimeEventHub,
  type RuntimeGateway,
  type RuntimeGatewayOptions,
  type RuntimeReadinessProbe,
} from '@zhiyun/runtime-gateway';
import { InspectionManager } from './inspection.js';

export interface Level2RuntimeRepositories {
  platform: PlatformRepository;
  collection: CollectionRepository;
  datasets: DatasetRepository;
  outputs: OutputRepository;
  preferences: PreferencesRepository;
  analytics: AnalysisRepository;
  corpus: CorpusRepository;
  aiAssistance: AiConversationRepository;
  monitoring: MonitoringRepository;
  recruitment: RecruitmentRepository;
}

export interface Level2RuntimeDependencies {
  repositories: Level2RuntimeRepositories;
  artifactStore: ArtifactStore;
  jobs: PlatformJobQueue;
  handlers: JobHandlerRegistry;
  crawler: CrawlerService;
  ai: AiProvider;
  aiOverride?: () => AiProvider | undefined;
  credentialStore: CredentialStore;
  analyticsWorker?: AnalyticsWorkerClient;
  host: HostCapabilities;
  schedulingEnvironment?: SchedulingEnvironment;
  openApiDocument: unknown;
  readiness?(): Promise<RuntimeReadinessProbe>;
  identity?: {
    repository: IdentityRepository;
    options: IdentityServiceOptions;
    secureCookies?: boolean;
  };
}

export type Level2RuntimeOptions = RuntimeGatewayOptions;

export interface Level2Runtime extends RuntimeGateway {
  setSchedulingEnvironment(environment: SchedulingEnvironment): Promise<void>;
  setAnalyticsWorker(
    worker: AnalyticsWorkerClient | undefined,
    status: HostCapabilities['metadata']['analyticsWorkerStatus'],
  ): void;
}

export async function buildLevel2Runtime(
  dependencies: Level2RuntimeDependencies,
  options: Level2RuntimeOptions,
): Promise<Level2Runtime> {
  const repositories = dependencies.repositories;
  const productGraph = resolveProductGraph(options.profileId);
  const aiEnabled = productGraph.plugins.some(
    ({ descriptor }) => descriptor.id === 'ai-assistance',
  );
  const identityEnabled = productGraph.plugins.some(
    ({ descriptor }) => descriptor.id === 'identity',
  );
  if (identityEnabled !== Boolean(dependencies.identity)) {
    throw new Error(
      identityEnabled
        ? 'Headless Identity is enabled but its SQLite repository and configuration are missing'
        : 'Identity dependencies may only be supplied to the Headless Identity profile',
    );
  }
  const identity = dependencies.identity
    ? new IdentityService(dependencies.identity.repository, dependencies.identity.options)
    : undefined;
  const realtime = new RealtimeEventHub();
  const dataApiRateLimits = new Map<string, { window: number; count: number }>();
  const trendInstallations = new Map<string, Promise<{ taskId: string | null }>>();
  const worker = new MutableAnalyticsWorker(dependencies.analyticsWorker);
  const inspections = new InspectionManager();
  const snapshotService = new DatasetSnapshotService(
    repositories.datasets,
    repositories.platform,
    dependencies.artifactStore,
    worker,
  );
  const cleaningService = new DatasetCleaningService(
    repositories.datasets,
    repositories.platform,
    dependencies.artifactStore,
    worker,
  );
  const collectionService = new CollectionService(repositories.collection, repositories.datasets);
  const collectionBatchCleanup = new CollectionBatchCleanup({
    repository: repositories.collection,
    datasets: repositories.datasets,
    jobs: dependencies.jobs,
    artifacts: dependencies.artifactStore,
  });
  const collectionScheduler = new CollectionScheduler(
    repositories.collection,
    repositories.platform,
    dependencies.jobs,
    5_000,
    dependencies.schedulingEnvironment,
  );
  const outputsService = new OutputsService(repositories.outputs);
  const recruitment = new RecruitmentService({
    repository: repositories.recruitment,
    platform: repositories.platform,
    replaceOutputBindings: (profileId, destinationIds) =>
      outputsService.bindTask(profileId, destinationIds),
    clearOutputBindings: async (profileId) => {
      await outputsService.clearCollectionTask(profileId);
    },
    resolveCredential: (reference) => dependencies.credentialStore.resolve(reference),
    ...(dependencies.host.notify
      ? {
          notify: async (title: string, body: string) => {
            await dependencies.host.notify!(title, body);
          },
        }
      : {}),
    async createErrorArtifact(importJobId, filename, content) {
      const workspace = await dependencies.artifactStore.openWorkspace(importJobId);
      const relativeSource = 'errors.jsonl';
      await writeFile(await workspace.resolve(relativeSource), content, { encoding: 'utf8' });
      const stored = await dependencies.artifactStore.commitWorkspaceFile(
        importJobId,
        relativeSource,
        `recruitment/${importJobId}/${filename}`,
      );
      const artifact = await repositories.platform.createArtifact({
        ownerPluginId: 'recruitment',
        kind: 'recruitment-import-errors',
        filename,
        contentType: 'application/x-ndjson',
        size: stored.size,
        checksum: stored.checksum,
        storageKey: stored.storageKey,
        metadata: { importJobId },
      });
      await dependencies.artifactStore.removeWorkspace(importJobId).catch(() => undefined);
      return artifact.id;
    },
  });
  const monitoring = new MonitoringService(repositories.monitoring, {
    async issue(evaluation, notification) {
      await enqueueOutputEventNotifications(
        { repository: repositories.outputs, jobs: dependencies.jobs },
        {
          eventId: notification.eventId,
          type: 'quality.issue.detected',
          occurredAt: notification.occurredAt,
          taskId: evaluation.taskId,
          runId: evaluation.runId,
          severity: notification.severity,
          payload: notification.payload,
        },
      );
      await deliverLocalMonitoringNotification(dependencies.host, repositories.platform, {
        eventId: notification.eventId,
        taskId: evaluation.taskId,
        runId: evaluation.runId,
        type: 'issue',
        issueCount:
          typeof notification.payload.issueCount === 'number' ? notification.payload.issueCount : 1,
      });
    },
    async recovered(evaluation, notification) {
      await enqueueOutputEventNotifications(
        { repository: repositories.outputs, jobs: dependencies.jobs },
        {
          eventId: notification.eventId,
          type: 'quality.recovered',
          occurredAt: notification.occurredAt,
          taskId: evaluation.taskId,
          runId: evaluation.runId,
          severity: 'info',
          payload: notification.payload,
        },
      );
      await deliverLocalMonitoringNotification(dependencies.host, repositories.platform, {
        eventId: notification.eventId,
        taskId: evaluation.taskId,
        runId: evaluation.runId,
        type: 'recovered',
      });
    },
  });
  const preferencesService = new PreferencesService(repositories.preferences);
  const analyticsCatalog = new AnalyticsCatalog(() => (worker.available() ? worker : undefined));
  const analysisRecipes = new AnalysisRecipeService(repositories.analytics, analyticsCatalog);
  const analysisJobs = new AnalysisJobService(
    repositories.analytics,
    repositories.platform,
    repositories.datasets,
    analyticsCatalog,
    dependencies.jobs,
  );
  const corpora = new CorpusService(repositories.corpus);
  const corpusRecipes = new CorpusRecipeService(repositories.corpus);
  const corpusBuilds = new CorpusBuildService(
    repositories.corpus,
    repositories.platform,
    repositories.datasets,
    () => worker.available(),
    dependencies.jobs,
  );
  const mutableAi = new MutableAiProvider(dependencies.ai, dependencies.aiOverride);
  const crawler: CrawlerService = {
    crawl(input) {
      const { cacheBinding, ...request } = input;
      return dependencies.crawler.crawl({
        ...request,
        ...(cacheBinding && !input.actionCache
          ? {
              actionCache: {
                ...cacheBinding,
                repository: repositories.aiAssistance,
                identity: () => mutableAi.current().cacheIdentity,
              },
            }
          : {}),
      });
    },
  };
  const collectionForAi: CollectionForAiPort = {
    async getTask(id) {
      const task = await repositories.collection.getTask(id);
      if (!task) return null;
      const settings = await resolveCollectionTaskSettings(
        task.requestSettings,
        task.browserSettings,
        task.credentialBindings,
        dependencies.credentialStore,
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
  const aiAssistance = new AiAssistanceService(collectionForAi, mutableAi, crawler, ruleCache);
  const assistantBusiness = createAssistantBusiness({ ...dependencies, crawler }, aiAssistance);
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
        const settings = await resolveCollectionTaskSettings(
          task.requestSettings,
          task.browserSettings,
          task.credentialBindings,
          dependencies.credentialStore,
        );
        return { ...task, ...settings };
      },
      async create(legacy, conversationId) {
        const now = new Date().toISOString();
        return repositories.collection.createDraft({
          id: deterministicUuid(`legacy-ai:${conversationId}`),
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
        if (draftFingerprint(next) !== draftFingerprint(draft)) next.preview = null;
        const result = await repositories.collection.updateDraft(next, revision);
        if (!result) throw new Error('REVISION_CONFLICT: Draft changed during AI editing');
        if (!result.taskId && (result.task.startUrl || result.task.instruction))
          await recordExperience(repositories.platform, {
            id: result.id,
            type: 'creation_started',
            taskId: deterministicUuid(`draft:${result.id}:task`),
            example: Boolean(result.exampleId),
          }).catch(() => undefined);
        return result;
      },
      async preview(id, revision, signal) {
        return assistantBusiness.previewDraft(id, revision, signal ?? AbortSignal.timeout(30_000));
      },
      async commit(id, revision) {
        const draft = await repositories.collection.getDraft(id);
        if (!draft) throw new Error('Draft was not found');
        if (draft.status === 'committed' && draft.result) return { taskId: draft.result.taskId };
        if (draft.revision !== revision)
          throw new Error('REVISION_CONFLICT: Draft changed before submission');
        const result = await commitCanonicalDraft(
          {
            repository: repositories.collection,
            platform: repositories.platform,
            jobs: dependencies.jobs,
            credentialStore: dependencies.credentialStore,
            runtimeMode: dependencies.host.metadata.mode,
            bindings: {
              list: (taskId) => repositories.outputs.listTaskBindings(taskId),
              replace: (taskId, ids) => outputsService.bindTask(taskId, ids),
              clear: async (taskId) => {
                await outputsService.clearCollectionTask(taskId);
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
    crawler,
    search: new AnonymousBrowserWebSearch(),
    jobs: dependencies.jobs,
    realtime: {
      publish: async (type, payload) => {
        const record =
          typeof payload.conversationId === 'string'
            ? await repositories.aiAssistance.getAssistantRecord(
                `session:${payload.conversationId}`,
              )
            : null;
        realtime.publish(type, { ...payload, audienceUserId: record?.value.ownerId ?? null });
      },
    },
  });
  const assistant = new AssistantService({
    repository: repositories.aiAssistance,
    crawler: crawlerAssistant,
    agent: new PiAgentRuntime(() => mutableAi.current()),
    business: assistantBusiness,
    jobs: dependencies.jobs,
    configured: () => mutableAi.configured(),
    publish: (type, payload) => realtime.publish(type, payload),
    enabled: process.env.ZHIYUN_ASSISTANT_ENABLED !== 'false',
  });

  const providerSettings = new AiProviderSettingsService({
    repository: repositories.aiAssistance,
    provider: mutableAi,
    credentials: dependencies.credentialStore,
    mode: dependencies.host.metadata.mode,
    headlessConfigured:
      dependencies.host.metadata.mode === 'headless' && dependencies.ai.name !== 'mock',
    onUsage: async (usage) => {
      await repositories.platform
        .appendEvent({
          type: 'ai.request.completed',
          producerPluginId: 'ai-assistance',
          aggregateType: usage.taskId ? 'task' : 'runtime',
          aggregateId: usage.taskId ?? dependencies.host.metadata.runtimeId,
          payload: { ...usage },
        })
        .catch(() => undefined);
    },
    ...(dependencies.host.promptCredential
      ? {
          promptCredential: () => dependencies.host.promptCredential!('ai-api-key'),
        }
      : {}),
  });

  dependencies.handlers.register({
    type: 'collection.crawl.execute',
    ownerPluginId: 'collection',
    resourceClass: 'browser-heavy',
    handler: createCollectionJobHandler({
      repository: repositories.collection,
      service: collectionService,
      crawler,
      credentialStore: dependencies.credentialStore,
      artifacts: dependencies.artifactStore,
      async afterSucceeded({ task, run }) {
        await assistant.notifyRun(task.id, run).catch(() => undefined);
        await recordExperience(repositories.platform, {
          id: run.id,
          type: 'run_succeeded',
          taskId: task.id,
          example: task.origin.kind === 'example',
          durationMs: Math.max(
            0,
            Date.parse(run.finishedAt ?? run.createdAt) - Date.parse(run.createdAt),
          ),
        }).catch(() => undefined);
        await enqueueMonitoringEvaluation(dependencies.jobs, {
          taskId: task.id,
          runId: run.id,
          outcome: 'succeeded',
        }).catch(async (error) => {
          await repositories.collection
            .appendRunLog({
              runId: run.id,
              level: 'warn',
              phase: 'monitoring',
              message: `Quality evaluation could not be queued: ${error instanceof Error ? error.message : String(error)}`,
              url: null,
              errorCode: 'MONITORING_ERROR',
              metadata: {},
            })
            .catch(() => undefined);
        });
        const succeededEvent = await repositories.platform.appendEvent({
          type: 'run.succeeded',
          producerPluginId: 'collection',
          aggregateType: 'run',
          aggregateId: run.id,
          payload: {
            taskId: task.id,
            runId: run.id,
            recordCount: run.recordCount,
            datasetStats: run.datasetStats,
          },
        });
        await enqueueOutputEventNotifications(
          { repository: repositories.outputs, jobs: dependencies.jobs },
          {
            eventId: succeededEvent.id,
            type: 'run.succeeded',
            occurredAt: succeededEvent.occurredAt,
            taskId: task.id,
            runId: run.id,
            severity: 'info',
            payload: succeededEvent.payload,
          },
        ).catch(() => undefined);
        if (run.datasetStats.added + run.datasetStats.updated + run.datasetStats.removed > 0) {
          const changedEvent = await repositories.platform.appendEvent({
            type: 'dataset.changed',
            producerPluginId: 'datasets',
            aggregateType: 'run',
            aggregateId: run.id,
            payload: {
              taskId: task.id,
              runId: run.id,
              changes: run.datasetStats,
            },
          });
          await enqueueOutputEventNotifications(
            { repository: repositories.outputs, jobs: dependencies.jobs },
            {
              eventId: changedEvent.id,
              type: 'dataset.changed',
              occurredAt: changedEvent.occurredAt,
              taskId: task.id,
              runId: run.id,
              severity: 'info',
              payload: changedEvent.payload,
            },
          ).catch(() => undefined);
        }
        const existing = new Map(
          (await repositories.outputs.listDeliveryAttempts(run.id)).map((attempt) => [
            attempt.destinationId,
            attempt,
          ]),
        );
        for (const destinationId of await repositories.outputs.listTaskBindings(task.id)) {
          const destination = await repositories.outputs.getDestination(destinationId);
          if (!destinationReceivesRunData(destination)) continue;
          const attempt =
            existing.get(destinationId) ??
            (await repositories.outputs.createDeliveryAttempt({
              destinationId,
              taskId: task.id,
              runId: run.id,
            }));
          if (attempt.status !== 'succeeded') {
            await enqueueOutputDelivery(dependencies.jobs, attempt);
          }
        }
      },
      async afterFailed({ task, run }) {
        await assistant.notifyRun(task.id, run).catch(() => undefined);
        const failedEvent = await repositories.platform.appendEvent({
          type: 'run.failed',
          producerPluginId: 'collection',
          aggregateType: 'run',
          aggregateId: run.id,
          payload: { taskId: task.id, runId: run.id, error: run.error },
        });
        await enqueueOutputEventNotifications(
          { repository: repositories.outputs, jobs: dependencies.jobs },
          {
            eventId: failedEvent.id,
            type: 'run.failed',
            occurredAt: failedEvent.occurredAt,
            taskId: task.id,
            runId: run.id,
            severity: 'error',
            payload: failedEvent.payload,
          },
        ).catch(() => undefined);
        await enqueueMonitoringEvaluation(dependencies.jobs, {
          taskId: task.id,
          runId: run.id,
          outcome: 'failed',
        }).catch(() => undefined);
      },
    }),
  });
  dependencies.handlers.register({
    type: 'monitoring.quality.evaluate',
    ownerPluginId: 'monitoring',
    resourceClass: 'io',
    handler: createMonitoringEvaluationJobHandler({
      service: monitoring,
      collection: repositories.collection,
      datasets: repositories.datasets,
    }),
  });
  if (aiEnabled) {
    dependencies.handlers.register({
      type: 'ai.assistant.turn',
      ownerPluginId: 'ai-assistance',
      resourceClass: 'io',
      handler: assistant.createTurnHandler(),
    });
    dependencies.handlers.register({
      type: 'ai.assistant.browser',
      ownerPluginId: 'ai-assistance',
      resourceClass: 'browser-heavy',
      handler: assistant.createBrowserHandler(),
    });
    dependencies.handlers.register({
      type: 'ai.conversation.turn',
      ownerPluginId: 'ai-assistance',
      resourceClass: 'browser-heavy',
      handler: crawlerAssistant.createTurnJobHandler(),
    });
  }

  const installTrendSource = (key: string): Promise<{ taskId: string | null }> => {
    const active = trendInstallations.get(key);
    if (active) return active;
    const installation = (async () => {
      const entry = sourceCatalogEntry(key);
      if (!entry?.supported || !entry.task || !entry.plan) return { taskId: null };
      const binding = await repositories.preferences.getTrendSourceBinding(key);
      let task = binding?.taskId ? await repositories.collection.getTask(binding.taskId) : null;
      if (!task) {
        const page = await repositories.collection.listTasks(undefined, 1_000);
        const reusable = page.items.find(
          (candidate) =>
            candidate.startUrl === entry.task!.startUrl && candidate.name === entry.task!.name,
        );
        task = reusable ? await repositories.collection.getTask(reusable.id) : null;
      }
      if (!task) {
        const { outputBindings, ...collectionInput } = entry.task;
        void outputBindings;
        const created = await repositories.collection.createTask(collectionInput);
        task = await repositories.collection.getTask(created.id);
      }
      if (!task) throw new Error(`Trend source ${key} could not create its Collection Task`);
      if (!task.activeRule) {
        await repositories.collection.createRule(
          task.id,
          `${entry.name}规则`,
          entry.plan,
          'system',
        );
      }
      return { taskId: task.id };
    })().finally(() => trendInstallations.delete(key));
    trendInstallations.set(key, installation);
    return installation;
  };

  const runTrendSource = async (key: string): Promise<Record<string, unknown>> => {
    const entry = sourceCatalogEntry(key);
    if (!entry?.supported) return { key, status: 'skipped', reason: 'unsupported' };
    let binding = await repositories.preferences.getTrendSourceBinding(key);
    if (binding && !binding.enabled) return { key, status: 'skipped', reason: 'disabled' };
    if (!binding?.taskId) {
      const installed = await installTrendSource(key);
      binding = await repositories.preferences.upsertTrendSourceBinding({
        key,
        platform: entry.platform,
        taskId: installed.taskId,
        enabled: binding?.enabled ?? true,
        autoRefresh: binding?.autoRefresh ?? true,
      });
    }
    if (!binding.taskId) return { key, status: 'skipped', reason: 'not-installed' };
    const active = (await repositories.collection.listRuns(binding.taskId)).find((run) =>
      ['queued', 'running', 'persisting'].includes(run.status),
    );
    if (active) {
      return { key, taskId: binding.taskId, runId: active.id, status: 'already-running' };
    }
    const run = await repositories.collection.createRun(binding.taskId);
    await dependencies.jobs.enqueue({
      id: run.id,
      ownerPluginId: 'collection',
      type: 'collection.crawl.execute',
      resourceClass: 'browser-heavy',
      payload: { taskId: binding.taskId, runId: run.id },
      maxAttempts: 2,
    });
    return { key, taskId: binding.taskId, runId: run.id, status: 'queued' };
  };
  dependencies.handlers.register({
    type: 'outputs.delivery.execute',
    ownerPluginId: 'outputs',
    resourceClass: 'delivery',
    handler: createOutputDeliveryJobHandler({
      afterDelivered: async (taskId, id) => {
        const task = await repositories.collection.getTask(taskId);
        await recordExperience(repositories.platform, {
          id,
          type: 'sync_completed',
          taskId,
          example: !task || task.origin.kind === 'example',
        });
      },
      repository: repositories.outputs,
      tasks: repositories.collection,
      datasets: repositories.datasets,
      credentials: dependencies.credentialStore,
      artifacts: new PlatformOutputArtifactStore(dependencies.artifactStore, {
        parquetWorker: worker,
      }),
    }),
  });
  dependencies.handlers.register({
    type: 'outputs.event-notification.execute',
    ownerPluginId: 'outputs',
    resourceClass: 'delivery',
    handler: createEventNotificationJobHandler({
      repository: repositories.outputs,
      credentials: dependencies.credentialStore,
    }),
  });
  dependencies.handlers.register({
    type: 'analytics.job.execute',
    ownerPluginId: 'analytics',
    resourceClass: 'python-heavy',
    handler: createAnalysisJobHandler({
      afterCompleted: async (datasetId, id) => {
        const dataset = await repositories.datasets.getDataset(datasetId);
        if (!dataset) return;
        const task = await repositories.collection.getTask(dataset.sourceTaskId);
        await recordExperience(repositories.platform, {
          id,
          type: 'analysis_completed',
          taskId: dataset.sourceTaskId,
          example: !task || task.origin.kind === 'example',
        });
      },
      repository: repositories.analytics,
      platform: repositories.platform,
      snapshots: repositories.datasets,
      artifactStore: dependencies.artifactStore,
      worker,
    }),
  });
  dependencies.handlers.register({
    type: 'corpus.build.execute',
    ownerPluginId: 'corpus',
    resourceClass: 'python-heavy',
    handler: createCorpusBuildHandler({
      repository: repositories.corpus,
      platform: repositories.platform,
      snapshots: repositories.datasets,
      artifactStore: dependencies.artifactStore,
      worker,
    }),
  });

  const registerPluginHttp = async (app: FastifyInstance) => {
    if (identity && dependencies.identity) {
      await registerIdentityHttp(app, identity, {
        ...(dependencies.identity.secureCookies === undefined
          ? {}
          : { secureCookies: dependencies.identity.secureCookies }),
      });
    }
    await registerDatasetsHttp(app, {
      cleaning: cleaningService,
      repository: repositories.datasets,
      onRunExported: async (runId, id) => {
        const run = await repositories.collection.getRun(runId);
        const task = run ? await repositories.collection.getTask(run.taskId) : null;
        if (task)
          await recordExperience(repositories.platform, {
            id,
            type: 'export_completed',
            taskId: task.id,
            example: task.origin.kind === 'example',
          });
      },
      onExported: async (taskId, id) => {
        const task = await repositories.collection.getTask(taskId);
        await recordExperience(repositories.platform, {
          id,
          type: 'export_completed',
          taskId,
          example: !task || task.origin.kind === 'example',
        });
      },
      taskSummaries: (query, ids) => repositories.collection.taskSummaries(query, ids),
      qualitySummaries: (ids) => repositories.monitoring.getHealthMany(ids),
      snapshots: snapshotService,
      platform: repositories.platform,
      artifactStore: dependencies.artifactStore,
    });
    await registerCollectionHttp(app, {
      repository: repositories.collection,
      platform: repositories.platform,
      jobs: dependencies.jobs,
      batches: collectionBatchCleanup,
      bindings: {
        list: (taskId) => repositories.outputs.listTaskBindings(taskId),
        replace: (taskId, destinationIds) => outputsService.bindTask(taskId, destinationIds),
        clear: async (taskId) => {
          await outputsService.clearCollectionTask(taskId);
        },
      },
      cleanup: [
        {
          clearTask: async (taskId) => {
            await preferencesService.clearCollectionTaskReference(taskId);
          },
        },
        { clearTask: (taskId) => repositories.monitoring.deleteTask(taskId) },
      ],
      credentialStore: dependencies.credentialStore,
      runtimeMode: dependencies.host.metadata.mode,
      ...(dependencies.host.promptCredential
        ? { promptCredential: dependencies.host.promptCredential.bind(dependencies.host) }
        : {}),
      ...(dependencies.host.createLoginSession
        ? { createLoginSession: dependencies.host.createLoginSession.bind(dependencies.host) }
        : {}),
      inspection: {
        async create(task) {
          const settings = await resolveCollectionTaskSettings(
            task.requestSettings,
            task.browserSettings,
            task.credentialBindings,
            dependencies.credentialStore,
          );
          return inspections.create({
            url: task.startUrl,
            requestSettings: settings.requestSettings,
            browserSettings: settings.browserSettings,
            networkPolicy: task.networkPolicy,
          });
        },
        screenshot: (id) => inspections.screenshot(id),
        action: (id, input) => inspections.action(id, input),
        step: (id, input) => inspections.step(id, input),
        select: (id, x, y) => inspections.select(id, x, y),
        close: (id) => inspections.close(id),
      },
      async previewRule(task, definition, limit, cacheBinding) {
        const settings = await resolveCollectionTaskSettings(
          task.requestSettings,
          task.browserSettings,
          task.credentialBindings,
          dependencies.credentialStore,
        );
        return crawler.crawl({
          url: task.startUrl,
          plan: definition,
          requestSettings: settings.requestSettings,
          browserSettings: settings.browserSettings,
          pagination: task.pagination,
          networkPolicy: task.networkPolicy,
          previewLimit: limit,
          cacheBinding: cacheBinding ?? {
            scope: `task:${task.id}`,
            taskVersion: task.revision,
            ruleVersion: `preview:${createHash('sha256').update(JSON.stringify(definition)).digest('hex')}`,
            configuration: task.datasetSettings,
          },
        });
      },
    });
    await registerOutputsHttp(app, {
      repository: repositories.outputs,
      jobs: dependencies.jobs,
      credentialStore: dependencies.credentialStore,
      ...(dependencies.host.promptCredential
        ? { promptCredential: (kind) => dependencies.host.promptCredential!(kind) }
        : {}),
      ...(dependencies.host.selectOutputDirectory
        ? {
            selectOutputDirectory: () => dependencies.host.selectOutputDirectory!(),
          }
        : {}),
    });
    await registerMonitoringHttp(app, {
      repository: repositories.monitoring,
      tasks: repositories.collection,
    });
    await registerRecruitmentHttp(app, recruitment);
    await registerTemplatesHttp(app, {
      collection: repositories.collection,
      platform: repositories.platform,
      protectTask: (task) =>
        protectTaskCredentials(task, {
          credentialStore: dependencies.credentialStore,
          runtimeMode: dependencies.host.metadata.mode,
        }),
      verifyPreview: (key, input) => verifyInitialRulePreview(repositories.platform, key, input),
      quality: repositories.monitoring,
    });
    await registerPreferencesHttp(app, {
      repository: repositories.preferences,
      service: preferencesService,
      bootstrapTrendSource: installTrendSource,
      runTrendSource,
      async trendItems() {
        const bindings = await repositories.preferences.listTrendSourceBindings();
        const groups = await Promise.all(
          bindings
            .filter((binding) => binding.enabled && binding.taskId)
            .map(async (binding) => {
              const dataset = await repositories.datasets.getDatasetBySourceTask(binding.taskId!);
              if (!dataset) return [];
              const page = await repositories.datasets.listRecords(dataset.id, undefined, 500, {
                includeRemoved: false,
              });
              return normalizeTrendRecords(binding.key, page.items);
            }),
        );
        const signals = await preferencesService.listSignals(undefined, 10_000);
        const profile = buildPreferenceProfile(signals.items);
        const order = new Map(TREND_SOURCE_CATALOG.map((entry, index) => [entry.key, index]));
        return matchPreferenceTags(groups.flat(), profile).sort(
          (left, right) =>
            (order.get(left.sourceKey) ?? 99) - (order.get(right.sourceKey) ?? 99) ||
            (left.rank ?? 999) - (right.rank ?? 999),
        );
      },
      async importPreference(body) {
        const input = preferenceImportSchema.parse(body);
        const resolver = contentResolver(input.url);
        if (!resolver) {
          throw new PreferencesHttpError(
            422,
            'NAVIGATION_ERROR',
            'Only supported public content links can be imported',
          );
        }
        const result = await dependencies.crawler.crawl({
          url: resolver.crawlUrl ?? input.url,
          plan: resolver.plan,
          requestSettings: {
            headers: {},
            cookies: [],
            timeoutMs: 20_000,
            retries: 0,
            retryBackoffMs: 1_000,
            concurrency: 1,
            delayMs: 1_500,
            maxRequests: 1,
            maxRuntimeMs: 30_000,
            domainRateLimitPerMinute: 40,
            respectRobotsTxt: true,
            maxResponseBytes: 5 * 1024 * 1024,
            redirectLimit: 5,
            userAgent: 'Mozilla/5.0 (compatible; ZhiYun/1.0; public-metadata-crawl)',
          },
          browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
          pagination: { type: 'none' },
          networkPolicy: { allowPrivateNetworks: false, allowedHosts: [], allowedCidrs: [] },
          previewLimit: 1,
        });
        const resolved = result.records[0];
        const finalResolver = resolved ? contentResolver(resolved.sourceUrl) : null;
        if (!resolved || !finalResolver || finalResolver.platform !== resolver.platform) {
          throw new PreferencesHttpError(
            422,
            'NAVIGATION_ERROR',
            'The URL did not resolve to supported public content metadata',
          );
        }
        const content = preferenceContentFromResolved(
          resolver.platform,
          resolved.data,
          resolved.sourceUrl,
        );
        if (!content) {
          throw new PreferencesHttpError(
            422,
            'EXTRACTION_ERROR',
            'Public content metadata could not be extracted',
          );
        }
        return preferencesService.setSignal({ kind: input.kind, content });
      },
    });
    await registerAnalyticsHttp(app, {
      artifactStore: dependencies.artifactStore,
      catalog: analyticsCatalog,
      recipes: analysisRecipes,
      jobs: analysisJobs,
      platform: repositories.platform,
    });
    await registerCorpusHttp(app, {
      corpora,
      recipes: corpusRecipes,
      builds: corpusBuilds,
      platform: repositories.platform,
      preview: (corpusId, snapshotId, recipe) => {
        if (!worker.available())
          throw new CorpusUnavailableError('Analytics Worker is unavailable');
        return previewCorpus(
          {
            repository: repositories.corpus,
            platform: repositories.platform,
            snapshots: repositories.datasets,
            artifactStore: dependencies.artifactStore,
            worker,
          },
          corpusId,
          snapshotId,
          recipe,
        );
      },
    });
    if (aiEnabled) {
      await registerAssistantHttp(app, assistant, repositories.platform);
      await registerAiAssistanceHttp(app, {
        service: aiAssistance,
        platform: repositories.platform,
        crawlerAssistant,
        providerSettings,
      });
    }
  };

  const gateway = await buildRuntimeGateway(
    {
      platform: repositories.platform,
      artifactStore: dependencies.artifactStore,
      jobs: dependencies.jobs,
      realtime,
      ...(aiEnabled
        ? {
            beforeJobsStart: () =>
              repositories.aiAssistance.failInterruptedTurns().then(() => assistant.recover()),
          }
        : {}),
      migrations: [
        { pluginId: 'platform', migrate: async () => undefined, close: async () => undefined },
        migration('datasets', repositories.datasets),
        migration('collection', repositories.collection),
        migration('outputs', repositories.outputs),
        migration('monitoring', repositories.monitoring),
        migration('preferences', repositories.preferences),
        migration('recruitment', repositories.recruitment),
        migration('analytics', repositories.analytics),
        migration('corpus', repositories.corpus),
        ...(aiEnabled ? [migration('ai-assistance', repositories.aiAssistance)] : []),
        ...(dependencies.identity ? [migration('identity', dependencies.identity.repository)] : []),
      ],
      registerPluginHttp,
      async recordExperienceEntry(draftId) {
        const draft = await repositories.collection.getDraft(draftId);
        if (!draft || draft.exampleId || draft.taskId) return;
        const bytes = createHash('sha256')
          .update(`draft:${draft.id}:task`)
          .digest()
          .subarray(0, 16);
        bytes[6] = (bytes[6]! & 0x0f) | 0x50;
        bytes[8] = (bytes[8]! & 0x3f) | 0x80;
        const hex = bytes.toString('hex');
        const taskId =
          draft.taskId ??
          `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        await recordExperience(repositories.platform, {
          id: draft.id,
          type: 'creation_started',
          taskId,
        });
      },
      metadata: dependencies.host.metadata,
      capabilities: dependencies.host.capabilities,
      openApiDocument: dependencies.openApiDocument,
      ...(dependencies.readiness ? { readiness: dependencies.readiness } : {}),
      effects: [
        { start: () => undefined, close: () => cleaningService.close() },
        new MonitoringEvaluationOutbox(repositories.platform, dependencies.jobs),
        new OutputEventNotificationOutbox(
          repositories.platform,
          repositories.outputs,
          dependencies.jobs,
        ),
        new OutputAttemptReplay(repositories.outputs, dependencies.jobs),
        new RecruitmentDigestScheduler(recruitment),
        collectionScheduler,
        collectionBatchCleanup,
        ...(aiEnabled
          ? [
              {
                start: () => providerSettings.initialize(),
                close: async () => undefined,
              },
              new AiConversationRetention(repositories.aiAssistance),
            ]
          : []),
        { start: () => undefined, close: () => inspections.closeAll() },
      ],
      ...(dependencies.host.saveArtifact
        ? {
            saveArtifact: (artifact) =>
              dependencies.host.saveArtifact!(
                {
                  id: artifact.id,
                  runId:
                    typeof artifact.metadata.runId === 'string'
                      ? artifact.metadata.runId
                      : artifact.id,
                  format: artifactFormat(artifact.filename),
                  filename: artifact.filename,
                  contentType: artifact.contentType,
                  size: artifact.size,
                  createdAt: artifact.createdAt,
                },
                { storageKey: artifact.storageKey },
              ),
          }
        : {}),
      async authenticateDataToken(token) {
        const tokenHash = createHash('sha256').update(token).digest('hex');
        const stored = await repositories.outputs.findApiToken(tokenHash);
        if (!stored || (stored.expiresAt && Date.parse(stored.expiresAt) <= Date.now())) {
          return {
            ok: false as const,
            status: 401 as const,
            code: 'UNAUTHORIZED',
            detail: 'Invalid or expired Data API token',
          };
        }
        const window = Math.floor(Date.now() / 60_000);
        const current = dataApiRateLimits.get(stored.id);
        const counter = current?.window === window ? current : { window, count: 0 };
        if (counter.count >= stored.rateLimitPerMinute) {
          return {
            ok: false as const,
            status: 429 as const,
            code: 'RATE_LIMITED',
            detail: 'Data API rate limit exceeded',
          };
        }
        counter.count += 1;
        dataApiRateLimits.set(stored.id, counter);
        return { ok: true as const, principal: { tokenId: stored.id, taskIds: stored.taskIds } };
      },
      ...(identity
        ? {
            workspaceAuthorization: {
              async authenticate(input: {
                sessionToken: string | undefined;
                csrfToken: string | undefined;
                mutation: boolean;
              }) {
                let principal: IdentityPrincipal;
                try {
                  principal = await identity.authenticate(input.sessionToken ?? '');
                } catch (error) {
                  if (error instanceof IdentityError && [401, 403].includes(error.status)) {
                    return {
                      ok: false as const,
                      status: error.status as 401 | 403,
                      code: error.code,
                      detail: error.message,
                    };
                  }
                  throw error;
                }
                const gatewayPrincipal = {
                  userId: principal.user.id,
                  email: principal.user.email,
                  role: principal.user.role,
                };
                if (input.mutation) {
                  try {
                    identity.verifyCsrf(principal, input.csrfToken);
                  } catch (error) {
                    if (error instanceof IdentityError && error.status === 403) {
                      return {
                        ok: false as const,
                        status: 403 as const,
                        code: error.code,
                        detail: error.message,
                        principal: gatewayPrincipal,
                      };
                    }
                    throw error;
                  }
                }
                return {
                  ok: true as const,
                  principal: gatewayPrincipal,
                  permissions: rolePermissions[principal.user.role],
                };
              },
              audit(input: {
                principal: Record<string, unknown>;
                operationId: string;
                resourceType: string;
                resourceId: string | null;
                result: 'succeeded' | 'failed' | 'denied';
                statusCode: number;
                traceId: string;
                network: string;
              }) {
                const actorUserId = input.principal.userId;
                if (typeof actorUserId !== 'string' || !actorUserId) {
                  throw new Error('Authenticated workspace principal has no user ID');
                }
                return identity.recordOperation({
                  actorUserId,
                  operationId: input.operationId,
                  resourceType: input.resourceType,
                  resourceId: input.resourceId,
                  result: input.result,
                  statusCode: input.statusCode,
                  traceId: input.traceId,
                  network: input.network,
                });
              },
            },
          }
        : {}),
    },
    options,
  );
  return {
    ...gateway,
    setSchedulingEnvironment: (environment) => collectionScheduler.setEnvironment(environment),
    async close() {
      await cleaningService.close();
      await gateway.close();
    },
    setAnalyticsWorker(nextWorker, status) {
      worker.set(nextWorker);
      gateway.setAnalyticsWorkerStatus(status);
    },
  };
}

function artifactFormat(filename: string): 'csv' | 'json' | 'xlsx' {
  if (filename.toLowerCase().endsWith('.csv')) return 'csv';
  if (filename.toLowerCase().endsWith('.xlsx')) return 'xlsx';
  return 'json';
}

function migration(
  pluginId: string,
  repository: { migrate(): Promise<void>; close(): Promise<void> },
) {
  return {
    pluginId,
    migrate: () => repository.migrate(),
    close: () => repository.close(),
  };
}
