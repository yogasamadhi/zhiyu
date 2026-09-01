import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAiProvider } from '@zhiyun/ai-runtime';
import { LocalArtifactStore } from '@zhiyun/artifact-store';
import type { CrawlerService } from '@zhiyun/contracts';
import { AesCredentialStore } from '@zhiyun/platform';
import { JobHandlerRegistry } from '@zhiyun/platform-core';
import { SqliteAnalysisRepository } from '@zhiyun/plugin-analytics';
import { SqliteAiConversationRepository } from '@zhiyun/plugin-ai-assistance';
import { SqliteCollectionRepository } from '@zhiyun/plugin-collection';
import { SqliteCorpusRepository } from '@zhiyun/plugin-corpus';
import { SqliteDatasetRepository } from '@zhiyun/plugin-datasets';
import {
  defaultQualityPolicy,
  monitoringEvaluationJobId,
  SqliteMonitoringRepository,
} from '@zhiyun/plugin-monitoring';
import { SqliteOutputRepository } from '@zhiyun/plugin-outputs';
import { SqlitePreferencesRepository } from '@zhiyun/plugin-preferences';
import { SqliteRecruitmentRepository } from '@zhiyun/plugin-recruitment';
import { resolveProductGraph } from '@zhiyun/product-profiles';
import { LocalPlatformJobQueue } from '@zhiyun/queue-local-v1';
import { openSqlitePlatformRepository } from '@zhiyun/storage-sqlite-v1';
import { buildLevel2Runtime, openApiDocument, type Level2Runtime } from '../src/index.js';

