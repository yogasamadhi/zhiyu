import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeCrawlPlan, type RequestSettings } from '@zhiyun/shared';
import { assertNetworkAllowed, CrawlerRuntime, fetchPageSource } from '../src/index.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const requestSettings: RequestSettings = {
  headers: { Authorization: 'Bearer secret', 'X-Public': 'visible' },
  cookies: [
    {
      name: 'session',
      value: 'secret-cookie',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ],
  timeoutMs: 5_000,
  retries: 0,
  retryBackoffMs: 1,
  concurrency: 1,
  delayMs: 0,
  maxRequests: 10,
  maxRuntimeMs: 30_000,
  domainRateLimitPerMinute: 10_000,
  respectRobotsTxt: false,
  maxResponseBytes: 1_024,
  redirectLimit: 3,
};

describe('network policy security', () => {
  it('blocks private, metadata and unsupported URL targets', async () => {
    await expect(
      assertNetworkAllowed('http://127.0.0.1/private', {
        allowPrivateNetworks: false,
        allowedHosts: [],
        allowedCidrs: [],
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_POLICY_ERROR' });
    await expect(
      assertNetworkAllowed('http://169.254.169.254/latest/meta-data', {
        allowPrivateNetworks: true,
        allowedHosts: [],
        allowedCidrs: [],
      }),
    ).rejects.toMatchObject({ code: 'NETWORK_POLICY_ERROR' });
    await expect(assertNetworkAllowed('file:///etc/passwd')).rejects.toMatchObject({
      code: 'NETWORK_POLICY_ERROR',
    });
  });

  it('allows explicitly enabled private development targets', async () => {
    await expect(
      assertNetworkAllowed('http://127.0.0.1:45100/products', {
        allowPrivateNetworks: true,
        allowedHosts: [],
        allowedCidrs: [],
      }),
    ).resolves.toBeUndefined();
  });

  it('revalidates redirects and never forwards scoped credentials across origins', async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    const destination = createServer((request, response) => {
      receivedHeaders = request.headers;
      response.setHeader('content-type', 'text/html');
      response.end('<main>ok</main>');
    });
    servers.push(destination);
    await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve));
    const destinationAddress = destination.address();
    if (!destinationAddress || typeof destinationAddress === 'string')
      throw new Error('No address');

    const origin = createServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader('location', `http://127.0.0.1:${destinationAddress.port}/target`);
      response.end();
    });
    servers.push(origin);
    await new Promise<void>((resolve) => origin.listen(0, resolve));
    const originAddress = origin.address();
    if (!originAddress || typeof originAddress === 'string') throw new Error('No address');
    const rootUrl = `http://127.0.0.1:${originAddress.port}/start`;

    const source = await fetchPageSource(rootUrl, {
      rootUrl,
      requestSettings,
      networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
    });
    expect(source.text).toContain('ok');
    expect(receivedHeaders.authorization).toBeUndefined();
    expect(receivedHeaders.cookie).toBeUndefined();
    expect(receivedHeaders['x-public']).toBe('visible');
  });

  it('applies the same redirect credential boundary to the HTTP crawler', async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    const destination = createServer((request, response) => {
      receivedHeaders = request.headers;
      response.setHeader('content-type', 'text/html');
      response.end('<article class="item"><h2>safe</h2></article>');
    });
    servers.push(destination);
    await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve));
    const destinationAddress = destination.address();
    if (!destinationAddress || typeof destinationAddress === 'string')
      throw new Error('No address');
    const origin = createServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader('location', `http://127.0.0.1:${destinationAddress.port}/target`);
      response.end();
    });
    servers.push(origin);
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
    const originAddress = origin.address();
    if (!originAddress || typeof originAddress === 'string') throw new Error('No address');
    const rootUrl = `http://127.0.0.1:${originAddress.port}/start`;
    const result = await new CrawlerRuntime().crawl({
      url: rootUrl,
      plan: normalizeCrawlPlan({
        type: 'css',
        container: '.item',
        fields: { name: { selector: 'h2', value: 'text', dataType: 'string' } },
      }),
      requestSettings,
      browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
      pagination: { type: 'none' },
      networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
    });
    expect(result.records[0]?.data.name).toBe('safe');
    expect(receivedHeaders.authorization).toBeUndefined();
    expect(receivedHeaders.cookie).toBeUndefined();
    expect(receivedHeaders['x-public']).toBe('visible');
  });

  it('rejects bodies larger than the configured limit', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-length', '2048');
      response.end('x'.repeat(2_048));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    const url = `http://127.0.0.1:${address.port}/large`;
    await expect(
      fetchPageSource(url, {
        requestSettings,
        networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
      }),
    ).rejects.toMatchObject({ code: 'CRAWLER_ERROR' });
  });

  it('stops reading oversized chunked bodies without a content-length header', async () => {
    let closedEarly = false;
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/plain');
      const timer = setInterval(() => response.write('x'.repeat(512)), 5);
      response.on('close', () => {
        closedEarly = true;
        clearInterval(timer);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    const url = `http://127.0.0.1:${address.port}/chunked`;
    await expect(
      fetchPageSource(url, {
        requestSettings,
        networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
      }),
    ).rejects.toMatchObject({ code: 'CRAWLER_ERROR' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closedEarly).toBe(true);
  });

  it('revalidates robots.txt redirects through the network policy', async () => {
    let protectedTargetReached = false;
    const protectedTarget = createServer((_request, response) => {
      protectedTargetReached = true;
      response.end('User-agent: *\nDisallow: /');
    });
    servers.push(protectedTarget);
    await new Promise<void>((resolve) => protectedTarget.listen(0, '127.0.0.1', resolve));
    const protectedAddress = protectedTarget.address();
    if (!protectedAddress || typeof protectedAddress === 'string') throw new Error('No address');

    const origin = createServer((request, response) => {
      if (request.url === '/robots.txt') {
        response.statusCode = 302;
        response.setHeader('location', `http://127.0.0.1:${protectedAddress.port}/private-robots`);
        response.end();
        return;
      }
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end('<article class="item"><h2>safe</h2></article>');
    });
    servers.push(origin);
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
    const originAddress = origin.address();
    if (!originAddress || typeof originAddress === 'string') throw new Error('No address');
    const url = `http://localhost:${originAddress.port}/products`;

    await new CrawlerRuntime().crawl({
      url,
      plan: normalizeCrawlPlan({
        type: 'css',
        container: '.item',
        fields: { name: { selector: 'h2', value: 'text', dataType: 'string' } },
      }),
      requestSettings: { ...requestSettings, respectRobotsTxt: true },
      browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
      pagination: { type: 'none' },
      networkPolicy: {
        allowPrivateNetworks: false,
        allowedHosts: ['localhost'],
        allowedCidrs: [],
      },
    });
    expect(protectedTargetReached).toBe(false);
  });

  it('checks robots.txt for detail URLs as well as the initial page', async () => {
    let privateDetailReached = false;
    let publicDetailReached = false;
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (request.url === '/robots.txt') {
        response.setHeader('content-type', 'text/plain');
        response.end('User-agent: *\nDisallow: /detail/private\n');
        return;
      }
      if (request.url === '/list') {
        response.end(`
          <article><a href="/detail/private">private</a></article>
          <article><a href="/detail/public">public</a></article>`);
        return;
      }
      if (request.url === '/detail/private') privateDetailReached = true;
      if (request.url === '/detail/public') publicDetailReached = true;
      response.end(`<main><p>${request.url}</p></main>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
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
          onError: 'skip',
          concurrency: 2,
        },
      },
      requestSettings: { ...requestSettings, respectRobotsTxt: true },
      browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
      pagination: { type: 'none' },
      networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
    });

    expect(privateDetailReached).toBe(false);
    expect(publicDetailReached).toBe(true);
    expect(result.records.map((record) => record.data.description)).toEqual(['/detail/public']);
    expect(result.metadata.warnings.some((warning) => warning.includes('robots.txt'))).toBe(true);
  });
});
