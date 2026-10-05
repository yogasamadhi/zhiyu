import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAiProvider, ScriptedChatProvider } from '@zhiyun/ai-runtime';
import { LocalArtifactStore } from '@zhiyun/artifact-store';
import { AesCredentialStore } from '@zhiyun/platform';
import { JobHandlerRegistry } from '@zhiyun/platform-core';
import { SqliteAnalysisRepository } from '@zhiyun/plugin-analytics';
import { SqliteAiConversationRepository, cacheDigest } from '@zhiyun/plugin-ai-assistance';
import { SqliteCollectionRepository } from '@zhiyun/plugin-collection';
import { SqliteCorpusRepository } from '@zhiyun/plugin-corpus';
import { SqliteDatasetRepository } from '@zhiyun/plugin-datasets';
import { SqliteMonitoringRepository } from '@zhiyun/plugin-monitoring';
import { SqliteOutputRepository } from '@zhiyun/plugin-outputs';
import { SqlitePreferencesRepository } from '@zhiyun/plugin-preferences';
import { SqliteRecruitmentRepository } from '@zhiyun/plugin-recruitment';
import { resolveProductGraph } from '@zhiyun/product-profiles';
import { LocalPlatformJobQueue } from '@zhiyun/queue-local-v1';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import {
  assistantDetailSchema,
  type AiProvider,
  type AssistantAction,
  type AssistantDetail,
  type CollectionDraft,
} from '@zhiyun/contracts';
import { buildLevel2Runtime, openApiDocument } from '../src/index.js';

const cleanup: Array<() => Promise<void>> = [];
let costFlowCalls = 0;
let costFlowStarted = 0;
let costFlowOperations: Record<string, number> = {};
beforeEach(() => {
  costFlowStarted = performance.now();
  costFlowCalls = 0;
  costFlowOperations = {};
});
afterEach(async ({ task }) => {
  console.info(
    'COST_CASE_METRICS',
    JSON.stringify({
      fixtureVersion: 'repair-quality-v3',
      name: task.name,
      providerCalls: costFlowCalls,
      operations: costFlowOperations,
      durationMs: performance.now() - costFlowStarted,
    }),
  );
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(ai: AiProvider = createAiProvider(), pollIntervalMs = 60_000) {
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-assistant-test-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory: directory,
    filePath: path,
    graphRevision: resolveProductGraph('test').revision,
  });
  const repositories = {
    platform,
    datasets: new SqliteDatasetRepository(path),
    collection: new SqliteCollectionRepository(path),
    outputs: new SqliteOutputRepository(path),
    preferences: new SqlitePreferencesRepository(path),
    recruitment: new SqliteRecruitmentRepository(path),
    analytics: new SqliteAnalysisRepository(path),
    corpus: new SqliteCorpusRepository(path),
    aiAssistance: new SqliteAiConversationRepository(path),
    monitoring: new SqliteMonitoringRepository(path),
  };
  const handlers = new JobHandlerRegistry();
  const jobs = new LocalPlatformJobQueue(platform, handlers, { pollIntervalMs });
  const runtime = await buildLevel2Runtime(
    {
      repositories,
      handlers,
      jobs,
      ai,
      crawler: {
        async crawl() {
          throw new Error('Offline lessons must not contact a website');
        },
      },
      credentialStore: new AesCredentialStore(join(directory, 'credentials'), undefined, false),
      artifactStore: new LocalArtifactStore(directory),
      openApiDocument: openApiDocument('test'),
      host: {
        metadata: {
          runtimeId: crypto.randomUUID(),
          generation: 1,
          apiVersion: 'v2',
          mode: 'desktop',
          productVersion: '1.0.0',
          analyticsWorkerStatus: 'unavailable',
          startedAt: new Date().toISOString(),
        },
        capabilities: {
          platform: 'darwin',
          browser: true,
          cron: true,
          credentials: true,
          artifactSaveDialog: false,
          notifications: false,
          tray: false,
        },
      },
    },
    {
      sessionNonce: 'assistant-test-nonce',
      profileId: 'test',
      allowedOrigins: ['app://zhiyun'],
      logger: false,
    },
  );
  cleanup.push(() => runtime.close());
  const session = await runtime.app.inject({
    method: 'POST',
    url: '/api/v2/session',
    payload: { nonce: 'assistant-test-nonce' },
  });
  const token = session.json().token as string;
  const request = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    url: string,
    payload?: unknown,
    revision?: number,
    key = crypto.randomUUID(),
  ) =>
    runtime.app.inject({
      method,
      url: `/api/v2${url}`,
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': key,
        ...(revision ? { 'if-match': `"${revision}"` } : {}),
      },
      ...(payload === undefined
        ? {}
        : {
            payload: JSON.stringify(payload),
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': 'application/json',
              'idempotency-key': key,
              ...(revision ? { 'if-match': `"${revision}"` } : {}),
            },
          }),
    });
  const detail = async (id: string) =>
    (await request('GET', `/assistant/conversations/${id}`)).json<AssistantDetail>();
  return { request, detail, jobs, repositories, runtime, directory, path };
}

