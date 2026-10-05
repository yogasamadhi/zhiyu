import type { CollectionDraft, CollectionDraftPatch } from '@zhiyun/contracts';
import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { assertNetworkAllowed, fetchPageSource } from '@zhiyun/crawler-runtime';
import { PlaywrightAdapter } from '@zhiyun/browser-runtime';
import {
  crawlPlanDefinitionSchema,
  paginationSchema,
  scheduleSchema,
  taskCreateSchema,
  type AiProvider,
  type CrawlerService,
} from '@zhiyun/contracts';
import {
  PlatformJobExecutionError,
  type JobExecutionContext,
  type PlatformJobQueue,
} from '@zhiyun/platform-core';
import type {
  AgentRuntimePort,
  AgentRuntimeTool,
  AiConversationRepository,
  CollectionForAiPort,
  WebSearchPort,
} from '../contracts/index.js';
import {
  emptyAiTaskDraft,
  redactAiSensitiveText,
  toSafeTaskCreate,
  type AiConversationStatus,
  type AiTaskDraft,
} from '../domain/index.js';
import { analyzePage } from './analyzer.js';
import { AccountedTurnError } from './cost-accounting.js';
import type { RuleAnalysisCache } from './rule-cache.js';

export interface AiRealtimePublisher {
  publish(type: string, payload: Record<string, unknown>): Promise<void> | void;
}

export interface CrawlerAssistantDependencies {
  repository: AiConversationRepository;
  collection: CollectionForAiPort;
  agent: AgentRuntimePort;
  provider: () => AiProvider;
  providerConfigured: () => boolean;
  crawler: CrawlerService;
  search: WebSearchPort;
  jobs: PlatformJobQueue;
  realtime?: AiRealtimePublisher;
  ruleCache?: RuleAnalysisCache;
  drafts?: {
    get(id: string): Promise<CollectionDraft | null>;
    resolve?(id: string): Promise<ReturnType<typeof taskCreateSchema.parse>>;
    create(legacy: AiTaskDraft, conversationId: string): Promise<CollectionDraft>;
    patch(id: string, revision: number, patch: CollectionDraftPatch): Promise<CollectionDraft>;
    preview(id: string, revision: number, signal?: AbortSignal): Promise<CollectionDraft>;
    commit(id: string, revision: number): Promise<{ taskId: string }>;
  };
}

export class CrawlerAssistantService {
  constructor(private readonly dependencies: CrawlerAssistantDependencies) {}

  async createConversation(title?: string, collectionDraftId?: string) {
    const linked = collectionDraftId
      ? await this.dependencies.drafts?.get(collectionDraftId)
      : null;
    if (collectionDraftId && !linked) throw new Error('Collection draft was not found');
    const conversation = await this.dependencies.repository.createConversation({
      ...(title ? { title } : {}),
    });
    const draft = await this.dependencies.repository.createDraft(
      conversation.id,
      linked ? fromCollectionDraft(linked, emptyAiTaskDraft()) : emptyAiTaskDraft(),
    );
    return { conversation: await this.requireConversation(conversation.id), draft };
  }

  listConversations(cursor?: string, limit?: number) {
    return this.dependencies.repository.listConversations(cursor, limit).then(async (page) => ({
      ...page,
      items: (
        await Promise.all(
          page.items.map(async (item) => {
            const record = await this.dependencies.repository.getAssistantRecord(
              `session:${item.id}`,
            );
            return record?.value.ownerId ? null : item;
          }),
        )
      ).filter((item): item is NonNullable<typeof item> => item !== null),
    }));
  }

  async getConversation(id: string) {
    const [conversation, messages, draft] = await Promise.all([
      this.requireConversation(id),
      this.dependencies.repository.listMessages(id),
      this.dependencies.repository.getLatestDraft(id),
    ]);
    return {
      conversation,
      messages,
      draft,
      providerConfigured: this.dependencies.providerConfigured(),
    };
  }

  async deleteConversation(id: string): Promise<boolean> {
    const conversation = await this.requireConversation(id);
    if (conversation.status === 'committing') throw new Error('Conversation is committing');
    return this.dependencies.repository.deleteConversation(id);
  }

  async archiveConversation(id: string) {
    return this.dependencies.repository.updateConversation(id, {
      status: 'archived',
      archivedAt: new Date().toISOString(),
    });
  }

