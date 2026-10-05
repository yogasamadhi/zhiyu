import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { MockAiProvider } from '@zhiyun/ai-runtime';
import { cacheDigest } from '@zhiyun/plugin-ai-assistance';
import { normalizeCrawlPlan, diagnosticRecovery } from '@zhiyun/contracts';
import { createProductRuntimeFixture } from './support/product-runtime.js';

describe('action cache in actual Collection jobs', () => {
  it('validates list and detail stages, replays current data, clears their owner and reports failed state', async () => {
    let name = 'First';
    let wrongAction = false;
    let wrongEffects = 0;
    const server = createServer((request, response) => {
      if (request.url === '/wrong-effect') {
        wrongEffects++;
        response.end('ok');
        return;
      }
      response.setHeader('content-type', 'text/html');
      const detail = request.url?.startsWith('/detail/');
      response.end(
        detail
          ? `<main><button id="reveal" onclick="document.querySelector('#details').hidden=false">Reveal</button><section id="details" hidden><p>${name} detail ${request.url?.slice(-1)}</p></section></main>`
          : `<main><input id="search"><button id="expand" onclick="${wrongAction ? "document.querySelector('#echo').textContent='wrong';fetch('/wrong-effect')" : "document.querySelector('#records').hidden=false"}">Expand</button><output id="echo"></output><section id="records" hidden><article><h2>${name} 1</h2><a href="/detail/1">Details</a></article><article><h2>${name} 2</h2><a href="/detail/2">Details</a></article></section></main>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not listen');
    const calls: string[] = [];
    const provider = new MockAiProvider((usage) => {
      calls.push(usage.operation);
    });
    let fixture: Awaited<ReturnType<typeof createProductRuntimeFixture>> | undefined;
    try {
      fixture = await createProductRuntimeFixture({ ai: provider });
      const { app, jobs, repositories } = fixture;
      const session = await app.inject({
        method: 'POST',
        url: '/api/v2/session',
        payload: { nonce: 'product-integration-session' },
      });
      expect(session.statusCode).toBe(200);
      const headers = { authorization: `Bearer ${session.json().token as string}` };
      const taskResponse = await app.inject({
        method: 'POST',
        url: '/api/v2/tasks',
        headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
        payload: {
          name: 'Verified action fixture',
          startUrl: `http://127.0.0.1:${address.port}/list`,
          instruction: 'Collect name and description',
          requestSettings: {
            retries: 0,
            delayMs: 0,
            timeoutMs: 2000,
            maxRuntimeMs: 30_000,
            respectRobotsTxt: false,
            domainRateLimitPerMinute: 10_000,
          },
          networkPolicy: { allowPrivateNetworks: true, allowedHosts: [], allowedCidrs: [] },
        },
      });
      expect(taskResponse.statusCode).toBe(201);
      const taskId = taskResponse.json().id as string;
      const plan = normalizeCrawlPlan({
        list: {
          mode: 'auto',
          rule: {
            type: 'css',
            container: '#records article',
            fields: {
              name: { selector: 'h2', value: 'text', dataType: 'string' },
              url: { selector: 'a', value: 'attribute', attribute: 'href', dataType: 'url' },
            },
          },
          actions: [
            { type: 'fill', selector: '#search', value: 'FAKE_FORM_FILL_c71a' },
            {
              type: 'click',
              selector: '#expand',
              semanticGoal: { intent: 'expand', description: 'Expand list records' },
              expectedState: { checks: [{ type: 'visible', selector: '#records' }] },
            },
          ],
        },
        detail: {
          urlField: 'url',
          mode: 'browser',
          concurrency: 1,
          rule: {
            type: 'css',
            container: '#details',
            fields: { description: { selector: 'p', value: 'text', dataType: 'string' } },
          },
          actions: [
            {
              type: 'click',
              selector: '#reveal',
              semanticGoal: { intent: 'expand', description: 'Reveal detail records' },
              expectedState: { checks: [{ type: 'visible', selector: '#details' }] },
            },
          ],
        },
      });
      const active = await repositories.collection.createRule(taskId, 'Fixture', plan, 'human');
      const run = async () => {
        const queued = await app.inject({
          method: 'POST',
          url: `/api/v2/tasks/${taskId}/runs`,
          headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
        });
        expect(queued.statusCode).toBe(202);
        const runId = queued.json().runId as string;
        for (let index = 0; index < 12; index++) {
          const job = await jobs.get(runId);
          expect(job).not.toBeNull();
          if (job && ['succeeded', 'failed', 'canceled'].includes(job.state)) break;
          await jobs.dispatchOnce();
        }
        expect((await jobs.get(runId))?.state).toMatch(/^(?:succeeded|failed|canceled)$/);
        const result = await app.inject({
          method: 'GET',
          url: `/api/v2/runs/${runId}`,
          headers,
        });
        expect(result.statusCode).toBe(200);
        return result.json();
      };
      const first = await run();
      expect(first).toMatchObject({ status: 'succeeded', recordCount: 2, aiUsed: false });
      expect(first.metadata.actionCache).toEqual({
        stages: 3,
        hitStages: 0,
        storedStages: 3,
        bypassedStages: 0,
        providerCalls: 0,
        reasons: { empty: 3 },
      });
      const cacheEntries = async () => {
        const stages = [
          { target: 'list', path: '/list' },
          { target: 'detail', path: '/detail/1' },
          { target: 'detail', path: '/detail/2' },
        ];
        const entries = await Promise.all(
          stages.map(
            async ({ target, path }) =>
              (
                await repositories.aiAssistance.readValidatedCache(
                  cacheDigest({
                    ownerScopeHash: cacheDigest(`task:${taskId}`),
                    target,
                    url: `http://127.0.0.1:${address.port}${path}`,
                    version: 1,
                  }),
                  'action',
                )
              ).entry,
          ),
        );
        return entries.filter((entry) => entry !== null);
      };
      expect(await cacheEntries()).toHaveLength(3);
      expect(JSON.stringify(await cacheEntries())).not.toContain('FAKE_FORM_FILL_c71a');
      name = 'Changed';
      const second = await run();
      expect(second).toMatchObject({ status: 'succeeded', recordCount: 2, aiUsed: false });
      expect(second.metadata.actionCache).toMatchObject({
        stages: 3,
        hitStages: 3,
        storedStages: 0,
        providerCalls: 0,
        reasons: { matched: 3 },
      });
      const records = await repositories.datasets.listRunRecords(second.id as string);
      expect(
        records.items
          .map((row) => row.data)
          .sort((a, b) => String(a.name).localeCompare(String(b.name))),
      ).toEqual([
        expect.objectContaining({ name: 'Changed 1', description: 'Changed detail 1' }),
        expect.objectContaining({ name: 'Changed 2', description: 'Changed detail 2' }),
      ]);
      expect(second.metadata.datasetSnapshotId).not.toBe(first.metadata.datasetSnapshotId);
      const clear = await app.inject({
        method: 'POST',
        url: '/api/v2/rules/cache/clear',
        headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
        payload: { taskId },
      });
      expect(clear.json()).toEqual({ status: 'cleared', deleted: 3 });
      expect(await cacheEntries()).toEqual([]);
      const afterClear = await run();
      expect(afterClear).toMatchObject({ status: 'succeeded', recordCount: 2 });
      expect(afterClear.metadata.actionCache).toMatchObject({ storedStages: 3, hitStages: 0 });
      const createdDraft = await app.inject({
        method: 'POST',
        url: '/api/v2/collection-drafts',
        headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
        payload: {},
      });
      expect(createdDraft.statusCode).toBe(201);
      const draftTask = (await repositories.collection.getTask(taskId))!;
      const updatedDraft = await app.inject({
        method: 'PATCH',
        url: `/api/v2/collection-drafts/${createdDraft.json().id as string}`,
        headers: {
          ...headers,
          'if-match': `"${createdDraft.json().revision as number}"`,
          'idempotency-key': crypto.randomUUID(),
        },
        payload: {
          step: 2,
          definition: plan,
          task: {
            name: 'Draft action fixture',
            instruction: draftTask.instruction,
            startUrl: draftTask.startUrl,
            requestSettings: draftTask.requestSettings,
            browserSettings: draftTask.browserSettings,
            networkPolicy: draftTask.networkPolicy,
          },
        },
      });
      expect(updatedDraft.statusCode).toBe(200);
      let currentDraft = updatedDraft.json();
      const previewDraft = async () => {
        const result = await app.inject({
          method: 'POST',
          url: `/api/v2/collection-drafts/${currentDraft.id as string}/preview`,
          headers: {
            ...headers,
            'if-match': `"${currentDraft.revision as number}"`,
            'idempotency-key': crypto.randomUUID(),
          },
        });
        expect(result.statusCode).toBe(200);
        currentDraft = result.json();
        return currentDraft;
      };
      const firstDraft = await previewDraft();
      expect(firstDraft.preview.actionCache).toMatchObject({
        stages: 3,
        storedStages: 3,
        providerCalls: 0,
      });
      const repeatDraft = await previewDraft();
      expect(repeatDraft.revision).toBeGreaterThan(firstDraft.revision);
      expect(repeatDraft.preview.actionCache).toMatchObject({
        stages: 3,
        hitStages: 3,
        providerCalls: 0,
      });
      const clearDraft = await app.inject({
        method: 'POST',
        url: '/api/v2/rules/cache/clear',
        headers: { ...headers, 'idempotency-key': crypto.randomUUID() },
        payload: { cacheScope: currentDraft.id },
      });
      expect(clearDraft.json()).toEqual({ status: 'cleared', deleted: 3 });
      expect(await cacheEntries()).toHaveLength(3);
      const regeneratedDraft = await previewDraft();
      expect(regeneratedDraft.preview.actionCache).toMatchObject({ storedStages: 3, hitStages: 0 });
      expect(regeneratedDraft.preview.records).toHaveLength(2);
      const verified = await cacheEntries();
      wrongAction = true;
      const failed = await run();
      expect(failed.status).toBe('failed');
      expect(wrongEffects).toBe(1);
      const diagnostics = await app.inject({
        method: 'GET',
        url: `/api/v2/runs/${failed.id as string}/diagnostics`,
        headers,
      });
      expect(diagnostics.json().steps).toContainEqual(
        expect.objectContaining({
          kind: 'action',
          actionType: 'click',
          status: 'failed',
          errorCode: 'ACTION_STATE_INVALID',
        }),
      );
      expect(diagnosticRecovery('ACTION_STATE_INVALID')).toBe('edit_fields');
      expect(await cacheEntries()).toEqual(verified);
      expect((await repositories.collection.getActiveRule(taskId))?.version.id).toBe(
        active.version.id,
      );
      expect(calls).toEqual([]);
      console.info(
        'COLLECTION_ACTION_CACHE_METRICS',
        JSON.stringify({
          fixture: 'list-detail-actions-v1',
          provider: 'Mock',
          initial: first.metadata.actionCache,
          repeat: second.metadata.actionCache,
          clearedStages: clear.json().deleted,
          actualMockCalls: calls.length,
          draftInitial: firstDraft.preview.actionCache,
          draftRepeat: repeatDraft.preview.actionCache,
          draftClearedStages: clearDraft.json().deleted,
          wrongActionEffects: wrongEffects,
        }),
      );
    } finally {
      try {
        await fixture?.close();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  }, 120_000);
});
