import { createHash } from 'node:crypto';
import { copyFile, readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  PlatformJobExecutionError,
  type ArtifactStore,
  type JobExecutionContext,
  type PlatformJobQueue,
  type PlatformRepository,
} from '@zhiyun/platform-core';
import type {
  AnalysisArtifactRef,
  AnalysisJob,
  AnalysisJobMetadata,
  AnalysisMethodDescriptor,
  AnalysisRecipe,
  AnalysisRepository,
  AnalysisResult,
  AnalysisSampling,
  AnalysisSeries,
  AnalysisTable,
  AnalyticsWorkerControl,
  CreateAnalysisJobInput,
  CreateAnalysisRecipeInput,
  DatasetSnapshotLookup,
} from '../contracts/index.js';

const IDEMPOTENCY_SCOPE = 'analytics:create-job';
const RESULT_LIMIT_BYTES = 64 * 1024 * 1024;

export class AnalyticsUnavailableError extends Error {
  readonly code = 'ANALYTICS_UNAVAILABLE';
}

export class AnalysisConflictError extends Error {
  readonly code = 'ANALYSIS_JOB_CONFLICT';
}

export class MethodCompatibilityError extends Error {
  readonly code = 'METHOD_INCOMPATIBLE';
}

export class MethodNotFoundError extends Error {
  readonly code = 'METHOD_NOT_FOUND';
}

export class AnalyticsCatalog {
  constructor(
    private readonly worker:
      AnalyticsWorkerControl | (() => AnalyticsWorkerControl | undefined) | undefined,
  ) {}

  async listMethods(): Promise<AnalysisMethodDescriptor[]> {
    const worker = typeof this.worker === 'function' ? this.worker() : this.worker;
    if (!worker) throw new AnalyticsUnavailableError('Analytics Worker is unavailable');
    const methods = await worker.methods();
    return methods
      .map(normalizeMethodDescriptor)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async require(methodId: string, methodVersion: string): Promise<AnalysisMethodDescriptor> {
    const method = (await this.listMethods()).find(({ id }) => id === methodId);
    if (!method) throw new MethodNotFoundError(`Analysis method not found: ${methodId}`);
    if (method.version !== methodVersion) {
      throw new MethodCompatibilityError(
        `Analysis method ${methodId}@${methodVersion} is unavailable; found ${method.version}`,
      );
    }
    return method;
  }

  validateParameters(method: AnalysisMethodDescriptor, parameters: Record<string, unknown>): void {
    const schema = method.parameterSchema;
    const properties = isObject(schema.properties) ? schema.properties : {};
    const unknown = Object.keys(parameters).filter((key) => !(key in properties));
    if (schema.additionalProperties === false && unknown.length > 0) {
      throw new MethodCompatibilityError(`Unknown method parameters: ${unknown.sort().join(', ')}`);
    }
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    const missing = required.filter((key) => parameters[key] === undefined);
    if (missing.length > 0) {
      throw new MethodCompatibilityError(`Missing method parameters: ${missing.join(', ')}`);
    }
    for (const [key, value] of Object.entries(parameters)) {
      const property = properties[key];
      if (isObject(property)) validateSchemaValue(key, value, property);
    }
  }
}

export class AnalysisRecipeService {
  constructor(
    private readonly repository: AnalysisRepository,
    private readonly catalog: AnalyticsCatalog,
  ) {}

  list(cursor?: string, limit?: number) {
    return this.repository.listRecipes(cursor, limit);
  }

  get(id: string) {
    return this.repository.getRecipe(id);
  }

  async create(input: CreateAnalysisRecipeInput): Promise<AnalysisRecipe> {
    validateRecipeInput(input);
    const method = await this.catalog.require(input.methodId, input.methodVersion);
    this.catalog.validateParameters(method, input.parameters);
    return this.repository.createRecipe(input);
  }

  async update(
    id: string,
    expectedRevision: number,
    input: CreateAnalysisRecipeInput,
  ): Promise<AnalysisRecipe | 'revision-conflict' | null> {
    validateRecipeInput(input);
    const method = await this.catalog.require(input.methodId, input.methodVersion);
    this.catalog.validateParameters(method, input.parameters);
    return this.repository.updateRecipe(id, expectedRevision, input);
  }

