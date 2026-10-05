import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAiProvider, OpenAiCompatibleProvider, HostedAiProvider } from '@zhiyun/ai-runtime';
import {
  browserSettingsSchema,
  requestSettingsSchema,
  crawlPlanDefinitionSchema,
  type AiProvider,
} from '@zhiyun/contracts';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { analyzePage, type AnalyzeInput } from '../src/application/analyzer.js';
import {
  RuleAnalysisCache,
  cacheDigest,
  pageStructureFingerprint,
} from '../src/application/rule-cache.js';
import { SqliteAiConversationRepository } from '../src/persistence/sqlite/index.js';

describe('persistent verified rule cache with local Mock fixtures', () => {
  let directory: string;
  let filePath: string;
  let platform: Awaited<ReturnType<typeof openSqlitePlatformRepository>>;
  let repository: SqliteAiConversationRepository;
  let cache: RuleAnalysisCache;
  let server: ReturnType<typeof createServer>;
  let page: string;
  let contentType: string;
  let input: AnalyzeInput;
  let calls: string[];
  let provider: AiProvider;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'zhiyun-rule-cache-'));
    filePath = join(directory, 'zhiyun.sqlite3');
    platform = await openSqlitePlatformRepository({
      dataDirectory: directory,
      filePath,
      graphRevision: 'rule-cache-fixture',
    });
    repository = new SqliteAiConversationRepository(filePath);
    await repository.migrate();
    cache = new RuleAnalysisCache(repository);
    page =
      '<main><article class="product-card"><h2>Alpha</h2><span class="price">10</span></article><article class="product-card"><h2>Beta</h2><span class="price">20</span></article></main>';
    contentType = 'text/html';
    server = createServer((request, response) => {
      response.setHeader('content-type', contentType);
      response.end(
        request.url?.includes('page=2')
          ? page.replace('Alpha', 'Next Alpha').replace('Beta', 'Next Beta')
          : page,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
    input = {
      taskId: randomUUID(),
      ruleVersion: 'fixture-rule-v1',
      url: `http://127.0.0.1:${address.port}/list`,
      instruction: 'name price',
      requestSettings: requestSettingsSchema.parse({
        timeoutMs: 5000,
        retries: 0,
        delayMs: 0,
        respectRobotsTxt: false,
      }),
      browserSettings: browserSettingsSchema.parse({}),
      networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
      useAi: true,
      forceBrowser: false,
    };
    calls = [];
    provider = new MockAiProvider((usage) => {
      calls.push(usage.operation);
    });
  });
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await repository?.close();
    await platform?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const analyze = () => analyzePage(input, provider, cache);
  const changeSql = (sql: string, ...values: unknown[]) => {
    const database = new Database(filePath);
    try {
      database.prepare(sql).run(...values);
    } finally {
      database.close();
    }
  };

  it('invalidates legacy qualification keys as a tool version change before reusing the new version', async () => {
    cache = new RuleAnalysisCache(repository, { toolSchemaVersion: 'crawl-plan-v1' });
    expect((await analyze()).cache).toMatchObject({ status: 'stored', providerCalls: 2 });
    await repository.close();
    repository = new SqliteAiConversationRepository(filePath);
    await repository.migrate();
    cache = new RuleAnalysisCache(repository);
    calls.length = 0;
    expect((await analyze()).cache).toMatchObject({
      status: 'stored',
      reason: 'prompt_changed',
      providerCalls: 2,
    });
    expect(calls).toEqual(['generateSchema', 'generateRule']);
    calls.length = 0;
    expect((await analyze()).cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(calls).toEqual([]);
  });

  it('creates a verified rule with two Mock calls, then uses fresh data with zero calls across repository reopen', async () => {
    const first = await analyze();
    expect(first.cache).toMatchObject({
      status: 'stored',
      reason: 'empty',
      providerCalls: 2,
      hitCount: 0,
    });
    expect(calls).toEqual(['generateSchema', 'generateRule']);
    const initialMockCalls = calls.length;
    await repository.close();
    repository = new SqliteAiConversationRepository(filePath);
    await repository.migrate();
    cache = new RuleAnalysisCache(repository);
    page = page.replace('Alpha', 'Changed').replace('>10<', '>30<');
    calls.length = 0;
    const second = await analyze();
    expect(second.cache).toMatchObject({
      status: 'hit',
      reason: 'matched',
      providerCalls: 0,
      hitCount: 1,
      previousValidated: true,
    });
    expect(second.aiUsed).toBe(false);
    expect(calls).toEqual([]);
    expect(second.preview[0]).toEqual({ name: 'Changed', price: 30 });
    const third = await analyze();
    expect(third.cache?.hitCount).toBe(2);
    console.info(
      'RULE_CACHE_METRICS',
      JSON.stringify({
        fixture: 'http-products-v1',
        provider: 'Mock',
        initialMockCalls,
        repeatMockCalls: calls.length,
        repeatAnalyses: 2,
        verifiedHits: third.cache?.hitCount,
      }),
    );
  });

  it('validates the old rule before reusing it on a structural change without a model call', async () => {
    await analyze();
    calls.length = 0;
    page = `<section>${page}</section>`;
    const result = await analyze();
    expect(result.cache).toMatchObject({
      status: 'stored',
      reason: 'structure_changed',
      previousValidated: true,
      providerCalls: 0,
      hitCount: 1,
    });
    expect(calls).toEqual([]);
  });
  it('caches public pagination and search parameters without mistaking them for plan metadata', async () => {
    input.url += '?page=1&limit=1000&q=name';
    const first = await analyze();
    expect(first.cache).toMatchObject({ status: 'stored', providerCalls: 2 });
    expect(calls).toHaveLength(2);
    const initialMockCalls = calls.length;
    calls.length = 0;
    page = page.replace('Alpha', 'Changed');
    const second = await analyze();
    expect(second.cache).toMatchObject({ status: 'hit', providerCalls: 0, hitCount: 1 });
    expect(calls).toEqual([]);
    expect(second.preview[0]?.name).toBe('Changed');
    console.info(
      'RULE_CACHE_METRICS',
      JSON.stringify({
        fixture: 'public-query-v1',
        provider: 'Mock',
        initialMockCalls,
        repeatMockCalls: calls.length,
        verifiedHits: second.cache?.hitCount,
      }),
    );
  });
  it.each(['token', 'api_key', 'csrf', 't', 'access_key'])(
    'isolates the %s URL parameter and keeps its value out of SQLite and WAL',
    async (parameter) => {
      const markers = ['FAKE_QUERY_TOKEN_a94c', 'FAKE_QUERY_TOKEN_f372'];
      input.url += `?${parameter}=${markers[0]}&page=1`;
      expect((await analyze()).cache?.status).toBe('stored');
      calls.length = 0;
      expect((await analyze()).cache).toMatchObject({ status: 'hit', providerCalls: 0 });
      expect(calls).toEqual([]);
      input.url = input.url.replace(markers[0]!, markers[1]!);
      expect((await analyze()).cache).toMatchObject({
        reason: 'session_changed',
        providerCalls: 2,
      });
      expect(calls).toHaveLength(2);
      let scanned = 0;
      for (const path of [filePath, `${filePath}-wal`]) {
        const bytes = await readFile(path);
        scanned++;
        for (const marker of markers) expect(bytes.includes(Buffer.from(marker))).toBe(false);
      }
      expect(scanned).toBe(2);
      const candidate = crawlPlanDefinitionSchema.parse({
        list: {
          rule: { type: 'css', container: `#${markers[1]}`, fields: { name: { selector: 'h2' } } },
        },
      });
      const html = `<article id="${markers[1]}"><h2>Alpha</h2></article>`;
      const rejected = await cache.resolve(
        input,
        provider,
        { input: html, structure: html, format: 'html', url: input.url },
        async () => ({ candidate, providerCalls: 2, generated: true }),
      );
      expect(rejected.cache.reason).toBe('privacy_rejected');
    },
  );
  it('does not confuse a short authentication value with the numeric plan version', async () => {
    input.url += '?code=1';
    input.requestSettings.headers.authorization = 'Bearer 1';
    expect((await analyze()).cache?.status).toBe('stored');
    calls.length = 0;
    expect((await analyze()).cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(calls).toEqual([]);
    const html = '<article data-testid="1"><h2>Alpha</h2></article>';
    const candidate = crawlPlanDefinitionSchema.parse({
      list: {
        rule: { type: 'css', container: '[data-testid="1"]', fields: { name: { selector: 'h2' } } },
      },
    });
    const result = await cache.resolve(
      input,
      provider,
      { input: html, structure: html, format: 'html', url: input.url },
      async () => ({ candidate, providerCalls: 2, generated: true }),
    );
    expect(result.cache.reason).toBe('privacy_rejected');
  });
  it.each(['css', 'xpath'] as const)(
    'persists validated %s structural attribute selectors',
    async (type) => {
      page = page
        .replaceAll('class="product-card"', 'class="product-card" data-testid="record"')
        .replaceAll('class="price"', 'class="price" data-testid="price"');
      class AttributeFixture extends MockAiProvider {
        override async generateRule(args: Parameters<AiProvider['generateRule']>[0]) {
          await super.generateRule(args);
          const priceAttribute = args.html.includes('data-testid="new-price"')
            ? 'new-price'
            : 'price';
          return crawlPlanDefinitionSchema.parse({
            list: {
              rule: {
                type,
                container:
                  type === 'css' ? '[data-testid="record"]' : '//article[@data-testid="record"]',
                fields: {
                  name: { selector: type === 'css' ? 'h2' : './h2' },
                  price: {
                    selector:
                      type === 'css'
                        ? `[data-testid="${priceAttribute}"]`
                        : `./span[@data-testid="${priceAttribute}"]`,
                    dataType: 'number',
                  },
                },
              },
            },
          });
        }
      }
      provider = new AttributeFixture((usage) => {
        calls.push(usage.operation);
      });
      expect((await analyze()).cache).toMatchObject({ status: 'stored', providerCalls: 2 });
      expect(calls).toHaveLength(2);
      calls.length = 0;
      page = page.replace('Alpha', 'Changed');
      const second = await analyze();
      expect(second.cache).toMatchObject({ status: 'hit', providerCalls: 0 });
      expect(calls).toEqual([]);
      expect(second.preview[0]).toEqual({ name: 'Changed', price: 10 });
      page = page.replaceAll('data-testid="price"', 'data-testid="new-price"');
      const changed = await analyze();
      expect(changed.cache).toMatchObject({
        reason: 'structure_changed',
        previousValidated: false,
        providerCalls: 2,
      });
      expect(calls).toHaveLength(2);
      calls.length = 0;
      expect((await analyze()).cache).toMatchObject({ status: 'hit', providerCalls: 0 });
      expect(calls).toEqual([]);
    },
  );
  it('reuses a custom rule before browser fallback even when the heuristic cannot identify its containers', async () => {
    page =
      '<main><div class="grid-card"><b class="custom-title">Alpha</b><i class="custom-price">10</i></div><div class="grid-card"><b class="custom-title">Beta</b><i class="custom-price">20</i></div></main>';
    class CustomFixture extends MockAiProvider {
      override async generateRule(args: Parameters<AiProvider['generateRule']>[0]) {
        await super.generateRule(args);
        return crawlPlanDefinitionSchema.parse({
          list: {
            rule: {
              type: 'css',
              container: '.grid-card',
              fields: {
                name: { selector: '.custom-title' },
                price: { selector: '.custom-price', dataType: 'number' },
              },
            },
          },
        });
      }
    }
    provider = new CustomFixture((usage) => {
      calls.push(usage.operation);
    });
    const first = await analyze();
    expect(first.engine).toBe('browser');
    expect(first.cache).toMatchObject({ status: 'stored', providerCalls: 2 });
    expect(calls).toHaveLength(2);
    const initialMockCalls = calls.length;
    calls.length = 0;
    page = page.replace('Alpha', 'Changed');
    const second = await analyze();
    expect(second.engine).toBe('http');
    expect(second.preview[0]).toEqual({ name: 'Changed', price: 10 });
    expect(second.cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(calls).toEqual([]);
    console.info(
      'RULE_CACHE_METRICS',
      JSON.stringify({
        fixture: 'custom-containers-v1',
        provider: 'Mock',
        firstEngine: first.engine,
        repeatEngine: second.engine,
        initialMockCalls,
        repeatMockCalls: calls.length,
        verifiedHits: second.cache?.hitCount,
      }),
    );
  }, 15_000);
  it('regenerates after changed containers invalidate the old extraction', async () => {
    await analyze();
    calls.length = 0;
    page = page.replaceAll('product-card', 'item');
    const result = await analyze();
    expect(result.cache).toMatchObject({
      status: 'stored',
      reason: 'structure_changed',
      previousValidated: false,
      providerCalls: 2,
    });
    expect(result.preview).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });
  it('waits for asynchronously rendered list records and reuses their rule without another model call', async () => {
    const products = page;
    page = `<main id="items"></main><script>setTimeout(() => {
      document.querySelector('#items').innerHTML = ${JSON.stringify(products)};
    }, 400);</script>`;
    const first = await analyze();
    expect(first.engine).toBe('browser');
    expect(first.preview).toEqual([
      { name: 'Alpha', price: 10 },
      { name: 'Beta', price: 20 },
    ]);
    expect(first.cache).toMatchObject({ status: 'stored', providerCalls: 2 });
    expect(calls).toHaveLength(2);
    calls.length = 0;
    page = page.replace('Alpha', 'Changed');
    const second = await analyze();
    expect(second.engine).toBe('browser');
    expect(second.preview[0]?.name).toBe('Changed');
    expect(second.cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(calls).toEqual([]);
  }, 15_000);
  it('does not call a provider on an empty deterministic preview when AI is explicitly disabled', async () => {
    input.useAi = false;
    page = '<main><div class="unknown-container">No heuristic fields</div></main>';
    const result = await analyze();
    expect(result.engine).toBe('browser');
    expect(result.preview).toEqual([]);
    expect(result.aiUsed).toBe(false);
    expect(result.cache).toMatchObject({
      status: 'miss',
      reason: 'validation_failed',
      providerCalls: 0,
    });
    expect(result.warnings.join(' ')).toContain('explicitly enable AI');
    expect(calls).toEqual([]);
  }, 15_000);
  it('rejects missing field data even when the structure is unchanged and never stores the invalid fallback', async () => {
    await analyze();
    const previous = (
      await repository.readValidatedCache(cacheDigest(`task:${input.taskId}`), 'rule')
    ).entry;
    const originalPage = page;
    calls.length = 0;
    page = page.replace('>10<', '><');
    const result = await analyze();
    expect(result.cache).toMatchObject({
      status: 'miss',
      reason: 'validation_failed',
      previousValidated: false,
      providerCalls: 2,
    });
    expect(
      (await repository.readValidatedCache(cacheDigest(`task:${input.taskId}`), 'rule')).entry,
    ).toEqual(previous);
    page = originalPage;
    calls.length = 0;
    expect((await analyze()).cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(calls).toEqual([]);
  });
  it.each([
    [
      'rule_changed',
      () => {
        input.ruleVersion = 'fixture-rule-v2';
      },
    ],
    [
      'rule_changed',
      () => {
        input.taskVersion = 2;
      },
    ],
    [
      'configuration_changed',
      () => {
        input.pagination = { type: 'next', selector: '.next', maxPages: 2 };
        page += '<a class="next" href="/list?page=2">Next</a>';
      },
    ],
    [
      'configuration_changed',
      () => {
        input.datasetSettings = { mode: 'upsert', keyFields: ['name'], detectRemoved: false };
      },
    ],
    [
      'provider_changed',
      () => {
        provider = Object.assign(
          new MockAiProvider((usage) => {
            calls.push(usage.operation);
          }),
          { name: 'mock-other-model' },
        );
      },
    ],
    [
      'prompt_changed',
      () => {
        cache = new RuleAnalysisCache(repository, { promptVersion: 'fixture-v2' });
      },
    ],
    [
      'provider_changed',
      () => {
        Object.defineProperty(provider, 'cacheIdentity', {
          get: () => ({ provider: 'mock', model: 'fixture-model-v2', configuration: 'mock-v1' }),
        });
      },
    ],
    [
      'prompt_changed',
      () => {
        cache = new RuleAnalysisCache(repository, { toolSchemaVersion: 'fixture-schema-v2' });
      },
    ],
    [
      'configuration_changed',
      () => {
        input.requestSettings.timeoutMs = 6000;
      },
    ],
    [
      'configuration_changed',
      () => {
        input.browserSettings.actions = [{ type: 'wait', milliseconds: 10 }];
      },
    ],
    [
      'session_changed',
      () => {
        input.requestSettings.headers.authorization = 'Bearer FAKE_CACHE_AUTH_CHANGED';
      },
    ],
    [
      'session_changed',
      () => {
        input.browserSettings.storageState = {
          origins: [
            {
              origin: 'http://fixture.invalid',
              localStorage: [{ name: 'session', value: 'FAKE_CACHE_SESSION_CHANGED' }],
            },
          ],
        };
      },
    ],
  ] as const)('invalidates for %s', async (reason, change) => {
    await analyze();
    calls.length = 0;
    change();
    const result = await analyze();
    expect(result.cache).toMatchObject({ status: 'stored', reason, providerCalls: 2 });
    expect(calls).toHaveLength(2);
  });
  it('expires without extending the original TTL on hits', async () => {
    let time = 1_000_000;
    cache = new RuleAnalysisCache(repository, { now: () => time, ttlMs: 100 });
    await analyze();
    time += 50;
    expect((await analyze()).cache?.status).toBe('hit');
    time += 51;
    calls.length = 0;
    expect((await analyze()).cache).toMatchObject({
      status: 'stored',
      reason: 'expired',
      providerCalls: 2,
    });
    expect(calls).toHaveLength(2);
  });
  it.each(['invalid-json', 'invalid-checksum', 'invalid-schema'])(
    'degrades corrupted %s with an explicit reason',
    async (kind) => {
      await analyze();
      calls.length = 0;
      const payload =
        kind === 'invalid-json' ? '{' : kind === 'invalid-schema' ? '{}' : '{"unexpected":true}';
      const hash =
        kind === 'invalid-checksum'
          ? '0'.repeat(64)
          : (await import('node:crypto')).createHash('sha256').update(payload).digest('hex');
      changeSql('UPDATE ai_validated_cache SET payload=?,payload_hash=?', payload, hash);
      const result = await analyze();
      expect(result.cache).toMatchObject({ status: 'stored', reason: 'corrupt', providerCalls: 2 });
      expect(calls).toHaveLength(2);
    },
  );
  it('clears one scope without deleting another task and stops in-flight writes after clearing', async () => {
    await analyze();
    const scope = `task:${input.taskId}`;
    const other = { ...input, taskId: randomUUID() };
    await analyzePage(other, provider, cache);
    expect(await cache.clear(scope)).toBe(1);
    expect((await repository.readValidatedCache(cacheDigest(scope), 'rule')).entry).toBeNull();
    expect((await analyzePage(other, provider, cache)).cache?.status).toBe('hit');
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = provider;
    provider = {
      ...current,
      cacheIdentity: current.cacheIdentity,
      streamChat: current.streamChat.bind(current),
      generateSchema: async (args) => {
        started();
        await hold;
        return current.generateSchema(args);
      },
      generateRule: current.generateRule.bind(current),
      extract: current.extract.bind(current),
      suggestRepair: current.suggestRepair.bind(current),
      explainFailure: current.explainFailure.bind(current),
    };
    const pending = analyze();
    await entered;
    expect(await cache.clear(scope)).toBe(0);
    release();
    expect((await pending).cache).toMatchObject({
      status: 'miss',
      reason: 'cleared_during_analysis',
      providerCalls: 2,
    });
    expect((await repository.readValidatedCache(cacheDigest(scope), 'rule')).entry).toBeNull();
  });
  it('degrades an invalid expiry instead of treating a NaN expiry as a permanent cache hit', async () => {
    await analyze();
    calls.length = 0;
    changeSql('UPDATE ai_validated_cache SET expires_at=?', 'not-a-time');
    const result = await analyze();
    expect(result.cache).toMatchObject({ status: 'stored', reason: 'corrupt', providerCalls: 2 });
    expect(calls).toHaveLength(2);
  });
  it('never writes page content, fill values, Cookie, authorization or storage-state markers into DB/WAL', async () => {
    const markers = [
      'FAKE_CACHE_TOKEN_7a2931',
      'FAKE_CACHE_COOKIE_83ea01',
      'FAKE_CACHE_FILL_23aae1',
      'FAKE_CACHE_STORAGE_3b201e',
      'FAKE_CACHE_PAGE_CONTENT_e242ab',
    ];
    input.requestSettings.headers.authorization = `Bearer ${markers[0]}`;
    input.requestSettings.cookies = [
      {
        name: 'session',
        value: markers[1]!,
        path: '/',
        secure: false,
        httpOnly: true,
        sameSite: 'Lax',
      },
    ];
    input.browserSettings.actions = [{ type: 'fill', selector: '#search', value: markers[2]! }];
    input.browserSettings.storageState = {
      origins: [{ origin: input.url, localStorage: [{ name: 'token', value: markers[3]! }] }],
    };
    page += `<aside>${markers[4]}</aside><input id="search" value="${markers[2]}">`;
    expect((await analyze()).cache?.status).toBe('stored');
    expect((await analyze()).cache?.status).toBe('hit');
    const entry = (await repository.readValidatedCache(cacheDigest(`task:${input.taskId}`), 'rule'))
      .entry!;
    expect(entry.payload).not.toContain('<');
    const files = [filePath, `${filePath}-wal`];
    let scanned = 0;
    for (const file of files) {
      const bytes = await readFile(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!bytes) continue;
      scanned++;
      for (const marker of markers) expect(bytes.includes(Buffer.from(marker))).toBe(false);
    }
    expect(scanned).toBe(2);
  });
  it('bypasses providers whose model identity is unknown', async () => {
    const current = provider;
    provider = {
      streamChat: current.streamChat.bind(current),
      generateSchema: current.generateSchema.bind(current),
      generateRule: current.generateRule.bind(current),
      extract: current.extract.bind(current),
      suggestRepair: current.suggestRepair.bind(current),
      explainFailure: current.explainFailure.bind(current),
    };
    expect((await analyze()).cache).toMatchObject({
      status: 'bypassed',
      reason: 'provider_unknown',
      providerCalls: 2,
    });
    expect(
      (await repository.readValidatedCache(cacheDigest(`task:${input.taskId}`), 'rule')).entry,
    ).toBeNull();
  });
  it('persists validated JSON rules without storing record values', async () => {
    contentType = 'application/json';
    page = JSON.stringify({
      items: [
        { name: 'Alpha', price: 10 },
        { name: 'Beta', price: 20 },
      ],
    });
    class JsonFixture extends MockAiProvider {
      override async generateRule(args: Parameters<AiProvider['generateRule']>[0]) {
        await super.generateRule(args);
        return args.schema;
      }
    }
    provider = new JsonFixture((usage) => {
      calls.push(usage.operation);
    });
    expect((await analyze()).cache?.status).toBe('stored');
    calls.length = 0;
    page = page.replace('Alpha', 'Changed');
    const result = await analyze();
    expect(result.cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(calls).toEqual([]);
    expect(result.preview[0]?.name).toBe('Changed');
    expect(
      (await repository.readValidatedCache(cacheDigest(`task:${input.taskId}`), 'rule')).entry
        ?.payload,
    ).not.toContain('Changed');
  });
  it('extracts and caches a top-level JSON record array with current values on reuse', async () => {
    contentType = 'application/json';
    page = JSON.stringify([
      { name: 'Alpha', price: 10 },
      { name: 'Beta', price: 20 },
    ]);
    class ArrayFixture extends MockAiProvider {
      override async generateRule(args: Parameters<AiProvider['generateRule']>[0]) {
        await super.generateRule(args);
        return args.schema;
      }
    }
    provider = new ArrayFixture((usage) => {
      calls.push(usage.operation);
    });
    const first = await analyze();
    expect(first.cache).toMatchObject({ status: 'stored', providerCalls: 2 });
    expect(first.candidate.list.rule.container).toBe('$[*]');
    expect(first.preview).toEqual([
      { name: 'Alpha', price: 10 },
      { name: 'Beta', price: 20 },
    ]);
    calls.length = 0;
    page = page.replace('Alpha', 'Changed');
    const second = await analyze();
    expect(second.cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(calls).toEqual([]);
    expect(second.preview[0]?.name).toBe('Changed');
  });
  it('does not cache generated fill values or unexecuted browser actions', async () => {
    const rule = crawlPlanDefinitionSchema.parse({
      list: {
        rule: { type: 'css', container: '.product-card', fields: { name: { selector: 'h2' } } },
        actions: [{ type: 'fill', selector: '#search', value: 'FAKE_GENERATED_FILL_a93b' }],
      },
    });
    const result = await cache.resolve(
      input,
      provider,
      { input: page, structure: page, format: 'html', url: input.url },
      async () => ({ candidate: rule, providerCalls: 2, generated: true }),
    );
    expect(result.cache).toMatchObject({ status: 'miss', reason: 'privacy_rejected' });
    rule.list.actions = [{ type: 'click', selector: '#next' }];
    const unverified = await cache.resolve(
      input,
      provider,
      { input: page, structure: page, format: 'html', url: input.url },
      async () => ({ candidate: rule, providerCalls: 2, generated: true }),
    );
    expect(unverified.cache).toMatchObject({ status: 'miss', reason: 'validation_failed' });
  });
  it('rejects raw DOM hidden in an otherwise valid plan metadata field', async () => {
    const candidate = crawlPlanDefinitionSchema.parse({
      list: {
        rule: { type: 'css', container: '.product-card', fields: { name: { selector: 'h2' } } },
      },
      dedupe: { strategy: 'hash', fields: [page] },
    });
    const result = await cache.resolve(
      input,
      provider,
      { input: page, structure: page, format: 'html', url: input.url },
      async () => ({ candidate, providerCalls: 2, generated: true }),
    );
    expect(result.cache).toMatchObject({ status: 'miss', reason: 'privacy_rejected' });
    expect(
      (await repository.readValidatedCache(cacheDigest(`task:${input.taskId}`), 'rule')).entry,
    ).toBeNull();
  });
  it('rejects selectors that echo a page credential or embed literal form values', async () => {
    const secret = 'FAKE_PAGE_TOKEN_SELECTOR_9bd5';
    page = `<main data-token="${secret}"><article id="${secret}" class="product-card"><h2>Alpha</h2></article></main>`;
    const rule = crawlPlanDefinitionSchema.parse({
      list: {
        rule: { type: 'css', container: `#${secret}`, fields: { name: { selector: 'h2' } } },
      },
    });
    const result = await cache.resolve(
      input,
      provider,
      { input: page, structure: page, format: 'html', url: input.url },
      async () => ({ candidate: rule, providerCalls: 2, generated: true }),
    );
    expect(result.cache.reason).toBe('privacy_rejected');
    rule.list.rule.container = '[data-token="literal-form-value"]';
    const literal = await cache.resolve(
      input,
      provider,
      { input: page, structure: page, format: 'html', url: input.url },
      async () => ({ candidate: rule, providerCalls: 2, generated: true }),
    );
    expect(literal.cache.reason).toBe('privacy_rejected');
    expect(
      (await repository.readValidatedCache(cacheDigest(`task:${input.taskId}`), 'rule')).entry,
    ).toBeNull();
  });
  it.each([
    { type: 'css', container: '[data-title="Alpha"]', field: 'h2' },
    { type: 'css', container: 'article:contains("Alpha")', field: 'h2' },
    { type: 'xpath', container: "//article[h2/text()='Alpha']", field: './h2' },
  ] as const)(
    'rejects a text-bearing $type selector despite a successful preview',
    async ({ type, container, field }) => {
      const html = '<article data-title="Alpha"><h2>Alpha</h2></article>';
      const candidate = crawlPlanDefinitionSchema.parse({
        list: { rule: { type, container, fields: { name: { selector: field } } } },
      });
      const result = await cache.resolve(
        input,
        provider,
        { input: html, structure: html, format: 'html', url: input.url },
        async () => ({ candidate, providerCalls: 0, generated: true }),
      );
      expect(result.preview).toEqual([{ name: 'Alpha' }]);
      expect(result.cache).toMatchObject({ status: 'miss', reason: 'privacy_rejected' });
      expect(
        (await repository.readValidatedCache(cacheDigest(`task:${input.taskId}`), 'rule')).entry,
      ).toBeNull();
    },
  );
  it('stores no fallback after a provider failure and propagates cancellation', async () => {
    const current = provider;
    provider = {
      ...current,
      cacheIdentity: current.cacheIdentity,
      streamChat: current.streamChat.bind(current),
      generateSchema: async () => {
        throw new Error('Fixture provider failure');
      },
      generateRule: current.generateRule.bind(current),
      extract: current.extract.bind(current),
      suggestRepair: current.suggestRepair.bind(current),
      explainFailure: current.explainFailure.bind(current),
    };
    expect((await analyze()).cache).toMatchObject({
      status: 'miss',
      reason: 'generation_failed',
      providerCalls: 1,
    });
    const controller = new AbortController();
    controller.abort(new Error('Fixture canceled'));
    input.signal = controller.signal;
    await expect(analyze()).rejects.toThrow('Fixture canceled');
    expect(
      (await repository.readValidatedCache(cacheDigest(`task:${input.taskId}`), 'rule')).entry,
    ).toBeNull();
  });
  it.each(['short-fill', 'bare-authorization'])(
    'rejects a selector echoing %s credentials',
    async (kind) => {
      const value = kind === 'short-fill' ? 'abc' : 'FAKE_RULE_AUTH_29ac';
      if (kind === 'short-fill')
        input.browserSettings.actions = [{ type: 'fill', selector: '#search', value }];
      else input.requestSettings.headers.authorization = `Bearer ${value}`;
      const html = `<article id="${value}"><h2>Alpha</h2></article>`;
      const candidate = crawlPlanDefinitionSchema.parse({
        list: {
          rule: { type: 'css', container: `#${value}`, fields: { name: { selector: 'h2' } } },
        },
      });
      const result = await cache.resolve(
        input,
        provider,
        { input: html, structure: html, format: 'html', url: input.url },
        async () => ({ candidate, providerCalls: 2, generated: true }),
      );
      expect(result.cache.reason).toBe('privacy_rejected');
      expect(
        (await repository.readValidatedCache(cacheDigest(`task:${input.taskId}`), 'rule')).entry,
      ).toBeNull();
    },
  );
  it('evicts old entries at a fixed global capacity and records its additive migration', async () => {
    const migrations = await platform.listMigrations();
    expect(migrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pluginId: 'ai-assistance', migrationId: '003-validated-cache' }),
      ]),
    );
    await analyze();
    const read = await repository.readValidatedCache(cacheDigest(`task:${input.taskId}`), 'rule');
    const entry = read.entry!;
    for (let index = 0; index < 260; index++)
      await repository.writeValidatedCache(
        {
          ...entry,
          scopeHash: cacheDigest(`fixture-${index}`),
          keyHash: cacheDigest(`key-${index}`),
          createdAt: entry.createdAt + index + 1,
          expiresAt: entry.expiresAt + index + 1,
        },
        read.generation,
      );
    const database = new Database(filePath);
    try {
      expect(database.prepare('SELECT count(*) AS total FROM ai_validated_cache').get()).toEqual({
        total: 256,
      });
    } finally {
      database.close();
    }
    expect((await repository.readValidatedCache(entry.scopeHash, 'rule')).entry).toBeNull();
  });
});

describe('rule cache structural and provider identity boundaries', () => {
  it('ignores HTML text/input values and JSON values, detects structures, and refuses truncated fingerprints', () => {
    expect(
      pageStructureFingerprint('<main><input value="private-a"><p>first</p></main>', 'html'),
    ).toBe(pageStructureFingerprint('<main><input value="private-b"><p>second</p></main>', 'html'));
    expect(pageStructureFingerprint({ items: [{ name: 'a', price: 10 }] }, 'json')).toBe(
      pageStructureFingerprint(
        {
          items: [
            { price: 20, name: 'b' },
            { name: 'c', price: 30 },
          ],
        },
        'json',
      ),
    );
    expect(pageStructureFingerprint({ items: [{ name: 'a', price: '10' }] }, 'json')).not.toBe(
      pageStructureFingerprint({ items: [{ name: 'a', price: 10 }] }, 'json'),
    );
    expect(
      pageStructureFingerprint({ items: Array.from({ length: 20_001 }, () => ({})) }, 'json'),
    ).toBeNull();
  });
  it('includes selected models/configuration without resolving keys; hosted identity requires actual selection', () => {
    let resolved = 0;
    const create = (model: string) =>
      new OpenAiCompatibleProvider({
        baseUrl: 'http://127.0.0.1/fixture',
        model,
        apiKey: async () => {
          resolved++;
          return 'FAKE_NEVER_RESOLVED';
        },
      });
    expect(create('a').cacheIdentity?.model).toBe('a');
    expect(create('b').cacheIdentity?.model).toBe('b');
    expect(resolved).toBe(0);
    const request = async () => new Response('{}');
    let model = 'a';
    const hosted = new HostedAiProvider(request, () => ({
      provider: 'hosted',
      model,
      configuration: 'fixture',
    }));
    expect(hosted.cacheIdentity?.model).toBe('a');
    model = 'b';
    expect(hosted.cacheIdentity?.model).toBe('b');
    expect(new HostedAiProvider(request).cacheIdentity).toBeUndefined();
  });
});
