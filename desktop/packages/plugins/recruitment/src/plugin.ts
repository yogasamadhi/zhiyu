import { type Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { ownRuntimeEffect } from '@zhiyun/runtime-contracts';
import { writeFile } from 'node:fs/promises';
import {
  RecruitmentDigestScheduler,
  RecruitmentService,
  registerRecruitmentHttp,
} from './index.js';

export const inject = [
  'artifacts',
  'credentials',
  'hostCapabilities',
  'outputsService',
  'runtimeHost',
];
export const Config = Schema.object({});
function createServices(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const repositories = dependencies.repositories;
  const recruitment = new RecruitmentService({
    repository: repositories.recruitment,
    platform: repositories.platform,
    replaceOutputBindings: (profileId, destinationIds) =>
      ctx.outputsService.bindTask(profileId, destinationIds),
    clearOutputBindings: async (profileId) => {
      await ctx.outputsService.clearCollectionTask(profileId);
    },
    resolveCredential: (reference) => ctx.credentials.resolve(reference),
    ...(ctx.hostCapabilities.notify
      ? {
          notify: async (title: string, body: string) => {
            await ctx.hostCapabilities.notify!(title, body);
          },
        }
      : {}),
    async createErrorArtifact(importJobId, filename, content) {
      const workspace = await ctx.artifacts.openWorkspace(importJobId);
      const relativeSource = 'errors.jsonl';
      await writeFile(await workspace.resolve(relativeSource), content, { encoding: 'utf8' });
      const stored = await ctx.artifacts.commitWorkspaceFile(
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
      await ctx.artifacts.removeWorkspace(importJobId).catch(() => undefined);
      return artifact.id;
    },
  });
  return { recruitment };
}
export type RuntimeServices = ReturnType<typeof createServices>;
type Services = RuntimeServices;
declare module '@deepseek-ai/cordis' {
  interface Context {
    recruitment: Services['recruitment'];
  }
}
export async function apply(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const repositories = dependencies.repositories;
  const repository = repositories.recruitment;
  ctx.effect(() => () => ctx.runtimeHost.closeRepository(repository), 'recruitment-storage');
  await repository.migrate();
  const services = createServices(ctx);
  ctx.provide('recruitment.service', services.recruitment);
  const { recruitment } = services;
  ctx.provide('recruitment', services.recruitment);

  ctx.effect(
    () =>
      ctx.runtimeHost.routes.register('recruitment', async (app) => {
        await registerRecruitmentHttp(app, recruitment);
      }),
    'recruitment-http',
  );
  ownRuntimeEffect(ctx, new RecruitmentDigestScheduler(recruitment), 'recruitment-digest');
}
export default { inject, Config, apply };
