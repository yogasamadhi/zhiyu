import { createHash } from 'node:crypto';
import { copyFile, readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  PlatformJobExecutionError,
  type ArtifactStore,
  type JobExecutionContext,
  type PlatformRepository,
} from '@zhiyun/platform-core';
import type {
  Corpus,
  CorpusArtifactRef,
  CorpusBuild,
  CorpusBuildMetadata,
  CorpusRecipe,
  CorpusRepository,
  CorpusSnapshotLookup,
  CorpusVersionStats,
  CorpusWorkerControl,
  CreateCorpusBuildInput,
  CreateCorpusInput,
  CreateCorpusRecipeInput,
} from '../contracts/index.js';

const IDEMPOTENCY_SCOPE = 'corpus:create-build';
const RESULT_LIMIT_BYTES = 4 * 1024 * 1024;

export class CorpusUnavailableError extends Error {
  readonly code = 'ANALYTICS_UNAVAILABLE';
}

export class CorpusConflictError extends Error {
  readonly code = 'CORPUS_VERSION_CONFLICT';
}

export class CorpusBuildError extends Error {
  readonly code = 'CORPUS_BUILD_FAILED';
}

export class CorpusService {
  constructor(private readonly repository: CorpusRepository) {}

  list(cursor?: string, limit?: number) {
    return this.repository.listCorpora(cursor, limit);
  }

  get(id: string) {
    return this.repository.getCorpus(id);
  }

  create(input: CreateCorpusInput): Promise<Corpus> {
    validateCorpusInput(input);
    return this.repository.createCorpus(input);
  }

  update(id: string, revision: number, input: CreateCorpusInput) {
    validateCorpusInput(input);
    return this.repository.updateCorpus(id, revision, input);
  }

  delete(id: string, revision: number) {
    return this.repository.deleteCorpus(id, revision);
  }
}

export class CorpusRecipeService {
  constructor(private readonly repository: CorpusRepository) {}

  list(corpusId: string) {
    return this.repository.listRecipes(corpusId);
  }

  async create(corpusId: string, input: CreateCorpusRecipeInput): Promise<CorpusRecipe> {
    if (!(await this.repository.getCorpus(corpusId)))
      throw new CorpusBuildError('Corpus not found');
    validateRecipeInput(input);
    return this.repository.createRecipe(corpusId, normalizeRecipeInput(input));
  }

  async update(corpusId: string, id: string, revision: number, input: CreateCorpusRecipeInput) {
    validateRecipeInput(input);
    return this.repository.updateRecipe(corpusId, id, revision, normalizeRecipeInput(input));
  }

  delete(corpusId: string, id: string, revision: number) {
    return this.repository.deleteRecipe(corpusId, id, revision);
  }
}

export class CorpusBuildService {
  constructor(
    private readonly repository: CorpusRepository,
    private readonly platform: PlatformRepository,
    private readonly snapshots: CorpusSnapshotLookup,
    private readonly workerAvailable = true,
  ) {}

