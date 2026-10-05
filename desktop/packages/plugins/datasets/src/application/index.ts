import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ArtifactStore, PlatformRepository } from '@zhiyun/platform-core';
import type {
  Dataset,
  DatasetCommitInput,
  DatasetCommitResult,
  DatasetRepository,
  DatasetSnapshot,
  DatasetsServiceContract,
  SnapshotWorkerClient,
} from '../contracts/index.js';
import { DatasetFingerprintBuilder } from '../domain/index.js';

export class DatasetsService implements DatasetsServiceContract {
  constructor(private readonly repository: DatasetRepository) {}

  getDataset(id: string): Promise<Dataset | null> {
    return this.repository.getDataset(id);
  }

  createProjection(input: DatasetCommitInput): Promise<DatasetCommitResult> {
    return this.repository.commitRunRecords(input);
  }

  getSnapshot(id: string): Promise<DatasetSnapshot | null> {
    return this.repository.getSnapshot(id);
  }
}

export interface DatasetSnapshotServiceOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  cancelGraceMs?: number;
}

export interface MaterializeSnapshotResult {
  snapshot: DatasetSnapshot;
  reused: boolean;
  inProgress: boolean;
}

export class DatasetSnapshotService {
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly cancelGraceMs: number;

  constructor(
    private readonly repository: DatasetRepository,
    private readonly platformRepository: PlatformRepository,
    private readonly artifactStore: ArtifactStore,
    private readonly worker: SnapshotWorkerClient,
    options: DatasetSnapshotServiceOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.cancelGraceMs = options.cancelGraceMs ?? 10_000;
  }

  async materialize(datasetId: string, signal?: AbortSignal): Promise<MaterializeSnapshotResult> {
    const jobId = randomUUID();
    const workspace = await this.artifactStore.openWorkspace(jobId);
    const inputPath = await workspace.resolve('input.ndjson');
    let claimedSnapshot: DatasetSnapshot | undefined;
    let preserveWorkspace = false;
    try {
      const spooled = await this.repository.withConsistentSnapshotRead(
        datasetId,
        async ({ dataset, records }) => {
          const fingerprint = new DatasetFingerprintBuilder(
            dataset.schemaVersion,
            dataset.settings,
          );
          const output = createWriteStream(inputPath, { flags: 'wx', mode: 0o600 });
          let rowCount = 0;
          try {
            for await (const record of records) {
              if (signal?.aborted) throw abortError();
              fingerprint.add(record);
              if (!record.removed) rowCount += 1;
              const line = `${JSON.stringify(record)}\n`;
              if (!output.write(line)) await once(output, 'drain');
            }
            output.end();
            await once(output, 'close');
          } catch (error) {
            output.destroy();
            throw error;
          }
          return { fingerprint: fingerprint.digest(), rowCount };
        },
      );
      const claim = await this.repository.claimSnapshotMaterialization(
        datasetId,
        spooled.fingerprint,
      );
      claimedSnapshot = claim.snapshot;
      if (claim.reused) {
        return { snapshot: claim.snapshot, reused: true, inProgress: false };
      }
      if (!claim.claimed) {
        return { snapshot: claim.snapshot, reused: false, inProgress: true };
      }

      await this.worker.submit({
        jobId,
        methodId: 'dataset.normalize_snapshot',
        methodVersion: '1.0.0',
        inputArtifactRef: 'input.ndjson',
        outputArtifactRef: 'normalize-result.json',
        parameters: { fingerprint: spooled.fingerprint },
      });
      const workerJob = await this.waitForWorker(jobId, signal);
      if (workerJob.state !== 'succeeded') {
        const code = workerJob.error?.code ?? 'SNAPSHOT_FAILED';
        throw new Error(`${code}: ${workerJob.error?.message ?? 'Snapshot normalization failed'}`);
      }
      const resultPath = await workspace.resolve('normalize-result.json');
      const result = normalizeResult(
        JSON.parse(await readFile(resultPath, 'utf8')),
        spooled.rowCount,
      );
      const storagePrefix = `datasets/${datasetId}/snapshots/${spooled.fingerprint}`;
      const [parquetFile, manifestFile] = await Promise.all([
        this.artifactStore.commitWorkspaceFile(
          jobId,
          result.parquetArtifactRef,
          `${storagePrefix}/snapshot.parquet`,
        ),
        this.artifactStore.commitWorkspaceFile(
          jobId,
          result.manifestArtifactRef,
          `${storagePrefix}/schema-manifest.json`,
        ),
      ]);
      const [parquetArtifact, manifestArtifact] = await Promise.all([
        this.platformRepository.createArtifact({
          ownerPluginId: 'datasets',
          kind: 'dataset.snapshot.parquet',
          filename: 'snapshot.parquet',
          contentType: 'application/vnd.apache.parquet',
          ...parquetFile,
          metadata: { datasetId, snapshotId: claim.snapshot.id, fingerprint: spooled.fingerprint },
        }),
        this.platformRepository.createArtifact({
          ownerPluginId: 'datasets',
          kind: 'dataset.snapshot.schema-manifest',
          filename: 'schema-manifest.json',
          contentType: 'application/json',
          ...manifestFile,
          metadata: { datasetId, snapshotId: claim.snapshot.id, fingerprint: spooled.fingerprint },
        }),
      ]);
      const snapshot = await this.repository.completeSnapshotMaterialization({
        snapshotId: claim.snapshot.id,
        parquetArtifactId: parquetArtifact.id,
        manifestArtifactId: manifestArtifact.id,
        rowCount: result.rowCount,
        warnings: result.warnings,
      });
      return { snapshot, reused: false, inProgress: false };
    } catch (error) {
      preserveWorkspace = error instanceof SnapshotWorkerStillRunningError;
      if (claimedSnapshot?.status === 'preparing' && !preserveWorkspace) {
        await this.repository
          .failSnapshotMaterialization(
            claimedSnapshot.id,
            error instanceof Error ? error.message : String(error),
          )
          .catch(() => undefined);
      }
      throw error;
    } finally {
      if (!preserveWorkspace) {
        await this.artifactStore.removeWorkspace(jobId).catch(() => undefined);
      }
    }
  }

