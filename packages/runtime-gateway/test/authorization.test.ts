import type { HTTPMethods } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactStore, PlatformJobQueue, PlatformRepository } from '@zhiyun/platform-core';
import { resolveProductGraph } from '@zhiyun/product-profiles';
import { buildRuntimeGateway, type RuntimeGateway } from '../src/index.js';

type IdentityRole = 'admin' | 'editor' | 'viewer';
type TestMethod = 'GET' | 'POST';
const rolePermissions: Readonly<Record<IdentityRole, readonly string[]>> = {
  admin: [
    'workspace.read',
    'workspace.manage',
    'task.write',
    'run.execute',
    'analysis.write',
    'output.bind',
    'output.manage',
    'member.manage',
    'audit.read',
  ],
  editor: ['workspace.read', 'task.write', 'run.execute', 'analysis.write', 'output.bind'],
  viewer: ['workspace.read'],
};

const runtimes: RuntimeGateway[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.close();
});

describe('Runtime Gateway route authorization', () => {
  it('rejects an API route that is not owned by the product graph', async () => {
    await expect(createGateway(true)).rejects.toThrow(
      'Runtime staged an unowned API route without requiredPermission: GET /api/v2/unowned-secret',
    );
  });

  it('uses each route contribution permission for the three workspace roles', async () => {
    const runtime = await createGateway();
    const request = (role: IdentityRole, method: TestMethod, url: string) =>
      runtime.app.inject({
        method,
        url,
        headers: {
          cookie: `zhiyun_session=${role}`,
          ...(method === 'GET' ? {} : { 'x-csrf-token': 'valid' }),
        },
      });

    expect((await request('viewer', 'GET', '/api/v2/tasks')).statusCode).toBe(200);
    expect((await request('viewer', 'POST', '/api/v2/tasks')).statusCode).toBe(403);
    expect((await request('viewer', 'POST', '/api/v2/datasets/a/exports')).statusCode).toBe(200);
    expect((await request('editor', 'POST', '/api/v2/tasks')).statusCode).toBe(200);
    expect((await request('editor', 'POST', '/api/v2/tasks/a/runs')).statusCode).toBe(200);
    expect((await request('editor', 'POST', '/api/v2/analytics/jobs')).statusCode).toBe(200);
    expect((await request('editor', 'POST', '/api/v2/output-destinations')).statusCode).toBe(403);
    expect((await request('editor', 'GET', '/api/v2/members')).statusCode).toBe(403);
    expect((await request('editor', 'GET', '/api/v2/audit-events')).statusCode).toBe(403);
    expect((await request('admin', 'POST', '/api/v2/output-destinations')).statusCode).toBe(200);
    expect((await request('admin', 'GET', '/api/v2/members')).statusCode).toBe(200);
    expect((await request('admin', 'GET', '/api/v2/audit-events')).statusCode).toBe(200);

    const missingCsrf = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/tasks',
      headers: { cookie: 'zhiyun_session=editor' },
    });
    expect(missingCsrf.statusCode).toBe(403);
  });

  it('keeps public, workspace cookie, Data API token and desktop session paths separate', async () => {
    const runtime = await createGateway();

    expect((await runtime.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await runtime.app.inject({ method: 'GET', url: '/api/v2/runtime' })).statusCode).toBe(
      200,
    );
    expect((await runtime.app.inject({ method: 'HEAD', url: '/api/v2/runtime' })).statusCode).toBe(
      200,
    );
    expect((await runtime.app.inject({ method: 'GET', url: '/api/v2/tasks' })).statusCode).toBe(
      401,
    );
    expect((await runtime.app.inject({ method: 'HEAD', url: '/api/v2/tasks' })).statusCode).toBe(
      401,
    );
    expect(
      (
        await runtime.app.inject({
          method: 'GET',
          url: '/api/v2/tasks',
          headers: { authorization: 'Bearer data-token' },
        })
      ).statusCode,
    ).toBe(401);

    const dataToken = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/data/tasks/a/records',
      headers: { authorization: 'Bearer data-token' },
    });
    expect(dataToken.statusCode).toBe(200);
    const workspaceCookieOnDataApi = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/data/tasks/a/records',
      headers: { cookie: 'zhiyun_session=admin' },
    });
    expect(workspaceCookieOnDataApi.statusCode).toBe(401);

    const legacyDesktopSession = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/session',
      payload: { nonce: 'gateway-test' },
    });
    expect(legacyDesktopSession.statusCode).toBe(410);
    expect(legacyDesktopSession.json()).toMatchObject({ code: 'IDENTITY_AUTH_REQUIRED' });

    const unknownApi = await runtime.app.inject({ method: 'GET', url: '/api/v1/tasks' });
    expect(unknownApi.statusCode).toBe(404);
    expect(unknownApi.headers['content-type']).toContain('application/problem+json');
  });
});

