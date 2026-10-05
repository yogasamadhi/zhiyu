import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { MockAiProvider } from '@zhiyun/ai-runtime';
import { PlaywrightAdapter, actionCacheDigest } from '@zhiyun/browser-runtime';
import {
  browserSettingsSchema,
  requestSettingsSchema,
  type BrowserActionCacheContext,
} from '@zhiyun/contracts';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { SqliteAiConversationRepository } from '../src/persistence/sqlite/index.js';
import { RuleAnalysisCache } from '../src/application/rule-cache.js';
import { analyzePage } from '../src/application/analyzer.js';

describe('verified local browser action cache', () => {
  let directory: string;
  let filePath: string;
  let platform: Awaited<ReturnType<typeof openSqlitePlatformRepository>>;
  let repository: SqliteAiConversationRepository;
  let server: ReturnType<typeof createServer>;
  let url: string;
  let html: string;
  let provider: MockAiProvider;
  let calls: string[];
  let settings: ReturnType<typeof browserSettingsSchema.parse>;
  let context: BrowserActionCacheContext;
  const request = requestSettingsSchema.parse({
    timeoutMs: 1000,
    retries: 0,
    delayMs: 0,
    respectRobotsTxt: false,
  });
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'zhiyun-action-cache-'));
    filePath = join(directory, 'zhiyun.sqlite3');
    platform = await openSqlitePlatformRepository({
      dataDirectory: directory,
      filePath,
      graphRevision: 'action-cache-fixture',
    });
    repository = new SqliteAiConversationRepository(filePath);
    await repository.migrate();
    html =
      '<main><input id="search" oninput="document.querySelector(\'#echo\').textContent=this.value"><output id="echo"></output><button id="expand" onclick="document.querySelector(\'#records\').hidden=false">Expand</button><section id="records" hidden><article class="product-card"><h2>Alpha</h2><span class="price">10</span></article><article class="product-card"><h2>Beta</h2><span class="price">20</span></article></section></main>';
    server = createServer((_incoming, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
    url = `http://127.0.0.1:${address.port}/list`;
    calls = [];
    provider = new MockAiProvider((usage) => {
      calls.push(usage.operation);
    });
    settings = browserSettingsSchema.parse({
      enabled: true,
      actions: [
        {
          type: 'click',
          selector: '#old-expand',
          semanticGoal: { intent: 'expand', description: 'Expand records' },
          expectedState: { checks: [{ type: 'visible', selector: '#records' }] },
        },
      ],
    });
    context = {
      repository,
      scope: `task:${randomUUID()}`,
      ruleVersion: 'rule-v1',
      taskVersion: 1,
      identity: () => provider.cacheIdentity,
      repair: (value, signal) =>
        provider.repairBrowserAction({ ...value, ...(signal ? { signal } : {}) }),
    };
  });
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await repository?.close();
    await platform?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  const load = () =>
    new PlaywrightAdapter().load(url, { browser: settings, request, actionCache: context });
  const entries = () => {
    const db = new Database(filePath);
    try {
      return db.prepare("SELECT * FROM ai_validated_cache WHERE kind='action'").all() as Array<
        Record<string, unknown>
      >;
    } finally {
      db.close();
    }
  };

  it('repairs one absent target, verifies it, then persists zero-call replay across repository reopen', async () => {
    const first = await load();
    expect(first.actionCache).toMatchObject({ status: 'stored', providerCalls: 1, hitCount: 0 });
    expect(calls).toEqual(['repairBrowserAction']);
    const initialMockCalls = calls.length;
    await repository.close();
    repository = new SqliteAiConversationRepository(filePath);
    await repository.migrate();
    context.repository = repository;
    html = html.replace('Alpha', 'Changed');
    calls.length = 0;
    const second = await load();
    expect(second.actionCache).toMatchObject({
      status: 'hit',
      providerCalls: 0,
      hitCount: 1,
      previousValidated: true,
    });
    expect(second.html).toContain('Changed');
    expect(calls).toEqual([]);
    console.info(
      'ACTION_CACHE_METRICS',
      JSON.stringify({
        fixture: 'expand-records-v1',
        provider: 'Mock',
        initialMockCalls,
        repeatMockCalls: calls.length,
        verifiedHits: second.actionCache?.hitCount,
      }),
    );
  });
  it('revalidates a compatible layout change before replaying without a call', async () => {
    await load();
    calls.length = 0;
    html += '<aside>Unrelated data</aside>';
    const second = await load();
    expect(second.actionCache).toMatchObject({
      status: 'stored',
      reason: 'structure_changed',
      providerCalls: 0,
      previousValidated: true,
      hitCount: 1,
    });
    expect(calls).toEqual([]);
  });
  it('rejects a successful click that did not reach its expected state and never retries its side effect', async () => {
    settings.actions[0] = {
      ...settings.actions[0]!,
      selector: '#expand',
    } as (typeof settings.actions)[0];
    html = html.replace(
      "document.querySelector('#records').hidden=false",
      "document.querySelector('#echo').textContent='Wrong action'",
    );
    const results: unknown[] = [];
    context.onResult = (value) => {
      results.push(value);
    };
    await expect(load()).rejects.toMatchObject({ code: 'ACTION_STATE_INVALID' });
    expect(results).toEqual([
      expect.objectContaining({ reason: 'validation_failed', providerCalls: 0 }),
    ]);
    expect(calls).toEqual([]);
    expect(entries()).toEqual([]);
  });
  it('rejects a model target that cannot produce the configured state', async () => {
    context.repair = async ({ candidates }) => {
      calls.push('fixtureRepair');
      return { selector: candidates.find((item) => item.tag === 'input')!.selector };
    };
    await expect(load()).rejects.toMatchObject({ code: 'ACTION_STATE_INVALID' });
    expect(calls).toEqual(['fixtureRepair']);
    expect(entries()).toEqual([]);
  });
  it.each(['rule', 'model', 'prompt', 'tools', 'session', 'configuration'] as const)(
    'invalidates an action after a %s change',
    async (change) => {
      await load();
      calls.length = 0;
      const reasons = {
        rule: 'rule_changed',
        model: 'provider_changed',
        prompt: 'prompt_changed',
        tools: 'prompt_changed',
        session: 'session_changed',
        configuration: 'configuration_changed',
      };
      if (change === 'rule') context.ruleVersion = 'rule-v2';
      if (change === 'model')
        context.identity = () => ({ ...provider.cacheIdentity, model: 'fixture-v2' });
      if (change === 'prompt')
        context.identity = () => ({
          ...provider.cacheIdentity,
          promptVersion: 'fixture-prompt-v2',
        });
      if (change === 'tools')
        context.identity = () => ({
          ...provider.cacheIdentity,
          toolSchemaVersion: 'fixture-tools-v2',
        });
      if (change === 'session') request.headers.authorization = 'Bearer FAKE_ACTION_AUTH_a929';
      if (change === 'configuration') context.configuration = { dataset: { detectRemoved: true } };
      try {
        expect((await load()).actionCache).toMatchObject({
          status: 'stored',
          reason: reasons[change],
          providerCalls: 1,
        });
        expect(calls).toEqual(['repairBrowserAction']);
      } finally {
        delete request.headers.authorization;
      }
    },
  );
  it('falls back from a corrupt payload with a visible reason and overwrites it only after verification', async () => {
    await load();
    calls.length = 0;
    const db = new Database(filePath);
    try {
      db.prepare("UPDATE ai_validated_cache SET payload='broken' WHERE kind='action'").run();
    } finally {
      db.close();
    }
    expect((await load()).actionCache).toMatchObject({
      status: 'stored',
      reason: 'corrupt',
      providerCalls: 1,
    });
    expect(calls).toEqual(['repairBrowserAction']);
  });
  it('regenerates an expired action and keeps its reason distinct from corruption', async () => {
    await load();
    const db = new Database(filePath);
    try {
      db.prepare("UPDATE ai_validated_cache SET created_at=?,expires_at=? WHERE kind='action'").run(
        Date.now() - 2000,
        Date.now() - 1000,
      );
    } finally {
      db.close();
    }
    calls.length = 0;
    expect((await load()).actionCache).toMatchObject({
      status: 'stored',
      reason: 'expired',
      providerCalls: 1,
      hitCount: 0,
    });
    expect(calls).toEqual(['repairBrowserAction']);
  });
  it('clears all independently cached page stages only for their owner', async () => {
    await load();
    url = url.replace('/list', '/detail');
    await load();
    const first = context.scope;
    context.scope = `task:${randomUUID()}`;
    await load();
    expect(entries()).toHaveLength(3);
    expect(await repository.clearValidatedCache(actionCacheDigest(first))).toBe(2);
    expect(entries()).toHaveLength(1);
    calls.length = 0;
    expect((await load()).actionCache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(calls).toEqual([]);
  });
  it('cannot resurrect a cache cleared while the repair was in flight', async () => {
    context.repair = async (value, signal) => {
      await repository.clearValidatedCache(actionCacheDigest(context.scope));
      return provider.repairBrowserAction({ ...value, ...(signal ? { signal } : {}) });
    };
    expect((await load()).actionCache).toMatchObject({
      status: 'miss',
      reason: 'cleared_during_analysis',
      providerCalls: 1,
    });
    expect(entries()).toEqual([]);
  });
  it('rechecks newly created session values before repairing a later action', async () => {
    const marker = 'FAKE_NEW_SESSION_58e7';
    html = html.replace(
      '<main>',
      `<main><button id="setup" onclick="localStorage.setItem('auth','${marker}');document.querySelector('#ready').hidden=false">Setup</button><aside id="ready" hidden></aside>`,
    );
    settings.actions = browserSettingsSchema.parse({
      actions: [
        {
          type: 'click',
          selector: '#setup',
          expectedState: { checks: [{ type: 'visible', selector: '#ready' }] },
        },
        {
          ...settings.actions[0],
          semanticGoal: { intent: 'expand', description: `Expand ${marker}` },
        },
      ],
    }).actions;
    await expect(load()).rejects.toMatchObject({ code: 'ACTION_STATE_INVALID' });
    expect(calls).toEqual([]);
    expect(entries()).toEqual([]);
  });
  it('does not call repair after an earlier action exceeds the bounded fingerprint', async () => {
    html = html.replace(
      '<main>',
      '<main><button id="setup" onclick="document.querySelector(\'#ready\').textContent=\'X\'.repeat(1048577);document.querySelector(\'#ready\').hidden=false">Setup</button><aside id="ready" hidden></aside>',
    );
    settings.actions = browserSettingsSchema.parse({
      actions: [
        {
          type: 'click',
          selector: '#setup',
          expectedState: { checks: [{ type: 'visible', selector: '#ready' }] },
        },
        settings.actions[0],
      ],
    }).actions;
    await expect(load()).rejects.toMatchObject({ code: 'ACTION_STATE_INVALID' });
    expect(calls).toEqual([]);
    expect(entries()).toEqual([]);
  });
  it('sends only recognized roles to repair even when a page embeds a credential in role', async () => {
    const marker = 'FAKE_ROLE_TOKEN_885a';
    html = html.replace('id="expand"', `id="expand" role="${marker}" data-token="${marker}"`);
    let observed: unknown;
    context.repair = async (input, signal) => {
      observed = input;
      return provider.repairBrowserAction({ ...input, ...(signal ? { signal } : {}) });
    };
    expect((await load()).actionCache?.status).toBe('stored');
    expect(calls).toEqual(['repairBrowserAction']);
    expect(JSON.stringify(observed)).not.toContain(marker);
    expect(entries()[0]!.payload).not.toContain(marker);
  });
  it('executes current fill values but stores neither them nor authentication/page content in SQLite/WAL or a repair input', async () => {
    const markers = [
      'FAKE_ACTION_FILL_217e',
      'FAKE_ACTION_COOKIE_371c',
      'FAKE_ACTION_HEADER_d710',
      'FAKE_ACTION_PAGE_TOKEN_e871',
      'FAKE_ACTION_BODY_28e3',
    ];
    settings.actions.unshift({ type: 'fill', selector: '#search', value: markers[0]! });
    html = html.replace('<main>', `<main data-token="${markers[3]}"><aside>${markers[4]}</aside>`);
    const localRequest = requestSettingsSchema.parse({
      ...request,
      headers: { authorization: `Bearer ${markers[2]}` },
      cookies: [
        {
          name: 'session',
          value: markers[1]!,
          path: '/',
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
    });
    const inputs: unknown[] = [];
    context.repair = (value, signal) => {
      inputs.push(value);
      return provider.repairBrowserAction({ ...value, ...(signal ? { signal } : {}) });
    };
    const run = () =>
      new PlaywrightAdapter().load(url, {
        browser: settings,
        request: localRequest,
        actionCache: context,
      });
    const first = await run();
    expect(first.html).toContain(markers[0]);
    expect(first.actionCache?.status).toBe('stored');
    calls.length = 0;
    expect((await run()).actionCache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(calls).toEqual([]);
    expect(inputs).toHaveLength(1);
    for (const marker of markers) expect(JSON.stringify(inputs)).not.toContain(marker);
    let scanned = 0;
    for (const file of [filePath, `${filePath}-wal`]) {
      const data = await readFile(file);
      scanned++;
      for (const marker of markers) expect(data.includes(Buffer.from(marker))).toBe(false);
    }
    expect(scanned).toBe(2);
    expect(JSON.parse(String(entries()[0]!.payload))).toEqual({
      version: 1,
      selectors: [expect.any(String), expect.any(String)],
    });
  });
  it('never sends an absent fill or wait target to a repair provider', async () => {
    settings = browserSettingsSchema.parse({
      enabled: true,
      actions: [{ type: 'fill', selector: '#absent', value: 'FAKE_FORM_VALUE_a817' }],
    });
    await expect(load()).rejects.toBeDefined();
    expect(calls).toEqual([]);
    expect(entries()).toEqual([]);
    settings = browserSettingsSchema.parse({
      enabled: true,
      actions: [{ type: 'waitFor', selector: '#absent' }],
    });
    await expect(load()).rejects.toBeDefined();
    expect(calls).toEqual([]);
    expect(entries()).toEqual([]);
  });
  it('honors a zero repair call budget and does not guess a target', async () => {
    context.maxRepairCalls = 0;
    await expect(load()).rejects.toMatchObject({ code: 'ACTION_STATE_INVALID' });
    expect(calls).toEqual([]);
    expect(entries()).toEqual([]);
  });
  it('bypasses unvalidated legacy clicks while preserving their deterministic execution', async () => {
    settings = browserSettingsSchema.parse({
      enabled: true,
      actions: [{ type: 'click', selector: '#expand' }],
    });
    expect((await load()).actionCache).toMatchObject({
      status: 'bypassed',
      reason: 'validation_failed',
      providerCalls: 0,
    });
    expect(entries()).toEqual([]);
  });
  it('integrates action and rule reuse through the actual analysis entry without escalating AI when disabled', async () => {
    const cache = new RuleAnalysisCache(repository);
    const input = {
      taskId: randomUUID(),
      ruleVersion: 'rule-v1',
      url,
      instruction: 'name price',
      requestSettings: request,
      browserSettings: settings,
      networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
      useAi: true,
      forceBrowser: false,
    };
    const first = await analyzePage(input, provider, cache);
    expect(first.engine).toBe('browser');
    expect(first.actionCache).toMatchObject({ status: 'stored', providerCalls: 1 });
    expect(first.cache).toMatchObject({ status: 'stored', providerCalls: 2 });
    expect(calls).toEqual(['repairBrowserAction', 'generateSchema', 'generateRule']);
    calls.length = 0;
    const second = await analyzePage(input, provider, cache);
    expect(second.actionCache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(second.cache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(calls).toEqual([]);
    input.useAi = false;
    const third = await analyzePage(input, provider, cache);
    expect(third.actionCache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(calls).toEqual([]);
  });
});
