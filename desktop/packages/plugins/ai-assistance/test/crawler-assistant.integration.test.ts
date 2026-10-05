import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScriptedChatProvider } from '@zhiyun/ai-runtime';
import { normalizeCrawlPlan, taskCreateSchema, type CrawlerService } from '@zhiyun/contracts';
import type { PlatformJobQueue } from '@zhiyun/platform-core';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import type { AgentRuntimePort, CollectionForAiPort } from '../src/contracts/index.js';
import type { CollectionDraft } from '@zhiyun/contracts';
import {
  CrawlerAssistantService,
  type CrawlerAssistantDependencies,
} from '../src/application/crawler-assistant.js';
import { SqliteAiConversationRepository } from '../src/persistence/sqlite/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('CrawlerAssistant confirmation boundary', () => {
  it('creates one deterministic Task/Rule only from the confirmation API', async () => {
    const fixture = await createFixture();
    const created = await fixture.service.createConversation();
    const draft = {
      ...created.draft.draft,
      name: 'Products',
      startUrl: 'https://example.com/products',
      instruction: 'Collect product names and URLs',
      rule: normalizeCrawlPlan({
        type: 'css',
        container: '.product',
        fields: {
          name: { selector: '.name', value: 'text', dataType: 'string' },
          url: { selector: 'a', value: 'attribute', attribute: 'href', dataType: 'url' },
        },
      }),
      preview: [
        { sourceUrl: 'https://example.com/products/1', data: { name: 'A', url: '/products/1' } },
      ],
      testMetadata: { requestCount: 1, recordCount: 1 },
      confirmationPresentedAt: new Date().toISOString(),
    };
    const version = await fixture.repository.createDraft(created.conversation.id, draft);
    await fixture.repository.updateConversation(created.conversation.id, {
      status: 'awaiting_confirmation',
    });
    const first = await fixture.service.commit(created.conversation.id, version.revision);
    const replay = await fixture.service.commit(created.conversation.id, version.revision);
    expect(first).toMatchObject({ replayed: false, taskId: expect.any(String) });
    expect(replay).toEqual({ taskId: first.taskId, replayed: true });
    expect(fixture.commit).toHaveBeenCalledTimes(1);
    expect(fixture.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: first.taskId,
        generatedBy: 'ai',
        origin: { kind: 'ai' },
        task: expect.objectContaining({
          requestSettings: expect.objectContaining({
            headers: {},
            cookies: [],
            respectRobotsTxt: true,
          }),
          credentialBindings: {},
          networkPolicy: { allowPrivateNetworks: false, allowedHosts: [], allowedCidrs: [] },
          outputBindings: [],
        }),
      }),
    );
  });

  it('rejects an old confirmation card after a new Draft revision', async () => {
    const fixture = await createFixture();
    const created = await fixture.service.createConversation();
    const confirmed = await fixture.repository.createDraft(created.conversation.id, {
      ...created.draft.draft,
      name: 'Products',
      startUrl: 'https://example.com/products',
      instruction: 'Collect names',
      rule: normalizeCrawlPlan({
        type: 'css',
        container: '.product',
        fields: { name: { selector: '.name', value: 'text', dataType: 'string' } },
      }),
      testMetadata: { recordCount: 1 },
      confirmationPresentedAt: new Date().toISOString(),
    });
    await fixture.repository.createDraft(created.conversation.id, {
      ...confirmed.draft,
      instruction: 'Collect names and prices',
      confirmationPresentedAt: null,
    });
    await fixture.repository.updateConversation(created.conversation.id, {
      status: 'awaiting_confirmation',
    });
    await expect(
      fixture.service.commit(created.conversation.id, confirmed.revision),
    ).rejects.toThrow('stale');
    expect(fixture.commit).not.toHaveBeenCalled();
  });

  it('safely resumes a commit left in committing state after a Runtime crash', async () => {
    const fixture = await createFixture();
    const created = await fixture.service.createConversation();
    const confirmed = await fixture.repository.createDraft(created.conversation.id, {
      ...created.draft.draft,
      name: 'Products',
      startUrl: 'https://example.com/products',
      instruction: 'Collect names',
      rule: normalizeCrawlPlan({
        type: 'css',
        container: '.product',
        fields: { name: { selector: '.name', value: 'text', dataType: 'string' } },
      }),
      testMetadata: { recordCount: 1 },
      confirmationPresentedAt: new Date().toISOString(),
    });
    await fixture.repository.updateConversation(created.conversation.id, {
      status: 'committing',
    });

    const result = await fixture.service.commit(created.conversation.id, confirmed.revision);

    expect(result).toMatchObject({ replayed: true, taskId: expect.any(String) });
    expect(fixture.commit).toHaveBeenCalledTimes(1);
    expect((await fixture.repository.getConversation(created.conversation.id))?.status).toBe(
      'committed',
    );
  });

  it('refuses to persist credential-like chat content', async () => {
    const fixture = await createFixture();
    const created = await fixture.service.createConversation();
    await expect(
      fixture.service.postMessage(created.conversation.id, 'password: hunter2'),
    ).rejects.toThrow('Do not enter');
    expect(await fixture.repository.listMessages(created.conversation.id)).toEqual([]);
  });
});