async function createGateway(registerUnownedRoute = false): Promise<RuntimeGateway> {
  const graph = resolveProductGraph('headless-server');
  const platform = {
    initialize: async () => undefined,
    recoverExpiredJobs: async () => 0,
    close: async () => undefined,
  } as unknown as PlatformRepository;
  const artifactStore = {
    initialize: async () => undefined,
    close: async () => undefined,
  } as unknown as ArtifactStore;
  const jobs = {
    start: () => undefined,
    close: async () => undefined,
  } as unknown as PlatformJobQueue;
  const roleByToken: Readonly<Record<string, IdentityRole>> = {
    admin: 'admin',
    editor: 'editor',
    viewer: 'viewer',
  };
  const runtime = await buildRuntimeGateway(
    {
      platform,
      artifactStore,
      jobs,
      migrations: graph.plugins
        .filter(({ descriptor }) => (descriptor.migrations?.length ?? 0) > 0)
        .map(({ descriptor }) => ({
          pluginId: descriptor.id,
          migrate: async () => undefined,
          close: async () => undefined,
        })),
      async registerPluginHttp(app) {
        for (const { descriptor } of graph.plugins) {
          if (descriptor.id === 'platform') continue;
          for (const route of descriptor.routes ?? []) {
            app.route({
              method: route.method as HTTPMethods,
              url: fastifyPath(route.path),
              handler: async () => ({ operationId: route.operationId }),
            });
          }
        }
        if (registerUnownedRoute) {
          app.get('/api/v2/unowned-secret', async () => ({ secret: true }));
        }
      },
      metadata: {
        runtimeId: crypto.randomUUID(),
        generation: 1,
        apiVersion: 'v2',
        mode: 'headless',
        productVersion: '1.0.0',
        analyticsWorkerStatus: 'ready',
        startedAt: new Date().toISOString(),
      },
      capabilities: {
        platform: 'headless',
        browser: true,
        cron: true,
        credentials: true,
        artifactSaveDialog: false,
        notifications: false,
        tray: false,
      },
      openApiDocument: minimalOpenApi(graph),
      authenticateDataToken: async (token) =>
        token === 'data-token'
          ? { ok: true as const, principal: { tokenId: 'data-token' } }
          : {
              ok: false as const,
              status: 401 as const,
              code: 'UNAUTHORIZED',
              detail: 'Invalid Data API token',
            },
      workspaceAuthorization: {
        async authenticate({ sessionToken, csrfToken, mutation }) {
          const role = sessionToken ? roleByToken[sessionToken] : undefined;
          if (!role) {
            return {
              ok: false as const,
              status: 401 as const,
              code: 'AUTHENTICATION_REQUIRED',
              detail: 'Login is required',
            };
          }
          const principal = { userId: `${role}-id`, role };
          if (mutation && csrfToken !== 'valid') {
            return {
              ok: false as const,
              status: 403 as const,
              code: 'CSRF_INVALID',
              detail: 'CSRF token is invalid',
              principal,
            };
          }
          return { ok: true as const, principal, permissions: rolePermissions[role] };
        },
      },
    },
    {
      sessionNonce: 'gateway-test',
      profileId: 'headless-server',
      allowedOrigins: ['https://zhiyun.example'],
      logger: false,
    },
  );
  runtimes.push(runtime);
  await runtime.app.ready();
  return runtime;
}

function fastifyPath(path: string): string {
  return path.replaceAll(/\{([^}]+)\}/g, ':$1');
}

function minimalOpenApi(graph: ReturnType<typeof resolveProductGraph>): unknown {
  const paths: Record<string, Record<string, { operationId: string }>> = {};
  for (const { descriptor } of graph.plugins) {
    for (const route of descriptor.routes ?? []) {
      (paths[route.path] ??= {})[route.method.toLowerCase()] = {
        operationId: route.operationId,
      };
    }
  }
  return { openapi: '3.1.0', paths };
}
