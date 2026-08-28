import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrowserSettings, RequestSettings } from '@zhiyun/shared';
import { PlaywrightAdapter, classifyBrowserFailure } from '../src/index.js';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

describe('browser failure classification', () => {
  it('returns a stable error when Chromium is missing', () => {
    expect(
      classifyBrowserFailure(
        new Error('Executable does not exist. Please run playwright install chromium'),
      ).code,
    ).toBe('BROWSER_MISSING');
  });

  it('returns a stable error when Chromium closes unexpectedly', () => {
    expect(
      classifyBrowserFailure(new Error('Target page, context or browser has been closed')).code,
    ).toBe('BROWSER_CRASHED');
  });

  it('keeps ordinary navigation failures separate', () => {
    expect(classifyBrowserFailure(new Error('net::ERR_NAME_NOT_RESOLVED')).code).toBe(
      'NAVIGATION_ERROR',
    );
  });
});

describe('PlaywrightAdapter', () => {
  it('scopes cookies without an explicit domain to the requested URL', async () => {
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<main id="cookie">${request.headers.cookie ?? 'missing'}</main>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server did not start');
    const loaded = await new PlaywrightAdapter().load(`http://127.0.0.1:${address.port}/cookie`, {
      browser: { enabled: true, waitUntil: 'domcontentloaded', actions: [] },
      request: {
        headers: {},
        cookies: [
          {
            name: 'session',
            value: 'fixture',
            path: '/',
            httpOnly: true,
            secure: false,
            sameSite: 'Lax',
          },
        ],
        timeoutMs: 10_000,
        retries: 0,
        retryBackoffMs: 0,
        concurrency: 1,
        delayMs: 0,
        maxRequests: 1,
        maxRuntimeMs: 20_000,
        domainRateLimitPerMinute: 60,
        respectRobotsTxt: false,
        maxResponseBytes: 10_000,
        redirectLimit: 1,
      },
    });
    expect(loaded.html).toContain('session=fixture');
  });

  it('rejects browser documents above the configured response limit', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<main>${'x'.repeat(4_096)}</main>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture server did not start');

    const browser: BrowserSettings = {
      enabled: true,
      waitUntil: 'domcontentloaded',
      actions: [],
    };
    const request: RequestSettings = {
      headers: {},
      cookies: [],
      timeoutMs: 10_000,
      retries: 0,
      retryBackoffMs: 0,
      concurrency: 1,
      delayMs: 0,
      maxRequests: 1,
      maxRuntimeMs: 20_000,
      domainRateLimitPerMinute: 60,
      respectRobotsTxt: false,
      maxResponseBytes: 1_024,
      redirectLimit: 1,
    };

    await expect(
      new PlaywrightAdapter().load(`http://127.0.0.1:${address.port}/oversized`, {
        browser,
        request,
      }),
    ).rejects.toMatchObject({ code: 'CRAWLER_ERROR' });
  });
});