  async postMessage(conversationId: string, content: string) {
    if (!this.dependencies.providerConfigured()) {
      throw new Error('AI_PROVIDER_NOT_CONFIGURED: Configure and test a Provider before chatting');
    }
    if (containsCredentialValue(content)) {
      throw new Error(
        'Do not enter passwords, API Keys, Cookies, Tokens, or other credentials in chat',
      );
    }
    const conversation = await this.requireConversation(conversationId);
    if (['failed', 'committing', 'committed', 'archived'].includes(conversation.status)) {
      throw new Error(`Conversation cannot accept messages from ${conversation.status}`);
    }
    await this.assertNoActiveTurn(conversationId);
    await this.ensureLinkedDraft(conversationId);
    const turn = await this.dependencies.repository.createTurn({ conversationId });
    const message = await this.dependencies.repository.appendMessage({
      conversationId,
      turnId: turn.id,
      role: 'user',
      content: content.trim().slice(0, 8_000),
    });
    if (conversation.title === '新建 AI 爬虫') {
      await this.dependencies.repository.updateConversation(conversationId, {
        title: content.trim().slice(0, 48) || conversation.title,
        status: 'active',
      });
    }
    await this.enqueueTurn(turn.id, conversationId);
    return { message, turn };
  }

  async selectSite(conversationId: string, url: string, expectedRevision: number) {
    if (!this.dependencies.providerConfigured()) throw new Error('AI_PROVIDER_NOT_CONFIGURED');
    await this.assertNoActiveTurn(conversationId);
    const current = (await this.requireDraftRevision(conversationId, expectedRevision)).draft;
    const selected = current.siteCandidates.find((candidate) => candidate.url === url);
    if (!selected) throw new Error('Site URL must be selected from the current candidate list');
    const draft = await this.persistDraft(
      conversationId,
      {
        ...current,
        startUrl: selected.url,
        selectedSiteUrl: selected.url,
        confirmationPresentedAt: null,
      },
      'draft_ready',
    );
    const turn = await this.dependencies.repository.createTurn({ conversationId });
    await this.dependencies.repository.appendMessage({
      conversationId,
      turnId: turn.id,
      role: 'user',
      content: `我选择站点：${selected.title}（${selected.url}）。请继续分析公开页面。`,
    });
    await this.enqueueTurn(turn.id, conversationId);
    return { draft, turn };
  }

  async testDraft(conversationId: string, expectedRevision: number, signal?: AbortSignal) {
    const current = await this.requireDraftRevision(conversationId, expectedRevision);
    if (!current.draft.rule || !current.draft.startUrl) {
      throw new Error('Draft requires a URL and generated Rule before testing');
    }
    await this.setStatus(conversationId, 'testing');
    if (current.draft.collectionDraftId && this.dependencies.drafts) {
      const linked = await this.dependencies.drafts.preview(
        current.draft.collectionDraftId,
        current.draft.collectionRevision!,
      );
      const draft = fromCollectionDraft(linked, current.draft);
      draft.testMetadata = { recordCount: linked.preview?.records.length ?? 0 };
      const version = await this.dependencies.repository.createDraft(conversationId, draft);
      await this.setStatus(conversationId, 'draft_ready');
      await this.publish('ai.draft.updated', {
        conversationId,
        revision: version.revision,
        draft: version.draft,
      });
      return version;
    }
    const result = await this.dependencies.crawler.crawl({
      url: current.draft.startUrl,
      plan: current.draft.rule,
      requestSettings: safeRequestSettings(),
      browserSettings: {
        enabled: current.draft.browserEnabled,
        waitUntil: 'domcontentloaded',
        actions: [],
      },
      pagination: current.draft.pagination,
      networkPolicy: publicNetworkPolicy(),
      previewLimit: 10,
      ...(signal ? { signal } : {}),
    });
    return this.persistDraft(
      conversationId,
      {
        ...current.draft,
        preview: result.records.slice(0, 10),
        testMetadata: result.metadata,
        confirmationPresentedAt: null,
      },
      'draft_ready',
    );
  }

