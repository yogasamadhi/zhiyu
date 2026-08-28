import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createAiProvider } from '@zhiyun/ai-runtime';
import { analyzePage } from '../src/application/analyzer.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('page analyzer', () => {
  it('recognizes structured JSON assigned inside a script element', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(`<html><body><script>
        _ROUTER_DATA = {"loaderData":{"detail_page":{"req":{
          "webID":"request-id","userAgent":"fixture","hostname":"internal",
          "isSSRPage":true,"domain":"https://example.com","uuid":"uuid",
          "reqName":"fixture","isInside":false,"isSuccess":true,
          "config":{"name":"configuration","url":"https://example.com/config"}
        },"seriesDetail":{
          "series_id":"12345",
          "series_name":"测试短剧",
          "intro":"简介",
          "cover":"https://example.com/cover.jpg",
          "episode_cnt":80,
          "tags":["甜宠","逆袭"]
        }}}};
      </script></body></html>`);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not listen');

    const result = await analyzePage(
      {
        url: `http://127.0.0.1:${address.port}/detail?series_id=12345`,
        instruction: '提取短剧详情',
        requestSettings: {
          headers: {},
          cookies: [],
          timeoutMs: 5_000,
          retries: 0,
          retryBackoffMs: 1,
          concurrency: 1,
          delayMs: 0,
          maxRequests: 10,
          maxRuntimeMs: 30_000,
          domainRateLimitPerMinute: 10_000,
          respectRobotsTxt: false,
          maxResponseBytes: 1024 * 1024,
          redirectLimit: 3,
        },
        browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
        useAi: false,
        forceBrowser: false,
        networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
      },
      createAiProvider(),
    );

    expect(result.engine).toBe('http');
    expect(result.candidate.list.source).toEqual({
      type: 'script-json-assignment',
      selector: 'script',
      marker: '_ROUTER_DATA =',
    });
    expect(result.candidate.list.rule).toMatchObject({
      type: 'json',
      container: '$["loaderData"]["detail_page"]["seriesDetail"]',
    });
    expect(result.preview[0]).toMatchObject({
      series_id: '12345',
      series_name: '测试短剧',
      episode_cnt: 80,
      tags: ['甜宠', '逆袭'],
    });
  });
});
