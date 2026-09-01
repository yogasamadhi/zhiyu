import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZhiYunClient, type RuntimeBridge } from '../src/index.js';

afterEach(() => vi.unstubAllGlobals());

describe('ZhiYunClient Runtime generation lifecycle', () => {
  it('does not reset the active Graph Query when the first Desktop bootstrap is published', async () => {
    const initial = {
      baseUrl: 'http://127.0.0.1:45001',
      sessionNonce: 'initial-nonce',
      runtimeId: '00000000-0000-4000-8000-000000000001',
      generation: 1,
      apiVersion: 'v2' as const,
    };
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let publish: ((bootstrap: typeof initial) => void) | undefined;
    const bridge: RuntimeBridge = {
      async getBootstrap() {
        publish?.(initial);
        return { ...initial, sessionNonce: 'issued-nonce' };
      },
      onBootstrapChanged(listener) {
        publish = listener;
        return () => undefined;
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/api/v2/session')) {
          return Response.json({
            token: 'session-token',
            runtime: {
              apiVersion: 'v2',
              mode: 'desktop',
              productVersion: '1.0.0',
              runtimeId: initial.runtimeId,
              generation: 1,
              profileId: 'desktop-studio',
              graphRevision: 'revision-1',
              enabledPluginIds: [],
              enabledUiContributionIds: [],
              analyticsWorkerStatus: 'ready',
              startedAt: new Date().toISOString(),
            },
            capabilities: {},
          });
        }
        return Response.json({
          profileId: 'desktop-studio',
          graphRevision: 'revision-1',
          plugins: [],
          routes: [],
          uiContributions: [],
        });
      }),
    );
    const client = new ZhiYunClient(bridge);
    let resetCount = 0;
    client.onRuntimeReset(() => {
      resetCount += 1;
    });

    await expect(client.getRuntimeGraph()).resolves.toMatchObject({
      profileId: 'desktop-studio',
    });
    expect(calls).toHaveLength(2);
    expect(calls.every(({ init }) => init.credentials === 'omit')).toBe(true);
    expect(resetCount).toBe(0);

    publish?.({ ...initial, generation: 2 });
    expect(resetCount).toBe(1);
  });
});

