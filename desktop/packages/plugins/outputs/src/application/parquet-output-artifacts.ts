import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  MaterializedOutputArtifact,
  OutputArtifactMaterializationInput,
} from '@zhiyun/outputs';
import type { ArtifactStore } from '@zhiyun/platform-core';

interface OutputParquetWorkerJob {
  state: 'queued' | 'running' | 'canceling' | 'canceled' | 'succeeded' | 'failed';
  error?: { code: string; message: string; retryable: boolean } | null;
}

export interface OutputParquetWorker {
  available(): boolean;
  submit(input: {
    jobId: string;
    methodId: string;
    methodVersion: string;
    inputArtifactRef?: string | null;
    outputArtifactRef?: string;
    parameters?: Record<string, unknown>;
  }): Promise<OutputParquetWorkerJob>;
  job(jobId: string): Promise<OutputParquetWorkerJob>;
  cancel(jobId: string): Promise<OutputParquetWorkerJob>;
}

export interface ParquetOutputMaterializerOptions {
  pollIntervalMs?: number;
  timeoutMs?: number;
  cancelGraceMs?: number;
}

interface NormalizeResult {
  parquetArtifactRef: string;
  manifestArtifactRef: string;
  rowCount: number;
}

interface NormalizeManifest {
  rowCount: number;
  columns: Array<{ sourceField: string; physicalName: string }>;
}

interface StoredArtifactMetadata {
  id: string;
  format: 'parquet';
  delivered: number;
  sha256: string;
  bytes: number;
  fields: string[];
}

/**
 * Materializes one run into Parquet using the same normalization method as
 * Dataset snapshots. Input is spooled as NDJSON with backpressure, while the
 * resulting Parquet and schema manifest are committed to the controlled
 * ArtifactStore before the reusable output sidecar is published.
 */
export class WorkerParquetOutputMaterializer {
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly cancelGraceMs: number;

  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly worker: OutputParquetWorker | undefined,
    options: ParquetOutputMaterializerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
    this.cancelGraceMs = options.cancelGraceMs ?? 10_000;
  }

  async materialize(
    input: OutputArtifactMaterializationInput,
  ): Promise<MaterializedOutputArtifact> {
    if (input.spec.format !== 'parquet') {
      throw new Error('WorkerParquetOutputMaterializer only accepts Parquet artifacts');
    }
    if (!this.worker?.available()) {
      throw new Error(
        'ANALYTICS_UNAVAILABLE: Parquet output requires an available Analytics Worker',
      );
    }

    const jobId = `output-parquet-${randomUUID()}`;
    const workspace = await this.artifacts.openWorkspace(jobId);
    let preserveWorkspace = false;
    try {
      const inputPath = await workspace.resolve('input.ndjson');
      const rowCount = await spoolRecords(inputPath, input);
      await this.worker.submit({
        jobId,
        methodId: 'dataset.normalize_snapshot',
        methodVersion: '1.0.0',
        inputArtifactRef: 'input.ndjson',
        outputArtifactRef: 'normalize-result.json',
        parameters: { fingerprint: input.id },
      });
      const workerJob = await this.waitForWorker(jobId, input.signal);
      if (workerJob.state !== 'succeeded') {
        const code = workerJob.error?.code ?? 'PARQUET_MATERIALIZATION_FAILED';
        throw new Error(`${code}: ${workerJob.error?.message ?? 'Parquet normalization failed'}`);
      }

      const result = normalizeResult(
        JSON.parse(await readFile(await workspace.resolve('normalize-result.json'), 'utf8')),
        rowCount,
      );
      const manifest = normalizeManifest(
        JSON.parse(await readFile(await workspace.resolve(result.manifestArtifactRef), 'utf8')),
        rowCount,
      );
      const dataKey = `outputs/${input.id}.parquet`;
      const manifestKey = `outputs/${input.id}.schema-manifest.json`;
      const metadataKey = `outputs/${input.id}.json`;
      const parquet = await this.artifacts.commitWorkspaceFile(
        jobId,
        result.parquetArtifactRef,
        dataKey,
      );
      await this.artifacts.commitWorkspaceFile(jobId, result.manifestArtifactRef, manifestKey);
      const metadata: StoredArtifactMetadata = {
        id: input.id,
        format: 'parquet',
        delivered: rowCount,
        sha256: parquet.checksum,
        bytes: parquet.size,
        fields: logicalFields(input, manifest),
      };
      await writeFile(await workspace.resolve(`${input.id}.json`), JSON.stringify(metadata), {
        flag: 'wx',
        mode: 0o600,
      });
      await this.artifacts.commitWorkspaceFile(jobId, `${input.id}.json`, metadataKey);
      const path = await this.artifacts.resolveArtifact(dataKey);
      const file = await stat(path);
      if (!file.isFile() || file.size !== metadata.bytes) {
        throw new Error('Parquet output artifact did not pass its final size check');
      }
      return { ...metadata, path };
    } catch (error) {
      preserveWorkspace = error instanceof OutputWorkerStillRunningError;
      throw error;
    } finally {
      if (!preserveWorkspace) {
        await this.artifacts.removeWorkspace(jobId).catch(() => undefined);
      }
    }
  }

  private async waitForWorker(jobId: string, signal?: AbortSignal) {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) {
        await this.worker!.cancel(jobId).catch(() => undefined);
        if (!(await this.waitForTerminal(jobId, this.cancelGraceMs))) {
          throw new OutputWorkerStillRunningError(jobId);
        }
        throw signal.reason ?? abortError();
      }
      const job = await this.worker!.job(jobId);
      if (isTerminal(job)) return job;
      await delay(this.pollIntervalMs);
    }
    await this.worker!.cancel(jobId).catch(() => undefined);
    if (!(await this.waitForTerminal(jobId, this.cancelGraceMs))) {
      throw new OutputWorkerStillRunningError(jobId);
    }
    throw new Error('RESOURCE_LIMIT_EXCEEDED: Parquet normalization timed out');
  }

  private async waitForTerminal(jobId: string, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      const job = await this.worker!.job(jobId).catch(() => undefined);
      if (job && isTerminal(job)) return true;
      await delay(this.pollIntervalMs);
    }
    return false;
  }
}