  delete(id: string, expectedRevision: number) {
    return this.repository.deleteRecipe(id, expectedRevision);
  }
}

export class AnalysisJobService {
  constructor(
    private readonly repository: AnalysisRepository,
    private readonly platform: PlatformRepository,
    private readonly snapshots: DatasetSnapshotLookup,
    private readonly catalog: AnalyticsCatalog,
    private readonly queue?: PlatformJobQueue,
  ) {}

  async create(input: CreateAnalysisJobInput, idempotencyKey: string): Promise<AnalysisJob> {
    validateJobInput(input);
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new AnalysisConflictError('A valid Idempotency-Key is required');
    }
    const method = await this.catalog.require(input.methodId, input.methodVersion);
    this.catalog.validateParameters(method, input.parameters);
    const snapshot = await this.snapshots.getSnapshot(input.snapshotId);
    if (!snapshot || snapshot.status !== 'ready' || !snapshot.parquetArtifactId) {
      throw new MethodCompatibilityError('Analysis requires a ready Dataset Snapshot');
    }
    if (snapshot.datasetId !== input.datasetId) {
      throw new MethodCompatibilityError('Snapshot does not belong to the selected Dataset');
    }

    const requestHash = sha256(canonicalJson(input));
    const jobId = deterministicUuid(`${IDEMPOTENCY_SCOPE}\0${idempotencyKey}`);
    const reservation = await this.platform.reserveIdempotency({
      scope: IDEMPOTENCY_SCOPE,
      key: idempotencyKey,
      requestHash,
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    if (reservation.state === 'conflict') {
      throw new AnalysisConflictError('Idempotency-Key was already used with another request');
    }
    if (reservation.state === 'completed') {
      const replayedId = responseJobId(reservation.responseBody);
      const replayed = await this.get(replayedId);
      if (!replayed) throw new AnalysisConflictError('Idempotent Analysis Job was not found');
      return replayed;
    }

    const existingJob = await this.platform.getJob(jobId);
    if (!existingJob) {
      const queuedJob = {
        id: jobId,
        ownerPluginId: 'analytics',
        type: 'analytics.job.execute',
        resourceClass: 'python-heavy',
        payload: { ...input },
        maxAttempts: 2,
      } as const;
      if (this.queue) await this.queue.enqueue(queuedJob);
      else await this.platform.enqueueJob(queuedJob);
    }
    if (!(await this.repository.getJobMetadata(jobId))) {
      await this.repository.createJobMetadata(jobId, input);
    }
    await this.platform.completeIdempotency({
      scope: IDEMPOTENCY_SCOPE,
      key: idempotencyKey,
      requestHash,
      responseStatus: 202,
      responseBody: { jobId },
    });
    return (await this.get(jobId))!;
  }

  async get(id: string): Promise<AnalysisJob | null> {
    const [metadata, job] = await Promise.all([
      this.repository.getJobMetadata(id),
      this.platform.getJob(id),
    ]);
    return metadata && job ? combineJob(metadata, job) : null;
  }

  async list(limit = 100): Promise<AnalysisJob[]> {
    const metadata = await this.repository.listJobMetadata(limit);
    const jobs = await Promise.all(metadata.map(({ id }) => this.platform.getJob(id)));
    return metadata.flatMap((item, index) => (jobs[index] ? [combineJob(item, jobs[index]!)] : []));
  }

  async cancel(id: string): Promise<AnalysisJob | null> {
    const canceled = this.queue
      ? await this.queue.cancel(id)
      : await this.platform.requestJobCancel(id);
    if (!canceled) return null;
    if (canceled.state === 'canceled') await this.repository.markJobCanceled(id);
    const metadata = await this.repository.getJobMetadata(id);
    return metadata ? combineJob(metadata, canceled) : null;
  }

  async retry(id: string, idempotencyKey: string): Promise<AnalysisJob> {
    const original = await this.get(id);
    if (!original) throw new AnalysisConflictError('Analysis Job was not found');
    if (!['failed', 'canceled', 'interrupted'].includes(original.state)) {
      throw new AnalysisConflictError('Only failed, canceled or interrupted Jobs can be retried');
    }
    return this.create(
      {
        recipeId: original.recipeId,
        datasetId: original.datasetId,
        snapshotId: original.snapshotId,
        methodId: original.methodId,
        methodVersion: original.methodVersion,
        parameters: original.parameters,
      },
      idempotencyKey,
    );
  }

  result(id: string): Promise<AnalysisResult | null> {
    return this.repository.getResult(id);
  }
}

export interface AnalysisExecutorDependencies {
  repository: AnalysisRepository;
  platform: PlatformRepository;
  snapshots: DatasetSnapshotLookup;
  artifactStore: ArtifactStore;
  worker: AnalyticsWorkerControl;
}

export function createAnalysisJobHandler(dependencies: AnalysisExecutorDependencies) {
  return async (context: JobExecutionContext): Promise<void> => {
    const metadata = await dependencies.repository.getJobMetadata(context.job.id);
    if (!metadata) {
      throw new PlatformJobExecutionError(
        'ANALYSIS_JOB_CONFLICT',
        'Analysis Job metadata is missing',
        false,
      );
    }
    const workspace = await dependencies.artifactStore.openWorkspace(context.job.id);
    let workerTerminal = false;
    try {
      await dependencies.repository.markJobStarted(context.job.id);
      const snapshot = await dependencies.snapshots.getSnapshot(metadata.snapshotId);
      if (!snapshot || snapshot.status !== 'ready' || !snapshot.parquetArtifactId) {
        throw new PlatformJobExecutionError(
          'SNAPSHOT_FAILED',
          'Dataset Snapshot is not ready',
          false,
        );
      }
      const snapshotArtifact = await dependencies.platform.getArtifact(snapshot.parquetArtifactId);
      if (!snapshotArtifact) {
        throw new PlatformJobExecutionError(
          'SNAPSHOT_FAILED',
          'Snapshot Parquet Artifact is missing',
          false,
        );
      }
      const source = await dependencies.artifactStore.resolveArtifact(snapshotArtifact.storageKey);
      const target = await workspace.resolve('snapshot.parquet');
      await copyFile(source, target);
      await context.progress(0.05, 'preparing');
      await dependencies.worker.submit({
        jobId: context.job.id,
        methodId: metadata.methodId,
        methodVersion: metadata.methodVersion,
        inputArtifactRef: 'snapshot.parquet',
        outputArtifactRef: 'analysis-result.json',
        parameters: metadata.parameters,
      });
      const workerJob = await waitForWorker(
        dependencies.worker,
        context.job.id,
        context.signal,
        context.progress,
      );
      workerTerminal = true;
      if (workerJob.state === 'canceled') {
        await dependencies.repository.markJobCanceled(context.job.id);
        throw new PlatformJobExecutionError('ANALYSIS_CANCELED', 'Analysis was canceled', false);
      }
      if (workerJob.state !== 'succeeded') {
        const code = workerJob.error?.code ?? 'WORKER_CRASHED';
        await dependencies.repository.markJobFailed(context.job.id, code);
        throw new PlatformJobExecutionError(
          code,
          workerJob.error?.message ?? 'Analytics Worker Job failed',
          workerJob.error?.retryable ?? code === 'WORKER_CRASHED',
        );
      }
      await context.persisting();
      const resultPath = await workspace.resolve('analysis-result.json');
      if ((await stat(resultPath)).size > RESULT_LIMIT_BYTES) {
        throw new PlatformJobExecutionError(
          'RESOURCE_LIMIT_EXCEEDED',
          'Structured Analysis Result exceeds 64MiB',
          false,
        );
      }
      const raw = JSON.parse(await readFile(resultPath, 'utf8')) as unknown;
      const workerResult = normalizeWorkerResult(raw);
      const workerVersion = (await dependencies.worker.version()).workerVersion;
      const artifacts: AnalysisArtifactRef[] = [];
      for (const output of workerResult.artifacts) {
        const filename = basename(output.artifactRef);
        const stored = await dependencies.artifactStore.commitWorkspaceFile(
          context.job.id,
          output.artifactRef,
          `analytics/${context.job.id}/${filename}`,
        );
        const artifact = await dependencies.platform.createArtifact({
          ownerPluginId: 'analytics',
          kind: output.kind,
          filename,
          contentType: output.contentType,
          ...stored,
          metadata: {
            jobId: context.job.id,
            datasetId: metadata.datasetId,
            snapshotId: metadata.snapshotId,
            methodId: metadata.methodId,
            methodVersion: metadata.methodVersion,
          },
        });
        artifacts.push({
          id: artifact.id,
          kind: artifact.kind,
          contentType: artifact.contentType,
          filename: artifact.filename,
        });
      }
      await dependencies.repository.saveResult({
        jobId: context.job.id,
        datasetId: metadata.datasetId,
        snapshotId: metadata.snapshotId,
        methodId: metadata.methodId,
        methodVersion: metadata.methodVersion,
        summary: workerResult.summary,
        metrics: workerResult.metrics,
        tables: workerResult.tables,
        series: workerResult.series,
        artifacts,
        warnings: workerResult.warnings,
        sampling: workerResult.sampling,
        workerVersion,
      });
    } catch (error) {
      if (context.signal.aborted && !workerTerminal) {
        await dependencies.repository.markJobCanceled(context.job.id).catch(() => undefined);
      }
      throw error;
    } finally {
      if (workerTerminal || !context.signal.aborted) {
        await dependencies.artifactStore.removeWorkspace(context.job.id).catch(() => undefined);
      }
    }
  };
}

async function waitForWorker(
  worker: AnalyticsWorkerControl,
  jobId: string,
  signal: AbortSignal,
  progress: (progress: number, phase: string) => Promise<void>,
) {
  while (true) {
    if (signal.aborted) await worker.cancel(jobId).catch(() => undefined);
    const job = await worker.job(jobId);
    await progress(Math.max(0.05, Math.min(0.9, job.progress * 0.85 + 0.05)), job.phase);
    if (['canceled', 'succeeded', 'failed'].includes(job.state)) return job;
    await delay(100);
  }
}

function combineJob(
  metadata: AnalysisJobMetadata,
  job: NonNullable<Awaited<ReturnType<PlatformRepository['getJob']>>>,
): AnalysisJob {
  return {
    ...metadata,
    state: job.state,
    phase: job.phase,
    progress: job.progress,
    attempt: job.attempt,
    error: job.error,
  };
}

function normalizeMethodDescriptor(value: unknown): AnalysisMethodDescriptor {
  if (!value || typeof value !== 'object') throw new Error('Invalid Analysis Method descriptor');
  const method = value as Record<string, unknown>;
  if (
    typeof method.id !== 'string' ||
    typeof method.version !== 'string' ||
    typeof method.category !== 'string' ||
    typeof method.titleKey !== 'string' ||
    typeof method.descriptionKey !== 'string' ||
    !Array.isArray(method.supportedFieldTypes) ||
    !isObject(method.parameterSchema) ||
    !isObject(method.outputSchema) ||
    !Array.isArray(method.recommendedVisualizations) ||
    !isObject(method.resourceLimits) ||
    typeof method.supportsSampling !== 'boolean'
  ) {
    throw new Error('Invalid Analysis Method descriptor');
  }
  return method as unknown as AnalysisMethodDescriptor;
}

interface WorkerResult {
  summary: Record<string, unknown>;
  metrics: Record<string, unknown>;
  tables: AnalysisTable[];
  series: AnalysisSeries[];
  artifacts: Array<{ kind: string; artifactRef: string; contentType: string }>;
  warnings: string[];
  sampling: AnalysisSampling;
}

function normalizeWorkerResult(value: unknown): WorkerResult {
  if (!isObject(value)) throw new Error('Invalid structured Analysis Result');
  const tables = Array.isArray(value.tables) ? value.tables : [];
  const series = Array.isArray(value.series) ? value.series : [];
  const artifacts = Array.isArray(value.artifacts) ? value.artifacts : [];
  const warnings = Array.isArray(value.warnings) ? value.warnings : [];
  if (
    !isObject(value.summary) ||
    !isObject(value.metrics) ||
    !isObject(value.sampling) ||
    tables.length > 50 ||
    series.length > 50 ||
    artifacts.length > 20 ||
    warnings.length > 1_000 ||
    tables.some(
      (table) =>
        !isObject(table) ||
        typeof table.id !== 'string' ||
        !Array.isArray(table.rows) ||
        table.rows.length > 10_000 ||
        table.rows.some((row) => !isObject(row)),
    ) ||
    series.some(
      (item) =>
        !isObject(item) ||
        typeof item.id !== 'string' ||
        typeof item.type !== 'string' ||
        !Array.isArray(item.data) ||
        item.data.length > 10_000 ||
        item.data.some((point) => !isObject(point)),
    ) ||
    artifacts.some(
      (artifact) =>
        !isObject(artifact) ||
        typeof artifact.kind !== 'string' ||
        typeof artifact.artifactRef !== 'string' ||
        typeof artifact.contentType !== 'string',
    ) ||
    warnings.some((warning) => typeof warning !== 'string' || warning.length > 4_000)
  ) {
    throw new Error('Invalid structured Analysis Result');
  }
  const sampling = value.sampling;
  if (
    typeof sampling.applied !== 'boolean' ||
    !Number.isInteger(sampling.inputRows) ||
    !Number.isInteger(sampling.sampleRows) ||
    (sampling.seed !== null && !Number.isInteger(sampling.seed))
  ) {
    throw new Error('Invalid Analysis sampling metadata');
  }
  return {
    summary: value.summary,
    metrics: value.metrics,
    tables: tables as AnalysisTable[],
    series: series as AnalysisSeries[],
    artifacts: artifacts as WorkerResult['artifacts'],
    warnings: warnings as string[],
    sampling: sampling as unknown as AnalysisSampling,
  };
}

function validateRecipeInput(input: CreateAnalysisRecipeInput): void {
  if (!input.name.trim() || input.name.length > 200) throw new Error('Recipe name is required');
  validateJobInput({ ...input, snapshotId: crypto.randomUUID() });
}

function validateJobInput(input: CreateAnalysisJobInput): void {
  if (!isUuid(input.datasetId) || !isUuid(input.snapshotId)) {
    throw new MethodCompatibilityError('Dataset and Snapshot IDs must be UUIDs');
  }
  if (!input.methodId || input.methodId.length > 128 || !input.methodVersion) {
    throw new MethodCompatibilityError('Method ID and version are required');
  }
  if (!isObject(input.parameters) || JSON.stringify(input.parameters).length > 1_000_000) {
    throw new MethodCompatibilityError('Analysis parameters are invalid or oversized');
  }
}

function responseJobId(value: unknown): string {
  if (!isObject(value) || typeof value.jobId !== 'string') {
    throw new AnalysisConflictError('Invalid idempotent response');
  }
  return value.jobId;
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash('sha256').update(value).digest().subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function validateSchemaValue(name: string, value: unknown, schema: Record<string, unknown>): void {
  const expected = schema.type;
  const validType =
    expected === 'string'
      ? typeof value === 'string'
      : expected === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : expected === 'integer'
          ? Number.isInteger(value)
          : expected === 'boolean'
            ? typeof value === 'boolean'
            : expected === 'array'
              ? Array.isArray(value)
              : true;
  if (!validType) throw new MethodCompatibilityError(`Invalid parameter type: ${name}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw new MethodCompatibilityError(`Invalid parameter value: ${name}`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      throw new MethodCompatibilityError(`Parameter is too short: ${name}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      throw new MethodCompatibilityError(`Parameter is too long: ${name}`);
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      throw new MethodCompatibilityError(`Parameter is below its minimum: ${name}`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      throw new MethodCompatibilityError(`Parameter exceeds its maximum: ${name}`);
    }
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) {
      throw new MethodCompatibilityError(`Parameter must exceed its minimum: ${name}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      throw new MethodCompatibilityError(`Parameter has too few items: ${name}`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      throw new MethodCompatibilityError(`Parameter has too many items: ${name}`);
    }
    if (
      schema.uniqueItems === true &&
      new Set(value.map((item) => canonicalJson(item))).size < value.length
    ) {
      throw new MethodCompatibilityError(`Parameter items must be unique: ${name}`);
    }
    if (isObject(schema.items)) {
      value.forEach((item, index) =>
        validateSchemaValue(`${name}[${index}]`, item, schema.items as Record<string, unknown>),
      );
    }
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
