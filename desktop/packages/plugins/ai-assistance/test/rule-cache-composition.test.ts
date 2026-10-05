import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAiProvider } from '@zhiyun/ai-runtime';
import {
  browserSettingsSchema,
  requestSettingsSchema,
  crawlPlanDefinitionSchema,
  type CrawlPlanDefinition,
} from '@zhiyun/contracts';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { analyzePage, type AnalyzeInput } from '../src/application/analyzer.js';
import { RuleAnalysisCache, cacheDigest } from '../src/application/rule-cache.js';
import { SqliteAiConversationRepository } from '../src/persistence/sqlite/index.js';

describe('complete rule qualification with local HTTP and Chromium fixtures', () => {
  let directory: string;
  let platform: Awaited<ReturnType<typeof openSqlitePlatformRepository>>;
  let repository: SqliteAiConversationRepository;
  let cache: RuleAnalysisCache;
  let server: ReturnType<typeof createServer>;
  let input: AnalyzeInput;
  let plan: CrawlPlanDefinition;
  let calls: string[];
  let provider: MockAiProvider;
  let revision: number;
  let detailLayout: boolean;
  let badDetail: string | undefined;
  let browserFixture: boolean;
  let session: string;
  let requests: string[];
  let effects: number;
  let detailSecret: string | undefined;
  let detailGate: Promise<void> | undefined;
  let onDetail: (() => void) | undefined;
  let nextState: 'active' | 'disabled' | 'aria-disabled' | 'cycle' | 'duplicate';
  let sitemapMode: 'normal' | 'empty' | undefined;
  let sitemapSecret: string | undefined;
  let detailValues: boolean;
  const configuredFill = 'FAKE_DETAIL_QUERY_BINDING_94ac';
  const configuredChoice = 'FAKE_DETAIL_SELECT_BINDING_29bd';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'zhiyun-rule-composition-'));
    platform = await openSqlitePlatformRepository({
      dataDirectory: directory,
      filePath: join(directory, 'zhiyun.sqlite3'),
      graphRevision: 'composition-fixture',
    });
    repository = new SqliteAiConversationRepository(join(directory, 'zhiyun.sqlite3'));
    await repository.migrate();
    cache = new RuleAnalysisCache(repository);
    revision = 1;
    detailLayout = false;
    browserFixture = false;
    badDetail = undefined;
    detailSecret = undefined;
    session = 'FAKE_DETAIL_SESSION_A_63ab';
    requests = [];
    effects = 0;
    calls = [];
    detailGate = undefined;
    onDetail = undefined;
    nextState = 'active';
    sitemapMode = undefined;
    sitemapSecret = undefined;
    detailValues = false;
    server = createServer((request, response) => {
      const url = new URL(request.url!, 'http://fixture.invalid');
      requests.push(url.pathname);
      response.setHeader('content-type', 'text/html; charset=utf-8');
      const valueControls = detailValues
        ? `<input id="query" oninput="const result=document.querySelector('.description');if(result)result.textContent='Detail '+this.value+' v${revision}'"><select id="choice" onchange="const result=document.querySelector('.amount');if(result)result.textContent='200'"><option value="default">Default</option><option value="${configuredChoice}">Configured</option></select>`
        : '';
      if (url.pathname === '/map.xml' || url.pathname === '/child.xml') {
        response.setHeader('content-type', 'application/xml');
        const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        response.end(
          url.pathname === '/map.xml'
            ? `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/child.xml</loc></sitemap></sitemapindex>`
            : `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${sitemapMode === 'empty' ? '' : [1, 2, 1].map((id) => `<url><loc>${origin}/detail/${id}${sitemapSecret ? `?auth=${sitemapSecret}` : ''}</loc><lastmod>2026-10-0${id}</lastmod></url>`).join('')}<url><loc>${origin}/ignore/3</loc></url></urlset>`,
        );
        return;
      }
      if (url.pathname === '/effect') {
        effects++;
        response.end('ok');
        return;
      }
      if (url.pathname.startsWith('/detail/')) {
        onDetail?.();
        const id = url.pathname.split('/').at(-1)!;
        const value = badDetail === 'type' ? 'invalid-number' : String(100 + revision);
        let content = `<section class="content" ${detailSecret ? `id="${detailSecret}"` : ''}><p class="description">Detail ${id} v${revision}</p><span class="amount">${value}</span></section>`;
        if (badDetail === 'missing')
          content = content.replace('class="description"', 'class="removed"');
        if (badDetail === 'ambiguous') content += content;
        if (badDetail === 'navigation') {
          response.statusCode = 500;
          response.end('failed');
          return;
        }
        if (detailLayout) content = `<div class="detail-layout">${content}</div>`;
        if (browserFixture)
          content = `<input value="FAKE_DETAIL_FILL_47ad"><button id="open-detail" onclick="document.querySelector('.content').hidden=false">Open</button><script>document.cookie='session=${session}; path=/';localStorage.setItem('session','${session}');</script>${content.replace('class="content"', 'hidden class="content"')}`;
        if (detailSecret) content += `<input data-token="${detailSecret}">`;
        content = valueControls + content;
        if (detailGate) void detailGate.then(() => response.end(content));
        else response.end(content);
        return;
      }
      const start = url.pathname === '/list/2' && nextState !== 'duplicate' ? 3 : 1;
      const article = (id: number) =>
        `<article class="product-card"><h2>Item ${id} v${revision}</h2><a href="/detail/${id}">Details</a></article>`;
      const next =
        nextState === 'disabled'
          ? '<button class="next" disabled>Next</button>'
          : `<a class="next" ${nextState === 'aria-disabled' ? 'aria-disabled="true"' : ''} href="${nextState === 'cycle' ? '/list/1' : '/list/2'}">Next</a>`;
      let html = `<main>${article(start)}${article(start + 1)}</main>${next}`;
      if (browserFixture)
        html = `<button id="open-list" onclick="${badDetail === 'action' || badDetail === 'action-fail' ? "fetch('/effect');" : ''}${badDetail === 'action-fail' ? '' : "document.querySelector('main').hidden=false"}">Open</button>${html.replace('<main>', '<main hidden>')}`;
      if (plan?.pagination.type === 'loadMore')
        html = `<main>${article(1)}</main><button id="more" ${nextState === 'disabled' ? 'disabled' : ''} onclick="${badDetail === 'pagination' ? "this.disabled=true;document.body.style.color='red'" : `document.querySelector('main').insertAdjacentHTML('beforeend', ${JSON.stringify(article(2)).replaceAll('"', '&quot;')})`}">More</button>`;
      if (plan?.pagination.type === 'infinite')
        html = `<style>.product-card{height:800px}</style><main>${article(1)}${article(2)}</main><script>let loaded=false;addEventListener('scroll',()=>{if(loaded)return;loaded=true;${badDetail === 'pagination' ? "document.body.style.color='red'" : `document.querySelector('main').insertAdjacentHTML('beforeend', ${JSON.stringify(article(3))})`}})</script>`;
      response.end(valueControls + html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
    input = {
      taskId: randomUUID(),
      ruleVersion: 'complete-plan-v1',
      url: `http://127.0.0.1:${address.port}/list/1`,
      instruction: 'name url',
      requestSettings: requestSettingsSchema.parse({
        timeoutMs: 3000,
        retries: 0,
        delayMs: 0,
        concurrency: 1,
        maxRuntimeMs: 20_000,
        respectRobotsTxt: false,
      }),
      browserSettings: browserSettingsSchema.parse({}),
      networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
      useAi: true,
      forceBrowser: false,
    };
    plan = crawlPlanDefinitionSchema.parse({
      list: {
        mode: 'http',
        rule: {
          type: 'css',
          container: '.product-card',
          fields: {
            name: { selector: 'h2' },
            url: { selector: 'a', value: 'attribute', attribute: 'href', dataType: 'url' },
          },
        },
      },
      pagination: { type: 'next', selector: '.next', maxPages: 2 },
      detail: {
        mode: 'http',
        urlField: 'url',
        rule: {
          type: 'css',
          container: '.content',
          fields: {
            description: { selector: '.description' },
            amount: { selector: '.amount', dataType: 'number' },
          },
        },
      },
    });
    class FixtureProvider extends MockAiProvider {
      override async generateRule(args: Parameters<MockAiProvider['generateRule']>[0]) {
        await super.generateRule(args);
        return structuredClone(plan);
      }
    }
    provider = new FixtureProvider((usage) => {
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
  const read = () => repository.readValidatedCache(cacheDigest(`task:${input.taskId}`), 'rule');

  it('reopens the cache, revalidates two pages and four details, and reuses fresh data with zero Mock calls', async () => {
    const first = await analyze();
    expect(first.cache).toMatchObject({ status: 'stored', providerCalls: 2 });
    expect(first.preview).toHaveLength(4);
    expect(requests).toEqual(expect.arrayContaining(['/list/2', '/detail/1', '/detail/4']));
    const original = (await read()).entry!;
    expect(JSON.parse(original.payload)).toMatchObject({
      cacheVersion: 2,
      plan: { detail: { urlField: 'url' } },
    });
    await repository.close();
    repository = new SqliteAiConversationRepository(join(directory, 'zhiyun.sqlite3'));
    await repository.migrate();
    cache = new RuleAnalysisCache(repository);
    calls.length = 0;
    requests.length = 0;
    revision++;
    const second = await analyze();
    expect(second.cache).toMatchObject({ status: 'hit', reason: 'matched', providerCalls: 0 });
    expect(calls).toEqual([]);
    expect(second.preview[0]).toMatchObject({
      name: 'Item 1 v2',
      description: 'Detail 1 v2',
      amount: 102,
    });
    expect(requests).toEqual(expect.arrayContaining(['/list/2', '/detail/1', '/detail/4']));
    detailLayout = true;
    const third = await analyze();
    expect(third.cache).toMatchObject({
      status: 'stored',
      reason: 'structure_changed',
      providerCalls: 0,
    });
    expect((await read()).entry?.structureHash).not.toBe(original.structureHash);
    expect((await analyze()).cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(await cache.clear(`task:${input.taskId}`)).toBe(1);
    expect((await analyze()).cache).toMatchObject({ status: 'stored', providerCalls: 2 });
    console.info(
      'COMPOSITION_CACHE_METRICS',
      JSON.stringify({
        fixture: 'http-list-pagination-details-v1',
        initialMockCalls: 2,
        repeatMockCalls: 0,
        pages: 2,
        detailPages: 4,
        records: second.preview.length,
        detailStructureChanged: third.cache?.reason,
        clearedEntries: 1,
      }),
    );
  }, 30_000);

  it.each(['missing', 'type', 'ambiguous', 'navigation'])(
    'rejects %s detail evidence and retains the prior entry',
    async (kind) => {
      expect((await analyze()).cache?.status).toBe('stored');
      const original = (await read()).entry!;
      badDetail = kind;
      calls.length = 0;
      const rejected = await analyze();
      expect(rejected.cache).toMatchObject({
        status: 'miss',
        reason: 'validation_failed',
        providerCalls: 2,
      });
      expect((await read()).entry).toEqual(original);
      badDetail = undefined;
      calls.length = 0;
      expect((await analyze()).cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    },
    30_000,
  );

  it('does not certify pagination when the configured next link does not execute', async () => {
    plan.pagination = { type: 'next', selector: '.missing-next', maxPages: 2 };
    expect((await analyze()).cache).toMatchObject({ status: 'miss', reason: 'validation_failed' });
    expect((await read()).entry).toBeNull();
  });

  it.each(['http', 'browser'] as const)(
    'validates explicit native/ARIA single-page termination in %s and observes later available pages',
    async (mode) => {
      plan.list.mode = mode;
      delete plan.detail;
      for (const terminal of ['disabled', 'aria-disabled'] as const) {
        nextState = terminal;
        await cache.clear(`task:${input.taskId}`);
        expect((await analyze()).cache).toMatchObject({ status: 'stored', providerCalls: 2 });
        calls.length = 0;
        requests.length = 0;
        const repeated = await analyze();
        expect(repeated.cache).toMatchObject({ status: 'hit', providerCalls: 0 });
        expect(repeated.preview).toHaveLength(2);
        expect(requests).not.toContain('/list/2');
        expect(calls).toEqual([]);
      }
      nextState = 'active';
      calls.length = 0;
      const expanded = await analyze();
      expect(expanded.cache).toMatchObject({
        status: 'stored',
        reason: 'structure_changed',
        providerCalls: 0,
      });
      expect(expanded.preview).toHaveLength(4);
      expect(requests).toContain('/list/2');
    },
    40_000,
  );

  it.each(['cycle', 'duplicate'] as const)(
    'rejects %s next-page evidence and retains the valid cache',
    async (state) => {
      delete plan.detail;
      expect((await analyze()).cache?.status).toBe('stored');
      const original = (await read()).entry!;
      nextState = state;
      expect((await analyze()).cache).toMatchObject({
        status: 'miss',
        reason: 'validation_failed',
      });
      expect((await read()).entry).toEqual(original);
    },
    25_000,
  );

  it('validates page templates with new data and rejects duplicate pages', async () => {
    delete plan.detail;
    plan.pagination = {
      type: 'page',
      urlTemplate: input.url.replace('/list/1', '/list/{page}'),
      startPage: 1,
      maxPages: 2,
    };
    expect((await analyze()).cache?.status).toBe('stored');
    calls.length = 0;
    expect((await analyze()).cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    const original = (await read()).entry!;
    nextState = 'duplicate';
    expect((await analyze()).cache).toMatchObject({ status: 'miss', reason: 'validation_failed' });
    expect((await read()).entry).toEqual(original);
  }, 25_000);

  it('validates disabled load-more termination without a click or repair call', async () => {
    plan.pagination = { type: 'loadMore', selector: '#more', maxClicks: 2, waitMs: 100 };
    plan.list.mode = 'browser';
    delete plan.detail;
    nextState = 'disabled';
    expect((await analyze()).cache).toMatchObject({ status: 'stored', providerCalls: 2 });
    calls.length = 0;
    expect((await analyze()).cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(calls).toEqual([]);
  }, 25_000);

  it('validates actual infinite-scroll records and rejects cosmetic scroll changes', async () => {
    plan.pagination = { type: 'infinite', maxScrolls: 2, waitMs: 100 };
    plan.list.mode = 'browser';
    delete plan.detail;
    const first = await analyze();
    expect(first.cache).toMatchObject({ status: 'stored', providerCalls: 2 });
    expect(first.preview).toHaveLength(3);
    calls.length = 0;
    expect((await analyze()).cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    const original = (await read()).entry!;
    badDetail = 'pagination';
    expect((await analyze()).cache).toMatchObject({ status: 'miss', reason: 'validation_failed' });
    expect((await read()).entry).toEqual(original);
  }, 30_000);

  const configureSitemap = () => {
    input.url = input.url.replace('/list/1', '/map.xml');
    sitemapMode = 'normal';
    plan.pagination = { type: 'none' };
    plan.discovery = {
      type: 'sitemap',
      urlField: 'url',
      lastModifiedField: 'modified',
      include: ['/detail/'],
      exclude: ['/ignore/'],
      sameOrigin: true,
      maxDepth: 1,
      maxSitemaps: 3,
      maxUrls: 10,
    };
  };

  it('reopens sitemap cache, verifies nested discovery and actual details, and retains it after invalid detail or empty discovery', async () => {
    configureSitemap();
    const first = await analyze();
    expect(first.engine).toBe('http');
    expect(first.cache).toMatchObject({ status: 'stored', providerCalls: 2 });
    expect(first.preview).toHaveLength(2);
    expect(requests).toEqual(expect.arrayContaining(['/child.xml', '/detail/1', '/detail/2']));
    expect(requests).not.toContain('/ignore/3');
    await repository.close();
    repository = new SqliteAiConversationRepository(join(directory, 'zhiyun.sqlite3'));
    await repository.migrate();
    cache = new RuleAnalysisCache(repository);
    revision++;
    calls.length = 0;
    const second = await analyze();
    expect(second.cache, JSON.stringify(second.cache)).toMatchObject({
      status: 'hit',
      providerCalls: 0,
    });
    expect(second.preview[0]).toMatchObject({
      description: 'Detail 2 v2',
      amount: 102,
      modified: '2026-10-02T00:00:00.000Z',
    });
    const original = (await read()).entry!;
    for (const failure of ['missing', 'empty']) {
      if (failure === 'missing') badDetail = 'missing';
      else {
        badDetail = undefined;
        sitemapMode = 'empty';
      }
      expect((await analyze()).cache).toMatchObject({
        status: 'miss',
        reason: 'validation_failed',
      });
      expect((await read()).entry).toEqual(original);
    }
    console.info(
      'SITEMAP_CACHE_METRICS',
      JSON.stringify({
        fixture: 'nested-sitemap-details-v1',
        initialMockCalls: 2,
        repeatMockCalls: second.cache?.providerCalls,
        records: second.preview.length,
        details: 2,
      }),
    );
  }, 30_000);

  it('qualifies discovered URL records without a CSS list extraction and rejects reflected private discovery filters', async () => {
    configureSitemap();
    delete plan.detail;
    plan.list.rule = {
      type: 'css',
      container: '.unused-list',
      fields: { unused: { selector: '.unused', value: 'text', dataType: 'string' } },
    };
    expect((await analyze()).cache).toMatchObject({ status: 'stored', providerCalls: 2 });
    calls.length = 0;
    const repeated = await analyze();
    expect(repeated.cache, JSON.stringify(repeated.cache)).toMatchObject({
      status: 'hit',
      providerCalls: 0,
    });
    const original = (await read()).entry!;
    sitemapSecret = 'FAKE_SITEMAP_PRIVATE_QUERY_65ca';
    plan.discovery!.include.push(sitemapSecret);
    input.ruleVersion = 'private-sitemap-candidate';
    expect((await analyze()).cache).toMatchObject({ status: 'miss', reason: 'privacy_rejected' });
    expect((await read()).entry).toEqual(original);
    const bytes = await readFile(join(directory, 'zhiyun.sqlite3-wal'));
    expect(bytes.toString()).not.toContain(sitemapSecret);
  }, 30_000);

  it('validates load-more data changes and rejects cosmetic DOM changes', async () => {
    plan.pagination = { type: 'loadMore', selector: '#more', maxClicks: 2, waitMs: 100 };
    plan.list.mode = 'browser';
    delete plan.detail;
    const first = await analyze();
    expect(first.cache).toMatchObject({ status: 'stored', providerCalls: 2 });
    expect(first.preview).toHaveLength(2);
    calls.length = 0;
    expect((await analyze()).cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    const original = (await read()).entry!;
    badDetail = 'pagination';
    expect((await analyze()).cache).toMatchObject({ status: 'miss', reason: 'validation_failed' });
    expect((await read()).entry).toEqual(original);
  }, 30_000);

  it('executes list and detail state checks without action repair and isolates changed browser sessions', async () => {
    browserFixture = true;
    plan.pagination = { type: 'none' };
    plan.list.mode = 'browser';
    plan.detail!.mode = 'browser';
    plan.list.actions = [
      {
        type: 'click',
        selector: '#open-list',
        semanticGoal: { intent: 'expand', description: 'Expand list' },
        expectedState: { requireTransition: true, checks: [{ type: 'visible', selector: 'main' }] },
      },
    ];
    plan.detail!.actions = [
      {
        type: 'click',
        selector: '#open-detail',
        semanticGoal: { intent: 'expand', description: 'Expand detail' },
        expectedState: {
          requireTransition: true,
          checks: [{ type: 'visible', selector: '.content' }],
        },
      },
    ];
    expect((await analyze()).cache).toMatchObject({ status: 'stored', providerCalls: 2 });
    calls.length = 0;
    expect((await analyze()).cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    session = 'FAKE_DETAIL_SESSION_B_63ab';
    expect((await analyze()).cache).toMatchObject({
      status: 'stored',
      reason: 'session_changed',
      providerCalls: 2,
    });
    expect(calls).not.toContain('repairBrowserAction');
    const bytes =
      (await readFile(join(directory, 'zhiyun.sqlite3'))).toString('utf8') +
      (await readFile(join(directory, 'zhiyun.sqlite3-wal'))).toString('utf8');
    expect(bytes).not.toContain(session);
    expect(bytes).not.toContain('FAKE_DETAIL_FILL_47ad');
  }, 30_000);

  it('restores detail fill/select configuration references through the full list-detail chain and uses changed current values', async () => {
    detailValues = true;
    plan.pagination = { type: 'none' };
    plan.list.mode = 'browser';
    plan.detail!.mode = 'browser';
    input.browserSettings = browserSettingsSchema.parse({
      enabled: true,
      actions: [
        { type: 'fill', selector: '#query', value: configuredFill },
        { type: 'select', selector: '#choice', value: configuredChoice },
      ],
    });
    plan.detail!.actions = structuredClone(input.browserSettings.actions);
    const first = await analyze();
    expect(first.cache).toMatchObject({ status: 'stored', providerCalls: 2 });
    expect(first.preview[0]).toMatchObject({
      description: `Detail ${configuredFill} v1`,
      amount: 200,
    });
    const payload = JSON.parse((await read()).entry!.payload);
    expect(payload.cacheVersion).toBe(3);
    expect(payload.valueBindings).toEqual([
      { stage: 'detail', index: 0, sourceIndex: 0 },
      { stage: 'detail', index: 1, sourceIndex: 1 },
    ]);
    expect(payload.plan.detail.actions.map((action: { value: string }) => action.value)).toEqual([
      '',
      '',
    ]);
    await repository.close();
    repository = new SqliteAiConversationRepository(join(directory, 'zhiyun.sqlite3'));
    await repository.migrate();
    cache = new RuleAnalysisCache(repository);
    revision++;
    calls.length = 0;
    const repeated = await analyze();
    expect(repeated.cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(repeated.preview[0]).toMatchObject({
      description: `Detail ${configuredFill} v2`,
      amount: 200,
    });
    const changed = 'FAKE_DETAIL_CURRENT_QUERY_38ba';
    input.browserSettings.actions[0] = { type: 'fill', selector: '#query', value: changed };
    plan.detail!.actions = structuredClone(input.browserSettings.actions);
    const updated = await analyze();
    expect(updated.cache).toMatchObject({
      status: 'stored',
      reason: 'configuration_changed',
      providerCalls: 2,
    });
    expect(updated.preview[0]).toMatchObject({ description: `Detail ${changed} v2`, amount: 200 });
    const bytes =
      (await readFile(join(directory, 'zhiyun.sqlite3'))).toString() +
      (await readFile(join(directory, 'zhiyun.sqlite3-wal'))).toString();
    for (const value of [configuredFill, configuredChoice, changed])
      expect(bytes).not.toContain(value);
    console.info(
      'DETAIL_VALUE_CACHE_METRICS',
      JSON.stringify({
        fixture: 'configured-detail-fill-select-v1',
        initialMockCalls: first.cache?.providerCalls,
        repeatMockCalls: repeated.cache?.providerCalls,
        afterConfigurationChangeMockCalls: updated.cache?.providerCalls,
        restoredDetailActions: repeated.candidate.detail?.actions.length,
        records: repeated.preview.length,
      }),
    );
  }, 40_000);

  it('rejects a rule reflecting a secret only found on a detail page', async () => {
    detailSecret = 'FAKE_DETAIL_ONLY_SECRET_72ba';
    plan.detail!.rule.container = `#${detailSecret}`;
    expect((await analyze()).cache).toMatchObject({ status: 'miss', reason: 'privacy_rejected' });
    expect((await read()).entry).toBeNull();
  }, 30_000);

  it('rejects raw DOM placed inside an otherwise executable semantic goal', async () => {
    browserFixture = true;
    plan.pagination = { type: 'none' };
    plan.list.mode = 'browser';
    delete plan.detail;
    plan.list.actions = [
      {
        type: 'click',
        selector: '#open-list',
        semanticGoal: {
          intent: 'expand',
          description: '<html><body>FAKE_RAW_PAGE_429b</body></html>',
        },
        expectedState: { requireTransition: true, checks: [{ type: 'visible', selector: 'main' }] },
      },
    ];
    expect((await analyze()).cache).toMatchObject({ status: 'miss', reason: 'privacy_rejected' });
    expect((await read()).entry).toBeNull();
  });

  it('does not accept an action whose effect violates its declared state', async () => {
    browserFixture = true;
    badDetail = 'action';
    plan.pagination = { type: 'none' };
    plan.list.mode = 'browser';
    plan.list.actions = [
      {
        type: 'click',
        selector: '#open-list',
        expectedState: {
          requireTransition: true,
          checks: [{ type: 'visible', selector: '.missing-state' }],
        },
      },
    ];
    expect((await analyze()).cache).toMatchObject({ status: 'miss', reason: 'validation_failed' });
    expect(calls).toEqual(['generateSchema', 'generateRule']);
    expect(effects).toBe(1);
    expect((await read()).entry).toBeNull();
  }, 30_000);

  it.each(['initial', 'cached'])(
    'does not resurrect an entry cleared during %s complete validation',
    async (kind) => {
      if (kind === 'cached') expect((await analyze()).cache?.status).toBe('stored');
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      detailGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      onDetail = entered;
      const pending = analyze();
      await started;
      await cache.clear(`task:${input.taskId}`);
      release();
      expect((await pending).cache).toMatchObject({
        status: 'miss',
        reason: 'cleared_during_analysis',
      });
      expect((await read()).entry).toBeNull();
    },
    30_000,
  );

  it('rejects a provider switch during cached detail validation without overwriting the prior entry', async () => {
    expect((await analyze()).cache?.status).toBe('stored');
    const original = (await read()).entry!;
    onDetail = () => {
      Object.assign(provider, { name: 'mock-composition-changed' });
    };
    const result = await analyze();
    expect(result.cache).toMatchObject({ status: 'miss', reason: 'provider_changed' });
    expect((await read()).entry).toEqual(original);
  }, 30_000);

  it('does not replay a cached action after a real effect fails its state check', async () => {
    browserFixture = true;
    plan.pagination = { type: 'none' };
    plan.list.mode = 'browser';
    delete plan.detail;
    plan.list.actions = [
      {
        type: 'click',
        selector: '#open-list',
        expectedState: { requireTransition: true, checks: [{ type: 'visible', selector: 'main' }] },
      },
    ];
    expect((await analyze()).cache?.status).toBe('stored');
    const original = (await read()).entry!;
    badDetail = 'action-fail';
    calls.length = 0;
    expect((await analyze()).cache).toMatchObject({
      status: 'miss',
      reason: 'validation_failed',
      providerCalls: 0,
    });
    expect(calls).toEqual([]);
    expect(effects).toBe(1);
    expect((await read()).entry).toEqual(original);
  }, 30_000);
});