  async commit(conversationId: string, expectedRevision: number) {
    const conversation = await this.requireConversation(conversationId);
    if (conversation.committedTaskId) {
      return { taskId: conversation.committedTaskId, replayed: true };
    }
    if (!['awaiting_confirmation', 'committing', 'failed'].includes(conversation.status)) {
      throw new Error('Draft is not awaiting confirmation');
    }
    const current = await this.requireDraftRevision(conversationId, expectedRevision);
    if (!current.draft.rule || !current.draft.confirmationPresentedAt) {
      throw new Error('The current Draft revision has no confirmation card');
    }
    if (current.draft.collectionDraftId && this.dependencies.drafts) {
      const result = await this.dependencies.drafts.commit(
        current.draft.collectionDraftId,
        current.draft.collectionRevision!,
      );
      await this.dependencies.repository.updateConversation(conversationId, {
        status: 'committed',
        committedTaskId: result.taskId,
        lastError: null,
      });
      return { ...result, replayed: false };
    }
    const task = taskCreateSchema.parse(toSafeTaskCreate(current.draft));
    const definition = crawlPlanDefinitionSchema.parse(current.draft.rule);
    const taskId = deterministicUuid(`zhiyun:ai-task:${conversationId}`);
    const ruleId = deterministicUuid(`zhiyun:ai-rule:${conversationId}`);
    const versionId = deterministicUuid(`zhiyun:ai-rule-version:${conversationId}:1`);
    await this.setStatus(conversationId, 'committing');
    try {
      await this.dependencies.collection.createTaskWithInitialRule({
        taskId,
        ruleId,
        versionId,
        task,
        ruleName: `${task.name} 初始规则`,
        definition,
        generatedBy: 'ai',
        origin: { kind: 'ai' },
      });
      await this.dependencies.repository.updateConversation(conversationId, {
        status: 'committed',
        committedTaskId: taskId,
        lastError: null,
      });
      return {
        taskId,
        ruleId,
        versionId,
        replayed: conversation.status !== 'awaiting_confirmation',
      };
    } catch (error) {
      await this.dependencies.repository.updateConversation(conversationId, {
        status: 'failed',
        lastError: redactAiSensitiveText(error instanceof Error ? error.message : String(error)),
      });
      throw error;
    }
  }

  async cancelTurn(turnId: string) {
    const turn = await this.dependencies.repository.getTurn(turnId);
    if (!turn) throw new Error('AI Turn was not found');
    await this.requireConversation(turn.conversationId);
    await this.dependencies.jobs.cancel(turnId);
    return this.dependencies.repository.updateTurn(turnId, {
      status: 'canceled',
      finishedAt: new Date().toISOString(),
      error: 'Canceled by user',
    });
  }

  async retryTurn(turnId: string) {
    if (!this.dependencies.providerConfigured()) throw new Error('AI_PROVIDER_NOT_CONFIGURED');
    const previous = await this.dependencies.repository.getTurn(turnId);
    if (!previous) throw new Error('AI Turn was not found');
    await this.requireConversation(previous.conversationId);
    if (!['failed', 'canceled'].includes(previous.status)) {
      throw new Error('Only failed or canceled Turns can be retried');
    }
    await this.assertNoActiveTurn(previous.conversationId);
    const turn = await this.dependencies.repository.createTurn({
      conversationId: previous.conversationId,
      attempt: previous.attempt + 1,
      ...(previous.costBudget ? { costBudget: previous.costBudget } : {}),
    });
    await this.dependencies.repository.updateConversation(previous.conversationId, {
      status: 'active',
      lastError: null,
    });
    await this.enqueueTurn(turn.id, previous.conversationId);
    return turn;
  }