describe('ZhiYunClient Dataset snapshots', () => {
  it('creates snapshots as idempotent v2 mutations', async () => {
    let mutation: { url: string; init: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        if (url.endsWith('/api/v2/session')) {
          return Response.json({
            token: 'session-token',
            runtime: {
              apiVersion: 'v2',
              mode: 'headless',
              productVersion: '1.0.0',
              runtimeId: '00000000-0000-4000-8000-000000000001',
              generation: 0,
              profileId: 'headless-server',
              graphRevision: 'revision-1',
              enabledPluginIds: [],
              enabledUiContributionIds: [],
              analyticsWorkerStatus: 'ready',
              startedAt: new Date().toISOString(),
            },
            capabilities: {},
          });
        }
        mutation = { url, init };
        return Response.json(
          {
            id: 'snapshot-1',
            datasetId: 'dataset/1',
            sourceRunId: null,
            fingerprint: 'fingerprint',
            schemaVersion: 1,
            status: 'ready',
            rowCount: 1,
            warnings: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          { status: 201 },
        );
      }),
    );

    const client = new ZhiYunClient(undefined);
    await expect(client.createDatasetSnapshot('dataset/1')).resolves.toMatchObject({
      id: 'snapshot-1',
      status: 'ready',
    });
    expect(mutation?.url.endsWith('/api/v2/datasets/dataset%2F1/snapshots')).toBe(true);
    expect(mutation?.init.method).toBe('POST');
    expect(new Headers(mutation?.init.headers).get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('ZhiYunClient workspace identity authentication', () => {
  it('switches from the legacy session endpoint to Cookie and CSRF authentication', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/api/v2/session')) {
          return Response.json(
            {
              type: 'https://zhiyun.dev/problems/identity-auth-required',
              title: 'IDENTITY_AUTH_REQUIRED',
              status: 410,
              detail: 'Use workspace authentication',
              instance: '/api/v2/session',
              code: 'IDENTITY_AUTH_REQUIRED',
              traceId: 'trace-session',
            },
            { status: 410 },
          );
        }
        if (url.endsWith('/api/v2/auth/status')) {
          return Response.json({ initialized: true });
        }
        if (url.endsWith('/api/v2/auth/login')) {
          return Response.json({
            user: identityUser,
            csrfToken: 'csrf-secret',
            idleExpiresAt: '2026-01-01T12:00:00.000Z',
            absoluteExpiresAt: '2026-01-07T00:00:00.000Z',
          });
        }
        if (url.includes('/api/v2/members/member-1')) return Response.json(identityUser);
        return new Response(null, { status: 204 });
      }),
    );

    const client = new ZhiYunClient(undefined);
    await expect(client.getAuthStatus()).resolves.toEqual({ initialized: true });
    expect(client.getAuthenticationMode()).toBe('workspace-cookie');
    await client.login({ email: 'admin@example.com', password: 'long-enough-password' });
    await client.updateMember('member-1', { role: 'editor' });

    const status = calls.find(({ url }) => url.endsWith('/api/v2/auth/status'))!;
    expect(status.init.credentials).toBe('include');
    expect(new Headers(status.init.headers).has('authorization')).toBe(false);
    const mutation = calls.find(({ url }) => url.includes('/api/v2/members/member-1'))!;
    const headers = new Headers(mutation.init.headers);
    expect(mutation.init.credentials).toBe('include');
    expect(mutation.init.method).toBe('PATCH');
    expect(headers.get('x-csrf-token')).toBe('csrf-secret');
    expect(headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers.has('authorization')).toBe(false);
  });

  it('clears in-memory CSRF state after an expired Cookie session', async () => {
    const mutations: RequestInit[] = [];
    let memberRequest = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        if (url.endsWith('/api/v2/session')) return identityRequiredResponse();
        if (url.endsWith('/api/v2/auth/login')) {
          return Response.json({
            user: identityUser,
            csrfToken: 'csrf-secret',
            idleExpiresAt: '2026-01-01T12:00:00.000Z',
            absoluteExpiresAt: '2026-01-07T00:00:00.000Z',
          });
        }
        if (url.includes('/api/v2/members/member-1')) {
          mutations.push(init);
          memberRequest += 1;
          if (memberRequest === 1) {
            return Response.json(
              {
                type: 'https://zhiyun.dev/problems/session-expired',
                title: 'SESSION_EXPIRED',
                status: 401,
                detail: 'Session expired',
                instance: '/api/v2/members/member-1',
                code: 'SESSION_EXPIRED',
                traceId: 'trace-expired',
              },
              { status: 401 },
            );
          }
          return Response.json(identityUser);
        }
        throw new Error(`Unexpected request ${url}`);
      }),
    );

    const client = new ZhiYunClient(undefined);
    await client.login({ email: 'admin@example.com', password: 'long-enough-password' });
    await expect(client.updateMember('member-1', { role: 'editor' })).rejects.toMatchObject({
      status: 401,
    });
    await client.updateMember('member-1', { role: 'viewer' });
    expect(new Headers(mutations[0]?.headers).get('x-csrf-token')).toBe('csrf-secret');
    expect(new Headers(mutations[1]?.headers).has('x-csrf-token')).toBe(false);
  });

  it('restores a rotated CSRF token from the Cookie session and retains it on failed logout', async () => {
    const mutations: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        if (url.endsWith('/api/v2/session')) return identityRequiredResponse();
        if (url.endsWith('/api/v2/auth/me')) {
          return Response.json({
            user: identityUser,
            permissions: ['workspace.read', 'member.manage'],
            csrfToken: 'rotated-after-refresh',
            idleExpiresAt: '2026-01-01T12:00:00.000Z',
            absoluteExpiresAt: '2026-01-07T00:00:00.000Z',
          });
        }
        if (url.endsWith('/api/v2/auth/logout')) {
          mutations.push({ url, init });
          return Response.json(
            {
              type: 'https://zhiyun.dev/problems/audit-failed',
              title: 'AUDIT_FAILED',
              status: 500,
              detail: 'Logout could not be completed',
              instance: '/api/v2/auth/logout',
              code: 'AUDIT_FAILED',
              traceId: 'trace-logout',
            },
            { status: 500 },
          );
        }
        if (url.includes('/api/v2/members/member-1')) {
          mutations.push({ url, init });
          return Response.json(identityUser);
        }
        throw new Error(`Unexpected request ${url}`);
      }),
    );

    const client = new ZhiYunClient(undefined);
    await expect(client.getCurrentUser()).resolves.toMatchObject({ user: identityUser });
    await expect(client.logout()).rejects.toMatchObject({ status: 500 });
    await client.updateMember('member-1', { role: 'editor' });

    expect(mutations).toHaveLength(2);
    for (const { init } of mutations) {
      expect(new Headers(init.headers).get('x-csrf-token')).toBe('rotated-after-refresh');
    }
  });

  it('lets two refreshed tabs recover the same session CSRF and mutate independently', async () => {
    const mutations: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
        const url = String(input);
        if (url.endsWith('/api/v2/session')) return identityRequiredResponse();
        if (url.endsWith('/api/v2/auth/me')) {
          return Response.json({
            user: identityUser,
            permissions: ['workspace.read', 'member.manage'],
            csrfToken: 'stable-session-csrf',
            idleExpiresAt: '2026-01-01T12:00:00.000Z',
            absoluteExpiresAt: '2026-01-07T00:00:00.000Z',
          });
        }
        if (url.includes('/api/v2/members/')) {
          mutations.push({ url, init });
          return Response.json(identityUser);
        }
        throw new Error(`Unexpected request ${url}`);
      }),
    );

    const firstTab = new ZhiYunClient(undefined);
    const secondTab = new ZhiYunClient(undefined);
    await Promise.all([firstTab.getCurrentUser(), secondTab.getCurrentUser()]);
    await Promise.all([
      firstTab.updateMember('member-a', { role: 'editor' }),
      secondTab.updateMember('member-b', { role: 'viewer' }),
    ]);

    expect(mutations).toHaveLength(2);
    expect(mutations.map(({ init }) => new Headers(init.headers).get('x-csrf-token'))).toEqual([
      'stable-session-csrf',
      'stable-session-csrf',
    ]);
  });
});

const identityUser = {
  id: 'member-1',
  email: 'admin@example.com',
  displayName: 'Admin',
  role: 'admin' as const,
  disabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function identityRequiredResponse(): Response {
  return Response.json(
    {
      type: 'https://zhiyun.dev/problems/identity-auth-required',
      title: 'IDENTITY_AUTH_REQUIRED',
      status: 410,
      detail: 'Use workspace authentication',
      instance: '/api/v2/session',
      code: 'IDENTITY_AUTH_REQUIRED',
      traceId: 'trace-session',
    },
    { status: 410 },
  );
}