  private async waitForWorker(jobId: string, signal?: AbortSignal) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        await this.worker.cancel(jobId).catch(() => undefined);
        if (!(await this.waitForTerminal(jobId, this.cancelGraceMs))) {
          throw new SnapshotWorkerStillRunningError(jobId);
        }
        throw abortError();
      }
      const job = await this.worker.job(jobId);
      if (['canceled', 'succeeded', 'failed'].includes(job.state)) return job;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, this.pollIntervalMs));
    }
    await this.worker.cancel(jobId).catch(() => undefined);
    if (!(await this.waitForTerminal(jobId, this.cancelGraceMs))) {
      throw new SnapshotWorkerStillRunningError(jobId);
    }
    throw new Error('RESOURCE_LIMIT_EXCEEDED: Snapshot normalization timed out');
  }

  private async waitForTerminal(jobId: string, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      const job = await this.worker.job(jobId).catch(() => undefined);
      if (job && ['canceled', 'succeeded', 'failed'].includes(job.state)) return true;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, this.pollIntervalMs));
    }
    return false;
  }
}

class SnapshotWorkerStillRunningError extends Error {
  constructor(jobId: string) {
    super(`WORKER_CRASHED: Worker Job ${jobId} exceeded the cancellation budget`);
    this.name = 'SnapshotWorkerStillRunningError';
  }
}

function normalizeResult(
  value: unknown,
  expectedRowCount: number,
): {
  parquetArtifactRef: string;
  manifestArtifactRef: string;
  rowCount: number;
  warnings: string[];
} {
  if (!value || typeof value !== 'object')
    throw new Error('SNAPSHOT_FAILED: Invalid Worker result');
  const result = value as Record<string, unknown>;
  if (
    typeof result.parquetArtifactRef !== 'string' ||
    typeof result.manifestArtifactRef !== 'string' ||
    !Number.isInteger(result.rowCount) ||
    result.rowCount !== expectedRowCount ||
    !Array.isArray(result.warnings) ||
    result.warnings.length > 10_000 ||
    result.warnings.some((warning) => typeof warning !== 'string' || warning.length > 4_000)
  ) {
    throw new Error('SNAPSHOT_FAILED: Invalid Worker result');
  }
  return {
    parquetArtifactRef: result.parquetArtifactRef,
    manifestArtifactRef: result.manifestArtifactRef,
    rowCount: result.rowCount as number,
    warnings: result.warnings as string[],
  };
}

function abortError(): Error {
  const error = new Error('Snapshot materialization was canceled');
  error.name = 'AbortError';
  return error;
}
