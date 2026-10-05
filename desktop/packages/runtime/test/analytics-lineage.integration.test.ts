import { createHash } from 'node:crypto';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { MockAiProvider } from '@zhiyun/ai-runtime';
import { ZhiYunClient, type AnalysisJobInput, type RuntimeBridge } from '@zhiyun/client';
import { describe, expect, it, vi } from 'vitest';
import { PlatformJobExecutionError } from '@zhiyun/platform-core';
import { createProductRuntimeFixture } from './support/product-runtime.js';

describe('four analysis questions in the actual local Runtime', () => {
  it('freezes cleaned inputs, preserves branches, compares compatible results and pages without an Artifact file', async () => {
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
        settings: { mode: 'append', keyFields: ['group'], detectRemoved: false },
        records: Array.from({ length: 550 }, (_, index) => ({
          sourceUrl: `http://127.0.0.1/fixture/${index}`,
          data: {
            group: `group-${String(index).padStart(4, '0')}`,
            value: ` ${index === 549 ? 40 : index % 10} `,
            date: new Date(Date.UTC(2024, 0, 1 + index)).toISOString(),
          },
        })),
      });
      const datasetId = committed.dataset.id;
      const source = await client.createDatasetSnapshot(datasetId);
      const sourceMetadata = (await runtime.repositories.datasets.getSnapshot(source.id))!;
      const sourceArtifact = (await runtime.repositories.platform.getArtifact(
        sourceMetadata.parquetArtifactId!,
      ))!;
      const sourcePath = join(runtime.directory, 'artifacts', sourceArtifact.storageKey);
      const sourceHash = createHash('sha256')
        .update(await readFile(sourcePath))
        .digest('hex');
      const cleaning = await client.saveDatasetCleaningRecipe(datasetId, {
        name: 'Typed values',
        expectedFields: {},
        steps: [
          { type: 'trim', fields: ['value'] },
          { type: 'convert', fields: ['value'], targetType: 'number', onError: 'null' },
          { type: 'convert', fields: ['date'], targetType: 'date', onError: 'null' },
        ],
      });
      const applied = await client.applyDatasetCleaning(datasetId, {
        snapshotId: source.id,
        recipeVersionId: cleaning.version.id,
      });
      const snapshotId = applied.session.selectedSnapshotId;
      const snapshot = await client.getDatasetSnapshot(datasetId, snapshotId);
      const common = { datasetId, snapshotId, methodVersion: '1.0.0' };
      const inputs: AnalysisJobInput[] = [
        {
          ...common,
          questionId: 'group-comparison',
          methodId: 'group.aggregate',
          parameters: { groupFields: ['group'], valueFields: ['value'], aggregations: ['mean'] },
        },
        {
          ...common,
          questionId: 'time-trend',
          methodId: 'time.trend',
          parameters: {
            timeField: 'date',
            valueField: 'value',
            interval: 'day',
            aggregation: 'mean',
            movingAverage: 7,
          },
        },
        {
          ...common,
          questionId: 'distribution',
          methodId: 'stats.descriptive',
          parameters: { fields: ['value'] },
        },
        {
          ...common,
          questionId: 'outliers',
          methodId: 'stats.outliers',
          parameters: { fields: ['value'], method: 'iqr', threshold: 1.5 },
        },
      ];
      const created = [];
      await expect(
        client.createAnalysisJob({ ...inputs[0]!, questionId: 'distribution' }),
      ).rejects.toMatchObject({ problem: { code: 'METHOD_INCOMPATIBLE', status: 422 } });
      for (const input of inputs) {
        const recipe = await client.createAnalysisRecipe({
          name: input.questionId!,
          datasetId,
          methodId: input.methodId,
          methodVersion: input.methodVersion,
          parameters: input.parameters,
        });
        const job = await client.createAnalysisJob({ ...input, recipeId: recipe.id });
        await client.getAnalysisRecipe(recipe.id);
        await client.updateAnalysisRecipe(recipe.id, {
          name: 'Changed later',
          datasetId,
          methodId: input.methodId,
          methodVersion: input.methodVersion,
          parameters: input.parameters,
        });
        await client.deleteAnalysisRecipe(recipe.id);
        const finished = await terminal(client, job.id);
        expect(finished.state, JSON.stringify(finished.error)).toBe('succeeded');
        const result = await client.getAnalysisResult(finished.resultId!);
        expect(result).toMatchObject({
          state: 'succeeded',
          snapshotId,
          parameters: input.parameters,
          provenance: {
            version: 1,
            inputFingerprint: snapshot.fingerprint,
            sourceSnapshotId: source.id,
            cleaningRecipeVersionId: cleaning.version.id,
            cleaningStep: 3,
            analysisRecipeId: recipe.id,
            analysisRecipeRevision: 1,
            questionId: input.questionId,
            parentResultId: null,
          },
        });
        expect(result.artifacts).toContainEqual(
          expect.objectContaining({ kind: 'analysis.result', filename: 'analysis-result.json' }),
        );
        expect(result.series[0]!.encoding).toBeDefined();
        created.push(result);
      }
      const groups = created[0]!,
        outliers = created[3]!;
      expect(groups.tables[0]).toMatchObject({ id: 'groups', totalRows: 550 });
      expect(groups.tables[0]!.rows).toHaveLength(20);
      expect(groups.series[0]!.encoding).toEqual({ xFields: ['group'], yFields: ['value_mean'] });
      const resultArtifact = groups.artifacts.find(
        (artifact) => artifact.kind === 'analysis.result',
      )!;
      const stored = (await runtime.repositories.platform.getArtifact(String(resultArtifact.id)))!;
      const resultPath = join(runtime.directory, 'artifacts', stored.storageKey);
      const fullBytes = (await readFile(resultPath)).length;
      const previewBytes = Buffer.byteLength(JSON.stringify(groups));
      expect(previewBytes).toBeLessThan(fullBytes / 5);
      const seen: string[] = [];
      // A missing report file proves that these requests read SQLite rows, without resolving/downloading the Artifact.
      await rename(resultPath, resultPath + '.offline');
      try {
        expect(await client.getAnalysisResult(groups.id)).toEqual(groups);
        let cursor: string | undefined;
        do {
          const page = await client.getAnalysisResultPage(
            groups.id,
            'table',
            'groups',
            200,
            cursor,
          );
          expect(page.items.length).toBeLessThanOrEqual(200);
          seen.push(...page.items.map((row) => String(row.group)));
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        await expect(
          client.getAnalysisResultPage(groups.id, 'table', 'groups', 201),
        ).rejects.toMatchObject({ problem: { code: 'VALIDATION_ERROR', status: 400 } });
        await expect(
          client.getAnalysisResultPage(groups.id, 'table', 'groups', 10, 'invalid'),
        ).rejects.toMatchObject({ problem: { code: 'INVALID_CURSOR', status: 400 } });
      } finally {
        await rename(resultPath + '.offline', resultPath);
      }
      expect(seen).toEqual(
        Array.from({ length: 550 }, (_, index) => `group-${String(index).padStart(4, '0')}`),
      );
      const original = JSON.stringify(outliers);
      const branch = await client.branchAnalysisResult(outliers.id, {
        ...outliers.parameters,
        threshold: 10,
      });
      const finished = await terminal(client, branch.id);
      expect(finished.state, JSON.stringify(finished.error)).toBe('succeeded');
      const branched = await client.getAnalysisResult(finished.resultId!);
      expect(branched.provenance).toMatchObject({
        parentResultId: outliers.id,
        sourceSnapshotId: source.id,
        cleaningRecipeVersionId: cleaning.version.id,
      });
      expect(JSON.stringify(await client.getAnalysisResult(outliers.id))).toBe(original);
      const compared = await client.compareAnalysisResults(outliers.id, branched.id);
      expect(compared.changedParameters).toEqual(['threshold']);
      expect(compared.left.tables.find((table) => table.id === 'outlierSamples')!.totalRows).toBe(
        1,
      );
      expect(compared.right.tables.find((table) => table.id === 'outlierSamples')!.totalRows).toBe(
        0,
      );
      await expect(client.compareAnalysisResults(groups.id, outliers.id)).rejects.toMatchObject({
        problem: { code: 'COMPARISON_INCOMPATIBLE', status: 409 },
      });
      await expect(
        client.branchAnalysisResult(outliers.id, { fields: ['value'], threshold: 11 }),
      ).rejects.toMatchObject({ problem: { code: 'METHOD_INCOMPATIBLE', status: 422 } });
      const unavailable = await client.createAnalysisRecipe({
        name: 'Unavailable field',
        datasetId,
        methodId: 'stats.descriptive',
        methodVersion: '1.0.0',
        parameters: { fields: ['absent'] },
      });
      const failure = await client.createAnalysisJob({
        ...common,
        recipeId: unavailable.id,
        methodId: unavailable.methodId,
        parameters: unavailable.parameters,
      });
      await client.getAnalysisRecipe(unavailable.id);
      await client.deleteAnalysisRecipe(unavailable.id);
      expect((await terminal(client, failure.id)).state).toBe('failed');
      const retry = await client.retryAnalysisJob(failure.id);
      expect(retry.provenance).toEqual(failure.provenance);
      expect(retry.recipeId).toBe(unavailable.id);
      expect((await terminal(client, retry.id)).state).toBe('failed');
      const artifactIds: string[] = [];
      const createArtifact = runtime.repositories.platform.createArtifact.bind(
        runtime.repositories.platform,
      );
      const artifactSpy = vi
        .spyOn(runtime.repositories.platform, 'createArtifact')
        .mockImplementation(async (input) => {
          const artifact = await createArtifact(input);
          if (input.ownerPluginId === 'analytics') artifactIds.push(artifact.id);
          return artifact;
        });
      const resultSpy = vi
        .spyOn(runtime.repositories.analytics, 'saveResult')
        .mockImplementationOnce(async (input) => {
          expect(input.artifacts).toHaveLength(1);
          throw new PlatformJobExecutionError(
            'FIXTURE_RESULT_WRITE_FAILED',
            'Fixture persistence failure',
            true,
          );
        });
      try {
        const recovering = await client.createAnalysisJob(inputs[0]!);
        const recovered = await terminal(client, recovering.id);
        expect(recovered).toMatchObject({ state: 'succeeded', attempt: 2 });
        expect(artifactIds).toHaveLength(2);
        expect(await runtime.repositories.platform.getArtifact(artifactIds[0]!)).toBeNull();
        const surviving = await runtime.repositories.platform.getArtifact(artifactIds[1]!);
        expect(surviving?.ownerPluginId).toBe('analytics');
        const persisted = await client.getAnalysisResult(recovered.resultId!);
        expect(persisted.artifacts.map((artifact) => artifact.id)).toEqual([artifactIds[1]!]);
        expect(persisted.provenance?.inputFingerprint).toBe(snapshot.fingerprint);
      } finally {
        artifactSpy.mockRestore();
        resultSpy.mockRestore();
      }
      expect(
        createHash('sha256')
          .update(await readFile(sourcePath))
          .digest('hex'),
      ).toBe(sourceHash);
      expect(await client.getDatasetSnapshot(datasetId, source.id)).toEqual(source);
      for (const suffix of ['collections/table/groups', 'branches', `compare/${outliers.id}`]) {
        const response = await fetch(
          `${baseUrl}/api/v2/analytics/results/${groups.id}/${suffix}`,
          suffix === 'branches'
            ? {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  'idempotency-key': 'unauthenticated',
                },
                body: JSON.stringify({ parameters: groups.parameters }),
              }
            : {},
        );
        expect(response.status).toBe(401);
      }
      const graph = await client.getRuntimeGraph();
      for (const [operation, permission] of [
        ['getAnalysisResultPage', 'workspace.read'],
        ['compareAnalysisResults', 'workspace.read'],
        ['branchAnalysisResult', 'analysis.write'],
      ])
        expect(
          graph.routes.find((route) => route.operationId === operation)?.requiredPermission,
        ).toBe(permission);
      expect(await readdir(join(runtime.directory, 'job-workspaces'))).toEqual([]);
      await writeFile(
        resolve(
          '.artifacts/no-credentials-optimization/20261003T054244Z/opt08-runtime-metrics.json',
        ),
        JSON.stringify(
          {
            rows: seen.length,
            previewBytes,
            fullArtifactBytes: fullBytes,
            ratio: previewBytes / fullBytes,
            questions: created.map((result) => result.provenance?.questionId),
            branchesPreserveOriginal: true,
            fullArtifactAbsentDuringPaging: true,
            sourceHashUnchanged: true,
            workspacesAfterTerminal: 0,
          },
          null,
          2,
        ) + '\n',
      );
    } finally {
      await runtime.close();
    }
  }, 60_000);
});

async function terminal(client: ZhiYunClient, id: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const job = await client.getAnalysisJob(id);
    if (['succeeded', 'failed', 'canceled'].includes(job.state)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Analysis fixture did not reach a terminal state');
}
