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
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
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
