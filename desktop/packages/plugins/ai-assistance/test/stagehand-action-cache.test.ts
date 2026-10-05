import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAiProvider } from '@zhiyun/ai-runtime';
import { PlaywrightAdapter, StagehandAdapter, actionCacheDigest } from '@zhiyun/browser-runtime';
import {
  browserSettingsSchema,
  requestSettingsSchema,
  type BrowserActionCacheContext,
} from '@zhiyun/contracts';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { SqliteAiConversationRepository } from '../src/persistence/sqlite/index.js';

describe('real Stagehand native actions with the persistent verified cache', () => {
  let directory: string;
  let filePath: string;
  let platform: Awaited<ReturnType<typeof openSqlitePlatformRepository>>;
  let repository: SqliteAiConversationRepository;
  let server: ReturnType<typeof createServer>;
  let url: string;
  let html: string;
  let effects: number;
  let provider: MockAiProvider;
  let calls: string[];
  let settings: ReturnType<typeof browserSettingsSchema.parse>;
  let request: ReturnType<typeof requestSettingsSchema.parse>;
  let context: BrowserActionCacheContext;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'zhiyun-stagehand-cache-'));
    filePath = join(directory, 'zhiyun.sqlite3');
    platform = await openSqlitePlatformRepository({
      dataDirectory: directory,
      filePath,
      graphRevision: 'stagehand-cache-fixture',
    });
    repository = new SqliteAiConversationRepository(filePath);
    await repository.migrate();
    effects = 0;
    html =
      '<main><input id="search" oninput="document.querySelector(\'#echo\').textContent=this.value"><output id="echo"></output><select id="choice"><option value="default">Default</option></select><button id="expand" onclick="document.querySelector(\'#records\').hidden=false">Expand</button><section id="records" hidden><article class="product-card"><h2>Alpha</h2><span class="price">10</span></article></section></main>';
    server = createServer((incoming, response) => {
      if (incoming.url === '/effect') {
        effects++;
        response.end('ok');
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No Stagehand fixture port');
    url = `http://127.0.0.1:${address.port}/list`;
    calls = [];
    provider = new MockAiProvider((usage) => {
      calls.push(usage.operation);
    });
    request = requestSettingsSchema.parse({
      timeoutMs: 1500,
      retries: 0,
      delayMs: 0,
      respectRobotsTxt: false,
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
  const load = (selfHeal = true) =>
    new StagehandAdapter({ enabled: true, selfHeal }).load(url, {
      browser: settings,
      request,
      actionCache: context,
    });
  const rows = () => {
    const db = new Database(filePath);
    try {
      return db.prepare("SELECT * FROM ai_validated_cache WHERE kind='action'").all() as Array<
        Record<string, unknown>
      >;
    } finally {
      db.close();
    }
  };

  it('repairs once through the explicit Mock callback and replays natively with zero calls after reopening SQLite', async () => {
    expect((await load()).actionCache).toMatchObject({
      status: 'stored',
      providerCalls: 1,
      hitCount: 0,
    });
    expect(calls).toEqual(['repairBrowserAction']);
    const initialMockCalls = calls.length;
    await repository.close();
    repository = new SqliteAiConversationRepository(filePath);
    await repository.migrate();
    context.repository = repository;
    calls.length = 0;
    html = html.replace('Alpha', 'Fresh record');
    const second = await load();
    expect(second.actionCache).toMatchObject({
      status: 'hit',
      providerCalls: 0,
      hitCount: 1,
      previousValidated: true,
    });
    expect(second.html).toContain('Fresh record');
    expect(calls).toEqual([]);
    console.info(
      'STAGEHAND_ACTION_CACHE_METRICS',
      JSON.stringify({
        fixture: 'native-expand-records-v1',
        provider: 'Mock',
        initialMockCalls,
        repeatMockCalls: calls.length,
        verifiedHits: second.actionCache?.hitCount,
      }),
    );
  }, 30_000);

  it('revalidates a structural change through the native driver before reusing the selector', async () => {
    await load();
    calls.length = 0;
    html += '<footer>New layout</footer>';
    expect((await load()).actionCache).toMatchObject({
      status: 'stored',
      reason: 'structure_changed',
      providerCalls: 0,
      hitCount: 1,
      previousValidated: true,
    });
    expect(calls).toEqual([]);
  }, 30_000);

  it('qualifies its native adapter configuration instead of treating a Playwright entry as a native cache hit', async () => {
    expect(
      (
        await new PlaywrightAdapter().load(url, {
          browser: settings,
          request,
          actionCache: context,
        })
      ).actionCache?.status,
    ).toBe('stored');
    calls.length = 0;
    expect((await load()).actionCache).toMatchObject({
      status: 'stored',
      reason: 'configuration_changed',
      providerCalls: 1,
    });
    expect(calls).toEqual(['repairBrowserAction']);
  }, 30_000);

  it.each(['rule', 'model', 'prompt', 'tools', 'session', 'configuration'] as const)(
    'invalidates native action reuse after a %s change',
    async (change) => {
      await load();
      calls.length = 0;
      const reason = {
        rule: 'rule_changed',
        model: 'provider_changed',
        prompt: 'prompt_changed',
        tools: 'prompt_changed',
        session: 'session_changed',
        configuration: 'configuration_changed',
      };
      if (change === 'rule') context.ruleVersion = 'rule-v2';
      if (change === 'model')
        context.identity = () => ({ ...provider.cacheIdentity, model: 'native-fixture-v2' });
      if (change === 'prompt')
        context.identity = () => ({ ...provider.cacheIdentity, promptVersion: 'native-prompt-v2' });
      if (change === 'tools')
        context.identity = () => ({
          ...provider.cacheIdentity,
          toolSchemaVersion: 'native-tools-v2',
        });
      if (change === 'session')
        request.headers.authorization = 'Bearer FAKE_NATIVE_CACHE_AUTH_a7d1';
      if (change === 'configuration') context.configuration = { dataset: { detectRemoved: true } };
      expect((await load()).actionCache).toMatchObject({
        status: 'stored',
        reason: reason[change],
        providerCalls: 1,
      });
      expect(calls).toEqual(['repairBrowserAction']);
    },
    30_000,
  );

  it.each(['corrupt', 'expired'] as const)(
    'regenerates a %s native action only after validating the replacement',
    async (change) => {
      await load();
      calls.length = 0;
      const db = new Database(filePath);
      try {
        if (change === 'corrupt')
          db.prepare("UPDATE ai_validated_cache SET payload='broken' WHERE kind='action'").run();
        else
          db.prepare(
            "UPDATE ai_validated_cache SET created_at=?,expires_at=? WHERE kind='action'",
          ).run(Date.now() - 2000, Date.now() - 1000);
      } finally {
        db.close();
      }
      expect((await load()).actionCache).toMatchObject({
        status: 'stored',
        reason: change,
        providerCalls: 1,
      });
      expect(calls).toEqual(['repairBrowserAction']);
    },
    30_000,
  );

  it('does not resurrect an owner cache cleared during the explicitly authorized repair', async () => {
    context.repair = async (value, signal) => {
      await repository.clearValidatedCache(actionCacheDigest(context.scope));
      return provider.repairBrowserAction({ ...value, ...(signal ? { signal } : {}) });
    };
    expect((await load()).actionCache).toMatchObject({
      status: 'miss',
      reason: 'cleared_during_analysis',
      providerCalls: 1,
    });
    expect(calls).toEqual(['repairBrowserAction']);
    expect(rows()).toEqual([]);
  }, 30_000);

  it('clears only the requested owner and leaves another native cache usable', async () => {
    await load();
    const first = context.scope;
    context.scope = `task:${randomUUID()}`;
    await load();
    expect(rows()).toHaveLength(2);
    expect(await repository.clearValidatedCache(actionCacheDigest(first))).toBe(1);
    calls.length = 0;
    expect((await load()).actionCache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(calls).toEqual([]);
  }, 30_000);

  it('executes current fill/select values but excludes values, cookies, authentication and page content from repair and SQLite/WAL', async () => {
    const markers = [
      'FAKE_NATIVE_FILL_084c',
      'FAKE_NATIVE_SELECT_08ce',
      'FAKE_NATIVE_COOKIE_a94f',
      'FAKE_NATIVE_AUTH_b8fa',
      'FAKE_NATIVE_BODY_c60e',
    ];
    html = html
      .replace('<main>', `<main data-token="${markers[4]}"><aside>${markers[4]}</aside>`)
      .replace('</select>', `<option value="${markers[1]}">Chosen</option></select>`);
    settings.actions.unshift(
      { type: 'fill', selector: '#search', value: markers[0]! },
      { type: 'select', selector: '#choice', value: markers[1]! },
    );
    request.headers.authorization = `Bearer ${markers[3]}`;
    request.cookies.push({
      name: 'session',
      value: markers[2]!,
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    });
    const inputs: unknown[] = [];
    context.repair = (value, signal) => {
      inputs.push(value);
      return provider.repairBrowserAction({ ...value, ...(signal ? { signal } : {}) });
    };
    const first = await load();
    expect(first.html).toContain(markers[0]);
    expect(first.actionCache?.status).toBe('stored');
    calls.length = 0;
    expect((await load()).actionCache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(calls).toEqual([]);
    expect(inputs).toHaveLength(1);
    for (const marker of markers) expect(JSON.stringify(inputs)).not.toContain(marker);
    for (const file of [filePath, `${filePath}-wal`]) {
      const data = await readFile(file);
      for (const marker of markers) expect(data.includes(Buffer.from(marker))).toBe(false);
    }
    expect(JSON.parse(String(rows()[0]!.payload))).toEqual({
      version: 1,
      selectors: [expect.any(String), expect.any(String), expect.any(String)],
    });
  }, 30_000);

  it('stops after one real side effect when a cached native click fails its state proof', async () => {
    await load();
    const original = rows()[0]!.payload;
    calls.length = 0;
    html = html.replace("document.querySelector('#records').hidden=false", "fetch('/effect')");
    await expect(load()).rejects.toMatchObject({ code: 'ACTION_STATE_INVALID' });
    expect(effects).toBe(1);
    expect(calls).toEqual([]);
    expect(rows()[0]!.payload).toBe(original);
  }, 30_000);

  it('honors a zero repair budget and selfHeal=false without invoking either model path', async () => {
    context.maxRepairCalls = 0;
    await expect(load()).rejects.toMatchObject({ code: 'ACTION_STATE_INVALID' });
    context.maxRepairCalls = 1;
    await expect(load(false)).rejects.toMatchObject({ code: 'ACTION_STATE_INVALID' });
    expect(calls).toEqual([]);
    expect(rows()).toEqual([]);
  }, 30_000);
});
