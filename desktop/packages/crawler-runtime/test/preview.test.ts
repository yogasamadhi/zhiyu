import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  normalizeCrawlPlan,
  requestSettingsSchema,
  summarizeCollectionPreview,
  type CrawlPlanDefinition,
} from '@zhiyun/shared';
import { CrawlerRuntime } from '../src/index.js';
import { previewFixturePages } from '../../../tooling/fixtures/src/preview-pages.js';

let origin: string;
const server = createServer((request, response) => {
  const html = previewFixturePages[new URL(request.url ?? '/', 'http://fixture').pathname];
  response.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
  response.end(html ?? 'missing');
});
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const base = () =>
  normalizeCrawlPlan({
    type: 'css',
    container: '.preview-item',
    fields: {
      name: { selector: 'h2', value: 'text', dataType: 'string' },
      price: { selector: '.price', value: 'text', dataType: 'number' },
      url: { selector: '.detail-link', value: 'attribute', attribute: 'href', dataType: 'url' },
    },
  });
const preview = (path: string, plan: CrawlPlanDefinition) =>
  new CrawlerRuntime().crawl({
    url: `${origin}${path}`,
    plan,
    previewLimit: 10,
    requestSettings: requestSettingsSchema.parse({
      retries: 0,
      delayMs: 0,
      respectRobotsTxt: false,
      domainRateLimitPerMinute: 10000,
      maxRequests: 20,
    }),
    browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
    pagination: { type: 'none' },
    networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
  });
const detail = (plan: CrawlPlanDefinition) =>
  normalizeCrawlPlan({
    ...plan,
    detail: {
      urlField: 'url',
      rule: {
        type: 'css',
        container: 'main.detail',
        fields: { description: { selector: '.description', value: 'text', dataType: 'string' } },
      },
    },
  });
describe('local collection preview fixtures', () => {
  it('presents three static list samples with unique detail relationships and field provenance', async () => {
    const plan = detail(base());
    const result = await preview('/preview/static', plan);
    expect(result.records).toHaveLength(3);
    expect(result.records.map((row) => row.inspection?.detail)).toEqual(
      Array.from({ length: 3 }, () => ({
        urlField: 'url',
        linkMatches: 1,
        recordMatches: 1,
        status: 'resolved',
      })),
    );
    expect(
      summarizeCollectionPreview(plan, result.records).find(
        (field) => field.name === 'description',
      ),
    ).toMatchObject({ stage: 'detail', missingCount: 0, invalidTypeCount: 0 });
    expect(result.metadata.browserUsed).toBe(false);
  }, 15000);
  it('loads dynamic pagination and reports the same three valid field samples', async () => {
    const plan = normalizeCrawlPlan({
      ...base(),
      list: { ...base().list, mode: 'browser' },
      pagination: { type: 'loadMore', selector: '#next', maxClicks: 2, waitMs: 50 },
    });
    const result = await preview('/preview/dynamic', plan);
    expect(result.records.map((row) => row.data.name)).toEqual([
      '样本商品 1',
      '样本商品 2',
      '样本商品 3',
    ]);
    expect(
      summarizeCollectionPreview(plan, result.records).every(
        (field) => field.measured && field.emptyCount === 0 && field.invalidTypeCount === 0,
      ),
    ).toBe(true);
    expect(result.metadata.browserUsed).toBe(true);
  }, 30000);
  it('identifies navigation, advertising, missing fields, blanks and type errors', async () => {
    const result = await preview('/preview/noise', base());
    expect(result.records).toHaveLength(5);
    expect(result.records.slice(0, 2).map((row) => row.inspection?.containerHint)).toEqual([
      'navigation',
      'advertisement',
    ]);
    expect(
      summarizeCollectionPreview(base(), result.records).find((field) => field.name === 'price'),
    ).toMatchObject({ missingCount: 1, invalidTypeCount: 1, emptyRatio: 0.6 });
  }, 15000);
  for (const [path, status] of [
    ['/preview/ambiguous-links', 'ambiguous_link'],
    ['/preview/ambiguous-records', 'ambiguous_record'],
  ] as const) {
    it(`explains ${status} instead of claiming a unique relationship`, async () => {
      const result = await preview(path, detail(base()));
      expect(result.records[0]?.inspection?.detail?.status).toBe(status);
    }, 15000);
  }
});