  createTurnJobHandler() {
    return async (context: JobExecutionContext): Promise<void> => {
      const turnId = stringValue(context.job.payload.turnId, 'turnId');
      const conversationId = stringValue(context.job.payload.conversationId, 'conversationId');
      const turn = await this.dependencies.repository.getTurn(turnId);
      if (!turn || turn.conversationId !== conversationId) {
        throw new PlatformJobExecutionError('AI_TURN_NOT_FOUND', 'AI Turn was not found', false);
      }
      if (turn.status !== 'queued') return;
      await this.dependencies.repository.updateTurn(turnId, {
        status: 'running',
        startedAt: new Date().toISOString(),
        error: null,
      });
      await this.publish('ai.turn.status', { conversationId, turnId, status: 'running' });
      const draftVersion = await this.ensureLinkedDraft(conversationId);
      if (!draftVersion) {
        throw new PlatformJobExecutionError('AI_DRAFT_NOT_FOUND', 'AI Draft was not found', false);
      }
      const persistedMessages = await this.dependencies.repository.listMessages(conversationId, 20);
      const messages = persistedMessages
        .filter((message) => message.role !== 'system')
        .map((message) => ({
          role: message.role as 'user' | 'assistant',
          content: message.content,
        }));
      const facts = (
        await Promise.all(
          [
            ...new Set(
              persistedMessages.flatMap((message) => (message.turnId ? [message.turnId] : [])),
            ),
          ]
            .slice(-10)
            .map((id) => this.dependencies.repository.listToolInvocations(id)),
        )
      )
        .flat()
        .filter(
          (invocation) =>
            invocation.status === 'succeeded' &&
            invocation.name === 'inspect_page' &&
            invocation.result,
        )
        .slice(-5)
        .map((invocation) => ({
          name: invocation.name as AgentRuntimeTool['name'],
          result: invocation.result!,
        }));
      const tools = this.createTools(conversationId, turnId, draftVersion.draft);
      const invocations = new Map<string, string>();
      try {
        const result = await this.dependencies.agent.runTurn({
          conversationId,
          turnId,
          costBudget: turn.costBudget ?? null,
          messages,
          facts,
          draft: draftVersion.draft,
          tools,
          signal: context.signal,
          onEvent: async (event) => {
            if (event.type === 'text-delta') {
              await this.publish('ai.turn.delta', {
                conversationId,
                turnId,
                delta: event.delta,
              });
            }
            if (event.type === 'tool-start') {
              const invocation = await this.dependencies.repository.createToolInvocation({
                conversationId,
                turnId,
                toolCallId: event.toolCallId,
                name: event.name,
                arguments: redactStructuredRecord(event.arguments),
              });
              invocations.set(event.toolCallId, invocation.id);
              await this.dependencies.repository.updateToolInvocation(invocation.id, {
                status: 'running',
              });
              await this.publish('ai.tool.status', {
                conversationId,
                turnId,
                toolCallId: event.toolCallId,
                name: event.name,
                status: 'running',
              });
            }
            if (event.type === 'tool-end') {
              const invocationId = invocations.get(event.toolCallId);
              if (invocationId) {
                await this.dependencies.repository.updateToolInvocation(invocationId, {
                  status: event.isError ? 'failed' : 'succeeded',
                  result: redactStructuredRecord(event.result),
                  error: event.isError ? 'Tool execution failed' : null,
                });
              }
              await this.publish('ai.tool.status', {
                conversationId,
                turnId,
                toolCallId: event.toolCallId,
                name: event.name,
                status: event.isError ? 'failed' : 'succeeded',
              });
            }
          },
        });
        await this.dependencies.repository.appendMessage({
          conversationId,
          turnId,
          role: 'assistant',
          content:
            redactAiSensitiveText(result.content.trim()).slice(0, 20_000) ||
            '已更新任务草稿，请查看右侧详情。',
        });
        await this.dependencies.repository.updateTurn(turnId, {
          status: 'succeeded',
          modelRounds: result.modelRounds,
          toolCalls: result.toolCalls,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          ...(result.accounting ? { accounting: result.accounting } : {}),
          finishedAt: new Date().toISOString(),
        });
        await context.progress(1, 'completed');
        await this.publish('ai.turn.status', { conversationId, turnId, status: 'succeeded' });
      } catch (error) {
        const canceled = context.signal.aborted;
        const message = redactAiSensitiveText(
          canceled
            ? 'AI Turn was canceled'
            : error instanceof Error
              ? error.message
              : String(error),
        );
        await this.dependencies.repository.updateTurn(turnId, {
          status: canceled ? 'canceled' : 'failed',
          error: message.slice(0, 2_000),
          ...(error instanceof AccountedTurnError ? { accounting: error.accounting } : {}),
          finishedAt: new Date().toISOString(),
        });
        await this.dependencies.repository.updateConversation(conversationId, {
          status: 'failed',
          lastError: message.slice(0, 2_000),
        });
        await this.publish('ai.turn.status', {
          conversationId,
          turnId,
          status: canceled ? 'canceled' : 'failed',
          error: message.slice(0, 2_000),
        });
        throw new PlatformJobExecutionError(
          canceled ? 'CANCELED' : 'AI_TURN_FAILED',
          message,
          false,
        );
      }
    };
  }

