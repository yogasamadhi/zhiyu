import { MockAiProvider } from '@zhiyun/ai-runtime';
import { ZhiYunClient, type RuntimeBridge } from '@zhiyun/client';
import { cleaningRecipeInputSchema, cleaningSessionDetailSchema } from '@zhiyun/contracts';
import { describe, expect, it } from 'vitest';
import { createProductRuntimeFixture } from './support/product-runtime.js';

describe('cleaning in the actual local Runtime and generated client', () => {
  it('negotiates its local session, publishes history, validates schemas and selects immutable steps', async () => {
    const runtime = await createProductRuntimeFixture({ ai: new MockAiProvider() });
    try {
      const baseUrl = await runtime.app.listen({ port: 0, host: '127.0.0.1' });
      const bridge: RuntimeBridge = {
        async getBootstrap() {
          return {
            baseUrl,
            sessionNonce: 'product-integration-session',
            runtimeId: crypto.randomUUID(),
            generation: 1,
            apiVersion: 'v2',
          };
        },
        onBootstrapChanged() {
          return () => undefined;
        },
      };
      const client = new ZhiYunClient(bridge);
      const committed = await runtime.repositories.datasets.commitRunRecords({
        sourceTaskId: crypto.randomUUID(),
        sourceRunId: crypto.randomUUID(),
        settings: { mode: 'append', keyFields: ['__fixture_missing_key__'], detectRemoved: false },
        records: [
          { sourceUrl: 'http://127.0.0.1/a', data: { price: ' 10 ' } },
          { sourceUrl: 'http://127.0.0.1/b', data: { price: 'bad' } },
        ],
      });
      const datasetId = committed.dataset.id;
      const snapshot = await client.createDatasetSnapshot(datasetId);
      const input = cleaningRecipeInputSchema.parse({
        name: 'Price conversion',
        steps: [
          { type: 'trim', fields: ['price'] },
          { type: 'convert', fields: ['price'], targetType: 'number' },
        ],
        expectedFields: { price: 'string' },
      });
      const preview = await client.previewDatasetCleaning(datasetId, {
        mode: 'steps',
        snapshotId: snapshot.id,
        steps: input.steps,
        expectedFields: input.expectedFields,
      });
      expect(preview.steps[1]!.errorRowCount).toBe(1);
      const saved = await client.saveDatasetCleaningRecipe(datasetId, {
        name: input.name,
        steps: input.steps,
        expectedFields: input.expectedFields,
      });
      const applied = cleaningSessionDetailSchema.parse(
        await client.applyDatasetCleaning(datasetId, {
          snapshotId: snapshot.id,
          recipeVersionId: saved.version.id,
        }),
      );
      expect(applied.session.selectedStep).toBe(2);
      expect((await client.listDatasetCleaningSessions(datasetId)).map((item) => item.id)).toEqual([
        applied.session.id,
      ]);
      expect(
        await client.getDatasetCleaningRecipe(datasetId, saved.recipe.id, saved.version.id),
      ).toEqual(saved);
      const selectedFields = await client.getDatasetFields(
        datasetId,
        applied.session.selectedSnapshotId,
      );
      expect(selectedFields.fields).toContainEqual(
        expect.objectContaining({ name: 'price', type: 'number', missingCount: 1 }),
      );
      const originalFields = await client.getDatasetFields(datasetId, snapshot.id);
      expect(originalFields.fields).toContainEqual(
        expect.objectContaining({ name: 'price', type: 'text', missingCount: 0 }),
      );
      const undone = cleaningSessionDetailSchema.parse(
        await client.selectDatasetCleaningStep(datasetId, applied.session.id, 0, 1),
      );
      expect(undone.session.selectedSnapshotId).toBe(snapshot.id);
      const redone = cleaningSessionDetailSchema.parse(
        await client.selectDatasetCleaningStep(datasetId, applied.session.id, 2, 2),
      );
      expect(redone.session.selectedSnapshotId).toBe(applied.session.selectedSnapshotId);
      await expect(
        client.selectDatasetCleaningStep(datasetId, applied.session.id, 0, 1),
      ).rejects.toMatchObject({ problem: { code: 'REVISION_CONFLICT', status: 409 } });
      expect(await client.getDatasetCleaningSession(datasetId, applied.session.id)).toEqual(redone);
      const unauthenticated = await fetch(
        `${baseUrl}/api/v2/datasets/${datasetId}/cleaning/recipes`,
      );
      expect(unauthenticated.status).toBe(401);
      const graph = await client.getRuntimeGraph();
      const permissions = new Map(
        graph.routes
          .filter((route) => route.operationId.includes('DatasetCleaning'))
          .map((route) => [route.operationId, route.requiredPermission]),
      );
      expect(permissions.size).toBe(8);
      expect(permissions.get('previewDatasetCleaning')).toBe('workspace.read');
      expect(permissions.get('saveDatasetCleaningRecipe')).toBe('task.write');
      expect(permissions.get('applyDatasetCleaning')).toBe('task.write');
      expect(permissions.get('selectDatasetCleaningStep')).toBe('task.write');
    } finally {
      await runtime.close();
    }
  }, 45_000);
});
