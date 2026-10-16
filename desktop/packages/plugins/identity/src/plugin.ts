import type {} from '@zhiyun/runtime-contracts';
import { type Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import type { WorkspaceAuthorization } from '@zhiyun/runtime-gateway';
import {
  IdentityError,
  IdentityService,
  registerIdentityHttp,
  rolePermissions,
  type IdentityPrincipal,
} from './index.js';

export const inject = ['runtimeHost'];
export const Config = Schema.object({});
function createServices(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const identity = dependencies.identity
    ? new IdentityService(dependencies.identity.repository, dependencies.identity.options)
    : undefined;
  const workspaceAuthorization: WorkspaceAuthorization = {
    async authenticate(input: {
      sessionToken: string | undefined;
      csrfToken: string | undefined;
      mutation: boolean;
    }) {
      let principal: IdentityPrincipal;
      try {
        principal = await identity!.authenticate(input.sessionToken ?? '');
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
          identity!.verifyCsrf(principal, input.csrfToken);
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
      return identity!.recordOperation({
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
  };
  return { workspaceAuthorization, identity };
}
export type RuntimeServices = ReturnType<typeof createServices>;
type Services = RuntimeServices;
declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceAuthorization: Services['workspaceAuthorization'];
    identity: Services['identity'];
  }
}
export async function apply(ctx: Context) {
  const { dependencies } = ctx.runtimeHost;
  const repository = dependencies.identity!.repository;
  ctx.effect(() => () => ctx.runtimeHost.closeRepository(repository), 'identity-storage');
  await repository.migrate();
  const services = createServices(ctx);
  ctx.provide('identity.service', services.identity);
  ctx.provide('workspaceAuthorization', services.workspaceAuthorization);
  const { identity } = services;
  ctx.provide('identity', services.identity);

  ctx.effect(
    () =>
      ctx.runtimeHost.routes.register('identity', async (app) => {
        if (identity && dependencies.identity) {
          await registerIdentityHttp(app, identity, {
            ...(dependencies.identity.secureCookies === undefined
              ? {}
              : { secureCookies: dependencies.identity.secureCookies }),
          });
        }
      }),
    'identity-http',
  );
}
export default { inject, Config, apply };