  createTools(
    conversationId: string,
    _turnId: string,
    initialDraft: AiTaskDraft,
  ): AgentRuntimeTool[] {
    let draft = initialDraft;
    let searchUsed = false;
    const save = async (next: AiTaskDraft, status?: AiConversationStatus) => {
      const version = await this.persistDraft(conversationId, next, status);
      draft = version.draft;
      return version;
    };
    return [
      {
        name: 'search_sites',
        description:
          'Search public web results when the user did not provide a URL. One call per Turn.',
        parameters: objectSchema({ query: { type: 'string', minLength: 1, maxLength: 300 } }, [
          'query',
        ]),
        execute: async (args, signal) => {
          if (searchUsed) throw new Error('search_sites can only be called once per Turn');
          if (draft.startUrl) throw new Error('A URL is already available; search is not allowed');
          searchUsed = true;
          const candidates = await this.dependencies.search.search(String(args.query), signal);
          if (candidates.length === 0) {
            return { experimental: true, candidates: [], askForUrl: true };
          }
          await save(
            { ...draft, siteCandidates: candidates, selectedSiteUrl: null },
            'awaiting_site_confirmation',
          );
          return { experimental: true, candidates, selectionRequired: true };
        },
      },
      {
        name: 'inspect_page',
        description: 'Inspect only the public URL explicitly provided or selected by the user.',
        parameters: objectSchema({ url: { type: 'string', format: 'uri' } }, ['url']),
        execute: async (args, signal) => {
          const url = String(args.url);
          if (!draft.startUrl || url !== draft.startUrl) {
            throw new Error('inspect_page URL must equal the user-provided or selected Draft URL');
          }
          if (draft.siteCandidates.length > 0 && draft.selectedSiteUrl !== url) {
            throw new Error('A search candidate must be confirmed before inspection');
          }
          const resolved = draft.collectionDraftId
            ? await this.dependencies.drafts?.resolve?.(draft.collectionDraftId)
            : null;
          const page = resolved?.browserSettings.enabled
            ? await new PlaywrightAdapter().load(url, {
                browser: resolved.browserSettings,
                request: resolved.requestSettings,
                signal,
                allowRequest: (target) => assertNetworkAllowed(target, resolved.networkPolicy),
              })
            : null;
          const source = page
            ? { text: page.html, finalUrl: page.url, contentType: 'text/html' }
            : await fetchPageSource(url, {
                rootUrl: url,
                requestSettings: resolved?.requestSettings ?? safeRequestSettings(),
                networkPolicy: resolved?.networkPolicy ?? publicNetworkPolicy(),
                signal,
              });
          signal.throwIfAborted();
          const $ = cheerio.load(source.text.slice(0, 500_000));
          const loginRequired = detectLoginWall($);
          const title = $('title').first().text().replace(/\s+/g, ' ').trim().slice(0, 200);
          const headings = $('h1,h2,h3')
            .slice(0, 12)
            .map((_index, element) => $(element).text().replace(/\s+/g, ' ').trim().slice(0, 120))
            .get()
            .filter(Boolean);
          await save({
            ...draft,
            startUrl: source.finalUrl,
            selectedSiteUrl: draft.selectedSiteUrl ? source.finalUrl : null,
            loginRequired,
            name: draft.name || title || new URL(source.finalUrl).hostname,
            confirmationPresentedAt: null,
          });
          return {
            url: source.finalUrl,
            title,
            headings,
            contentType: source.contentType,
            loginRequired,
            loginGuidance: loginRequired
              ? 'Open secure login from the draft, then inspect and preview again before creating the task.'
              : null,
          };
        },
      },
      {
        name: 'update_task_draft',
        description:
          'Update safe Task fields and collection intent. Advanced security fields are forbidden.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', maxLength: 120 },
            startUrl: { type: 'string', format: 'uri' },
            instruction: { type: 'string', maxLength: 2000 },
            schedule: { type: 'object' },
            pagination: { type: 'object' },
            browserEnabled: { type: 'boolean' },
            datasetMode: { enum: ['snapshot', 'upsert', 'append'] },
            keyFields: { type: 'array', items: { type: 'string' }, maxItems: 20 },
          },
        },
        execute: async (args) => {
          rejectDangerousDraftKeys(args);
          if (containsCredentialInStructuredValue(args)) {
            throw new Error('Credential-like values are not allowed in an AI Task draft');
          }
          const next: AiTaskDraft = {
            ...draft,
            ...(typeof args.name === 'string' ? { name: args.name.slice(0, 120) } : {}),
            ...(typeof args.startUrl === 'string'
              ? { startUrl: publicUrl(args.startUrl), selectedSiteUrl: null }
              : {}),
            ...(typeof args.instruction === 'string'
              ? { instruction: args.instruction.slice(0, 2_000) }
              : {}),
            ...(args.schedule ? { schedule: scheduleSchema.parse(args.schedule) } : {}),
            ...(args.pagination ? { pagination: paginationSchema.parse(args.pagination) } : {}),
            ...(typeof args.browserEnabled === 'boolean'
              ? { browserEnabled: args.browserEnabled }
              : {}),
            ...(typeof args.datasetMode === 'string' &&
            ['snapshot', 'upsert', 'append'].includes(args.datasetMode)
              ? { datasetMode: args.datasetMode as AiTaskDraft['datasetMode'] }
              : {}),
            ...(Array.isArray(args.keyFields)
              ? {
                  keyFields: args.keyFields
                    .filter((item): item is string => typeof item === 'string')
                    .slice(0, 20),
                }
              : {}),
            confirmationPresentedAt: null,
          };
          const version = await save(next, next.startUrl ? 'draft_ready' : 'active');
          return { revision: version.revision, draft: version.draft };
        },
      },
      {
        name: 'generate_rule',
        description: 'Generate a typed CrawlPlan for the current confirmed public page.',
        parameters: objectSchema({}, []),
        execute: async (_args, signal) => {
          if (!draft.startUrl || !draft.instruction.trim()) {
            throw new Error('URL and collection instruction are required before rule generation');
          }
          if (signal.aborted) throw signal.reason;
          const resolved = draft.collectionDraftId
            ? await this.dependencies.drafts?.resolve?.(draft.collectionDraftId)
            : null;
          const result = await analyzePage(
            {
              url: draft.startUrl,
              cacheScope: draft.collectionDraftId
                ? `draft:${draft.collectionDraftId}`
                : `conversation:${conversationId}`,
              instruction: draft.instruction,
              signal,
              requestSettings: resolved?.requestSettings ?? safeRequestSettings(),
              browserSettings: resolved?.browserSettings ?? {
                enabled: draft.browserEnabled,
                waitUntil: 'domcontentloaded',
                actions: [],
              },
              pagination: draft.pagination,
              datasetSettings: resolved?.datasetSettings ?? {
                mode: draft.datasetMode,
                keyFields: draft.keyFields,
                detectRemoved: true,
              },
              useAi: true,
              forceBrowser: draft.browserEnabled,
              networkPolicy: resolved?.networkPolicy ?? publicNetworkPolicy(),
            } as Parameters<typeof analyzePage>[0],
            this.dependencies.provider(),
            this.dependencies.ruleCache,
          );
          signal.throwIfAborted();
          const version = await save(
            {
              ...draft,
              startUrl: result.sourceUrl,
              rule: result.candidate,
              preview: [],
              testMetadata: null,
              confirmationPresentedAt: null,
            },
            'draft_ready',
          );
          return {
            revision: version.revision,
            engine: result.engine,
            warnings: result.warnings,
            cache: result.cache,
            actionCache: result.actionCache,
            rule: result.candidate,
          };
        },
      },
      {
        name: 'test_rule',
        description: 'Test the current CrawlPlan and retain at most 10 preview records.',
        parameters: objectSchema({}, []),
        execute: async (_args, signal) => {
          if (!draft.startUrl || !draft.rule) throw new Error('A generated Rule is required');
          if (draft.collectionDraftId && this.dependencies.drafts) {
            const linked = await this.dependencies.drafts.preview(
              draft.collectionDraftId,
              draft.collectionRevision!,
              signal,
            );
            draft = fromCollectionDraft(linked, draft);
            const version = await this.dependencies.repository.createDraft(conversationId, draft);
            await this.publish('ai.draft.updated', {
              conversationId,
              revision: version.revision,
              draft: version.draft,
            });
            return {
              revision: version.revision,
              preview: draft.preview,
              metadata: draft.testMetadata,
            };
          }
          await this.setStatus(conversationId, 'testing');
          const result = await this.dependencies.crawler.crawl({
            url: draft.startUrl,
            plan: draft.rule,
            requestSettings: safeRequestSettings(),
            browserSettings: {
              enabled: draft.browserEnabled,
              waitUntil: 'domcontentloaded',
              actions: [],
            },
            pagination: draft.pagination,
            networkPolicy: publicNetworkPolicy(),
            previewLimit: 10,
            signal,
          });
          const version = await save(
            {
              ...draft,
              preview: result.records.slice(0, 10),
              testMetadata: result.metadata,
              confirmationPresentedAt: null,
            },
            'draft_ready',
          );
          return {
            revision: version.revision,
            preview: version.draft.preview,
            metadata: version.draft.testMetadata,
          };
        },
      },
      {
        name: 'present_draft',
        description:
          'Lock the current tested draft revision and display a confirmation card. Never creates a Task.',
        parameters: objectSchema({}, []),
        execute: async () => {
          if (!draft.rule || !draft.startUrl) throw new Error('Draft requires a URL and Rule');
          if (!draft.testMetadata) throw new Error('Draft Rule must be tested before confirmation');
          const version = await save(
            { ...draft, confirmationPresentedAt: new Date().toISOString() },
            'awaiting_confirmation',
          );
          return {
            revision: version.revision,
            confirmationRequired: true,
            commitByButtonOnly: true,
          };
        },
      },
    ];
  }

  private async ensureLinkedDraft(conversationId: string) {
    const previous = await this.dependencies.repository.getLatestDraft(conversationId);
    if (!previous || !this.dependencies.drafts) return previous;
    const linked = previous.draft.collectionDraftId
      ? await this.dependencies.drafts.get(previous.draft.collectionDraftId)
      : await this.dependencies.drafts.create(previous.draft, conversationId);
    if (!linked) throw new Error('Collection draft was deleted');
    if (linked.status !== 'editing') throw new Error('Collection draft is already submitted');
    const draft = fromCollectionDraft(linked, previous.draft);
    return this.dependencies.repository.createDraft(conversationId, draft);
  }

  private async persistDraft(
    conversationId: string,
    draft: AiTaskDraft,
    status?: AiConversationStatus,
  ) {
    if (
      !draft.collectionDraftId &&
      this.dependencies.drafts &&
      status !== 'awaiting_site_confirmation'
    ) {
      const linked = await this.dependencies.drafts.create(draft, conversationId);
      draft = fromCollectionDraft(linked, draft);
    }
    if (draft.collectionDraftId && this.dependencies.drafts) {
      const current = await this.dependencies.drafts.get(draft.collectionDraftId);
      const baseline = current ? fromCollectionDraft(current, emptyAiTaskDraft()) : null;
      const linked = await this.dependencies.drafts.patch(
        draft.collectionDraftId,
        draft.collectionRevision!,
        {
          task: {
            name: draft.name,
            startUrl: draft.startUrl ?? '',
            instruction: draft.instruction,
            pagination: draft.pagination,
            ...(JSON.stringify(scheduleSchema.parse(draft.schedule)) !==
            JSON.stringify(scheduleSchema.parse(baseline?.schedule ?? { type: 'manual' }))
              ? { schedule: draft.schedule }
              : {}),
            ...(draft.browserEnabled !== baseline?.browserEnabled
              ? {
                  browserSettings: {
                    waitUntil: 'domcontentloaded',
                    actions: [],
                    ...current?.task.browserSettings,
                    enabled: draft.browserEnabled,
                  },
                }
              : {}),
            ...(draft.datasetMode !== baseline?.datasetMode ||
            JSON.stringify(draft.keyFields) !== JSON.stringify(baseline?.keyFields)
              ? {
                  datasetSettings: {
                    detectRemoved: true,
                    ...current?.task.datasetSettings,
                    mode: draft.datasetMode,
                    keyFields: draft.keyFields,
                  },
                }
              : {}),
          },
          definition: draft.rule,
        },
      );
      draft = fromCollectionDraft(linked, draft);
    }
    const version = await this.dependencies.repository.createDraft(conversationId, draft);
    if (status) await this.setStatus(conversationId, status);
    await this.publish('ai.draft.updated', {
      conversationId,
      revision: version.revision,
      draft: version.draft,
    });
    return version;
  }

  private async setStatus(conversationId: string, status: AiConversationStatus): Promise<void> {
    await this.dependencies.repository.updateConversation(conversationId, { status });
  }

  private async enqueueTurn(turnId: string, conversationId: string): Promise<void> {
    await this.dependencies.jobs.enqueue({
      id: turnId,
      ownerPluginId: 'ai-assistance',
      type: 'ai.conversation.turn',
      resourceClass: 'browser-heavy',
      payload: { turnId, conversationId },
      maxAttempts: 1,
    });
    await this.publish('ai.turn.status', { conversationId, turnId, status: 'queued' });
  }

  private async assertNoActiveTurn(conversationId: string): Promise<void> {
    const jobs = await this.dependencies.jobs.list({ ownerPluginId: 'ai-assistance', limit: 100 });
    if (
      jobs.some(
        (job) =>
          job.payload.conversationId === conversationId &&
          ['queued', 'claimed', 'running', 'persisting', 'canceling'].includes(job.state),
      )
    ) {
      throw new Error('Conversation already has an active Turn');
    }
  }

  private async requireConversation(id: string) {
    const record = await this.dependencies.repository.getAssistantRecord(`session:${id}`);
    if (record?.value.ownerId) throw new Error('AI Conversation was not found');
    const value = await this.dependencies.repository.getConversation(id);
    if (!value) throw new Error(`AI Conversation ${id} was not found`);
    return value;
  }

  private async requireDraftRevision(id: string, revision: number) {
    const value = await this.dependencies.repository.getLatestDraft(id);
    if (!value) throw new Error('AI Draft was not found');
    if (value.revision !== revision) throw new Error('Draft revision is stale');
    return value;
  }

  private async publish(type: string, payload: Record<string, unknown>): Promise<void> {
    await this.dependencies.realtime?.publish(type, payload);
  }
}

