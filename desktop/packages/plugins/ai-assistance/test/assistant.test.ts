import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptedChatProvider } from '@zhiyun/ai-runtime';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import type { JobExecutionContext, PlatformJobQueue } from '@zhiyun/platform-core';
import type {
  AgentRuntimePort,
  AssistantActor,
  AssistantBusinessPort,
  CollectionForAiPort,
} from '../src/contracts/index.js';
import { AssistantService } from '../src/application/assistant.js';
import { CrawlerAssistantService } from '../src/application/crawler-assistant.js';
import { PiAgentRuntime } from '../src/application/pi-adapter.js';
import { withTurnAccounting } from '../src/application/cost-accounting.js';
import { SqliteAiConversationRepository } from '../src/persistence/sqlite/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const alice: AssistantActor = {
  id: 'alice',
  permissions: ['workspace.read', 'task.write', 'run.execute', 'output.bind'],
};
const bob: AssistantActor = { ...alice, id: 'bob' };

async function fixture(
  provider = new ScriptedChatProvider([{ text: '一行是一条记录，一列是一个字段。' }]),
) {
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-assistant-unit-'));
  const path = join(directory, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory: directory,
    filePath: path,
    graphRevision: 'assistant',
  });
  const repository = new SqliteAiConversationRepository(path);
  await repository.migrate();
  cleanups.push(async () => {
    await repository.close();
    await platform.close();
    await rm(directory, { recursive: true, force: true });
  });
  const jobs = {
    enqueue: vi.fn(),
    cancel: vi.fn(),
    list: vi.fn(async () => []),
  } as unknown as PlatformJobQueue;
  const business: AssistantBusinessPort = {
    read: vi.fn(async (resource) => ({
      resource,
      revision: 1,
      summary: { taskId: resource.id, name: 'Task', schedule: { type: 'manual' } },
    })),
    getDraft: vi.fn(async () => null),
    createExample: vi.fn(),
    draftForTask: vi.fn(),
    patchDraft: vi.fn(),
    previewDraft: vi.fn(),
    execute: vi.fn(async () => ({ taskId: 'task-one', runId: 'run-one' })),
    recoverAction: vi.fn(async () => null),
    prepareRepair: vi.fn(),
    verifyLesson: vi.fn(async () => null),
    resolveActor: vi.fn(async (actor) => actor),
    controlledLogin: false,
  };
  const agent: AgentRuntimePort = new PiAgentRuntime(() => provider);
  const crawler = new CrawlerAssistantService({
    repository,
    jobs,
    agent,
    collection: {} as CollectionForAiPort,
    provider: () => provider,
    providerConfigured: () => true,
    crawler: { crawl: vi.fn() },
    search: { search: async () => [] },
  });
  const publish = vi.fn();
  const service = new AssistantService({
    repository,
    jobs,
    agent,
    crawler,
    business,
    configured: () => true,
    publish,
  });
  const run = async (id: string, turnId: string, actor = alice) =>
    service.createTurnHandler()({
      job: { id: turnId, payload: { conversationId: id, turnId, actor } },
      signal: new AbortController().signal,
    } as unknown as JobExecutionContext);
  return { service, repository, jobs, business, publish, run, crawler };
}