const runtimes: Level2Runtime[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.close();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('Level 2 Runtime composition', () => {
  it('starts the immutable graph and runs Collection into an independent Dataset', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zhiyun-level2-runtime-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'zhiyun.sqlite3');
    const graph = resolveProductGraph('test');
    const platform = await openSqlitePlatformRepository({
      dataDirectory: directory,
      filePath: databasePath,
      graphRevision: graph.revision,
    });
    const repositories = {
      platform,
      datasets: new SqliteDatasetRepository(databasePath),
      collection: new SqliteCollectionRepository(databasePath),
      outputs: new SqliteOutputRepository(databasePath),
      preferences: new SqlitePreferencesRepository(databasePath),
      recruitment: new SqliteRecruitmentRepository(databasePath),
      analytics: new SqliteAnalysisRepository(databasePath),
      corpus: new SqliteCorpusRepository(databasePath),
      aiAssistance: new SqliteAiConversationRepository(databasePath),
      monitoring: new SqliteMonitoringRepository(databasePath),
    };
    const handlers = new JobHandlerRegistry();
    const jobs = new LocalPlatformJobQueue(platform, handlers, { pollIntervalMs: 60_000 });
    let retryFailuresRemaining = 0;
    let emptyNextRun = false;
    let qualityNotificationFailuresRemaining = 0;
    const crawler: CrawlerService = {
      async crawl(input) {
        if (input.url.includes('/retry-items') && retryFailuresRemaining > 0) {
          retryFailuresRemaining -= 1;
          throw new Error('temporary upstream failure');
        }
        const records =
          input.url.includes('/items') && emptyNextRun
            ? []
            : [
                {
                  sourceUrl: 'https://example.com/items/1',
                  data: { id: 'item-1', name: 'Level 2 fixture', score: 9.5 },
                },
              ];
        emptyNextRun = false;
        return {
          records,
          metadata: {
            requestCount: 1,
            recordCount: records.length,
            browserUsed: false,
            aiUsed: false,
          },
        };
      },
    };
    const runtime = await buildLevel2Runtime(
      {
        repositories,
        handlers,
        jobs,
        crawler,
        ai: createAiProvider(),
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
          async notify(title) {
            if (title === '织云任务需要关注' && qualityNotificationFailuresRemaining > 0) {
              qualityNotificationFailuresRemaining -= 1;
              throw new Error('injected quality notifier failure');
            }
          },
        },
      },
      {
        sessionNonce: 'level2-test-nonce',
        profileId: 'test',
        allowedOrigins: ['app://zhiyun'],
        logger: false,
      },
    );
    runtimes.push(runtime);
    await runtime.app.ready();

    const health = await runtime.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
    const readiness = await runtime.app.inject({ method: 'GET', url: '/ready' });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toMatchObject({
      status: 'ready',
      checks: {
        database: { status: 'ok' },
        redis: { status: 'ok', applicability: 'not-applicable' },
        queue: { status: 'ok', implementation: 'local' },
        browser: { status: 'ok' },
        analyticsWorker: { status: 'degraded', workerStatus: 'unavailable' },
      },
    });

    expect(runtime.graph.pluginIds).toEqual(
      expect.arrayContaining(['platform', 'collection', 'datasets', 'analytics', 'corpus']),
    );
    expect(runtime.graph.pluginIds).not.toContain('legacy.runtime');

    const session = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/session',
      payload: { nonce: 'level2-test-nonce' },
    });
    expect(session.statusCode).toBe(200);
    expect(session.headers['x-runtime-generation']).toBe('1');
    const authorization = { authorization: `Bearer ${session.json().token as string}` };

    const replay = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/session',
      payload: { nonce: 'level2-test-nonce' },
    });
    expect(replay.statusCode).toBe(401);

    const unauthenticated = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/tasks',
      headers: {
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers['content-type']).toContain('application/problem+json');
    expect(unauthenticated.headers['x-trace-id']).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(unauthenticated.json()).toMatchObject({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    });

    const updatePreflight = await runtime.app.inject({
      method: 'OPTIONS',
      url: '/api/v2/tasks/example',
      headers: {
        origin: 'app://zhiyun',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'authorization,content-type,if-match,idempotency-key',
      },
    });
    expect(updatePreflight.statusCode).toBe(204);
    expect(updatePreflight.headers['access-control-allow-methods']).toContain('PUT');

    const graphResponse = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/runtime/graph',
      headers: authorization,
    });
    expect(graphResponse.statusCode).toBe(200);
    expect(graphResponse.json()).toMatchObject({
      profileId: 'test',
      graphRevision: graph.revision,
    });
    expect(graphResponse.json().uiContributions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'ai-assistance.crawler-assistant-route' }),
        expect.objectContaining({ id: 'ai-assistance.crawler-assistant-navigation' }),
      ]),
    );

    const providerSettings = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/ai/provider',
      headers: authorization,
    });
    expect(providerSettings.statusCode).toBe(200);
    expect(providerSettings.headers.etag).toBe('"1"');
    expect(providerSettings.json()).toMatchObject({
      configured: false,
      apiKeyConfigured: false,
      writable: true,
      source: 'mock',
      catalogUpdatedAt: '2026-08-29',
      catalog: expect.arrayContaining([
        expect.objectContaining({
          id: 'openai',
          baseUrl: 'https://api.openai.com/v1',
        }),
        expect.objectContaining({
          id: 'deepseek',
          baseUrl: 'https://api.deepseek.com',
        }),
      ]),
    });
    expect(providerSettings.body).not.toContain('apiKeyRef');

    const conversationKey = crypto.randomUUID();
    const conversationResponse = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/crawler-assistant/conversations',
      headers: { ...authorization, 'idempotency-key': conversationKey },
      payload: { title: 'HTTP contract fixture' },
    });
    expect(conversationResponse.statusCode).toBe(201);
    expect(conversationResponse.headers.etag).toBe('"1"');
    const conversationId = conversationResponse.json().conversation.id as string;
    const conversationReplay = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/crawler-assistant/conversations',
      headers: { ...authorization, 'idempotency-key': conversationKey },
      payload: { title: 'HTTP contract fixture' },
    });
    expect(conversationReplay.json().conversation.id).toBe(conversationId);
    const disabledMessage = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/crawler-assistant/conversations/${conversationId}/messages`,
      headers: { ...authorization, 'idempotency-key': crypto.randomUUID() },
      payload: { content: 'Collect public products' },
    });
    expect(disabledMessage.statusCode).toBe(503);
    expect(disabledMessage.json()).toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });

    const missingDraftEtag = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/crawler-assistant/conversations/${conversationId}/draft/test`,
      headers: { ...authorization, 'idempotency-key': crypto.randomUUID() },
    });
    expect(missingDraftEtag.statusCode).toBe(428);
    expect(missingDraftEtag.headers['content-type']).toContain('application/problem+json');

    const initialTask = {
      name: 'Previewed task',
      startUrl: 'https://example.com/previewed-items',
      instruction: 'Collect previewed fixture items',
    };
    const initialDefinition = {
      type: 'json',
      container: '$.items',
      fields: { id: { path: '$.id', dataType: 'string' } },
    };
    const previewKey = crypto.randomUUID();
    const draftCreation = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/tasks/initialize',
      headers: { ...authorization, 'idempotency-key': crypto.randomUUID() },
      payload: {
        task: { ...initialTask, name: 'Untested draft' },
        definition: initialDefinition,
        ruleName: 'Draft rule',
        saveAsDraft: true,
      },
    });
    expect(draftCreation.statusCode).toBe(201);
    expect(draftCreation.json()).toMatchObject({
      task: {
        status: 'draft',
        origin: { kind: 'manual' },
        activeRule: { rule: { name: 'Draft rule' } },
      },
      run: null,
    });
    const initialPreview = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/rules/preview',
      headers: { ...authorization, 'idempotency-key': previewKey },
      payload: { task: initialTask, definition: initialDefinition },
    });
    expect(initialPreview.statusCode).toBe(200);
    expect(initialPreview.json()).toMatchObject({
      previewKey,
      records: [expect.objectContaining({ data: expect.objectContaining({ id: 'item-1' }) })],
    });

    const templateInstantiation = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/task-templates/list-page/instantiate',
      headers: { ...authorization, 'idempotency-key': crypto.randomUUID() },
      payload: {
        task: initialTask,
        definition: initialDefinition,
        previewKey,
        parameters: {
          container: '.item',
          titleSelector: '.title',
          linkSelector: 'a',
        },
      },
    });
    expect(templateInstantiation.statusCode).toBe(201);
    expect(templateInstantiation.json()).toMatchObject({
      status: 'ready',
      origin: { kind: 'template', templateId: 'list-page', templateVersion: 1 },
      activeRule: { rule: { name: '普通列表页规则' } },
    });

    const unsafeTemplateInstantiation = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/task-templates/list-page/instantiate',
      headers: { ...authorization, 'idempotency-key': crypto.randomUUID() },
      payload: {
        task: {
          ...initialTask,
          name: 'Unsafe template task',
          requestSettings: { headers: { authorization: 'Bearer must-not-persist' } },
        },
        definition: initialDefinition,
        previewKey,
        parameters: {
          container: '.item',
          titleSelector: '.title',
          linkSelector: 'a',
        },
      },
    });
    expect(unsafeTemplateInstantiation.statusCode).toBe(400);
    expect(JSON.stringify(unsafeTemplateInstantiation.json())).not.toContain('must-not-persist');

    const mismatchedInitialCreation = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/tasks/initialize',
      headers: { ...authorization, 'idempotency-key': crypto.randomUUID() },
      payload: {
        task: { ...initialTask, instruction: 'A changed instruction' },
        definition: initialDefinition,
        previewKey,
      },
    });
    expect(mismatchedInitialCreation.statusCode).toBe(409);
    expect(mismatchedInitialCreation.json()).toMatchObject({
      code: 'SUCCESSFUL_PREVIEW_REQUIRED',
    });

    const initialCreationKey = crypto.randomUUID();
    const initialCreation = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/tasks/initialize',
      headers: { ...authorization, 'idempotency-key': initialCreationKey },
      payload: {
        task: initialTask,
        definition: initialDefinition,
        previewKey,
        ruleName: 'Previewed rule',
        runAfterCreate: false,
      },
    });
    expect(initialCreation.statusCode).toBe(201);
    expect(initialCreation.json()).toMatchObject({
      task: {
        status: 'ready',
        origin: { kind: 'manual' },
        activeRule: { rule: { name: 'Previewed rule' } },
      },
      run: null,
    });
    const initialCreationReplay = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/tasks/initialize',
      headers: { ...authorization, 'idempotency-key': initialCreationKey },
      payload: {
        task: initialTask,
        definition: initialDefinition,
        previewKey,
        ruleName: 'Previewed rule',
        runAfterCreate: false,
      },
    });
    expect(initialCreationReplay.json()).toEqual(initialCreation.json());

    const taskResponse = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/tasks',
      headers: { ...authorization, 'idempotency-key': crypto.randomUUID() },
      payload: {
        name: 'Level 2 task',
        startUrl: 'https://example.com/items',
        instruction: 'Collect the fixture items',
      },
    });
    expect(taskResponse.statusCode).toBe(201);
    const taskId = taskResponse.json().id as string;

    const ruleResponse = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${taskId}/rules`,
      headers: { ...authorization, 'idempotency-key': crypto.randomUUID() },
      payload: {
        name: 'Fixture rule',
        definition: {
          type: 'json',
          container: '$.items',
          fields: { id: { path: '$.id', dataType: 'string' } },
        },
      },
    });
    expect(ruleResponse.statusCode).toBe(201);

    const eventOnlyDestination = await repositories.outputs.createDestination({
      name: 'Failure notifications only',
      type: 'webhook',
      config: {
        url: 'https://example.com/failure-events',
        events: ['run.failed', 'quality.issue.detected'],
      },
      credentialRef: null,
      enabled: true,
    });
    await repositories.outputs.replaceTaskBindings(taskId, [eventOnlyDestination.id]);

    const queued = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${taskId}/runs`,
      headers: { ...authorization, 'idempotency-key': crypto.randomUUID() },
    });
    expect(queued.statusCode).toBe(202);
    await jobs.dispatchOnce();

    const runResponse = await runtime.app.inject({
      method: 'GET',
      url: `/api/v2/runs/${queued.json().runId as string}`,
      headers: authorization,
    });
    expect(runResponse.json()).toMatchObject({ status: 'succeeded', recordCount: 1 });
    expect(await repositories.outputs.listDeliveryAttempts(queued.json().runId as string)).toEqual(
      [],
    );
    expect(
      await repositories.monitoring.getEvaluationByRun(queued.json().runId as string),
    ).toBeNull();
    expect(await jobs.get(monitoringEvaluationJobId(queued.json().runId as string))).toMatchObject({
      state: 'queued',
      type: 'monitoring.quality.evaluate',
    });
    await jobs.dispatchOnce();
    expect(
      await repositories.monitoring.getEvaluationByRun(queued.json().runId as string),
    ).toMatchObject({
      status: 'unknown',
      issues: [],
    });

    await repositories.outputs.replaceTaskBindings(taskId, []);
    await repositories.monitoring.upsertPolicy(taskId, {
      ...defaultQualityPolicy,
      minimumBaselineRuns: 1,
    });
    emptyNextRun = true;
    qualityNotificationFailuresRemaining = 1;
    const qualityRetryResponse = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${taskId}/runs`,
      headers: { ...authorization, 'idempotency-key': crypto.randomUUID() },
    });
    const qualityRetryRunId = qualityRetryResponse.json().runId as string;
    await jobs.dispatchOnce();
    expect(await repositories.collection.getRun(qualityRetryRunId)).toMatchObject({
      status: 'succeeded',
      recordCount: 0,
    });
    expect(await repositories.monitoring.getEvaluationByRun(qualityRetryRunId)).toBeNull();

    await jobs.dispatchOnce();
    const failedQualityJob = await jobs.get(monitoringEvaluationJobId(qualityRetryRunId));
    const pendingQualityNotification =
      await repositories.monitoring.getPendingNotificationByRun(qualityRetryRunId);
    expect(failedQualityJob).toMatchObject({
      state: 'queued',
      attempt: 1,
      error: { message: expect.stringContaining('injected quality notifier failure') },
    });
    expect(await repositories.monitoring.getEvaluationByRun(qualityRetryRunId)).toMatchObject({
      status: 'warning',
      issues: expect.arrayContaining([expect.objectContaining({ kind: 'empty-result' })]),
    });
    expect(pendingQualityNotification).toMatchObject({
      type: 'quality.issue.detected',
      taskId,
      runId: qualityRetryRunId,
    });
    expect(
      (await repositories.platform.listEvents(0, 1_000)).filter(
        (event) =>
          event.type === 'quality.issue.detected' && event.payload.runId === qualityRetryRunId,
      ),
    ).toEqual([expect.objectContaining({ id: pendingQualityNotification?.eventId })]);

    await new Promise((resolve) => setTimeout(resolve, 1_050));
    await jobs.dispatchOnce();
    expect(await jobs.get(monitoringEvaluationJobId(qualityRetryRunId))).toMatchObject({
      state: 'succeeded',
      attempt: 2,
    });
    expect(await repositories.monitoring.getPendingNotificationByRun(qualityRetryRunId)).toBeNull();
    expect(
      (await repositories.platform.listEvents(0, 1_000)).filter(
        (event) =>
          event.type === 'quality.issue.detected' && event.payload.runId === qualityRetryRunId,
      ),
    ).toHaveLength(1);

    const retryTaskResponse = await runtime.app.inject({
      method: 'POST',
      url: '/api/v2/tasks',
      headers: { ...authorization, 'idempotency-key': crypto.randomUUID() },
      payload: {
        name: 'Retrying task',
        startUrl: 'https://example.com/retry-items',
        instruction: 'Retry one transient failure',
      },
    });
    const retryTaskId = retryTaskResponse.json().id as string;
    await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${retryTaskId}/rules`,
      headers: { ...authorization, 'idempotency-key': crypto.randomUUID() },
      payload: {
        name: 'Retry rule',
        definition: initialDefinition,
      },
    });
    await repositories.outputs.replaceTaskBindings(retryTaskId, [eventOnlyDestination.id]);
    const retryRunResponse = await runtime.app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${retryTaskId}/runs`,
      headers: { ...authorization, 'idempotency-key': crypto.randomUUID() },
    });
    const retryRunId = retryRunResponse.json().runId as string;
    retryFailuresRemaining = 1;
    await jobs.dispatchOnce();
    expect(await repositories.collection.getRun(retryRunId)).toMatchObject({ status: 'failed' });
    expect(await repositories.monitoring.getEvaluationByRun(retryRunId)).toBeNull();
    expect(
      (await repositories.platform.listEvents(0, 1_000)).filter(
        (event) => event.type === 'run.failed' && event.payload.runId === retryRunId,
      ),
    ).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 1_050));
    await jobs.dispatchOnce();
    expect(await repositories.collection.getRun(retryRunId)).toMatchObject({
      status: 'succeeded',
    });
    expect(await repositories.monitoring.getEvaluationByRun(retryRunId)).toBeNull();
    expect(await jobs.get(monitoringEvaluationJobId(retryRunId))).toMatchObject({
      state: 'queued',
      type: 'monitoring.quality.evaluate',
    });
    await jobs.dispatchOnce();
    expect(await repositories.monitoring.getEvaluationByRun(retryRunId)).toMatchObject({
      status: 'unknown',
      issues: [],
    });
    expect(await repositories.monitoring.getHealth(retryTaskId)).not.toMatchObject({
      status: 'failing',
    });

    const datasets = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/datasets',
      headers: authorization,
    });
    expect(datasets.statusCode).toBe(200);
    expect(datasets.json().items).toHaveLength(2);
    expect(datasets.json().items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceTaskId: taskId, currentCount: 0 }),
        expect.objectContaining({ sourceTaskId: retryTaskId, currentCount: 1 }),
      ]),
    );

    const analytics = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/analytics/methods',
      headers: authorization,
    });
    expect(analytics.statusCode).toBe(503);
    expect(analytics.json()).toMatchObject({ code: 'ANALYTICS_UNAVAILABLE' });

    const legacy = await runtime.app.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: authorization,
    });
    expect(legacy.statusCode).toBe(404);
    expect(legacy.headers['content-type']).toContain('application/problem+json');

    const redacted = await runtime.app.inject({
      method: 'GET',
      url: '/api/v2/does-not-exist?token=do-not-leak&query=visible',
      headers: authorization,
    });
    expect(redacted.statusCode).toBe(404);
    expect(redacted.body).not.toContain('do-not-leak');
    expect(redacted.json()).toMatchObject({
      code: 'NOT_FOUND',
      instance: expect.stringContaining('query=visible'),
      traceId: expect.any(String),
    });
  });
});
