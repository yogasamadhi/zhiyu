import { type Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { recordExperience } from '@zhiyun/platform-core';
import { ownRuntimeEffect } from '@zhiyun/runtime-contracts';
import {
  DatasetCleaningService,
  DatasetSnapshotService,
  createExportArtifact,
  exportRecordData,
  registerDatasetsHttp,
} from './index.js';

export const inject = ['artifacts', 'runtimeHost', 'worker'];
export const Config = Schema.object({});
function createServices(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const repositories = dependencies.repositories;
  const snapshotService = new DatasetSnapshotService(
    repositories.datasets,
    repositories.platform,
    ctx.artifacts,
    ctx.worker,
  );
  const cleaningService = new DatasetCleaningService(
    repositories.datasets,
    repositories.platform,
    ctx.artifacts,
    ctx.worker,
  );
  return { createExportArtifact, exportRecordData, snapshotService, cleaningService };
}
export type RuntimeServices = ReturnType<typeof createServices>;
type Services = RuntimeServices;
declare module '@deepseek-ai/cordis' {
  interface Context {
    createExportArtifact: Services['createExportArtifact'];
    exportRecordData: Services['exportRecordData'];
    snapshotService: Services['snapshotService'];
    cleaningService: Services['cleaningService'];
  }
}
export async function apply(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const repositories = dependencies.repositories;
  const repository = repositories.datasets;
  ctx.effect(() => () => ctx.runtimeHost.closeRepository(repository), 'datasets-storage');
  await repository.migrate();
  const services = createServices(ctx);
  ctx.provide('datasets.read', repositories.datasets);
  ctx.provide('datasets.ingestion', repositories.datasets);
  ctx.provide('datasets.snapshot', {
    createSnapshot: (datasetId: string) => services.snapshotService.materialize(datasetId),
  });
  ctx.provide('createExportArtifact', services.createExportArtifact);
  ctx.provide('exportRecordData', services.exportRecordData);
  const { snapshotService, cleaningService } = services;
  ctx.provide('snapshotService', services.snapshotService);
  ctx.provide('cleaningService', services.cleaningService);

  ctx.effect(
    () =>
      ctx.runtimeHost.routes.register('datasets', async (app) => {
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
          artifactStore: ctx.artifacts,
        });
      }),
    'datasets-http',
  );
  ownRuntimeEffect(
    ctx,
    { start: () => undefined, close: () => cleaningService.close() },
    'dataset-cleaning',
  );
}
export default { inject, Config, apply };