function safeRequestSettings() {
  return {
    headers: {},
    cookies: [],
    timeoutMs: 30_000,
    retries: 1,
    retryBackoffMs: 1_000,
    concurrency: 2,
    delayMs: 500,
    maxRequests: 100,
    maxRuntimeMs: 120_000,
    domainRateLimitPerMinute: 60,
    respectRobotsTxt: true,
    maxResponseBytes: 10 * 1024 * 1024,
    redirectLimit: 5,
    userAgent: 'Mozilla/5.0 (compatible; ZhiYun/1.0; crawler-assistant-preview)',
  };
}

function publicNetworkPolicy() {
  return { allowPrivateNetworks: false, allowedHosts: [], allowedCidrs: [] };
}

function publicUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are allowed');
  if (
    [...url.searchParams.keys()].some((key) =>
      /token|key|secret|password|auth|cookie|signature/i.test(key),
    )
  ) {
    throw new Error('URLs containing credential-like query parameters are not allowed');
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  return url.toString();
}

function rejectDangerousDraftKeys(value: Record<string, unknown>): void {
  const forbidden =
    /^(?:headers?|cookies?|proxy|credential|secret|token|password|outputbindings|allowprivatenetworks|respectrobotstxt)$/i;
  const hasForbiddenKey = (input: unknown): boolean => {
    if (Array.isArray(input)) return input.some(hasForbiddenKey);
    if (!input || typeof input !== 'object') return false;
    return Object.entries(input).some(
      ([key, item]) => forbidden.test(key) || hasForbiddenKey(item),
    );
  };
  if (hasForbiddenKey(value)) {
    throw new Error('Advanced credentials, network, output, and robots fields are not allowed');
  }
}

