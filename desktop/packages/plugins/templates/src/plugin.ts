import type {} from '@zhiyun/runtime-contracts';
import { type Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { registerTemplatesHttp } from './index.js';

export const inject = [
  'credentials',
  'hostCapabilities',
  'protectTaskCredentials',
  'runtimeHost',
  'verifyInitialRulePreview',
];
export const Config = Schema.object({});
export async function apply(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const repositories = dependencies.repositories;

  ctx.effect(
    () =>
      ctx.runtimeHost.routes.register('templates', async (app) => {
        await registerTemplatesHttp(app, {
          collection: repositories.collection,
          platform: repositories.platform,
          protectTask: (task) =>
            ctx.protectTaskCredentials(task, {
              credentialStore: ctx.credentials,
              runtimeMode: ctx.hostCapabilities.metadata.mode,
            }),
          verifyPreview: (key, input) =>
            ctx.verifyInitialRulePreview(repositories.platform, key, input),
          quality: repositories.monitoring,
        });
      }),
    'templates-http',
  );
}
export default { inject, Config, apply };
