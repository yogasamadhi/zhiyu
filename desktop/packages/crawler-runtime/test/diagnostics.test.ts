import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  normalizeCrawlPlan,
  requestSettingsSchema,
  diagnosticRecovery,
  type DiagnosticStep,
} from '@zhiyun/shared';
import { CrawlerRuntime, type CrawlRequest } from '../src/index.js';
let origin: string;
let cancelOnRequest: (() => void) | undefined;
const server = createServer((request, response) => {
  if (request.url === '/cancel') {
    cancelOnRequest?.();
    return;
  }
  if (request.url === '/slow') return;
  if (request.url === '/failed') {
    response.writeHead(503);
    response.end('private-page-marker');
    return;
  }
  response.setHeader(
    'content-type',
    request.url === '/json' ? 'application/json' : 'text/html; charset=utf-8',
  );
  response.end(
    request.url === '/json'
      ? JSON.stringify({ items: [{ name: 'Sample' }] })
      : '<input id="login"><article><h2>Sample</h2></article>',
  );
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
function input(path: string, steps: DiagnosticStep[]): CrawlRequest {
  return {
    url: `${origin}${path}`,
    plan: normalizeCrawlPlan({
      type: 'css',
      container: 'article',
      fields: {
        name: { selector: 'h2', value: 'text', dataType: 'string' },
        missing: { selector: '.gone', value: 'text', dataType: 'string' },
      },
    }),
    requestSettings: requestSettingsSchema.parse({
      retries: 0,
      delayMs: 0,
      respectRobotsTxt: false,
      domainRateLimitPerMinute: 10000,
      timeoutMs: 1000,
      maxRuntimeMs: 15000,
    }),
    browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
    pagination: { type: 'none' },
    networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
    onDiagnostic: (step) => {
      steps.push(step);
    },
  };
}
const json = (request: CrawlRequest) => ({
  ...request,
  plan: normalizeCrawlPlan({
    type: 'json',
    container: '$.items[*]',
    fields: { name: { path: '$.name', dataType: 'string' } },
  }),
});
describe('actual local collection diagnostics', () => {
  it('locates a failed HTTP navigation after retries are exhausted', async () => {
    const steps: DiagnosticStep[] = [];
    await expect(new CrawlerRuntime().crawl(input('/failed', steps))).rejects.toThrow();
    const failure = steps.find((step) => step.kind === 'navigation' && step.status === 'failed');
    expect(failure?.errorCode).toBe('NAVIGATION_ERROR');
    expect(diagnosticRecovery(failure!.errorCode!)).toBe('retry');
    expect(JSON.stringify(steps)).not.toContain('private-page-marker');
    expect(JSON.stringify(steps)).not.toContain(origin);
  }, 15000);
  it('locates the invalid field by its declared index without changing row data', async () => {
    const steps: DiagnosticStep[] = [];
    const result = await new CrawlerRuntime().crawl(input('/fields', steps));
    expect(result.records).toEqual([
      { sourceUrl: `${origin}/fields`, data: { name: 'Sample', missing: null } },
    ]);
    expect(steps).toContainEqual(
      expect.objectContaining({
        kind: 'selector',
        fieldIndex: 1,
        matchedCount: 0,
        errorCode: 'SELECTOR_UNMATCHED',
      }),
    );
    expect(steps).toContainEqual(
      expect.objectContaining({ kind: 'extraction', recordCount: 1, status: 'succeeded' }),
    );
    expect(diagnosticRecovery('SELECTOR_UNMATCHED')).toBe('edit_fields');
  }, 15000);
  it('reports an actual navigation timeout and the limit editing recovery', async () => {
    const steps: DiagnosticStep[] = [];
    await expect(new CrawlerRuntime().crawl(json(input('/slow', steps)))).rejects.toThrow();
    expect(steps).toContainEqual(
      expect.objectContaining({ kind: 'navigation', status: 'failed', errorCode: 'TIMEOUT' }),
    );
    expect(diagnosticRecovery('TIMEOUT')).toBe('edit_limits');
  }, 15000);
  it('distinguishes a vanished browser container from a navigation timeout', async () => {
    const steps: DiagnosticStep[] = [];
    const request = input('/browser', steps);
    request.plan.list.mode = 'browser';
    request.plan.list.rule = {
      ...request.plan.list.rule,
      type: 'css',
      container: '.removed-container',
      fields: { name: { selector: 'h2', value: 'text', dataType: 'string' } },
    };
    request.requestSettings.timeoutMs = 1100;
    await expect(new CrawlerRuntime().crawl(request)).rejects.toThrow();
    expect(steps).toContainEqual(
      expect.objectContaining({ kind: 'navigation', status: 'succeeded' }),
    );
    expect(steps).toContainEqual(
      expect.objectContaining({
        kind: 'selector',
        status: 'failed',
        errorCode: 'SELECTOR_UNMATCHED',
      }),
    );
  }, 15000);
  it('reports caller cancellation at the in-flight navigation step', async () => {
    const steps: DiagnosticStep[] = [];
    const controller = new AbortController();
    cancelOnRequest = () => controller.abort();
    try {
      await expect(
        new CrawlerRuntime().crawl({ ...json(input('/cancel', steps)), signal: controller.signal }),
      ).rejects.toMatchObject({ code: 'CANCELED' });
      expect(steps).toContainEqual(
        expect.objectContaining({ kind: 'navigation', status: 'canceled', errorCode: 'CANCELED' }),
      );
      expect(diagnosticRecovery('CANCELED')).toBe('new_run');
    } finally {
      cancelOnRequest = undefined;
    }
  });
  it('observes real browser navigation and fill while excluding its sensitive value', async () => {
    const steps: DiagnosticStep[] = [];
    const request = input('/browser', steps);
    request.plan.list.mode = 'browser';
    request.browserSettings.actions = [
      { type: 'fill', selector: '#login', value: 'private-fill-marker' },
    ];
    const result = await new CrawlerRuntime().crawl(request);
    expect(result.records[0]?.data.name).toBe('Sample');
    expect(steps).toContainEqual(
      expect.objectContaining({ kind: 'navigation', status: 'succeeded', statusCode: 200 }),
    );
    expect(steps).toContainEqual(
      expect.objectContaining({ kind: 'action', actionType: 'fill', status: 'succeeded' }),
    );
    expect(JSON.stringify(steps)).not.toContain('private-fill-marker');
    expect(JSON.stringify(steps)).not.toContain('#login');
  }, 15000);
  it('keeps both successful results and original failures when diagnostic storage rejects', async () => {
    const request = json(input('/json', []));
    const withoutDiagnostics = { ...request };
    delete withoutDiagnostics.onDiagnostic;
    const regular = await new CrawlerRuntime().crawl(withoutDiagnostics);
    const degraded = await new CrawlerRuntime().crawl({
      ...request,
      onDiagnostic: async () => {
        throw new Error('Diagnostic storage unavailable');
      },
    });
    expect(degraded.records).toEqual(regular.records);
    expect(degraded.metadata.recordCount).toBe(regular.metadata.recordCount);
    await expect(
      new CrawlerRuntime().crawl({
        ...json(input('/failed', [])),
        onDiagnostic: async () => {
          throw new Error('Diagnostic storage unavailable');
        },
      }),
    ).rejects.toMatchObject({ code: 'NAVIGATION_ERROR' });
  });
});