export function containsCredentialValue(value: string): boolean {
  return (
    /(?:password|passwd|密码|cookie|token|api[-_ ]?key|authorization)\s*[:=：]\s*\S+/i.test(
      value,
    ) || /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i.test(value)
  );
}

function containsCredentialInStructuredValue(value: unknown): boolean {
  if (typeof value === 'string') return containsCredentialValue(value);
  if (Array.isArray(value)) return value.some(containsCredentialInStructuredValue);
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(containsCredentialInStructuredValue);
}

export function redactStructuredRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sanitize = (item: unknown, key?: string): unknown => {
    if (key && /token|key|secret|password|authorization|cookie|credential/i.test(key)) {
      return '[REDACTED]';
    }
    if (typeof item === 'string') return redactAiSensitiveText(item);
    if (Array.isArray(item)) return item.map((entry) => sanitize(entry));
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(
      Object.entries(item).map(([entryKey, entry]) => [entryKey, sanitize(entry, entryKey)]),
    );
  };
  return sanitize(value) as Record<string, unknown>;
}

function detectLoginWall($: cheerio.CheerioAPI): boolean {
  const text = $('body').text().replace(/\s+/g, ' ').slice(0, 20_000);
  const passwordField = $('input[type="password"]').length > 0;
  const loginLanguage =
    /(?:登录后|请登录|账号登录|sign\s*in|log\s*in|authentication required)/i.test(text);
  const usefulContent = $('article,.item,.product-card,main p').length;
  return passwordField || (loginLanguage && usefulContent < 2);
}