describe('Assistant ownership, pi tools and action recovery', () => {
  it('shows tested repair records next to a pending action without applying the proposal', async () => {
    const f = await fixture();
    const id = (
      await f.service.create(alice, { context: { resource: { kind: 'task', id: 'task-one' } } })
    ).conversation.id;
    const { turn } = await f.service.post(alice, id, 'Check the missing price');
    await f.repository.updateTurn(turn.id, { status: 'running' });
    vi.mocked(f.business.prepareRepair).mockResolvedValue({
      resource: { kind: 'task', id: 'task-one' },
      revision: 1,
      parameters: { ruleId: 'rule-one', proposalId: 'proposal-one' },
      summary: 'The price selector changed',
      preview: {
        records: [{ sourceUrl: 'https://example.com/item', data: { price: 12 } }],
        createdAt: new Date().toISOString(),
      },
    });
    await withTurnAccounting(turn.id, null, () =>
      f.service.createBrowserHandler()({
        job: {
          id: crypto.randomUUID(),
          payload: {
            actor: alice,
            conversationId: id,
            parentTurnId: turn.id,
            name: 'prepare_repair',
            args: {},
          },
        },
        signal: new AbortController().signal,
      } as unknown as JobExecutionContext),
    );
    const detail = await f.service.detail(alice, id);
    expect(detail.actions).toHaveLength(1);
    expect(detail.actions[0]?.status).toBe('pending');
    expect(detail.messages.flatMap((message) => message.blocks)).toContainEqual(
      expect.objectContaining({
        type: 'preview',
        repairActionId: detail.actions[0]!.id,
        records: [{ sourceUrl: 'https://example.com/item', data: { price: 12 } }],
      }),
    );
    expect(f.business.execute).not.toHaveBeenCalled();
  });
  it('prepares one operation identity across concurrent entry points and allows a later explicit run', async () => {
    const f = await fixture();
    const id = (
      await f.service.create(alice, { context: { resource: { kind: 'task', id: 'task-one' } } })
    ).conversation.id;
    const [first, second] = await Promise.all([
      f.service.prepareAction(alice, id, 'run'),
      f.service.prepareAction(alice, id, 'run'),
    ]);
    expect(first.id).toBe(second.id);
    await Promise.all([
      f.service.execute(alice, first.id, first.revision),
      f.service.execute(alice, second.id, second.revision),
    ]);
    expect(f.business.execute).toHaveBeenCalledOnce();
    expect((await f.service.prepareAction(alice, id, 'run')).id).not.toBe(first.id);
  });
  it('keeps pure questions draft-free and routes product help through pi with scoped events', async () => {
    const f = await fixture(
      new ScriptedChatProvider([
        { toolCalls: [{ id: 'help', name: 'search_help', arguments: { query: '字段' } }] },
        { text: '字段是表格的一列。' },
      ]),
    );
    const id = (await f.service.create(alice, {})).conversation.id;
    const { turn } = await f.service.post(alice, id, '什么是字段？');
    await f.run(id, turn.id);
    expect((await f.service.detail(alice, id)).turn).toMatchObject({
      status: 'succeeded',
      toolCalls: 1,
    });
    expect(await f.repository.getLatestDraft(id)).toBeNull();
    expect(f.jobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ resourceClass: 'io' }));
    expect(f.publish.mock.calls.every((call) => call[1].audienceUserId === alice.id)).toBe(true);
    expect(f.business.execute).not.toHaveBeenCalled();
  });

  it('enforces owner access on messages, actions and legacy cancellation while retaining old shared access', async () => {
    const f = await fixture();
    const id = (await f.service.create(alice, {})).conversation.id;
    const card = await f.service.prepareAction(alice, id, 'create_example');
    const { turn } = await f.service.post(alice, id, 'Hello');
    await expect(f.service.detail(bob, id)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.action(bob, card.id)).rejects.toMatchObject({ status: 404 });
    await expect(f.service.cancel(bob, turn.id)).rejects.toMatchObject({ status: 404 });
    await expect(f.crawler.cancelTurn(turn.id)).rejects.toThrow();
    expect((await f.service.list(bob)).items).toEqual([]);
    const shared = await f.repository.createConversation({ title: 'Legacy' });
    expect((await f.service.detail(bob, shared.id)).conversation.ownerId).toBeNull();
    await expect(
      f.service.post({ id: 'viewer', permissions: ['workspace.read'] }, shared.id, 'edit'),
    ).rejects.toMatchObject({ status: 403 });
    const personal = await f.service.create({ id: 'viewer', permissions: ['workspace.read'] }, {});
    expect(personal.conversation.ownerId).toBe('viewer');
  });

  it('does not execute stale cards after resource changes or permission revocation', async () => {
    const f = await fixture();
    const id = (
      await f.service.create(alice, { context: { resource: { kind: 'task', id: 'task-one' } } })
    ).conversation.id;
    const card = await f.service.prepareAction(alice, id, 'run');
    vi.mocked(f.business.resolveActor).mockResolvedValueOnce({
      id: alice.id,
      permissions: ['workspace.read'],
    });
    await expect(f.service.execute(alice, card.id, card.revision)).rejects.toMatchObject({
      status: 403,
    });
    vi.mocked(f.business.read).mockResolvedValueOnce({
      resource: card.resource!,
      revision: 2,
      summary: {},
    });
    await expect(f.service.execute(alice, card.id, card.revision)).rejects.toMatchObject({
      status: 412,
    });
    expect((await f.service.action(alice, card.id)).status).toBe('expired');
    expect(f.business.execute).not.toHaveBeenCalled();
  });

  it('reconciles a completed business action after restart without executing it again', async () => {
    const f = await fixture();
    const id = (
      await f.service.create(alice, { context: { resource: { kind: 'task', id: 'task-one' } } })
    ).conversation.id;
    const card = await f.service.prepareAction(alice, id, 'run');
    await f.repository.putAssistantRecord(
      {
        id: `action:${card.id}`,
        conversationId: id,
        kind: 'action',
        value: { ...card, status: 'running' },
      },
      card.revision,
    );
    vi.mocked(f.business.recoverAction).mockResolvedValue({
      taskId: 'task-one',
      runId: 'the-existing-run',
    });
    await f.service.recover();
    const result = await f.service.execute(alice, card.id, card.revision);
    expect(result).toMatchObject({ status: 'succeeded', result: { runId: 'the-existing-run' } });
    expect(f.business.execute).not.toHaveBeenCalled();
  });

  it('releases failed turns and permits a follow-up without changing the conversation lifecycle', async () => {
    const f = await fixture();
    const id = (await f.service.create(alice, {})).conversation.id;
    const { turn } = await f.service.post(alice, id, 'hello');
    vi.mocked(f.business.resolveActor).mockRejectedValueOnce(new Error('account unavailable'));
    await f.run(id, turn.id);
    expect((await f.service.detail(alice, id)).conversation).toMatchObject({
      lifecycle: 'active',
      activeTurnId: null,
    });
    expect((await f.service.detail(alice, id)).turn?.status).toBe('failed');
    expect((await f.service.post(alice, id, 'try again')).turn.status).toBe('queued');
  });
});