async function spoolRecords(
  path: string,
  input: OutputArtifactMaterializationInput,
): Promise<number> {
  const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  const configuredFields = input.spec.fields.length > 0;
  const selectedFields = input.spec.fields.filter((field) => field !== '_source_url');
  let rowCount = 0;
  try {
    for await (const record of input.records) {
      if (input.signal?.aborted) throw input.signal.reason ?? abortError();
      const data = configuredFields
        ? Object.fromEntries(selectedFields.map((field) => [field, record.data[field] ?? null]))
        : record.data;
      const recordKey = createHash('sha256').update(`${input.id}\0${rowCount}`).digest('hex');
      const contentHash = createHash('sha256').update(canonicalJson(data)).digest('hex');
      const line = `${JSON.stringify({
        recordKey,
        sourceUrl: input.spec.includeSourceUrl ? record.sourceUrl : '',
        contentHash,
        removed: false,
        data,
      })}\n`;
      if (!output.write(line)) await once(output, 'drain');
      rowCount += 1;
    }
    output.end();
    await once(output, 'close');
    return rowCount;
  } catch (error) {
    output.destroy();
    throw error;
  }
}

function normalizeResult(value: unknown, expectedRows: number): NormalizeResult {
  if (!value || typeof value !== 'object') {
    throw new Error('PARQUET_MATERIALIZATION_FAILED: Invalid Worker result');
  }
  const result = value as Record<string, unknown>;
  if (
    typeof result.parquetArtifactRef !== 'string' ||
    typeof result.manifestArtifactRef !== 'string' ||
    !Number.isInteger(result.rowCount) ||
    result.rowCount !== expectedRows
  ) {
    throw new Error('PARQUET_MATERIALIZATION_FAILED: Invalid Worker result');
  }
  return {
    parquetArtifactRef: result.parquetArtifactRef,
    manifestArtifactRef: result.manifestArtifactRef,
    rowCount: result.rowCount as number,
  };
}

function normalizeManifest(value: unknown, expectedRows: number): NormalizeManifest {
  if (!value || typeof value !== 'object') {
    throw new Error('PARQUET_MATERIALIZATION_FAILED: Invalid schema manifest');
  }
  const manifest = value as Record<string, unknown>;
  if (
    manifest.rowCount !== expectedRows ||
    !Array.isArray(manifest.columns) ||
    manifest.columns.some(
      (column) =>
        !column ||
        typeof column !== 'object' ||
        typeof (column as Record<string, unknown>).sourceField !== 'string' ||
        typeof (column as Record<string, unknown>).physicalName !== 'string',
    )
  ) {
    throw new Error('PARQUET_MATERIALIZATION_FAILED: Invalid schema manifest');
  }
  return {
    rowCount: expectedRows,
    columns: manifest.columns as NormalizeManifest['columns'],
  };
}

function logicalFields(
  input: OutputArtifactMaterializationInput,
  manifest: NormalizeManifest,
): string[] {
  const fields =
    input.spec.fields.length > 0
      ? input.spec.fields.filter((field) => field !== '_source_url')
      : [...manifest.columns]
          .sort((left, right) => left.physicalName.localeCompare(right.physicalName))
          .map((column) => column.sourceField);
  if (input.spec.includeSourceUrl && !fields.includes('_source_url')) fields.push('_source_url');
  return fields;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function isTerminal(job: OutputParquetWorkerJob): boolean {
  return job.state === 'canceled' || job.state === 'succeeded' || job.state === 'failed';
}

function abortError(): Error {
  const error = new Error('Parquet output materialization was canceled');
  error.name = 'AbortError';
  return error;
}

class OutputWorkerStillRunningError extends Error {
  constructor(jobId: string) {
    super(`WORKER_CRASHED: Worker Job ${jobId} exceeded the cancellation budget`);
    this.name = 'OutputWorkerStillRunningError';
  }
}