function objectSchema(properties: Record<string, unknown>, required: string[]) {
  return { type: 'object', additionalProperties: false, properties, required };
}

function deterministicUuid(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stringValue(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) {
    throw new PlatformJobExecutionError('AI_TURN_INVALID', `Missing ${name}`, false);
  }
  return value;
}

export function fromCollectionDraft(source: CollectionDraft, previous: AiTaskDraft): AiTaskDraft {
  return {
    ...previous,
    collectionDraftId: source.id,
    collectionRevision: source.revision,
    name: source.task.name ?? '',
    startUrl: source.task.startUrl || null,
    instruction: source.task.instruction ?? '',
    schedule: source.task.schedule ?? previous.schedule,
    pagination: source.task.pagination ?? previous.pagination,
    browserEnabled: source.task.browserSettings?.enabled ?? false,
    datasetMode: source.task.datasetSettings?.mode ?? previous.datasetMode,
    keyFields: source.task.datasetSettings?.keyFields ?? previous.keyFields,
    rule: source.definition,
    preview: source.preview?.records ?? [],
    testMetadata: source.preview
      ? (previous.testMetadata ?? { recordCount: source.preview.records.length })
      : null,
    confirmationPresentedAt: source.preview ? previous.confirmationPresentedAt : null,
  };
}
