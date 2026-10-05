import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeCrawlPlan, requestSettingsSchema } from '@zhiyun/shared';
import { CrawlerRuntime, type CrawlRequest } from '../src/index.js';

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
async function fixture(path: string, plan: CrawlRequest['plan']): Promise<CrawlRequest> {
  const server = createServer((request, response) => {
    if (request.url === '/auto') {
      response.setHeader('content-type', 'text/html');
      response.end(
        '<!doctype html><html><body><script>const row=document.createElement("article");row.textContent="browser row";document.body.append(row);</script></body></html>',
      );
    } else if (request.url === '/large') {
      response.setHeader('content-type', 'application/json');
      response.write('{"items":[');
      const payload = '界'.repeat(140000);
      for (let id = 0; id < 7; id++)
        response.write(`${id ? ',' : ''}${JSON.stringify({ name: String(id), payload })}`);
      response.end(']}');
    } else if (request.url?.startsWith('/warnings')) {
      response.setHeader('content-type', 'application/json');
      const page = Number(new URL(request.url, 'http://fixture').searchParams.get('page'));
      response.write('{"items":[');
      for (let id = 0; id < 1000; id++)
        response.write(
          `${id ? ',' : ''}${JSON.stringify({ id: `${page}-${id}`, value: 'invalid-number' })}`,
        );
      response.end(']}');
    } else {
      response.setHeader('content-type', 'application/json');
      response.end('{"items":[{"name":"one"}]}');
    }
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  return {
    url: `http://127.0.0.1:${address.port}${path}`,
    plan,
    requestSettings: requestSettingsSchema.parse({
      delayMs: 0,
      retries: 0,
      respectRobotsTxt: false,
      domainRateLimitPerMinute: 10000,
    }),
    browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
    pagination: { type: 'none' },
    networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
  };
}
describe('streaming producer boundaries', () => {
  it('retains bounded JSON extraction warnings and their full observed count across pages', async () => {
    const input = await fixture(
      '/warnings',
      normalizeCrawlPlan({
        list: {
          mode: 'http',
          rule: {
            type: 'json',
            container: '$.items[*]',
            fields: {
              id: { path: '$.id', dataType: 'string' },
              value: { path: '$.value', dataType: 'number' },
            },
          },
        },
        limits: { maxRecords: 3000 },
      }),
    );
    input.plan.pagination = {
      type: 'page',
      urlTemplate: `${input.url}?page={page}`,
      startPage: 1,
      maxPages: 3,
    };
    let count = 0;
    const result = await new CrawlerRuntime().crawl({
      ...input,
      onBatch: async (batch) => {
        expect(batch.records.every((record) => record.data.value === null)).toBe(true);
        count += batch.records.length;
        return { acceptedCount: batch.records.length, totalCount: count };
      },
    });
    expect(count).toBe(3000);
    expect(result.records).toEqual([]);
    expect(result.metadata.warningTotal).toBe(3000);
    expect(result.metadata.warnings).toHaveLength(128);
    expect(result.metadata.warnings[127]).toBe('Additional warnings omitted: 2873');
    expect(Buffer.byteLength(JSON.stringify(result.metadata.warnings))).toBeLessThanOrEqual(
      64 * 1024,
    );
  });
  it('keeps browser fallback distinct from an empty HTTP reservation at the same URL', async () => {
    const input = await fixture(
      '/auto',
      normalizeCrawlPlan({
        type: 'css',
        container: 'article',
        fields: { name: { selector: ':scope', value: 'text', dataType: 'string' } },
      }),
    );
    const rows: unknown[] = [];
    const result = await new CrawlerRuntime().crawl({
      ...input,
      onBatch: async (batch) => {
        rows.push(...batch.records.map((row) => row.data));
        return { acceptedCount: batch.records.length, totalCount: rows.length };
      },
    });
    expect(rows).toEqual([{ name: 'browser row' }]);
    expect(result.records).toEqual([]);
    expect(result.metadata.recordCount).toBe(1);
    expect(result.metadata.browserUsed).toBe(true);
    expect(result.metadata.requestCount).toBe(2);
  }, 30000);
  it('rejects an invalid consumer acknowledgement instead of reporting a successful collection', async () => {
    const input = await fixture(
      '/json',
      normalizeCrawlPlan({
        type: 'json',
        container: '$.items[*]',
        fields: { name: { path: '$.name', dataType: 'string' } },
      }),
    );
    await expect(
      new CrawlerRuntime().crawl({
        ...input,
        onBatch: async () => ({ acceptedCount: 1, totalCount: -1 }),
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('splits large Unicode rows by serialized bytes while preserving their order', async () => {
    const input = await fixture(
      '/large',
      normalizeCrawlPlan({
        type: 'json',
        container: '$.items[*]',
        fields: {
          name: { path: '$.name', dataType: 'string' },
          payload: { path: '$.payload', dataType: 'string' },
        },
      }),
    );
    const names: unknown[] = [];
    const counts: number[] = [];
    const result = await new CrawlerRuntime().crawl({
      ...input,
      onBatch: async (batch) => {
        expect(Buffer.byteLength(JSON.stringify(batch.records))).toBeLessThanOrEqual(1024 * 1024);
        counts.push(batch.records.length);
        names.push(...batch.records.map((row) => row.data.name));
        return { acceptedCount: batch.records.length, totalCount: names.length };
      },
    });
    expect(counts).toEqual([2, 2, 2, 1]);
    expect(names).toEqual(['0', '1', '2', '3', '4', '5', '6']);
    expect(result.records).toEqual([]);
    expect(result.metadata.recordCount).toBe(7);
  });
});
