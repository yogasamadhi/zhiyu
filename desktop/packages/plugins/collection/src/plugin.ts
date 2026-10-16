import { type Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { CrawlerService } from '@zhiyun/contracts';
import { recordExperience } from '@zhiyun/platform-core';
import { ownRuntimeEffect } from '@zhiyun/runtime-contracts';
import { createHash } from 'node:crypto';
import {
  CollectionBatchCleanup,
  CollectionScheduler,
  CollectionService,
  commitCanonicalDraft,
  createCollectionJobHandler,
  deterministicUuid,
  draftFingerprint,
  enqueueRun,
  executeProductExample,
  productExampleDraft,
  protectTaskCredentials,
  registerCollectionHttp,
  resolveCollectionTaskSettings,
  verifyInitialRulePreview,
} from './index.js';
import { InspectionManager } from './inspection.js';

export const inject = [
  'aiProvider',
  'artifacts',
  'crawlerProvider',
  'credentials',
  'hostCapabilities',
  'jobHandlers',
  'jobs',
  'preferencesService',
  'runtimeHost',
];
export const Config = Schema.object({
  schedulerIntervalMs: Schema.number().min(100).default(5_000),
});
function createServices(ctx: Context, config: ReturnType<typeof Config>) {
  const { dependencies } = ctx.runtimeHost;
  const repositories = dependencies.repositories;
  const inspections = new InspectionManager();
  const collectionService = new CollectionService(repositories.collection, repositories.datasets);
  const collectionBatchCleanup = new CollectionBatchCleanup({
    repository: repositories.collection,
    datasets: repositories.datasets,
    jobs: ctx.jobs,
    artifacts: ctx.artifacts,
  });
  const collectionScheduler = new CollectionScheduler(
    repositories.collection,
    repositories.platform,
    ctx.jobs,
    config.schedulerIntervalMs,
    dependencies.schedulingEnvironment,
  );
  const crawler: CrawlerService = {
    crawl(input) {
      const { cacheBinding, ...request } = input;
      return ctx.crawlerProvider.crawl({
        ...request,
        ...(cacheBinding && ctx.get('mutableAi') && !input.actionCache
          ? {
              actionCache: {
                ...cacheBinding,
                repository: repositories.aiAssistance,
                identity: () => (ctx.get('mutableAi')?.current() ?? ctx.aiProvider).cacheIdentity,
              },
            }
          : {}),
      });
    },
  };
  const recordExperienceEntry: (draftId: string) => Promise<void> = async function (
    draftId: string,
  ) {
    const draft = await repositories.collection.getDraft(draftId);
    if (!draft || draft.exampleId || draft.taskId) return;
    const bytes = createHash('sha256').update(`draft:${draft.id}:task`).digest().subarray(0, 16);
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
  };
  return {
    productExampleDraft,
    executeProductExample,
    enqueueRun,
    recordExperienceEntry,
    inspections,
    collectionService,
    collectionBatchCleanup,
    collectionScheduler,
    crawler,
    protectTaskCredentials,
    verifyInitialRulePreview,
    resolveCollectionTaskSettings,
    deterministicUuid,
    draftFingerprint,
    commitCanonicalDraft,
  };
}
export type RuntimeServices = ReturnType<typeof createServices>;
type Services = RuntimeServices;
declare module '@deepseek-ai/cordis' {
  interface Context {
    productExampleDraft: Services['productExampleDraft'];
    executeProductExample: Services['executeProductExample'];
    enqueueRun: Services['enqueueRun'];
    recordExperienceEntry: Services['recordExperienceEntry'];
    inspections: Services['inspections'];
    collectionService: Services['collectionService'];
    collectionBatchCleanup: Services['collectionBatchCleanup'];
    collectionScheduler: Services['collectionScheduler'];
    crawler: Services['crawler'];
    protectTaskCredentials: Services['protectTaskCredentials'];
    verifyInitialRulePreview: Services['verifyInitialRulePreview'];
    resolveCollectionTaskSettings: Services['resolveCollectionTaskSettings'];
    deterministicUuid: Services['deterministicUuid'];
    draftFingerprint: Services['draftFingerprint'];
    commitCanonicalDraft: Services['commitCanonicalDraft'];
  }
}
export async function apply(ctx: Context, config: ReturnType<typeof Config>) {
  const { dependencies } = ctx.runtimeHost;
  const repositories = dependencies.repositories;
  const repository = repositories.collection;
  ctx.effect(() => () => ctx.runtimeHost.closeRepository(repository), 'collection-storage');
  await repository.migrate();
  const services = createServices(ctx, config);
  ctx.provide('collection.read', repositories.collection);
  ctx.provide('collection.services', services.collectionService);
  ctx.provide('commitCanonicalDraft', services.commitCanonicalDraft);
  ctx.provide('deterministicUuid', services.deterministicUuid);
  ctx.provide('draftFingerprint', services.draftFingerprint);
  ctx.provide('productExampleDraft', services.productExampleDraft);
  ctx.provide('executeProductExample', services.executeProductExample);
  ctx.provide('resolveCollectionTaskSettings', services.resolveCollectionTaskSettings);
  ctx.provide('enqueueRun', services.enqueueRun);
  ctx.provide('recordExperienceEntry', services.recordExperienceEntry);
  const { inspections, collectionService, collectionBatchCleanup, collectionScheduler, crawler } =
    services;
  ctx.provide('inspections', services.inspections);
  ctx.provide('collectionService', services.collectionService);
  ctx.provide('collectionBatchCleanup', services.collectionBatchCleanup);
  ctx.provide('collectionScheduler', services.collectionScheduler);
  ctx.provide('crawler', services.crawler);
  ctx.provide('protectTaskCredentials', services.protectTaskCredentials);
  ctx.provide('verifyInitialRulePreview', services.verifyInitialRulePreview);
  ctx.effect(
    () =>
      ctx.jobHandlers.register({
        type: 'collection.crawl.execute',
        ownerPluginId: 'collection',
        resourceClass: 'browser-heavy',
        handler: createCollectionJobHandler({
          repository: repositories.collection,
          service: collectionService,
          crawler,
          credentialStore: ctx.credentials,
          artifacts: ctx.artifacts,
          async afterSucceeded({ task, run }) {
            await ctx
              .get('assistant')
              ?.notifyRun(task.id, run)
              .catch(() => undefined);
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
            await ctx
              .get('enqueueMonitoringEvaluation')?.(ctx.jobs, {
                taskId: task.id,
                runId: run.id,
                outcome: 'succeeded',
              })
              .catch(async (error) => {
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
            await ctx
              .get('enqueueOutputEventNotifications')?.(
                { repository: repositories.outputs, jobs: ctx.jobs },
                {
                  eventId: succeededEvent.id,
                  type: 'run.succeeded',
                  occurredAt: succeededEvent.occurredAt,
                  taskId: task.id,
                  runId: run.id,
                  severity: 'info',
                  payload: succeededEvent.payload,
                },
              )
              .catch(() => undefined);
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
              await ctx
                .get('enqueueOutputEventNotifications')?.(
                  { repository: repositories.outputs, jobs: ctx.jobs },
                  {
                    eventId: changedEvent.id,
                    type: 'dataset.changed',
                    occurredAt: changedEvent.occurredAt,
                    taskId: task.id,
                    runId: run.id,
                    severity: 'info',
                    payload: changedEvent.payload,
                  },
                )
                .catch(() => undefined);
            }
            if (ctx.get('outputsService')) {
              const existing = new Map(
                (await repositories.outputs.listDeliveryAttempts(run.id)).map((attempt) => [
                  attempt.destinationId,
                  attempt,
                ]),
              );
              for (const destinationId of await repositories.outputs.listTaskBindings(task.id)) {
                const destination = await repositories.outputs.getDestination(destinationId);
                if (!ctx.get('destinationReceivesRunData')?.(destination)) continue;
                const attempt =
                  existing.get(destinationId) ??
                  (await repositories.outputs.createDeliveryAttempt({
                    destinationId,
                    taskId: task.id,
                    runId: run.id,
                  }));
                if (attempt.status !== 'succeeded') {
                  await ctx.get('enqueueOutputDelivery')?.(ctx.jobs, attempt);
                }
              }
            }
          },
          async afterFailed({ task, run }) {
            await ctx
              .get('assistant')
              ?.notifyRun(task.id, run)
              .catch(() => undefined);
            const failedEvent = await repositories.platform.appendEvent({
              type: 'run.failed',
              producerPluginId: 'collection',
              aggregateType: 'run',
              aggregateId: run.id,
              payload: { taskId: task.id, runId: run.id, error: run.error },
            });
            await ctx
              .get('enqueueOutputEventNotifications')?.(
                { repository: repositories.outputs, jobs: ctx.jobs },
                {
                  eventId: failedEvent.id,
                  type: 'run.failed',
                  occurredAt: failedEvent.occurredAt,
                  taskId: task.id,
                  runId: run.id,
                  severity: 'error',
                  payload: failedEvent.payload,
                },
              )
              .catch(() => undefined);
            await ctx
              .get('enqueueMonitoringEvaluation')?.(ctx.jobs, {
                taskId: task.id,
                runId: run.id,
                outcome: 'failed',
              })
              .catch(() => undefined);
          },
        }),
      }),
    'job-handler',
  );
  ctx.effect(
    () =>
      ctx.runtimeHost.routes.register('collection', async (app) => {
        await registerCollectionHttp(app, {
          repository: repositories.collection,
          platform: repositories.platform,
          jobs: ctx.jobs,
          batches: collectionBatchCleanup,
          bindings: {
            list: (taskId) =>
              ctx.get('outputsService')
                ? repositories.outputs.listTaskBindings(taskId)
                : Promise.resolve([]),
            replace: (taskId, destinationIds) =>
              ctx.get('outputsService')?.bindTask(taskId, destinationIds) ?? Promise.resolve(),
            clear: async (taskId) => {
              await ctx.get('outputsService')?.clearCollectionTask(taskId);
            },
          },
          cleanup: [
            {
              clearTask: async (taskId) => {
                await ctx.preferencesService.clearCollectionTaskReference(taskId);
              },
            },
            {
              clearTask: async (taskId) => {
                if (ctx.get('monitoring')) await repositories.monitoring.deleteTask(taskId);
              },
            },
          ],
          credentialStore: ctx.credentials,
          runtimeMode: ctx.hostCapabilities.metadata.mode,
          ...(ctx.hostCapabilities.promptCredential
            ? { promptCredential: ctx.hostCapabilities.promptCredential.bind(ctx.hostCapabilities) }
            : {}),
          ...(ctx.hostCapabilities.createLoginSession
            ? {
                createLoginSession: ctx.hostCapabilities.createLoginSession.bind(
                  ctx.hostCapabilities,
                ),
              }
            : {}),
          inspection: {
            async create(task) {
              const settings = await resolveCollectionTaskSettings(
                task.requestSettings,
                task.browserSettings,
                task.credentialBindings,
                ctx.credentials,
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
              ctx.credentials,
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
      }),
    'collection-http',
  );
  ownRuntimeEffect(ctx, collectionScheduler, 'collection-scheduler');
  ownRuntimeEffect(ctx, collectionBatchCleanup, 'collection-cleanup');
  ownRuntimeEffect(
    ctx,
    { start: () => undefined, close: () => inspections.closeAll() },
    'inspection',
  );
}
export default { inject, Config, apply };
