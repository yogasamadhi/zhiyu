import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAiProvider } from '@zhiyun/ai-runtime';
import {
  browserSettingsSchema,
  requestSettingsSchema,
  type AiProvider,
  type BrowserAction,
} from '@zhiyun/contracts';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { analyzePage, type AnalyzeInput } from '../src/application/analyzer.js';
import { RuleAnalysisCache, cacheDigest } from '../src/application/rule-cache.js';
import { SqliteAiConversationRepository } from '../src/persistence/sqlite/index.js';

describe('configured actions and value references for current JSON and DOM sources', () => {
  let directory: string, filePath: string, origin: string;
  let platform: Awaited<ReturnType<typeof openSqlitePlatformRepository>>;
  let repository: SqliteAiConversationRepository;
  let cache: RuleAnalysisCache;
  let server: ReturnType<typeof createServer>;
  let input: AnalyzeInput;
  let provider: AiProvider;
  let calls: string[], modelInputs: unknown[];
  let revision: number, effects: number;
  let wrongState: boolean,
    boundValues: boolean,
    unconfiguredValue: boolean,
    wrongModelRule: boolean,
    reflectedSchema: boolean;
  let browserSession: string;
  let browserJsonRequests: number;
  const fill = 'FAKE_CONFIGURED_QUERY_217c';
  const select = 'FAKE_CONFIGURED_OPTION_93f6';
  const cookie = 'FAKE_CONFIGURED_COOKIE_d738';
  const authorization = 'FAKE_CONFIGURED_AUTH_dc8a';
  const pageSecret = 'FAKE_PAGE_SECRET_ce14';

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'zhiyun-json-actions-'));
    filePath = join(directory, 'zhiyun.sqlite3');
    platform = await openSqlitePlatformRepository({
      dataDirectory: directory,
      filePath,
      graphRevision: 'json-action-fixture',
    });
    repository = new SqliteAiConversationRepository(filePath);
    await repository.migrate();
    cache = new RuleAnalysisCache(repository);
    revision = 1;
    effects = 0;
    browserJsonRequests = 0;
    wrongState = false;
    boundValues = false;
    unconfiguredValue = false;
    wrongModelRule = false;
    reflectedSchema = false;
    browserSession = 'FAKE_BROWSER_JSON_SESSION_862b';
    calls = [];
    modelInputs = [];
    server = createServer((incoming, response) => {
      if (incoming.url === '/effect') {
        effects++;
        response.end('ok');
        return;
      }
      if (incoming.url === '/json') {
        const browser = String(incoming.headers['user-agent']).includes('HeadlessChrome');
        if (browser) {
          browserJsonRequests++;
          response.setHeader(
            'set-cookie',
            `browser-session=${browserSession}; Path=/; HttpOnly; SameSite=Lax`,
          );
        }
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            items: [
              { name: `${browser ? 'Browser' : 'HTTP'} JSON v${revision}`, price: revision + 10 },
            ],
          }),
        );
        return;
      }
      response.setHeader('content-type', 'text/html');
      const isEmbedded = incoming.url === '/embedded';
      const data = JSON.stringify({
        items: [{ name: `Initial v${revision}`, price: revision + 10 }],
      });
      const update = isEmbedded
        ? `document.querySelector('#state').textContent='_ROUTER_DATA = '+JSON.stringify({items:[{name:'Result '+document.querySelector('#search').value+' v${revision}',price:${revision + 10}}]})+';';`
        : `document.querySelector('h2').textContent='Result '+document.querySelector('#search').value+' v${revision}';`;
      response.end(
        `<main data-token="${pageSecret}"><input id="search" oninput="${isEmbedded ? '' : update}"><select id="choice" onchange="document.querySelector('.price').textContent=this.selectedOptions[0].dataset.price"><option value="default" data-price="10">Default</option><option value="${select}" data-price="20">Chosen</option></select><button id="search-button" onclick="fetch('/effect');${wrongState ? '' : `${update}document.querySelector('#ready').hidden=false;`}">Search</button><aside id="ready" hidden>Ready</aside><article class="product-card"><h2>Initial v${revision}</h2><span class="price">10</span></article>${isEmbedded ? `<script id="state">_ROUTER_DATA = ${data};</script>` : ''}<aside>${pageSecret}</aside></main>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No JSON fixture port');
    origin = `http://127.0.0.1:${address.port}`;
    input = {
      taskId: randomUUID(),
      ruleVersion: 'json-actions-v1',
      url: `${origin}/embedded`,
      instruction: 'name price',
      requestSettings: requestSettingsSchema.parse({
        timeoutMs: 1500,
        retries: 0,
        delayMs: 0,
        respectRobotsTxt: false,
        concurrency: 1,
        maxRuntimeMs: 20_000,
      }),
      browserSettings: browserSettingsSchema.parse({
        actions: [
          { type: 'fill', selector: '#search', value: fill },
          {
            type: 'click',
            selector: '#old-search',
            semanticGoal: { intent: 'submit', description: 'Show search records' },
            expectedState: { checks: [{ type: 'visible', selector: '#ready' }] },
          },
        ],
      }),
      networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
      useAi: true,
      forceBrowser: false,
    };
    const mock = new MockAiProvider((usage) => {
      calls.push(usage.operation);
    });
    class TypedFixture implements AiProvider {
      readonly name = mock.name;
      readonly cacheIdentity = mock.cacheIdentity;
      readonly streamChat = mock.streamChat.bind(mock);
      readonly extract = mock.extract.bind(mock);
      readonly suggestRepair = mock.suggestRepair.bind(mock);
      readonly explainFailure = mock.explainFailure.bind(mock);
      readonly repairBrowserAction = mock.repairBrowserAction.bind(mock);
      async generateSchema(args: Parameters<AiProvider['generateSchema']>[0]) {
        modelInputs.push({ sample: args.sample, instruction: args.instruction });
        const fields = await mock.generateSchema(args);
        return reflectedSchema ? [{ name: authorization, type: 'string' as const }] : fields;
      }
      async generateRule(args: Parameters<AiProvider['generateRule']>[0]) {
        modelInputs.push({ html: args.html, instruction: args.instruction, schema: args.schema });
        const dom = await mock.generateRule(args);
        if (wrongModelRule) return dom;
        const plan = structuredClone(args.schema);
        if (boundValues)
          plan.list.actions = input.browserSettings.actions
            .filter((action) => action.type === 'fill' || action.type === 'select')
            .map((action) => structuredClone(action));
        if (unconfiguredValue)
          plan.list.actions = [
            { type: 'fill', selector: '#search', value: 'FAKE_UNCONFIGURED_MODEL_VALUE_491e' },
          ];
        return plan;
      }
    }
    provider = new TypedFixture();
  });
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await repository?.close();
    await platform?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const analyze = () => analyzePage(input, provider, cache);
  const entry = async () =>
    (await repository.readValidatedCache(cacheDigest(`task:${input.taskId}`), 'rule')).entry;
  const cleanModelInputs = (markers: string[]) => {
    for (const marker of markers) expect(JSON.stringify(modelInputs)).not.toContain(marker);
  };
  const cleanDatabase = async (markers: string[]) => {
    for (const name of [filePath, `${filePath}-wal`]) {
      const data = await readFile(name);
      for (const marker of markers) expect(data.includes(Buffer.from(marker))).toBe(false);
    }
  };
  const configureValues = () => {
    input.url = `${origin}/form`;
    boundValues = true;
    input.browserSettings = browserSettingsSchema.parse({
      actions: [
        { type: 'fill', selector: '#search', value: fill },
        { type: 'select', selector: '#choice', value: select },
      ],
    });
  };
  const alterPayload = async (change: (value: Record<string, unknown>) => void) => {
    const current = (await entry())!;
    const value = JSON.parse(current.payload) as Record<string, unknown>;
    change(value);
    const payload = JSON.stringify(value);
    const db = new Database(filePath);
    try {
      db.prepare('UPDATE ai_validated_cache SET payload=?,payload_hash=? WHERE key_hash=?').run(
        payload,
        createHash('sha256').update(payload).digest('hex'),
        current.keyHash,
      );
    } finally {
      db.close();
    }
  };

  it('executes configured actions before embedded JSON analysis and reuses both caches with fresh data and zero Mock calls', async () => {
    const first = await analyze();
    expect(first.engine).toBe('browser');
    expect(first.preview).toEqual([{ name: `Result ${fill} v1`, price: 11 }]);
    expect(first.actionCache).toMatchObject({ status: 'stored', providerCalls: 1 });
    expect(first.cache).toMatchObject({ status: 'stored', providerCalls: 2 });
    expect(calls).toEqual(['repairBrowserAction', 'generateSchema', 'generateRule']);
    expect(effects).toBe(1);
    const initialMockCalls = calls.length;
    await repository.close();
    repository = new SqliteAiConversationRepository(filePath);
    await repository.migrate();
    cache = new RuleAnalysisCache(repository);
    revision = 2;
    calls.length = 0;
    const second = await analyze();
    expect(second.preview).toEqual([{ name: `Result ${fill} v2`, price: 12 }]);
    expect(second.cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(second.actionCache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(calls).toEqual([]);
    expect(effects).toBe(2);
    cleanModelInputs([fill, pageSecret]);
    await cleanDatabase([fill, pageSecret]);
    console.info(
      'JSON_ACTION_CACHE_METRICS',
      JSON.stringify({
        fixture: 'embedded-configured-actions-v1',
        provider: 'Mock',
        initialMockCalls,
        repeatMockCalls: calls.length,
        actionEffects: effects,
        ruleHits: second.cache?.hitCount,
        actionHits: second.actionCache?.hitCount,
      }),
    );
  }, 30_000);

  it('reads a raw JSON document from the current browser page after configured actions', async () => {
    input.url = `${origin}/json`;
    input.browserSettings = browserSettingsSchema.parse({
      actions: [{ type: 'wait', milliseconds: 1 }],
    });
    const result = await analyze();
    expect(result.engine).toBe('browser');
    expect(result.preview).toEqual([{ name: 'Browser JSON v1', price: 11 }]);
    expect(result.cache).toMatchObject({ status: 'stored', providerCalls: 2 });
    expect(result.actionCache).toMatchObject({ status: 'stored', providerCalls: 0 });
    expect(browserJsonRequests).toBe(1);
    calls.length = 0;
    revision = 2;
    const next = await analyze();
    expect(next.preview[0]?.name).toBe('Browser JSON v2');
    expect(next.cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(calls).toEqual([]);
  }, 30_000);

  it('honors forceBrowser even with no actions and invalidates a changed actual JSON browser session', async () => {
    input.url = `${origin}/json`;
    input.forceBrowser = true;
    input.browserSettings = browserSettingsSchema.parse({});
    expect((await analyze()).preview[0]?.name).toBe('Browser JSON v1');
    calls.length = 0;
    expect((await analyze()).cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(calls).toEqual([]);
    browserSession = 'FAKE_BROWSER_JSON_SESSION_CHANGED_a267';
    expect((await analyze()).cache).toMatchObject({
      status: 'stored',
      reason: 'session_changed',
      providerCalls: 2,
    });
    cleanModelInputs([browserSession, 'FAKE_BROWSER_JSON_SESSION_862b']);
    await cleanDatabase([browserSession, 'FAKE_BROWSER_JSON_SESSION_862b']);
  }, 30_000);

  it('redacts private DOM attributes from an embedded JSON model sample without requiring a browser session', async () => {
    input.browserSettings = browserSettingsSchema.parse({});
    const first = await analyze();
    expect(first.engine).toBe('http');
    expect(first.preview).toEqual([{ name: 'Initial v1', price: 11 }]);
    expect(first.cache).toMatchObject({ status: 'stored', providerCalls: 2 });
    expect(calls).toEqual(['generateSchema', 'generateRule']);
    expect(modelInputs).toHaveLength(2);
    cleanModelInputs([pageSecret]);
    await cleanDatabase([pageSecret]);
    calls.length = 0;
    revision = 2;
    const second = await analyze();
    expect(second.preview).toEqual([{ name: 'Initial v2', price: 12 }]);
    expect(second.cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(calls).toEqual([]);
  }, 30_000);

  it.each(['json', 'embedded'] as const)(
    'does not skip an invalid configured fill for a %s source or send it to a model',
    async (format) => {
      input.url = `${origin}/${format}`;
      input.browserSettings = browserSettingsSchema.parse({
        actions: [{ type: 'fill', selector: '#absent', value: fill }],
      });
      await expect(analyze()).rejects.toMatchObject({ code: 'NAVIGATION_ERROR' });
      expect(calls).toEqual([]);
      expect(await entry()).toBeNull();
    },
    30_000,
  );

  it('stops an embedded JSON analysis after one failed click effect without generating or replaying', async () => {
    input.browserSettings.actions[1] = {
      ...(input.browserSettings.actions[1] as Extract<BrowserAction, { type: 'click' }>),
      selector: '#search-button',
    };
    wrongState = true;
    await expect(analyze()).rejects.toMatchObject({ code: 'ACTION_STATE_INVALID' });
    expect(effects).toBe(1);
    expect(calls).toEqual([]);
    expect(await entry()).toBeNull();
  }, 30_000);

  it('performs and verifies known configured actions on embedded JSON with AI explicitly disabled', async () => {
    input.useAi = false;
    input.browserSettings.actions[1] = {
      ...(input.browserSettings.actions[1] as Extract<BrowserAction, { type: 'click' }>),
      selector: '#search-button',
    };
    const result = await analyze();
    expect(result.preview[0]?.name).toBe(`Result ${fill} v1`);
    expect(result.aiUsed).toBe(false);
    expect(calls).toEqual([]);
    expect((await analyze()).cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(effects).toBe(2);
  }, 30_000);

  it('projects configured fill/select values, restores them after SQLite reopen and stores neither values nor credentials in cache or model inputs', async () => {
    configureValues();
    input.requestSettings.headers.authorization = `Bearer ${authorization}`;
    input.requestSettings.cookies = [
      { name: 'session', value: cookie, path: '/', httpOnly: true, secure: false, sameSite: 'Lax' },
    ];
    const first = await analyze();
    expect(first.cache).toMatchObject({ status: 'stored', providerCalls: 2 });
    expect(first.preview[0]).toEqual({ name: `Result ${fill} v1`, price: 20 });
    const payload = JSON.parse((await entry())!.payload);
    expect(payload.cacheVersion).toBe(3);
    expect(payload.plan.list.actions.map((action: { value: string }) => action.value)).toEqual([
      '',
      '',
    ]);
    expect(payload.valueBindings).toEqual([
      { stage: 'list', index: 0, sourceIndex: 0 },
      { stage: 'list', index: 1, sourceIndex: 1 },
    ]);
    await repository.close();
    repository = new SqliteAiConversationRepository(filePath);
    await repository.migrate();
    cache = new RuleAnalysisCache(repository);
    calls.length = 0;
    revision = 2;
    const next = await analyze();
    expect(next.cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(next.preview[0]).toEqual({ name: `Result ${fill} v2`, price: 20 });
    expect(
      next.candidate.list.actions.map((action) => ('value' in action ? action.value : undefined)),
    ).toEqual([fill, select]);
    expect(calls).toEqual([]);
    cleanModelInputs([fill, select, cookie, authorization, pageSecret]);
    await cleanDatabase([fill, select, cookie, authorization, pageSecret]);
    console.info(
      'CONFIGURED_VALUE_CACHE_METRICS',
      JSON.stringify({
        fixture: 'configured-fill-select-v1',
        provider: 'Mock',
        initialMockCalls: 2,
        repeatMockCalls: calls.length,
        restoredActions: next.candidate.list.actions.length,
        verifiedHits: next.cache?.hitCount,
      }),
    );
  }, 30_000);

  it('uses a changed current value after configuration invalidation and never restores a stale literal', async () => {
    configureValues();
    await analyze();
    calls.length = 0;
    const changed = 'FAKE_CURRENT_QUERY_CHANGED_e273';
    input.browserSettings.actions[0] = { type: 'fill', selector: '#search', value: changed };
    const next = await analyze();
    expect(next.cache).toMatchObject({
      status: 'stored',
      reason: 'configuration_changed',
      providerCalls: 2,
    });
    expect(next.preview[0]?.name).toBe(`Result ${changed} v1`);
    expect(next.candidate.list.actions[0]).toMatchObject({ value: changed });
    cleanModelInputs([fill, changed]);
    await cleanDatabase([fill, changed]);
  }, 30_000);

  it.each(['missing-reference', 'duplicate-reference', 'literal-value', 'legacy-value'] as const)(
    'rejects a checksummed %s binding payload and regenerates safely',
    async (kind) => {
      configureValues();
      await analyze();
      calls.length = 0;
      await alterPayload((payload) => {
        const bindings = payload.valueBindings as Array<Record<string, unknown>>;
        if (kind === 'missing-reference') bindings[0]!.sourceIndex = 999;
        if (kind === 'duplicate-reference') bindings.push({ ...bindings[0] });
        if (kind === 'literal-value')
          (payload.plan as { list: { actions: Array<{ value: string }> } }).list.actions[0]!.value =
            'FAKE_CORRUPT_LITERAL_849f';
        if (kind === 'legacy-value') {
          payload.cacheVersion = 2;
          delete payload.valueBindings;
        }
      });
      const result = await analyze();
      expect(result.cache).toMatchObject({ status: 'stored', reason: 'corrupt', providerCalls: 2 });
      expect(result.candidate.list.actions[0]).toMatchObject({ value: fill });
      expect(calls).toEqual(['generateSchema', 'generateRule']);
    },
    30_000,
  );

  it('rejects a newly generated value absent from the task configuration without overwriting the prior valid entry', async () => {
    configureValues();
    await analyze();
    const original = (await entry())!;
    unconfiguredValue = true;
    input.ruleVersion = 'json-actions-v2';
    const result = await analyze();
    expect(result.cache).toMatchObject({ status: 'miss', reason: 'privacy_rejected' });
    expect(await entry()).toEqual(original);
  }, 30_000);

  it('does not cache or claim successful AI generation when a JSON fixture returns a DOM rule', async () => {
    input.url = `${origin}/json`;
    input.browserSettings = browserSettingsSchema.parse({});
    wrongModelRule = true;
    const result = await analyze();
    expect(result.preview[0]?.name).toBe('HTTP JSON v1');
    expect(result.aiUsed).toBe(false);
    expect(result.cache).toMatchObject({
      status: 'miss',
      reason: 'generation_failed',
      providerCalls: 2,
    });
    expect(await entry()).toBeNull();
  }, 30_000);

  it('does not pass a schema reflecting authentication into the second model call or replace the valid cache', async () => {
    input.url = `${origin}/form`;
    input.browserSettings = browserSettingsSchema.parse({});
    input.requestSettings.headers.authorization = `Bearer ${authorization}`;
    await analyze();
    const previous = (await entry())!;
    calls.length = 0;
    modelInputs.length = 0;
    reflectedSchema = true;
    input.ruleVersion = 'json-actions-v2';
    const result = await analyze();
    expect(result.cache).toMatchObject({
      status: 'miss',
      reason: 'generation_failed',
      providerCalls: 1,
    });
    expect(calls).toEqual(['generateSchema']);
    expect(await entry()).toEqual(previous);
    cleanModelInputs([authorization]);
  }, 30_000);
});
