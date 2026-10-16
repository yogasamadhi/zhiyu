import type {} from '@zhiyun/runtime-contracts';
import { type Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { recordExperience } from '@zhiyun/platform-core';
import {
  AnalysisJobService,
  AnalysisRecipeService,
  AnalyticsCatalog,
  createAnalysisJobHandler,
  registerAnalyticsHttp,
} from './index.js';

export const inject = ['artifacts', 'jobHandlers', 'jobs', 'runtimeHost', 'worker'];
export const Config = Schema.object({});
function createServices(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const repositories = dependencies.repositories;
  const analyticsCatalog = new AnalyticsCatalog(() =>
    ctx.worker.available() ? ctx.worker : undefined,
  );
  const analysisRecipes = new AnalysisRecipeService(repositories.analytics, analyticsCatalog);
  const analysisJobs = new AnalysisJobService(
    repositories.analytics,
    repositories.platform,
    repositories.datasets,
    analyticsCatalog,
    ctx.jobs,
  );
  return { analyticsCatalog, analysisRecipes, analysisJobs };
}
export type RuntimeServices = ReturnType<typeof createServices>;
type Services = RuntimeServices;
declare module '@deepseek-ai/cordis' {
  interface Context {
    analyticsCatalog: Services['analyticsCatalog'];
    analysisRecipes: Services['analysisRecipes'];
    analysisJobs: Services['analysisJobs'];
  }
}
export async function apply(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const repositories = dependencies.repositories;
  const repository = repositories.analytics;
  ctx.effect(() => () => ctx.runtimeHost.closeRepository(repository), 'analytics-storage');
  await repository.migrate();
  const services = createServices(ctx);
  ctx.provide('analytics.catalog', services.analyticsCatalog);
  const { analyticsCatalog, analysisRecipes, analysisJobs } = services;
  ctx.provide('analyticsCatalog', services.analyticsCatalog);
  ctx.provide('analysisRecipes', services.analysisRecipes);
  ctx.provide('analysisJobs', services.analysisJobs);
  ctx.effect(
    () =>
      ctx.jobHandlers.register({
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
          artifactStore: ctx.artifacts,
          worker: ctx.worker,
        }),
      }),
    'job-handler',
  );
  ctx.effect(
    () =>
      ctx.runtimeHost.routes.register('analytics', async (app) => {
        await registerAnalyticsHttp(app, {
          artifactStore: ctx.artifacts,
          catalog: analyticsCatalog,
          recipes: analysisRecipes,
          jobs: analysisJobs,
          platform: repositories.platform,
        });
      }),
    'analytics-http',
  );
}
export default { inject, Config, apply };
