import { type Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { recordExperience } from '@zhiyun/platform-core';
import { ownRuntimeEffect } from '@zhiyun/runtime-contracts';
import type { RuntimeGatewayDependencies } from '@zhiyun/runtime-gateway';
import { createHash } from 'node:crypto';
import {
  OutputAttemptReplay,
  OutputEventNotificationOutbox,
  OutputsService,
  PlatformOutputArtifactStore,
  createEventNotificationJobHandler,
  createOutputDeliveryJobHandler,
  destinationReceivesRunData,
  enqueueOutputDelivery,
  enqueueOutputEventNotifications,
  registerOutputsHttp,
} from './index.js';

export const inject = [
  'artifacts',
  'credentials',
  'hostCapabilities',
  'jobHandlers',
  'jobs',
  'runtimeHost',
  'worker',
];
export const Config = Schema.object({});
function createServices(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const repositories = dependencies.repositories;
  const dataApiRateLimits = new Map<
    string,
    {
      window: number;
      count: number;
    }
  >();
  const outputsService = new OutputsService(repositories.outputs);
  const authenticateDataToken: (
    token: string,
  ) => ReturnType<NonNullable<RuntimeGatewayDependencies['authenticateDataToken']>> =
    async function (token: string) {
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
    };
  return {
    authenticateDataToken,
    dataApiRateLimits,
    outputsService,
    enqueueOutputEventNotifications,
    destinationReceivesRunData,
    enqueueOutputDelivery,
  };
}
export type RuntimeServices = ReturnType<typeof createServices>;
type Services = RuntimeServices;
declare module '@deepseek-ai/cordis' {
  interface Context {
    authenticateDataToken: Services['authenticateDataToken'];
    dataApiRateLimits: Services['dataApiRateLimits'];
    outputsService: Services['outputsService'];
    enqueueOutputEventNotifications: Services['enqueueOutputEventNotifications'];
    destinationReceivesRunData: Services['destinationReceivesRunData'];
    enqueueOutputDelivery: Services['enqueueOutputDelivery'];
  }
}
export async function apply(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const repositories = dependencies.repositories;
  const repository = repositories.outputs;
  ctx.effect(() => () => ctx.runtimeHost.closeRepository(repository), 'outputs-storage');
  await repository.migrate();
  const services = createServices(ctx);
  ctx.provide('outputs.service', services.outputsService);
  ctx.provide('enqueueOutputDelivery', services.enqueueOutputDelivery);
  ctx.provide('authenticateDataToken', services.authenticateDataToken);

  ctx.provide('dataApiRateLimits', services.dataApiRateLimits);
  ctx.provide('outputsService', services.outputsService);
  ctx.provide('enqueueOutputEventNotifications', services.enqueueOutputEventNotifications);
  ctx.provide('destinationReceivesRunData', services.destinationReceivesRunData);
  ctx.effect(
    () =>
      ctx.jobHandlers.register({
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
          credentials: ctx.credentials,
          artifacts: new PlatformOutputArtifactStore(ctx.artifacts, {
            parquetWorker: ctx.worker,
          }),
        }),
      }),
    'job-handler',
  );
  ctx.effect(
    () =>
      ctx.jobHandlers.register({
        type: 'outputs.event-notification.execute',
        ownerPluginId: 'outputs',
        resourceClass: 'delivery',
        handler: createEventNotificationJobHandler({
          repository: repositories.outputs,
          credentials: ctx.credentials,
        }),
      }),
    'job-handler',
  );
  ctx.effect(
    () =>
      ctx.runtimeHost.routes.register('outputs', async (app) => {
        await registerOutputsHttp(app, {
          repository: repositories.outputs,
          jobs: ctx.jobs,
          credentialStore: ctx.credentials,
          ...(ctx.hostCapabilities.promptCredential
            ? { promptCredential: (kind) => ctx.hostCapabilities.promptCredential!(kind) }
            : {}),
          ...(ctx.hostCapabilities.selectOutputDirectory
            ? {
                selectOutputDirectory: () => ctx.hostCapabilities.selectOutputDirectory!(),
              }
            : {}),
        });
      }),
    'outputs-http',
  );
  ownRuntimeEffect(
    ctx,
    new OutputEventNotificationOutbox(repositories.platform, repositories.outputs, ctx.jobs),
    'output-outbox',
  );
  ownRuntimeEffect(ctx, new OutputAttemptReplay(repositories.outputs, ctx.jobs), 'output-replay');
}
export default { inject, Config, apply };
