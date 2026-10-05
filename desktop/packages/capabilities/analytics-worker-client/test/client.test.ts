import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsWorkerClient, type AnalyticsWorkerError } from '../src/index.js';

const bootstrap = {
  baseUrl: 'http://127.0.0.1:41234',
  token: 'private-worker-token',
  generation: 1,
  protocolVersion: 'worker/v1' as const,
  workerVersion: '1.0.0',
};

afterEach(() => vi.restoreAllMocks());

describe('AnalyticsWorkerClient', () => {
  it('authenticates health requests without exposing credentials in the URL', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(new AnalyticsWorkerClient(bootstrap).health()).resolves.toEqual({ status: 'ok' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://127.0.0.1:41234/health');
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer private-worker-token',
    );
  });

  it('maps Worker problems to stable client errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          type: 'about:blank',
          title: 'Unavailable',
          status: 503,
          code: 'ANALYTICS_UNAVAILABLE',
          detail: 'Worker unavailable',
        }),
        { status: 503, headers: { 'content-type': 'application/problem+json' } },
      ),
    );
    await expect(new AnalyticsWorkerClient(bootstrap).methods()).rejects.toMatchObject({
      status: 503,
      code: 'ANALYTICS_UNAVAILABLE',
    } satisfies Partial<AnalyticsWorkerError>);
  });
});