describe('canonical AI draft collaboration', () => {
  it('applies a restricted patch and rejects an AI edit after a manual revision', async () => {
    let canonical: CollectionDraft = {
      id: crypto.randomUUID(),
      revision: 1,
      taskId: null,
      taskRevision: null,
      exampleId: null,
      step: 1,
      mode: 'manual',
      task: {
        name: 'Manual',
        startUrl: 'https://example.com',
        instruction: 'Names',
        outputBindings: ['destination'],
        requestSettings: taskCreateSchema.shape.requestSettings.parse({
          headers: { 'X-Project': 'retained' },
        }),
      },
      definition: null,
      preview: null,
      status: 'editing',
      commitRun: null,
      result: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const patch = vi.fn(async (_id, revision, input) => {
      if (revision !== canonical.revision) throw new Error('Draft revision conflict');
      canonical = {
        ...canonical,
        revision: revision + 1,
        task: { ...canonical.task, ...input.task },
        definition: input.definition,
      };
      return canonical;
    }) as NonNullable<CrawlerAssistantDependencies['drafts']>['patch'];
    const fixture = await createFixture({
      get: async () => canonical,
      patch,
      create: vi.fn(),
      preview: vi.fn(),
      commit: vi.fn(),
    });
    const created = await fixture.service.createConversation(undefined, canonical.id);
    const version = await fixture.repository.createDraft(created.conversation.id, {
      ...created.draft.draft,
      siteCandidates: [
        {
          title: 'Products',
          url: 'https://example.com/products',
          summary: 'Public products',
          source: 'bing',
        },
      ],
    });
    await fixture.service.selectSite(
      created.conversation.id,
      'https://example.com/products',
      version.revision,
    );
    expect(canonical.task).toMatchObject({
      startUrl: 'https://example.com/products',
      outputBindings: ['destination'],
      requestSettings: { headers: { 'X-Project': 'retained' } },
    });
    expect(patch).toHaveBeenLastCalledWith(
      canonical.id,
      1,
      expect.objectContaining({
        task: expect.objectContaining({
          name: 'Manual',
          startUrl: 'https://example.com/products',
          instruction: 'Names',
          pagination: { type: 'none' },
        }),
      }),
    );
    const before = await fixture.repository.getLatestDraft(created.conversation.id);
    canonical = {
      ...canonical,
      revision: canonical.revision + 1,
      task: { ...canonical.task, name: 'Manual wins' },
    };
    await expect(
      fixture.service.selectSite(
        created.conversation.id,
        'https://example.com/products',
        before!.revision,
      ),
    ).rejects.toThrow('revision conflict');
    expect((await fixture.repository.getLatestDraft(created.conversation.id))?.revision).toBe(
      before?.revision,
    );
    expect(canonical.task.name).toBe('Manual wins');
  });
  it('converts a legacy conversation on continuation and keeps the prior messages', async () => {
    const id = crypto.randomUUID();
    const create = vi.fn(
      async (legacy) =>
        ({
          id,
          revision: 1,
          taskId: null,
          taskRevision: null,
          exampleId: null,
          step: 1,
          mode: 'ai',
          task: {
            name: legacy.name,
            startUrl: legacy.startUrl ?? '',
            instruction: legacy.instruction,
          },
          definition: legacy.rule,
          preview: null,
          status: 'editing',
          commitRun: null,
          result: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }) as CollectionDraft,
    );
    const fixture = await createFixture({
      create,
      get: vi.fn(),
      patch: vi.fn(),
      preview: vi.fn(),
      commit: vi.fn(),
    });
    const created = await fixture.service.createConversation();
    await fixture.repository.appendMessage({
      conversationId: created.conversation.id,
      role: 'assistant',
      content: 'Previous context',
    });
    await fixture.service.postMessage(created.conversation.id, 'Continue editing');
    expect(create).toHaveBeenCalledOnce();
    expect(
      (await fixture.repository.getLatestDraft(created.conversation.id))?.draft.collectionDraftId,
    ).toBe(id);
    expect(
      (await fixture.repository.listMessages(created.conversation.id)).map(
        (message) => message.content,
      ),
    ).toContain('Previous context');
  });
});

async function createFixture(drafts?: CrawlerAssistantDependencies['drafts']) {
  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-ai-service-'));
  const filePath = join(directory, 'zhiyun.sqlite3');
  const platform = await openSqlitePlatformRepository({
    dataDirectory: directory,
    filePath,
    graphRevision: 'ai-service-test',
  });
  const repository = new SqliteAiConversationRepository(filePath);
  await repository.migrate();
  const commit = vi.fn(
    async (input: Parameters<CollectionForAiPort['createTaskWithInitialRule']>[0]) => ({
      taskId: input.taskId,
      ruleId: input.ruleId,
      versionId: input.versionId,
    }),
  );
  const collection = { createTaskWithInitialRule: commit } as unknown as CollectionForAiPort;
  const agent = { runTurn: vi.fn() } as unknown as AgentRuntimePort;
  const crawler = { crawl: vi.fn() } as unknown as CrawlerService;
  const jobs = {
    list: async () => [],
    enqueue: vi.fn(),
    cancel: vi.fn(),
  } as unknown as PlatformJobQueue;
  const provider = new ScriptedChatProvider([]);
  const service = new CrawlerAssistantService({
    repository,
    ...(drafts ? { drafts } : {}),
    collection,
    agent,
    provider: () => provider,
    providerConfigured: () => true,
    crawler,
    search: { search: async () => [] },
    jobs,
  });
  cleanups.push(async () => {
    await repository.close();
    await platform.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { service, repository, commit };
}
