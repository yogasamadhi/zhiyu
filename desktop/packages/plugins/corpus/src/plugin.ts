import type {} from '@zhiyun/runtime-contracts';
import { type Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import {
  CorpusBuildService,
  CorpusRecipeService,
  CorpusService,
  CorpusUnavailableError,
  createCorpusBuildHandler,
  previewCorpus,
  registerCorpusHttp,
} from './index.js';

export const inject = ['artifacts', 'jobHandlers', 'jobs', 'runtimeHost', 'worker'];
export const Config = Schema.object({});
function createServices(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const repositories = dependencies.repositories;
  const corpora = new CorpusService(repositories.corpus);
  const corpusRecipes = new CorpusRecipeService(repositories.corpus);
  const corpusBuilds = new CorpusBuildService(
    repositories.corpus,
    repositories.platform,
    repositories.datasets,
    () => ctx.worker.available(),
    ctx.jobs,
  );
  return { corpora, corpusRecipes, corpusBuilds };
}
export type RuntimeServices = ReturnType<typeof createServices>;
type Services = RuntimeServices;
declare module '@deepseek-ai/cordis' {
  interface Context {
    corpora: Services['corpora'];
    corpusRecipes: Services['corpusRecipes'];
    corpusBuilds: Services['corpusBuilds'];
  }
}
export async function apply(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const repositories = dependencies.repositories;
  const repository = repositories.corpus;
  ctx.effect(() => () => ctx.runtimeHost.closeRepository(repository), 'corpus-storage');
  await repository.migrate();
  const services = createServices(ctx);
  const { corpora, corpusRecipes, corpusBuilds } = services;
  ctx.provide('corpora', services.corpora);
  ctx.provide('corpusRecipes', services.corpusRecipes);
  ctx.provide('corpusBuilds', services.corpusBuilds);
  ctx.effect(
    () =>
      ctx.jobHandlers.register({
        type: 'corpus.build.execute',
        ownerPluginId: 'corpus',
        resourceClass: 'python-heavy',
        handler: createCorpusBuildHandler({
          repository: repositories.corpus,
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
      ctx.runtimeHost.routes.register('corpus', async (app) => {
        await registerCorpusHttp(app, {
          corpora,
          recipes: corpusRecipes,
          builds: corpusBuilds,
          platform: repositories.platform,
          preview: (corpusId, snapshotId, recipe) => {
            if (!ctx.worker.available())
              throw new CorpusUnavailableError('Analytics Worker is unavailable');
            return previewCorpus(
              {
                repository: repositories.corpus,
                platform: repositories.platform,
                snapshots: repositories.datasets,
                artifactStore: ctx.artifacts,
                worker: ctx.worker,
              },
              corpusId,
              snapshotId,
              recipe,
            );
          },
        });
      }),
    'corpus-http',
  );
}
export default { inject, Config, apply };
