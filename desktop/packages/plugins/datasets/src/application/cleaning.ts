import { createHash, randomUUID } from 'node:crypto';
import { copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import {
  cleaningApplyInputSchema,
  cleaningParametersSchema,
  cleaningPreviewInputSchema,
  cleaningRecipeInputSchema,
  cleaningResultSchema,
  cleaningSessionDetailSchema,
  type CleaningApplyInput,
  type CleaningParameters,
  type CleaningPreviewInput,
  type CleaningRecipeInput,
  type CleaningResult,
  type CleaningSessionDetail,
} from '@zhiyun/shared';
import type { ArtifactStore, PlatformRepository } from '@zhiyun/platform-core';
import type {
  DatasetRepository,
  DatasetSnapshot,
  SnapshotWorkerClient,
} from '../contracts/index.js';
import { DatasetCleaningConflictError } from '../contracts/cleaning.js';

export class DatasetCleaningError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class DatasetCleaningService {
  private readonly active = new Map<
    string,
    { controller: AbortController; completed: Promise<unknown> }
  >();
  private closed = false;
  constructor(
    private readonly datasets: DatasetRepository,
    private readonly platform: PlatformRepository,
    private readonly artifacts: ArtifactStore,
    private readonly worker: SnapshotWorkerClient,
    private readonly options: {
      pollIntervalMs?: number;
      timeoutMs?: number;
      cancelGraceMs?: number;
    } = {},
  ) {}

  async close(): Promise<void> {
    this.closed = true;
    for (const { controller } of this.active.values()) controller.abort();
    await Promise.allSettled([...this.active.values()].map(({ completed }) => completed));
  }

  async saveRecipe(datasetId: string, value: CleaningRecipeInput) {
    z.uuid().parse(datasetId);
    const input = cleaningRecipeInputSchema.parse(value);
    if (!(await this.datasets.getDataset(datasetId)))
      throw new DatasetCleaningError('NOT_FOUND', 'Dataset was not found', 404);
    return this.datasets.cleaning.saveRecipe({
      datasetId,
      name: input.name,
      steps: input.steps,
      expectedFields: input.expectedFields,
      ...(input.recipeId === undefined ? {} : { recipeId: input.recipeId }),
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    });
  }

  async listRecipes(datasetId: string) {
    z.uuid().parse(datasetId);
    return this.datasets.cleaning.listRecipes(datasetId);
  }

  async getRecipe(datasetId: string, recipeId: string, versionId?: string) {
    const recipe = await this.datasets.cleaning.getRecipe(recipeId);
    if (!recipe || recipe.datasetId !== datasetId)
      throw new DatasetCleaningError('NOT_FOUND', 'Cleaning recipe was not found', 404);
    const version = await this.datasets.cleaning.getRecipeVersion(
      versionId ?? recipe.currentVersionId,
    );
    if (!version || version.recipeId !== recipe.id)
      throw new DatasetCleaningError('NOT_FOUND', 'Cleaning recipe version was not found', 404);
    return { recipe, version };
  }

  async preview(
    datasetId: string,
    value: CleaningPreviewInput,
    signal?: AbortSignal,
  ): Promise<CleaningResult> {
    const input = cleaningPreviewInputSchema.parse(value);
    const params =
      input.mode === 'recipe'
        ? await this.recipeParameters(input.recipeVersionId)
        : { steps: input.steps, expectedFields: input.expectedFields };
    return this.execute(
      datasetId,
      input.snapshotId,
      params,
      undefined,
      signal,
    ) as Promise<CleaningResult>;
  }

  async apply(
    datasetId: string,
    value: CleaningApplyInput,
    signal?: AbortSignal,
  ): Promise<CleaningSessionDetail> {
    const input = cleaningApplyInputSchema.parse(value);
    const params = await this.recipeParameters(input.recipeVersionId);
    return this.execute(
      datasetId,
      input.snapshotId,
      params,
      input.recipeVersionId,
      signal,
    ) as Promise<CleaningSessionDetail>;
  }

  private async recipeParameters(versionId: string) {
    const version = await this.datasets.cleaning.getRecipeVersion(versionId);
    if (!version)
      throw new DatasetCleaningError('NOT_FOUND', 'Cleaning recipe version was not found', 404);
    return { steps: version.steps, expectedFields: version.expectedFields };
  }

  private execute(
    datasetId: string,
    snapshotId: string,
    params: Pick<CleaningParameters, 'steps' | 'expectedFields'>,
    versionId?: string,
    signal?: AbortSignal,
  ) {
    if (this.closed)
      throw new DatasetCleaningError('ANALYTICS_UNAVAILABLE', 'Cleaning service is stopping', 503);
    const jobId = randomUUID();
    const controller = new AbortController();
    const completed = this.run(
      jobId,
      datasetId,
      snapshotId,
      params,
      versionId,
      signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
    ).finally(() => this.active.delete(jobId));
    this.active.set(jobId, { controller, completed });
    return completed;
  }

  private async input(datasetId: string, snapshotId: string): Promise<DatasetSnapshot> {
    z.uuid().parse(datasetId);
    z.uuid().parse(snapshotId);
    const snapshot = await this.datasets.getSnapshot(snapshotId);
    if (!snapshot || snapshot.datasetId !== datasetId)
      throw new DatasetCleaningError('NOT_FOUND', 'Input Snapshot was not found', 404);
    if (snapshot.status !== 'ready' || !snapshot.parquetArtifactId || !snapshot.manifestArtifactId)
      throw new DatasetCleaningError(
        'SNAPSHOT_NOT_READY',
        'Cleaning requires a ready input Snapshot',
        409,
      );
    return snapshot;
  }

  private async run(
    jobId: string,
    datasetId: string,
    snapshotId: string,
    params: Pick<CleaningParameters, 'steps' | 'expectedFields'>,
    versionId: string | undefined,
    signal: AbortSignal,
  ) {
    const snapshot = await this.input(datasetId, snapshotId);
    const workspace = await this.artifacts.openWorkspace(jobId);
    const createdArtifacts: string[] = [];
    let submitted = false,
      published = false,
      preserveWorkspace = false;
    try {
      this.checkAbort(signal);
      for (const [artifactId, destination, kind] of [
        [snapshot.parquetArtifactId!, 'snapshot.parquet', 'dataset.snapshot.parquet'],
        [snapshot.manifestArtifactId!, 'schema-manifest.json', 'dataset.snapshot.schema-manifest'],
      ]) {
        const artifact = await this.platform.getArtifact(artifactId!);
        if (
          !artifact ||
          artifact.ownerPluginId !== 'datasets' ||
          artifact.kind !== kind ||
          artifact.metadata.datasetId !== datasetId
        )
          throw new DatasetCleaningError('NOT_FOUND', 'Input Snapshot Artifact was not found', 404);
        const source = await this.artifacts.resolveArtifact(artifact.storageKey);
        await copyFile(source, await workspace.resolve(destination!));
      }
      this.checkAbort(signal);
      const parameters = cleaningParametersSchema.parse({
        ...params,
        fingerprint: snapshot.fingerprint,
        manifestArtifactRef: 'schema-manifest.json',
      });
      submitted = true;
      await this.worker.submit({
        jobId,
        methodId: 'dataset.clean_snapshot',
        methodVersion: '1.0.0',
        inputArtifactRef: 'snapshot.parquet',
        outputArtifactRef: 'cleaning-result.json',
        parameters,
      });
      await this.wait(jobId, signal);
      const resultPath = await workspace.resolve('cleaning-result.json');
      if ((await stat(resultPath)).size > 16 * 1024 * 1024)
        throw new DatasetCleaningError(
          'RESOURCE_LIMIT_EXCEEDED',
          'Cleaning report exceeds its limit',
        );
      const report = cleaningResultSchema.parse(JSON.parse(await readFile(resultPath, 'utf8')));
      this.validateReport(report, snapshot, parameters);
      this.checkAbort(signal);
      if (!versionId) return report;
      const prefix = `dataset-cleaning/${jobId}`;
      const persist = async (
        reference: string,
        filename: string,
        kind: string,
        contentType: string,
        metadata: Record<string, unknown>,
      ) => {
        const file = await this.artifacts.commitWorkspaceFile(
          jobId,
          reference,
          `${prefix}/${filename}`,
        );
        this.checkAbort(signal);
        const artifactId = randomUUID();
        createdArtifacts.push(artifactId);
        return this.platform.createArtifact({
          id: artifactId,
          ownerPluginId: 'datasets',
          kind,
          filename,
          contentType,
          ...file,
          metadata: {
            datasetId,
            inputSnapshotId: snapshot.id,
            recipeVersionId: versionId,
            cleaningJobId: jobId,
            ...metadata,
          },
        });
      };
      const steps = [];
      const savedReport = structuredClone(report);
      for (const step of report.steps) {
        this.checkAbort(signal);
        const parquet = await persist(
          step.parquetArtifactRef,
          `step-${step.index + 1}.parquet`,
          'dataset.snapshot.parquet',
          'application/vnd.apache.parquet',
          { fingerprint: step.fingerprint, step: step.index + 1 },
        );
        const manifest = await persist(
          step.manifestArtifactRef,
          `step-${step.index + 1}-manifest.json`,
          'dataset.snapshot.schema-manifest',
          'application/json',
          { fingerprint: step.fingerprint, step: step.index + 1 },
        );
        steps.push({
          fingerprint: step.fingerprint,
          rowCount: step.rowCount,
          parquetArtifactId: parquet.id,
          manifestArtifactId: manifest.id,
        });
        savedReport.steps[step.index]!.parquetArtifactRef = parquet.id;
        savedReport.steps[step.index]!.manifestArtifactRef = manifest.id;
      }
      savedReport.parquetArtifactRef = steps.at(-1)!.parquetArtifactId;
      savedReport.manifestArtifactRef = steps.at(-1)!.manifestArtifactId;
      await writeFile(
        await workspace.resolve('saved-cleaning-result.json'),
        JSON.stringify(savedReport),
        { flag: 'wx', mode: 0o600 },
      );
      const reportArtifact = await persist(
        'saved-cleaning-result.json',
        'cleaning-result.json',
        'dataset.cleaning.report',
        'application/json',
        { fingerprint: report.fingerprint },
      );
      this.checkAbort(signal);
      const result = await this.datasets.cleaning.publishSession({
        datasetId,
        inputSnapshotId: snapshot.id,
        recipeVersionId: versionId,
        reportArtifactId: reportArtifact.id,
        steps,
      });
      published = true;
      return cleaningSessionDetailSchema.parse({
        session: result.session,
        recipeVersion: await this.datasets.cleaning.getRecipeVersion(versionId),
        report: savedReport,
      });
    } catch (error) {
      preserveWorkspace = error instanceof CleaningWorkerStillRunningError;
      if (submitted && !preserveWorkspace) {
        const terminal = await this.worker.job(jobId).catch(() => undefined);
        if (!terminal || !['succeeded', 'failed', 'canceled'].includes(terminal.state)) {
          await this.worker.cancel(jobId).catch(() => undefined);
          preserveWorkspace = !(await this.terminal(jobId));
        }
      }
      if (!published) {
        const removed = await Promise.allSettled(
          createdArtifacts.map((id) => this.platform.removeArtifact(id, 'datasets')),
        );
        const failures = removed.filter((item) => item.status === 'rejected');
        if (failures.length)
          throw new AggregateError(
            [error, ...failures.map((item) => item.reason)],
            'Cleaning failed and Artifact cleanup requires retry',
            { cause: error },
          );
        await this.artifacts.removeArtifactDirectory('dataset-cleaning', jobId);
      }
      throw error;
    } finally {
      if (!preserveWorkspace) await this.artifacts.removeWorkspace(jobId);
    }
  }

  private validateReport(
    report: CleaningResult,
    snapshot: DatasetSnapshot,
    parameters: CleaningParameters,
  ) {
    if (
      report.inputFingerprint !== snapshot.fingerprint ||
      report.inputRowCount !== snapshot.rowCount ||
      report.steps.length !== parameters.steps.length
    )
      throw new DatasetCleaningError(
        'INVALID_WORKER_RESULT',
        'Cleaning result does not match its input',
        502,
      );
    let fingerprint = snapshot.fingerprint,
      rows = snapshot.rowCount;
    for (let index = 0; index < report.steps.length; index++) {
      const step = report.steps[index]!;
      if (
        step.index !== index ||
        step.inputFingerprint !== fingerprint ||
        step.inputRowCount !== rows ||
        !isDeepStrictEqual(step.operation, parameters.steps[index]) ||
        (step.operation.type === 'dedupe' ? step.rowCount > rows : step.rowCount !== rows)
      )
        throw new DatasetCleaningError(
          'INVALID_WORKER_RESULT',
          'Cleaning result does not match its recipe',
          502,
        );
      fingerprint = step.fingerprint;
      rows = step.rowCount;
    }
    if (report.fingerprint !== fingerprint || report.rowCount !== rows)
      throw new DatasetCleaningError(
        'INVALID_WORKER_RESULT',
        'Cleaning result does not match its final step',
        502,
      );
  }

  private checkAbort(signal: AbortSignal) {
    if (signal.aborted) throw new DatasetCleaningError('CANCELED', 'Cleaning was canceled', 409);
  }

  private async wait(jobId: string, signal: AbortSignal) {
    const deadline = Date.now() + (this.options.timeoutMs ?? 10 * 60_000);
    while (Date.now() < deadline && !signal.aborted) {
      const job = await this.worker.job(jobId);
      if (job.state === 'succeeded') return;
      if (job.state === 'failed' || job.state === 'canceled')
        throw new DatasetCleaningError(
          job.error?.code ?? 'CANCELED',
          job.error?.message ?? 'Cleaning was canceled',
          400,
        );
      await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs ?? 100));
    }
    await this.worker.cancel(jobId).catch(() => undefined);
    if (!(await this.terminal(jobId))) throw new CleaningWorkerStillRunningError();
    this.checkAbort(signal);
    throw new DatasetCleaningError('RESOURCE_LIMIT_EXCEEDED', 'Cleaning timed out', 408);
  }

  private async terminal(jobId: string): Promise<boolean> {
    const deadline = Date.now() + (this.options.cancelGraceMs ?? 10_000);
    while (Date.now() < deadline) {
      const job = await this.worker.job(jobId).catch(() => undefined);
      if (job && ['succeeded', 'failed', 'canceled'].includes(job.state)) return true;
      await new Promise((resolve) => setTimeout(resolve, this.options.pollIntervalMs ?? 100));
    }
    return false;
  }

  async listSessions(datasetId: string) {
    z.uuid().parse(datasetId);
    return this.datasets.cleaning.listSessions(datasetId);
  }

  async getSession(datasetId: string, sessionId: string): Promise<CleaningSessionDetail> {
    const session = await this.datasets.cleaning.getSession(sessionId);
    if (!session || session.datasetId !== datasetId)
      throw new DatasetCleaningError('NOT_FOUND', 'Cleaning history was not found', 404);
    const artifact = await this.platform.getArtifact(session.reportArtifactId);
    if (
      !artifact ||
      artifact.ownerPluginId !== 'datasets' ||
      artifact.kind !== 'dataset.cleaning.report' ||
      artifact.metadata.datasetId !== datasetId
    )
      throw new DatasetCleaningError('NOT_FOUND', 'Cleaning report was not found', 404);
    const path = await this.artifacts.resolveArtifact(artifact.storageKey);
    if ((await stat(path)).size > 16 * 1024 * 1024)
      throw new DatasetCleaningError(
        'RESOURCE_LIMIT_EXCEEDED',
        'Cleaning report exceeds its limit',
      );
    const contents = await readFile(path);
    if (createHash('sha256').update(contents).digest('hex') !== artifact.checksum)
      throw new DatasetCleaningError(
        'INVALID_ARTIFACT',
        'Cleaning report checksum does not match',
        409,
      );
    return cleaningSessionDetailSchema.parse({
      session,
      recipeVersion: await this.datasets.cleaning.getRecipeVersion(session.recipeVersionId),
      report: JSON.parse(contents.toString('utf8')),
    });
  }

  async selectStep(
    datasetId: string,
    sessionId: string,
    selectedStep: number,
    expectedRevision: number,
  ) {
    await this.getSession(datasetId, sessionId);
    try {
      await this.datasets.cleaning.selectStep(sessionId, selectedStep, expectedRevision);
    } catch (error) {
      if (error instanceof DatasetCleaningConflictError) throw error;
      throw new DatasetCleaningError(
        'VALIDATION_ERROR',
        error instanceof Error ? error.message : 'Invalid cleaning step',
        400,
        { cause: error },
      );
    }
    return this.getSession(datasetId, sessionId);
  }
}

class CleaningWorkerStillRunningError extends DatasetCleaningError {
  constructor() {
    super('WORKER_CRASHED', 'Worker has not stopped; its own workspace is retained', 503);
  }
}