  async create(
    corpusId: string,
    input: CreateCorpusBuildInput,
    idempotencyKey: string,
  ): Promise<CorpusBuild> {
    if (!this.workerAvailable) throw new CorpusUnavailableError('Analytics Worker is unavailable');
    if (!idempotencyKey || idempotencyKey.length > 200) {
      throw new CorpusConflictError('A valid Idempotency-Key is required');
    }
    if (!isUuid(corpusId) || !isUuid(input.recipeId) || !isUuid(input.snapshotId)) {
      throw new CorpusBuildError('Corpus, Recipe and Snapshot IDs must be UUIDs');
    }
    const [corpus, recipe, snapshot] = await Promise.all([
      this.repository.getCorpus(corpusId),
      this.repository.getRecipe(input.recipeId),
      this.snapshots.getSnapshot(input.snapshotId),
    ]);
    if (!corpus || !recipe || recipe.corpusId !== corpusId) {
      throw new CorpusBuildError('Corpus Recipe was not found');
    }
    if (
      !snapshot ||
      snapshot.status !== 'ready' ||
      !snapshot.parquetArtifactId ||
      snapshot.datasetId !== corpus.datasetId
    ) {
      throw new CorpusBuildError('Corpus Build requires a ready Snapshot for its Dataset');
    }
    if (
      recipe.snapshotPolicy.mode === 'pinned' &&
      recipe.snapshotPolicy.snapshotId !== snapshot.id
    ) {
      throw new CorpusBuildError('Snapshot does not match the pinned Recipe policy');
    }
    const request = { corpusId, ...input, recipeRevision: recipe.revision };
    const requestHash = sha256(canonicalJson(request));
    const jobId = deterministicUuid(`${IDEMPOTENCY_SCOPE}\0${idempotencyKey}`);
    const reservation = await this.platform.reserveIdempotency({
      scope: IDEMPOTENCY_SCOPE,
      key: idempotencyKey,
      requestHash,
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    if (reservation.state === 'conflict') {
      throw new CorpusConflictError('Idempotency-Key was already used with another request');
    }
    if (reservation.state === 'completed') {
      const replayedId = responseBuildId(reservation.responseBody);
      const replayed = await this.get(replayedId);
      if (!replayed) throw new CorpusConflictError('Idempotent Corpus Build was not found');
      return replayed;
    }
    if (!(await this.platform.getJob(jobId))) {
      await this.platform.enqueueJob({
        id: jobId,
        ownerPluginId: 'corpus',
        type: 'corpus.build.execute',
        resourceClass: 'python-heavy',
        payload: request,
        maxAttempts: 2,
      });
    }
    if (!(await this.repository.getBuildMetadata(jobId))) {
      await this.repository.createBuildMetadata(jobId, {
        corpusId,
        recipeId: recipe.id,
        recipeRevision: recipe.revision,
        datasetId: corpus.datasetId,
        snapshotId: snapshot.id,
      });
    }
    await this.platform.completeIdempotency({
      scope: IDEMPOTENCY_SCOPE,
      key: idempotencyKey,
      requestHash,
      responseStatus: 202,
      responseBody: { buildId: jobId },
    });
    return (await this.get(jobId))!;
  }

  async get(id: string): Promise<CorpusBuild | null> {
    const [metadata, job] = await Promise.all([
      this.repository.getBuildMetadata(id),
      this.platform.getJob(id),
    ]);
    return metadata && job ? combineBuild(metadata, job) : null;
  }

  async list(corpusId?: string, limit = 100): Promise<CorpusBuild[]> {
    const metadata = await this.repository.listBuildMetadata(corpusId, limit);
    const jobs = await Promise.all(metadata.map(({ id }) => this.platform.getJob(id)));
    return metadata.flatMap((item, index) =>
      jobs[index] ? [combineBuild(item, jobs[index]!)] : [],
    );
  }

  async cancel(id: string): Promise<CorpusBuild | null> {
    const job = await this.platform.requestJobCancel(id);
    if (!job) return null;
    if (job.state === 'canceled') await this.repository.markBuildCanceled(id);
    const metadata = await this.repository.getBuildMetadata(id);
    return metadata ? combineBuild(metadata, job) : null;
  }

  async retry(id: string, idempotencyKey: string): Promise<CorpusBuild> {
    const original = await this.get(id);
    if (!original) throw new CorpusBuildError('Corpus Build was not found');
    if (!['failed', 'canceled', 'interrupted'].includes(original.state)) {
      throw new CorpusConflictError('Only failed, canceled or interrupted Builds can be retried');
    }
    return this.create(
      original.corpusId,
      { recipeId: original.recipeId, snapshotId: original.snapshotId },
      idempotencyKey,
    );
  }

  getVersion(id: string) {
    return this.repository.getVersion(id);
  }

  listVersions(corpusId: string, limit?: number) {
    return this.repository.listVersions(corpusId, limit);
  }
}

export interface CorpusExecutorDependencies {
  repository: CorpusRepository;
  platform: PlatformRepository;
  snapshots: CorpusSnapshotLookup;
  artifactStore: ArtifactStore;
  worker: CorpusWorkerControl;
}

export function createCorpusBuildHandler(dependencies: CorpusExecutorDependencies) {
  return async (context: JobExecutionContext): Promise<void> => {
    const metadata = await dependencies.repository.getBuildMetadata(context.job.id);
    if (!metadata) {
      throw new PlatformJobExecutionError(
        'CORPUS_BUILD_FAILED',
        'Corpus Build metadata is missing',
        false,
      );
    }
    const workspace = await dependencies.artifactStore.openWorkspace(context.job.id);
    let workerTerminal = false;
    try {
      const [recipe, snapshot] = await Promise.all([
        dependencies.repository.getRecipe(metadata.recipeId),
        dependencies.snapshots.getSnapshot(metadata.snapshotId),
      ]);
      if (!recipe || recipe.revision !== metadata.recipeRevision) {
        throw new PlatformJobExecutionError(
          'CORPUS_VERSION_CONFLICT',
          'Corpus Recipe revision is unavailable',
          false,
        );
      }
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
          'Snapshot Artifact is missing',
          false,
        );
      }
      await dependencies.repository.markBuildStarted(context.job.id);
      await copyFile(
        await dependencies.artifactStore.resolveArtifact(snapshotArtifact.storageKey),
        await workspace.resolve('snapshot.parquet'),
      );
      await context.progress(0.05, 'preparing');
      await dependencies.worker.submit({
        jobId: context.job.id,
        methodId: 'corpus.build',
        methodVersion: '1.0.0',
        inputArtifactRef: 'snapshot.parquet',
        outputArtifactRef: 'corpus-result.json',
        parameters: {
          datasetId: metadata.datasetId,
          snapshotId: metadata.snapshotId,
          snapshotFingerprint: snapshot.fingerprint,
          sourceRunId: snapshot.sourceRunId,
          recipeId: metadata.recipeId,
          recipeRevision: metadata.recipeRevision,
          selectedTextFields: recipe.selectedTextFields,
          metadataFields: recipe.metadataFields,
          stripHtml: recipe.stripHtml,
          unicodeNormalization: recipe.unicodeNormalization,
          deduplication: recipe.deduplication,
          nearDuplicateThreshold: recipe.nearDuplicateThreshold,
          chunkSize: recipe.chunkSize,
          chunkOverlap: recipe.chunkOverlap,
          languagePolicy: recipe.languagePolicy,
          outputFormats: recipe.outputFormats,
        },
      });
      const workerJob = await waitForWorker(
        dependencies.worker,
        context.job.id,
        context.signal,
        context.progress,
      );
      workerTerminal = true;
      if (workerJob.state === 'canceled') {
        await dependencies.repository.markBuildCanceled(context.job.id);
        throw new PlatformJobExecutionError(
          'CORPUS_BUILD_CANCELED',
          'Corpus Build was canceled',
          false,
        );
      }
      if (workerJob.state !== 'succeeded') {
        const code = workerJob.error?.code ?? 'WORKER_CRASHED';
        await dependencies.repository.markBuildFailed(context.job.id, code);
        throw new PlatformJobExecutionError(
          code,
          workerJob.error?.message ?? 'Corpus Worker Job failed',
          workerJob.error?.retryable ?? code === 'WORKER_CRASHED',
        );
      }
      await context.persisting();
      const resultPath = await workspace.resolve('corpus-result.json');
      if ((await stat(resultPath)).size > RESULT_LIMIT_BYTES) {
        throw new PlatformJobExecutionError(
          'RESOURCE_LIMIT_EXCEEDED',
          'Corpus result metadata exceeds 4MiB',
          false,
        );
      }
      const result = normalizeWorkerResult(JSON.parse(await readFile(resultPath, 'utf8')));
      const artifacts: CorpusArtifactRef[] = [];
      for (const output of result.artifacts) {
        const filename = basename(output.artifactRef);
        const stored = await dependencies.artifactStore.commitWorkspaceFile(
          context.job.id,
          output.artifactRef,
          `corpus/${metadata.corpusId}/${result.manifest.corpusFingerprint}/${filename}`,
        );
        if (stored.checksum !== output.checksum || stored.size !== output.size) {
          throw new PlatformJobExecutionError(
            'CORPUS_BUILD_FAILED',
            `Corpus Artifact checksum mismatch: ${filename}`,
            false,
          );
        }
        const artifact = await dependencies.platform.createArtifact({
          ownerPluginId: 'corpus',
          kind: output.kind,
          filename,
          contentType: output.contentType,
          ...stored,
          metadata: {
            corpusId: metadata.corpusId,
            buildId: metadata.id,
            snapshotId: metadata.snapshotId,
            fingerprint: result.manifest.corpusFingerprint,
          },
        });
        artifacts.push({
          id: artifact.id,
          kind: artifact.kind,
          contentType: artifact.contentType,
          filename: artifact.filename,
          checksum: artifact.checksum,
          size: artifact.size,
        });
      }
      await dependencies.repository.saveVersion({
        corpusId: metadata.corpusId,
        buildId: metadata.id,
        datasetId: metadata.datasetId,
        snapshotId: metadata.snapshotId,
        snapshotFingerprint: snapshot.fingerprint,
        recipeId: metadata.recipeId,
        recipeRevision: metadata.recipeRevision,
        fingerprint: result.manifest.corpusFingerprint,
        workerVersion: result.manifest.workerVersion,
        stats: manifestStats(result.manifest),
        artifacts,
      });
    } catch (error) {
      if (context.signal.aborted && !workerTerminal) {
        await dependencies.repository.markBuildCanceled(context.job.id).catch(() => undefined);
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
  worker: CorpusWorkerControl,
  jobId: string,
  signal: AbortSignal,
  progress: (progress: number, phase: string) => Promise<void>,
) {
  while (true) {
    if (signal.aborted) await worker.cancel(jobId).catch(() => undefined);
    const job = await worker.job(jobId);
    await progress(Math.max(0.05, Math.min(0.9, job.progress * 0.85 + 0.05)), job.phase);
    if (['canceled', 'succeeded', 'failed'].includes(job.state)) return job;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
}

function combineBuild(
  metadata: CorpusBuildMetadata,
  job: NonNullable<Awaited<ReturnType<PlatformRepository['getJob']>>>,
): CorpusBuild {
  return {
    ...metadata,
    state: job.state,
    phase: job.phase,
    progress: job.progress,
    attempt: job.attempt,
    error: job.error,
  };
}

interface WorkerManifest extends Record<string, unknown> {
  corpusFingerprint: string;
  workerVersion: string;
  inputRowCount: number;
  documentCount: number;
  chunkCount: number;
  characterCount: number;
  failureCount: number;
  languages: Record<string, number>;
  deduplication: { exactDuplicates: number; nearDuplicates: number; threshold: number };
}

interface WorkerCorpusResult {
  manifest: WorkerManifest;
  artifacts: Array<{
    kind: string;
    artifactRef: string;
    contentType: string;
    checksum: string;
    size: number;
  }>;
}

function normalizeWorkerResult(value: unknown): WorkerCorpusResult {
  if (!isObject(value) || !isObject(value.manifest) || !Array.isArray(value.artifacts)) {
    throw new CorpusBuildError('Invalid structured Corpus Result');
  }
  const manifest = value.manifest;
  const artifacts = value.artifacts;
  const requiredFiles = new Set([
    'documents.parquet',
    'chunks.parquet',
    'corpus.jsonl',
    'manifest.json',
  ]);
  if (
    typeof manifest.corpusFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.corpusFingerprint) ||
    typeof manifest.workerVersion !== 'string' ||
    !isObject(manifest.languages) ||
    !isObject(manifest.deduplication) ||
    artifacts.length < 4 ||
    artifacts.length > 5 ||
    artifacts.some(
      (artifact) =>
        !isObject(artifact) ||
        typeof artifact.kind !== 'string' ||
        typeof artifact.artifactRef !== 'string' ||
        !/^[A-Za-z0-9._-]{1,255}$/.test(artifact.artifactRef) ||
        typeof artifact.contentType !== 'string' ||
        typeof artifact.checksum !== 'string' ||
        !/^[a-f0-9]{64}$/.test(artifact.checksum) ||
        !Number.isSafeInteger(artifact.size) ||
        Number(artifact.size) < 0,
    )
  ) {
    throw new CorpusBuildError('Invalid structured Corpus Result');
  }
  for (const artifact of artifacts)
    requiredFiles.delete(String((artifact as Record<string, unknown>).artifactRef));
  if (requiredFiles.size) throw new CorpusBuildError('Corpus Result omitted required Artifacts');
  manifestStats(manifest as WorkerManifest);
  return value as unknown as WorkerCorpusResult;
}

function manifestStats(manifest: WorkerManifest): CorpusVersionStats {
  const numericKeys = [
    'inputRowCount',
    'documentCount',
    'chunkCount',
    'characterCount',
    'failureCount',
  ] as const;
  if (numericKeys.some((key) => !Number.isSafeInteger(manifest[key]) || manifest[key] < 0)) {
    throw new CorpusBuildError('Corpus Manifest contains invalid statistics');
  }
  const deduplication = manifest.deduplication;
  if (
    !Number.isSafeInteger(deduplication.exactDuplicates) ||
    !Number.isSafeInteger(deduplication.nearDuplicates)
  ) {
    throw new CorpusBuildError('Corpus Manifest contains invalid deduplication statistics');
  }
  const languages = Object.fromEntries(
    Object.entries(manifest.languages).map(([key, value]) => {
      if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new CorpusBuildError('Corpus Manifest contains invalid language statistics');
      }
      return [key, Number(value)];
    }),
  );
  return {
    inputRowCount: manifest.inputRowCount,
    documentCount: manifest.documentCount,
    chunkCount: manifest.chunkCount,
    characterCount: manifest.characterCount,
    failureCount: manifest.failureCount,
    exactDuplicates: deduplication.exactDuplicates,
    nearDuplicates: deduplication.nearDuplicates,
    languages,
  };
}

function validateCorpusInput(input: CreateCorpusInput): void {
  if (!input.name.trim() || input.name.length > 200 || !isUuid(input.datasetId)) {
    throw new CorpusBuildError('Corpus name and Dataset ID are required');
  }
}

function validateRecipeInput(input: CreateCorpusRecipeInput): void {
  if (!input.name.trim() || input.name.length > 200)
    throw new CorpusBuildError('Recipe name is required');
  validateFields(input.selectedTextFields, 'selectedTextFields', true);
  validateFields(input.metadataFields, 'metadataFields', false);
  if (
    !['NFC', 'NFKC'].includes(input.unicodeNormalization) ||
    !['none', 'exact', 'exact-and-near'].includes(input.deduplication) ||
    !['zh-en-first', 'generic'].includes(input.languagePolicy) ||
    !Number.isFinite(input.nearDuplicateThreshold) ||
    input.nearDuplicateThreshold < 0.5 ||
    input.nearDuplicateThreshold > 1 ||
    !Number.isInteger(input.chunkSize) ||
    input.chunkSize < 100 ||
    input.chunkSize > 10_000 ||
    !Number.isInteger(input.chunkOverlap) ||
    input.chunkOverlap < 0 ||
    input.chunkOverlap >= input.chunkSize ||
    input.chunkOverlap > 2_000 ||
    !Array.isArray(input.outputFormats) ||
    input.outputFormats.some((item) => !['parquet', 'jsonl', 'markdown'].includes(item))
  ) {
    throw new CorpusBuildError('Corpus Recipe contains invalid controlled parameters');
  }
  if (
    !isObject(input.snapshotPolicy) ||
    !['latest', 'pinned'].includes(String(input.snapshotPolicy.mode)) ||
    (input.snapshotPolicy.mode === 'pinned' && !isUuid(input.snapshotPolicy.snapshotId))
  ) {
    throw new CorpusBuildError('Corpus Snapshot policy is invalid');
  }
}

function normalizeRecipeInput(input: CreateCorpusRecipeInput): CreateCorpusRecipeInput {
  return {
    ...input,
    selectedTextFields: [...input.selectedTextFields],
    metadataFields: [...input.metadataFields],
    outputFormats: [...new Set([...input.outputFormats, 'parquet', 'jsonl'] as const)].sort(),
  };
}

function validateFields(value: unknown, name: string, required: boolean): void {
  if (
    !Array.isArray(value) ||
    (required && value.length === 0) ||
    value.length > 100 ||
    value.some((item) => typeof item !== 'string' || !item || item.length > 255) ||
    new Set(value).size !== value.length
  ) {
    throw new CorpusBuildError(`Invalid ${name}`);
  }
}

function responseBuildId(value: unknown): string {
  if (!isObject(value) || typeof value.buildId !== 'string') {
    throw new CorpusConflictError('Invalid idempotent Corpus response');
  }
  return value.buildId;
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
