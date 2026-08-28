import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeCrawlPlan, type RequestSettings } from '@zhiyun/shared';
import { CrawlerRuntime } from '../src/index.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const settings: RequestSettings = {
  headers: {},
  cookies: [],
  timeoutMs: 10_000,
  retries: 0,
  retryBackoffMs: 1,
  concurrency: 2,
  delayMs: 0,
  maxRequests: 20,
  maxRuntimeMs: 30_000,
  domainRateLimitPerMinute: 10_000,
  respectRobotsTxt: false,
  maxResponseBytes: 1024 * 1024,
  redirectLimit: 3,
};

describe('crawler pipeline integration', () => {
  it('runs paginated JSON APIs through the shared request budget', async () => {
    const requestedPages: number[] = [];
    const server = createServer((request, response) => {
      const page = Number(new URL(request.url ?? '/', 'http://fixture').searchParams.get('page'));
      requestedPages.push(page);
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          items: [
            { id: page * 10 + 1, name: `JSON ${page}-A` },
            { id: page * 10 + 2, name: `JSON ${page}-B` },
          ],
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
    const template = `http://127.0.0.1:${address.port}/api/products?page={page}`;
    const result = await new CrawlerRuntime().crawl({
      url: template.replace('{page}', '1'),
      plan: {
        ...normalizeCrawlPlan({
          type: 'json',
          container: '$.items[*]',
          fields: {
            id: { path: '$.id', dataType: 'number' },
            name: { path: '$.name', dataType: 'string' },
          },
        }),
        pagination: { type: 'page', urlTemplate: template, startPage: 1, maxPages: 3 },
      },
      requestSettings: { ...settings, maxRequests: 2 },
      browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
      pagination: { type: 'none' },
      networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
    });
    expect(requestedPages).toEqual([1, 2]);
    expect(result.metadata.requestCount).toBe(2);
    expect(result.records.map((record) => record.data.name)).toEqual([
      'JSON 1-A',
      'JSON 1-B',
      'JSON 2-A',
      'JSON 2-B',
    ]);
  });

  it('paginates lists and merges each unique detail URL once', async () => {
    let detailRequests = 0;
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (request.url === '/list') {
        response.end(`
          <article class="item"><h2>A</h2><a href="/detail/one">详情</a></article>
          <article class="item"><h2>B</h2><a href="/detail/one">详情</a></article>
          <a class="next" href="/list?page=2">next</a>`);
        return;
      }
      if (request.url === '/list?page=2') {
        response.end('<article class="item"><h2>C</h2><a href="/detail/two">详情</a></article>');
        return;
      }
      detailRequests += 1;
      response.end(`<main><p class="description">${request.url}</p></main>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
    const result = await new CrawlerRuntime().crawl({
      url: `http://127.0.0.1:${address.port}/list`,
      plan: {
        ...normalizeCrawlPlan({
          type: 'css',
          container: '.item',
          fields: {
            name: { selector: 'h2', value: 'text', dataType: 'string' },
            url: { selector: 'a', value: 'attribute', attribute: 'href', dataType: 'url' },
          },
        }),
        pagination: { type: 'next', selector: '.next', maxPages: 2 },
        detail: {
          urlField: 'url',
          rule: {
            type: 'css',
            container: 'main',
            fields: {
              description: { selector: '.description', value: 'text', dataType: 'string' },
            },
          },
          mode: 'http',
          actions: [],
          mergeStrategy: 'detailWins',
          onError: 'keep-list-record',
          concurrency: 2,
        },
      },
      requestSettings: settings,
      browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
      pagination: { type: 'none' },
      networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
    });
    expect(result.records).toHaveLength(3);
    expect(result.records.map((record) => record.data.description)).toEqual([
      '/detail/one',
      '/detail/one',
      '/detail/two',
    ]);
    expect(detailRequests).toBe(2);
  });

  it('shares maxRequests across list and unique detail requests', async () => {
    let detailRequests = 0;
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (request.url === '/list') {
        response.end(`
          <article class="item"><h2>A</h2><a href="/detail/one">详情</a></article>
          <article class="item"><h2>B</h2><a href="/detail/two">详情</a></article>
          <article class="item"><h2>C</h2><a href="/detail/three">详情</a></article>`);
        return;
      }
      detailRequests += 1;
      response.end(`<main><p class="description">${request.url}</p></main>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
    const result = await new CrawlerRuntime().crawl({
      url: `http://127.0.0.1:${address.port}/list`,
      plan: {
        ...normalizeCrawlPlan({
          type: 'css',
          container: '.item',
          fields: {
            name: { selector: 'h2', value: 'text', dataType: 'string' },
            url: { selector: 'a', value: 'attribute', attribute: 'href', dataType: 'url' },
          },
        }),
        detail: {
          urlField: 'url',
          rule: {
            type: 'css',
            container: 'main',
            fields: {
              description: { selector: '.description', value: 'text', dataType: 'string' },
            },
          },
          mode: 'http',
          actions: [],
          mergeStrategy: 'detailWins',
          onError: 'keep-list-record',
          concurrency: 3,
        },
      },
      requestSettings: { ...settings, maxRequests: 2 },
      browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
      pagination: { type: 'none' },
      networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
    });
    expect(detailRequests).toBe(1);
    expect(result.metadata.requestCount).toBe(2);
    expect(result.records.filter((record) => record.data.description)).toHaveLength(1);
    expect(
      result.metadata.warnings.filter((warning) => warning.includes('maxRequests')),
    ).toHaveLength(2);
  });

  it('enforces maxRuntime across the detail stage', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (request.url === '/list') {
        response.end('<article class="item"><h2>A</h2><a href="/detail/slow">详情</a></article>');
        return;
      }
      setTimeout(() => response.end('<main><p class="description">slow</p></main>'), 2_000);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
    const started = Date.now();
    await expect(
      new CrawlerRuntime().crawl({
        url: `http://127.0.0.1:${address.port}/list`,
        plan: {
          ...normalizeCrawlPlan({
            type: 'css',
            container: '.item',
            fields: {
              name: { selector: 'h2', value: 'text', dataType: 'string' },
              url: { selector: 'a', value: 'attribute', attribute: 'href', dataType: 'url' },
            },
          }),
          detail: {
            urlField: 'url',
            rule: {
              type: 'css',
              container: 'main',
              fields: {
                description: { selector: '.description', value: 'text', dataType: 'string' },
              },
            },
            mode: 'http',
            actions: [],
            mergeStrategy: 'detailWins',
            onError: 'fail-run',
            concurrency: 1,
          },
        },
        requestSettings: { ...settings, maxRuntimeMs: 500 },
        browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
        pagination: { type: 'none' },
        networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
      }),
    ).rejects.toMatchObject({ code: 'CRAWLER_ERROR' });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('discovers sitemap entries and extracts structured detail data from script JSON', async () => {
    const requested: string[] = [];
    const server = createServer((request, response) => {
      requested.push(request.url ?? '/');
      if (request.url === '/sitemap.xml') {
        response.setHeader('content-type', 'application/xml');
        response.end(`<?xml version="1.0" encoding="UTF-8"?>
          <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <sitemap><loc>http://127.0.0.1:${(server.address() as { port: number }).port}/child.xml</loc></sitemap>
          </sitemapindex>`);
        return;
      }
      if (request.url === '/child.xml') {
        response.setHeader('content-type', 'application/xml');
        response.end(`<?xml version="1.0" encoding="UTF-8"?>
          <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
            <url><loc>http://127.0.0.1:${(server.address() as { port: number }).port}/detail/one</loc><lastmod>2026-08-01</lastmod></url>
            <url><loc>http://127.0.0.1:${(server.address() as { port: number }).port}/player/blocked</loc></url>
            <url><loc>http://127.0.0.1:${(server.address() as { port: number }).port}/detail/two</loc><lastmod>2026-08-02</lastmod></url>
          </urlset>`);
        return;
      }
      const id = request.url?.split('/').pop();
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<script>
        globalThis.__mustNotRun = true;
        _ROUTER_DATA = {"loaderData":{"detail_page":{"seriesDetail":{"series_id":"${id}","series_name":"Series ${id}","tags":["甜宠","逆袭"]}}}};
      </script>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
    const result = await new CrawlerRuntime().crawl({
      url: `http://127.0.0.1:${address.port}/sitemap.xml`,
      plan: normalizeCrawlPlan({
        list: {
          mode: 'http',
          actions: [],
          rule: {
            type: 'css',
            container: 'body',
            fields: {
              detailUrl: { selector: 'a', value: 'attribute', attribute: 'href', dataType: 'url' },
            },
          },
        },
        discovery: {
          type: 'sitemap',
          urlField: 'detailUrl',
          lastModifiedField: 'lastModified',
          include: ['/detail/'],
          exclude: [],
          sameOrigin: true,
          maxDepth: 1,
          maxSitemaps: 3,
          maxUrls: 10,
        },
        detail: {
          urlField: 'detailUrl',
          mode: 'http',
          actions: [],
          source: {
            type: 'script-json-assignment',
            selector: 'script',
            marker: '_ROUTER_DATA =',
          },
          rule: {
            type: 'json',
            container: '$.loaderData.detail_page.seriesDetail',
            fields: {
              seriesId: { path: '$.series_id', dataType: 'string' },
              title: { path: '$.series_name', dataType: 'string' },
              tags: { path: '$.tags', dataType: 'json' },
            },
          },
          mergeStrategy: 'detailWins',
          onError: 'fail-run',
          concurrency: 2,
        },
        dedupe: { strategy: 'fields', fields: ['seriesId'] },
        limits: { maxRecords: 10 },
      }),
      requestSettings: settings,
      browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
      pagination: { type: 'none' },
      networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
    });

    expect(result.records.map((record) => record.data.seriesId)).toEqual(['two', 'one']);
    expect(result.records[0]?.data.tags).toEqual(['甜宠', '逆袭']);
    expect(result.records[0]?.data.lastModified).toBe('2026-08-02T00:00:00.000Z');
    expect(requested).toEqual(['/sitemap.xml', '/child.xml', '/detail/two', '/detail/one']);
    expect(result.metadata.requestCount).toBe(4);
    expect(globalThis).not.toHaveProperty('__mustNotRun');
  });

  it('applies previewLimit before issuing detail requests', async () => {
    let detailRequests = 0;
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (request.url === '/list') {
        response.end(
          [1, 2, 3].map((id) => `<article><a href="/detail/${id}">${id}</a></article>`).join(''),
        );
        return;
      }
      detailRequests += 1;
      response.end(`<main><p>${request.url}</p></main>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
    const result = await new CrawlerRuntime().crawl({
      url: `http://127.0.0.1:${address.port}/list`,
      plan: {
        ...normalizeCrawlPlan({
          type: 'css',
          container: 'article',
          fields: {
            url: { selector: 'a', value: 'attribute', attribute: 'href', dataType: 'url' },
          },
        }),
        detail: {
          urlField: 'url',
          rule: {
            type: 'css',
            container: 'main',
            fields: { description: { selector: 'p', value: 'text', dataType: 'string' } },
          },
          mode: 'http',
          actions: [],
          mergeStrategy: 'detailWins',
          onError: 'fail-run',
          concurrency: 3,
        },
      },
      requestSettings: settings,
      browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
      pagination: { type: 'none' },
      networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
      previewLimit: 1,
    });

    expect(result.records).toHaveLength(1);
    expect(detailRequests).toBe(1);
    expect(result.metadata.requestCount).toBe(2);
  });

  it('serializes same-origin detail requests through the configured delay', async () => {
    const detailStartedAt: number[] = [];
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (request.url === '/list') {
        response.end(`
          <article><a href="/detail/one">one</a></article>
          <article><a href="/detail/two">two</a></article>`);
        return;
      }
      detailStartedAt.push(Date.now());
      response.end(`<main><p>${request.url}</p></main>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
    await new CrawlerRuntime().crawl({
      url: `http://127.0.0.1:${address.port}/list`,
      plan: {
        ...normalizeCrawlPlan({
          type: 'css',
          container: 'article',
          fields: {
            url: { selector: 'a', value: 'attribute', attribute: 'href', dataType: 'url' },
          },
        }),
        detail: {
          urlField: 'url',
          rule: {
            type: 'css',
            container: 'main',
            fields: { description: { selector: 'p', value: 'text', dataType: 'string' } },
          },
          mode: 'http',
          actions: [],
          mergeStrategy: 'detailWins',
          onError: 'fail-run',
          concurrency: 2,
        },
      },
      requestSettings: { ...settings, delayMs: 40 },
      browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
      pagination: { type: 'none' },
      networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
    });

    expect(detailStartedAt).toHaveLength(2);
    expect(detailStartedAt[1]! - detailStartedAt[0]!).toBeGreaterThanOrEqual(30);
  });
});