describe('Assistant through the real runtime and canonical Collection services', () => {
  it('still rejects assistant changes to manually owned browser and dataset settings', async () => {
    const usage = vi.fn();
    const provider = new ScriptedChatProvider(
      [
        {
          toolCalls: [
            {
              id: 'change-browser',
              name: 'update_task_draft',
              arguments: { browserEnabled: false },
            },
          ],
        },
        { text: '此配置由手动编辑器管理。' },
        {
          toolCalls: [
            {
              id: 'change-dataset',
              name: 'update_task_draft',
              arguments: { datasetMode: 'upsert' },
            },
          ],
        },
        { text: '此配置由手动编辑器管理。' },
      ],
      usage,
    );
    const f = await fixture(provider, 25);
    const manual = await f.repositories.collection.createDraft({
      id: crypto.randomUUID(),
      revision: 1,
      taskId: null,
      taskRevision: null,
      exampleId: null,
      step: 2,
      mode: 'manual',
      task: {
        name: 'Manual ownership',
        startUrl: 'https://example.invalid',
        instruction: 'name',
        browserSettings: { enabled: true, waitUntil: 'domcontentloaded', actions: [] },
        datasetSettings: { mode: 'append', keyFields: ['name'], detectRemoved: false },
      },
      definition: null,
      preview: null,
      status: 'editing',
      commitRun: null,
      result: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const opened = await f.request('POST', '/assistant/conversations', {
      context: { resource: { kind: 'draft', id: manual.id } },
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const id = opened.json<AssistantDetail>().conversation.id;
    for (const content of ['关闭浏览器', '更改数据写入方式']) {
      expect(
        (await f.request('POST', `/assistant/conversations/${id}/messages`, { content }))
          .statusCode,
      ).toBe(202);
      await vi.waitFor(
        async () => {
          expect((await f.detail(id)).conversation.activeTurnId).toBeNull();
        },
        { timeout: 10_000, interval: 50 },
      );
      const current = await f.detail(id);
      const calls = await f.repositories.aiAssistance.listToolInvocations(current.turn!.id);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('INVALID_AI_PATCH'),
      });
      expect(await f.repositories.collection.getDraft(manual.id)).toEqual(manual);
    }
    expect(usage).not.toHaveBeenCalled();
  }, 25_000);
  it('generates cache feedback through real assistant jobs, preserves manual settings, clears its scope and restores persisted messages', async () => {
    let revision = 1;
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<article class="product-card"><h2>Current v${revision}</h2><span class="price">${revision + 10}</span></article>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No assistant fixture port');
    const calls: string[] = [];
    const script = Array.from({ length: 4 }, (_, index) => [
      { toolCalls: [{ id: `generate-${index}`, name: 'generate_rule', arguments: {} }] },
      { text: '字段已准备，请查看结果。' },
    ]).flat();
    let chatCalls = 0;
    class CountingScriptedProvider extends ScriptedChatProvider {
      override async *streamChat(args: Parameters<ScriptedChatProvider['streamChat']>[0]) {
        chatCalls++;
        yield* super.streamChat(args);
      }
    }
    const f = await fixture(
      new CountingScriptedProvider(script, (usage) => {
        calls.push(usage.operation);
      }),
      25,
    );
    const createdDraft = await f.request('POST', '/collection-drafts', {});
    expect(createdDraft.statusCode, createdDraft.body).toBe(201);
    const initial = createdDraft.json<CollectionDraft>();
    const patched = await f.request(
      'PATCH',
      `/collection-drafts/${initial.id}`,
      {
        task: {
          name: 'Assistant local cache',
          startUrl: `http://127.0.0.1:${address.port}/products`,
          instruction: 'name price',
          requestSettings: { retries: 0, delayMs: 0, respectRobotsTxt: false, concurrency: 1 },
          networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
          browserSettings: {
            enabled: true,
            actions: [{ type: 'waitFor', selector: '.product-card' }],
          },
          schedule: { type: 'manual' },
          datasetSettings: { mode: 'append', keyFields: ['name'], detectRemoved: false },
        },
      },
      initial.revision,
    );
    expect(patched.statusCode, patched.body).toBe(200);
    const manual = patched.json<CollectionDraft>();
    const opened = await f.request('POST', '/assistant/conversations', {
      context: {
        intent: 'collect',
        resource: { kind: 'draft', id: initial.id },
        goal: 'name price',
      },
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const id = opened.json<AssistantDetail>().conversation.id;
    const generate = async () => {
      const posted = await f.request('POST', `/assistant/conversations/${id}/messages`, {
        content: '请生成字段',
      });
      expect(posted.statusCode, posted.body).toBe(202);
      await vi.waitFor(
        async () => {
          const current = await f.detail(id);
          expect(current.turn?.status, current.turn?.error ?? '').toBe('succeeded');
          expect(current.conversation.activeTurnId).toBeNull();
        },
        { timeout: 15_000, interval: 50 },
      );
      const current = assistantDetailSchema.parse(await f.detail(id));
      const accounting = current.turn?.accounting;
      expect(accounting?.operations.chat).toBe(2);
      const fields = current.messages
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === 'fields');
      const block = fields.at(-1);
      const invocations = await f.repositories.aiAssistance.listToolInvocations(current.turn!.id);
      expect(
        block,
        invocations
          .map((item) => item.error)
          .filter(Boolean)
          .join('; '),
      ).toBeDefined();
      expect(accounting?.calls).toBe(2 + block!.cache!.providerCalls);
      expect(accounting?.operations.generateSchema ?? 0).toBe(
        block!.cache!.providerCalls === 2 ? 1 : 0,
      );
      expect(accounting?.operations.generateRule ?? 0).toBe(
        block!.cache!.providerCalls === 2 ? 1 : 0,
      );
      const draft = (await f.repositories.collection.getDraft(initial.id))!;
      for (const field of [
        'requestSettings',
        'networkPolicy',
        'browserSettings',
        'schedule',
        'datasetSettings',
      ] as const)
        expect(draft.task[field]).toEqual(manual.task[field]);
      return block!;
    };
    const first = await generate();
    expect(first.cache).toMatchObject({ status: 'stored', providerCalls: 2, hitCount: 0 });
    expect(first.actionCache).toMatchObject({ status: 'stored', providerCalls: 0 });
    expect(calls).toEqual(['generateSchema', 'generateRule']);
    const firstCalls = calls.length;
    const initialChatCalls = chatCalls;
    calls.length = 0;
    chatCalls = 0;
    revision = 2;
    const repeated = await generate();
    expect(repeated.cache).toMatchObject({ status: 'hit', providerCalls: 0, hitCount: 1 });
    expect(repeated.actionCache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(calls).toEqual([]);
    const repeatRuleCalls = calls.length;
    const repeatChatCalls = chatCalls;
    const cleared = await f.request('POST', '/rules/cache/clear', { cacheScope: initial.id });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toEqual({ status: 'cleared', deleted: 2 });
    chatCalls = 0;
    const afterClear = await generate();
    expect(afterClear.cache).toMatchObject({ status: 'stored', reason: 'empty', providerCalls: 2 });
    expect(afterClear.actionCache).toMatchObject({
      status: 'stored',
      reason: 'empty',
      providerCalls: 0,
    });
    expect(calls).toEqual(['generateSchema', 'generateRule']);
    const afterClearRuleCalls = calls.length;
    const afterClearChatCalls = chatCalls;
    calls.length = 0;
    chatCalls = 0;
    const database = new DatabaseSync(f.path);
    try {
      expect(
        database
          .prepare(
            "UPDATE ai_validated_cache SET payload='broken' WHERE scope_hash=? AND kind='rule'",
          )
          .run(cacheDigest(`draft:${initial.id}`)).changes,
      ).toBe(1);
    } finally {
      database.close();
    }
    const afterCorrupt = await generate();
    expect(afterCorrupt.cache).toMatchObject({
      status: 'stored',
      reason: 'corrupt',
      providerCalls: 2,
    });
    expect(afterCorrupt.actionCache).toMatchObject({ status: 'hit', providerCalls: 0 });
    expect(calls).toEqual(['generateSchema', 'generateRule']);
    await f.runtime.close();
    const reopened = new SqliteAiConversationRepository(f.path);
    await reopened.migrate();
    cleanup.push(() => reopened.close());
    const persisted = await reopened.listAssistantRecords('blocks', id);
    expect(persisted.flatMap((row) => row.value.blocks as unknown[])).toEqual(
      expect.arrayContaining([first, repeated, afterClear, afterCorrupt]),
    );
    console.info(
      'ASSISTANT_CACHE_FEEDBACK_METRICS',
      JSON.stringify({
        fixture: 'default-assistant-cache-feedback-v1',
        provider: 'Mock',
        initialRuleGenerationMockCalls: firstCalls,
        repeatRuleGenerationMockCalls: repeatRuleCalls,
        afterClearRuleGenerationMockCalls: afterClearRuleCalls,
        corruptRuleGenerationMockCalls: calls.length,
        scriptedChatCalls: {
          initial: initialChatCalls,
          repeat: repeatChatCalls,
          afterClear: afterClearChatCalls,
          afterCorrupt: chatCalls,
        },
        restoredFieldCards: persisted.length,
        clearedEntries: cleared.json().deleted,
      }),
    );
  }, 40_000);
  it('answers without drafts, continues after failure, preserves archived lifecycle and old shared sessions', async () => {
    const f = await fixture();
    const created = await f.request('POST', '/assistant/conversations', {});
    expect(created.statusCode).toBe(201);
    const id = created.json<AssistantDetail>().conversation.id;
    expect(await f.repositories.aiAssistance.getLatestDraft(id)).toBeNull();
    const sent = await f.request('POST', `/assistant/conversations/${id}/messages`, {
      content: '字段是什么意思？',
    });
    expect(sent.statusCode).toBe(202);
    expect(await f.jobs.get(sent.json().turn.id)).toMatchObject({ resourceClass: 'io' });
    await f.jobs.dispatchOnce();
    let current = await f.detail(id);
    expect(current.turn?.status).toBe('succeeded');
    expect(current.messages.at(-1)?.content).toContain('固定引导');
    expect(current.conversation.collectionDraftId).toBeNull();
    expect(await f.repositories.aiAssistance.getLatestDraft(id)).toBeNull();
    const archived = await f.request(
      'PATCH',
      `/assistant/conversations/${id}`,
      { lifecycle: 'archived' },
      current.conversation.revision,
    );
    expect(archived.statusCode).toBe(200);
    expect(
      (await f.request('POST', `/assistant/conversations/${id}/messages`, { content: '继续' }))
        .statusCode,
    ).toBe(409);
    current = await f.detail(id);
    await f.request(
      'PATCH',
      `/assistant/conversations/${id}`,
      { lifecycle: 'active' },
      current.conversation.revision,
    );
    expect(
      (
        await f.request('POST', `/assistant/conversations/${id}/messages`, {
          content: '如何导出？',
        })
      ).statusCode,
    ).toBe(202);
    await f.jobs.dispatchOnce();
    const legacy = await f.repositories.aiAssistance.createConversation({
      title: 'Shared old conversation',
    });
    expect((await f.detail(legacy.id)).conversation.ownerId).toBeNull();
    expect((await f.detail(id)).conversation.ownerId).toBe('local-workspace');
  });

  it('finishes an offline preview, creates exactly one task/run, exports one artifact and keeps the conversation usable', async () => {
    const f = await fixture();
    const id = (
      await f.request('POST', '/assistant/conversations', { mode: 'teach' })
    ).json<AssistantDetail>().conversation.id;
    const lesson = async (event: string) => {
      const current = await f.detail(id);
      const response = await f.request(
        'POST',
        `/assistant/conversations/${id}/lesson-progress`,
        { lessonId: 'export', event },
        current.conversation.revision,
      );
      expect(response.statusCode, response.body).toBe(200);
      return response.json<AssistantDetail>();
    };
    const first = await lesson('start');
    const example = first.actions.find((action) => action.kind === 'create_example')!;
    expect(
      (await f.request('POST', `/assistant/actions/${example.id}/execute`, {}, example.revision))
        .statusCode,
    ).toBe(200);
    await lesson('verify');
    const preview = await lesson('verify');
    expect(
      preview.messages.some((message) =>
        message.blocks.some((block) => block.type === 'preview' && block.records.length === 6),
      ),
    ).toBe(true);
    const ready = await lesson('verify');
    const save = ready.actions.find((action) => action.kind === 'save_and_run')!;
    expect(save).toBeDefined();
    const responses = await Promise.all([
      f.request('POST', `/assistant/actions/${save.id}/execute`, {}, save.revision),
      f.request('POST', `/assistant/actions/${save.id}/execute`, {}, save.revision),
    ]);
    expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
    const saved = (await f.detail(id)).actions.find((action) => action.id === save.id)!;
    expect(saved.status).toBe('succeeded');
    const taskId = saved.result!.taskId as string;
    expect(await f.repositories.collection.listRuns(taskId)).toHaveLength(1);
    await f.jobs.dispatchOnce();
    expect((await f.repositories.collection.listRuns(taskId))[0]?.status).toBe('succeeded');
    await lesson('verify');
    const exportReady = await lesson('verify');
    const card = exportReady.actions.find((action) => action.kind === 'export')!;
    const exported = await f.request(
      'POST',
      `/assistant/actions/${card.id}/execute`,
      {},
      card.revision,
    );
    expect(exported.statusCode, exported.body).toBe(200);
    const replay = await f.request(
      'POST',
      `/assistant/actions/${card.id}/execute`,
      {},
      card.revision,
    );
    expect(replay.json<AssistantAction>().result).toEqual(exported.json<AssistantAction>().result);
    expect((await lesson('verify')).conversation.lessons[0]?.status).toBe('completed');
    expect(
      (
        await f.request('POST', `/assistant/conversations/${id}/messages`, {
          content: '如何使用这些数据？',
        })
      ).statusCode,
    ).toBe(202);
    for (let attempt = 0; attempt < 10 && (await f.detail(id)).turn?.status === 'queued'; attempt++)
      await f.jobs.dispatchOnce();
    expect((await f.detail(id)).turn?.status).toBe('succeeded');
    const prepared = await f.request('POST', `/assistant/conversations/${id}/actions`, {
      kind: 'run',
    });
    expect(prepared.statusCode, prepared.body).toBe(200);
    const runCard = prepared.json<AssistantAction>();
    const queued = await f.request(
      'POST',
      `/assistant/actions/${runCard.id}/execute`,
      {},
      runCard.revision,
    );
    expect(queued.statusCode, queued.body).toBe(200);
    const queuedRunId = queued.json<AssistantAction>().result!.runId as string;
    const task = (await f.repositories.collection.getTask(taskId))!;
    await f.repositories.collection.updateTask(
      taskId,
      { name: 'Changed after confirming the run' },
      task.revision,
    );
    for (
      let attempt = 0;
      attempt < 10 && (await f.repositories.collection.getRun(queuedRunId))?.status === 'queued';
      attempt++
    )
      await f.jobs.dispatchOnce();
    const rejected = await f.repositories.collection.getRun(queuedRunId);
    expect(rejected).toMatchObject({
      status: 'failed',
      recordCount: 0,
      errorCode: 'VALIDATION_ERROR',
    });
    expect(rejected?.error).toContain('changed after this run was confirmed');
  });

  it('requires server-observed exercise events and expires operations when their target changes', async () => {
    const f = await fixture();
    let current = (await f.request('POST', '/assistant/conversations', {})).json<AssistantDetail>();
    const id = current.conversation.id;
    const lessonUrl = `/assistant/conversations/${id}/lesson-progress`;
    current = (
      await f.request(
        'POST',
        lessonUrl,
        { lessonId: 'pagination', event: 'start' },
        current.conversation.revision,
      )
    ).json<AssistantDetail>();
    expect(
      (
        await f.request(
          'POST',
          lessonUrl,
          { lessonId: 'pagination', event: 'verify', pages: 2 },
          current.conversation.revision,
        )
      ).statusCode,
    ).toBe(422);
    current = (
      await f.request(
        'POST',
        lessonUrl,
        { lessonId: 'pagination', event: 'load_more' },
        current.conversation.revision,
      )
    ).json<AssistantDetail>();
    current = (
      await f.request(
        'POST',
        lessonUrl,
        { lessonId: 'pagination', event: 'verify' },
        current.conversation.revision,
      )
    ).json<AssistantDetail>();
    expect(current.conversation.lessons[0]?.status).toBe('completed');
    const card = (
      await f.request('POST', `/assistant/conversations/${id}/actions`, { kind: 'create_example' })
    ).json<AssistantAction>();
    current = await f.detail(id);
    expect(
      (
        await f.request(
          'PUT',
          `/assistant/conversations/${id}/context`,
          { ...current.conversation.context, goal: 'A different objective' },
          current.conversation.context.revision,
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await f.request('POST', `/assistant/actions/${card.id}/execute`, {}, card.revision))
        .statusCode,
    ).toBe(412);
    expect((await f.detail(id)).actions.find((action) => action.id === card.id)?.status).toBe(
      'expired',
    );
  });

  it('persists an HTTP estimate budget, stops before a tool and restores accounting after SQLite reopen', async () => {
    let calls = 0;
    class BudgetProvider extends ScriptedChatProvider {
      override async *streamChat(input: Parameters<ScriptedChatProvider['streamChat']>[0]) {
        calls++;
        costFlowCalls++;
        costFlowOperations.chat = (costFlowOperations.chat ?? 0) + 1;
        yield* super.streamChat(input);
      }
    }
    const f = await fixture(
      new BudgetProvider([
        { toolCalls: [{ id: 'blocked-rule', name: 'generate_rule', arguments: {} }] },
        { text: 'Unused response' },
      ]),
      25,
    );
    const id = (await f.request('POST', '/assistant/conversations', {})).json<AssistantDetail>()
      .conversation.id;
    const budget = { maximum: 0.25, perCallEstimate: 0.25, currency: 'CNY' };
    const posted = await f.request('POST', `/assistant/conversations/${id}/messages`, {
      content: 'Bounded costs',
      costBudget: budget,
    });
    expect(posted.statusCode, posted.body).toBe(202);
    await vi.waitFor(
      async () => expect((await f.detail(id)).conversation.activeTurnId).toBeNull(),
      { timeout: 10_000, interval: 50 },
    );
    const current = await f.detail(id);
    expect(current.turn).toMatchObject({
      status: 'succeeded',
      costBudget: budget,
      accounting: { calls: 1, estimatedCost: 0.25, stopReason: 'cost_limit' },
    });
    expect(calls).toBe(1);
    expect(await f.repositories.aiAssistance.listToolInvocations(current.turn!.id)).toEqual([]);
    expect(current.actions).toEqual([]);
    const reopened = new SqliteAiConversationRepository(f.path);
    try {
      await reopened.migrate();
      expect(await reopened.getTurn(current.turn!.id)).toEqual(current.turn);
    } finally {
      await reopened.close();
    }
  }, 15_000);

  it('preserves accounting after a provider failure and carries the budget into an HTTP retry', async () => {
    let calls = 0;
    class FailingOnceProvider extends ScriptedChatProvider {
      override async *streamChat(input: Parameters<ScriptedChatProvider['streamChat']>[0]) {
        calls++;
        costFlowCalls++;
        costFlowOperations.chat = (costFlowOperations.chat ?? 0) + 1;
        if (calls === 1) throw new Error('Fixture provider failure');
        yield* super.streamChat(input);
      }
    }
    const f = await fixture(new FailingOnceProvider([{ text: 'Retried fixture' }]), 25);
    const id = (await f.request('POST', '/assistant/conversations', {})).json<AssistantDetail>()
      .conversation.id;
    const budget = { maximum: 1, perCallEstimate: 0.25, currency: 'CNY' };
    expect(
      (
        await f.request('POST', `/assistant/conversations/${id}/messages`, {
          content: 'Retry a bounded request',
          costBudget: budget,
        })
      ).statusCode,
    ).toBe(202);
    await vi.waitFor(
      async () => expect((await f.detail(id)).conversation.activeTurnId).toBeNull(),
      { timeout: 10_000, interval: 50 },
    );
    const failed = (await f.detail(id)).turn!;
    expect(failed).toMatchObject({
      status: 'failed',
      costBudget: budget,
      accounting: { calls: 1, estimatedCost: 0.25, operations: { chat: 1 } },
    });
    expect(failed.error).toContain('Fixture provider failure');
    expect((await f.request('POST', `/assistant/turns/${failed.id}/retry`, {})).statusCode).toBe(
      200,
    );
    await vi.waitFor(
      async () => expect((await f.detail(id)).conversation.activeTurnId).toBeNull(),
      { timeout: 10_000, interval: 50 },
    );
    const retry = (await f.detail(id)).turn!;
    expect(retry.id).not.toBe(failed.id);
    expect(retry).toMatchObject({
      status: 'succeeded',
      attempt: 1,
      costBudget: budget,
      accounting: { calls: 1, estimatedCost: 0.25, operations: { chat: 1 } },
    });
    expect(await f.repositories.aiAssistance.getTurn(failed.id)).toEqual(failed);
    expect(calls).toBe(2);
  });

  it('rejects an invalid HTTP budget before queuing work or changing the active turn', async () => {
    const f = await fixture();
    const id = (await f.request('POST', '/assistant/conversations', {})).json<AssistantDetail>()
      .conversation.id;
    for (const budget of [
      { maximum: -1 },
      { maximum: 1, currency: 'private-value' },
      { maximum: 1, perCallEstimate: -2 },
    ]) {
      expect(
        (
          await f.request('POST', `/assistant/conversations/${id}/messages`, {
            content: 'Invalid budget',
            costBudget: budget,
          })
        ).statusCode,
      ).toBe(400);
      expect((await f.detail(id)).conversation.activeTurnId).toBeNull();
    }
  });

  for (const { suffix, contentType, body } of [
    {
      suffix: '',
      contentType: 'text/html',
      body: '<main><article class="product-card"><h2>Fixture</h2><span class="price">10</span></article></main>',
    },
    {
      suffix: ' for JSON',
      contentType: 'application/json',
      body: JSON.stringify({ items: [{ name: 'Fixture', price: 10 }] }),
    },
    {
      suffix: ' for embedded JSON',
      contentType: 'text/html',
      body: '<main><script>_ROUTER_DATA = {"product":{"name":"Fixture","price":10}};</script></main>',
    },
  ]) {
    it(
      'shares the cost limit with an independently queued browser tool and stops its second generation call' +
        suffix,
      async () => {
        const server = createServer((_request, response) => {
          response.setHeader('content-type', contentType);
          response.end(body);
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('No cost fixture port');
        class QueuedBudgetProvider extends ScriptedChatProvider {
          override async *streamChat(input: Parameters<ScriptedChatProvider['streamChat']>[0]) {
            costFlowCalls++;
            costFlowOperations.chat = (costFlowOperations.chat ?? 0) + 1;
            yield* super.streamChat(input);
          }
          override async generateSchema(
            input: Parameters<ScriptedChatProvider['generateSchema']>[0],
          ) {
            costFlowCalls++;
            costFlowOperations.generateSchema = (costFlowOperations.generateSchema ?? 0) + 1;
            return super.generateSchema(input);
          }
          override async generateRule(input: Parameters<ScriptedChatProvider['generateRule']>[0]) {
            costFlowCalls++;
            costFlowOperations.generateRule = (costFlowOperations.generateRule ?? 0) + 1;
            return super.generateRule(input);
          }
        }
        const f = await fixture(
          new QueuedBudgetProvider([
            { toolCalls: [{ id: 'queued-generation', name: 'generate_rule', arguments: {} }] },
            { text: 'Unused response' },
          ]),
          25,
        );
        const initial = (await f.request('POST', '/collection-drafts', {})).json<CollectionDraft>();
        const patched = await f.request(
          'PATCH',
          `/collection-drafts/${initial.id}`,
          {
            task: {
              name: 'Queued budget fixture',
              startUrl: `http://127.0.0.1:${address.port}/items`,
              instruction: 'name price',
              requestSettings: { retries: 0, delayMs: 0, respectRobotsTxt: false },
              networkPolicy: { allowPrivateNetworks: true },
              browserSettings: { enabled: false },
            },
          },
          initial.revision,
        );
        expect(patched.statusCode, patched.body).toBe(200);
        const id = (
          await f.request('POST', '/assistant/conversations', {
            context: { resource: { kind: 'draft', id: initial.id } },
          })
        ).json<AssistantDetail>().conversation.id;
        const posted = await f.request('POST', `/assistant/conversations/${id}/messages`, {
          content: 'Generate a bounded rule',
          costBudget: { maximum: 0.5, perCallEstimate: 0.25, currency: 'CNY' },
        });
        expect(posted.statusCode, posted.body).toBe(202);
        await vi.waitFor(
          async () => expect((await f.detail(id)).conversation.activeTurnId).toBeNull(),
          { timeout: 15_000, interval: 50 },
        );
        const current = await f.detail(id);
        expect(current.turn).toMatchObject({
          status: 'succeeded',
          accounting: {
            calls: 2,
            estimatedCost: 0.5,
            stopReason: 'cost_limit',
            operations: { chat: 1, generateSchema: 1 },
          },
        });
        expect(costFlowCalls).toBe(2);
        expect(costFlowOperations).toEqual({ chat: 1, generateSchema: 1 });
        expect((await f.repositories.collection.getDraft(initial.id))?.definition).toBeNull();
        expect(current.actions).toEqual([]);
        expect(
          (await f.repositories.aiAssistance.listToolInvocations(current.turn!.id))[0]?.status,
        ).toBe('failed');
      },
      20_000,
    );
  }
});
