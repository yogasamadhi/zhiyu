import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { materializeRecords } from './serialization.js';
import type {
  MaterializedOutputArtifact,
  OutputArtifactSpec,
  OutputDestinationLike,
  OutputRecord,
} from './types.js';
import { booleanConfig, parseFields, parseFormat } from './serialization.js';

interface StoredArtifactMetadata {
  id: string;
  format: OutputArtifactSpec['format'];
  delivered: number;
  sha256: string;
  bytes: number;
  fields: string[];
}

export interface OutputArtifactMaterializationInput {
  id: string;
  spec: OutputArtifactSpec;
  records: AsyncIterable<OutputRecord> | Iterable<OutputRecord>;
  signal?: AbortSignal;
}

export interface OutputArtifactStore {
  get(id: string): Promise<MaterializedOutputArtifact | null>;
  materialize(input: OutputArtifactMaterializationInput): Promise<MaterializedOutputArtifact>;
}

export function outputArtifactSpec(
  destination: Pick<OutputDestinationLike, 'type' | 'config'>,
): OutputArtifactSpec | null {
  if (destination.type !== 'local-directory' && destination.type !== 's3') return null;
  const format = parseFormat(destination.config.format, 'csv');
  const fields = parseFields(destination.config.fields ?? destination.config.columns);
  const includeSourceUrl = booleanConfig(destination.config.includeSourceUrl, true);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ format, fields, includeSourceUrl }))
    .digest('hex');
  return { format, fields, includeSourceUrl, fingerprint };
}

export function outputArtifactId(runId: string, spec: OutputArtifactSpec): string {
  return createHash('sha256')
    .update(`zhiyun-output-artifact:v1:${runId}:${spec.fingerprint}`)
    .digest('hex');
}

/**
 * A small durable cache for output materializations. Files and metadata are
 * atomically published, so retries and destinations with the same tabular
 * shape can reuse the exact bytes without scanning the run again.
 */
export class FileOutputArtifactStore implements OutputArtifactStore {
  constructor(private readonly rootPath: string) {}

  async get(id: string): Promise<MaterializedOutputArtifact | null> {
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    return this.#read(id);
  }

  async materialize(
    input: OutputArtifactMaterializationInput,
  ): Promise<MaterializedOutputArtifact> {
    await mkdir(this.rootPath, { recursive: true, mode: 0o700 });
    const existing = await this.get(input.id);
    if (existing) return existing;

    const lockPath = this.#path(input.id, 'lock');
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    for (let wait = 0; wait < 600; wait += 1) {
      if (input.signal?.aborted) {
        throw input.signal.reason ?? new Error('Output artifact materialization aborted');
      }
      try {
        lock = await open(lockPath, 'wx', 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const completed = await this.#read(input.id);
        if (completed) return completed;
        const lockStats = await stat(lockPath).catch(() => null);
        if (lockStats && Date.now() - lockStats.mtimeMs > 60_000) {
          await rm(lockPath, { force: true });
          continue;
        }
        await delay(50, undefined, input.signal ? { signal: input.signal } : undefined);
      }
    }
    if (!lock) throw new Error('Timed out waiting for output artifact materialization');

    const temporaryData = this.#path(input.id, `${randomUUID()}.tmp`);
    const temporaryMetadata = this.#path(input.id, `${randomUUID()}.json.tmp`);
    try {
      const completed = await this.#read(input.id);
      if (completed) return completed;
      const materialized = await materializeRecords(
        temporaryData,
        input.records,
        {
          format: input.spec.format,
          fields: input.spec.fields,
          includeSourceUrl: input.spec.includeSourceUrl,
        },
        input.signal,
      );
      const metadata: StoredArtifactMetadata = {
        id: input.id,
        format: input.spec.format,
        delivered: materialized.delivered,
        sha256: materialized.sha256,
        bytes: materialized.bytes,
        fields: materialized.fields,
      };
      await rename(temporaryData, this.#path(input.id, input.spec.format));
      await writeFile(temporaryMetadata, JSON.stringify(metadata), {
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporaryMetadata, this.#path(input.id, 'json'));
      return this.#artifact(metadata);
    } finally {
      await lock.close();
      await Promise.all([
        rm(lockPath, { force: true }),
        rm(temporaryData, { force: true }),
        rm(temporaryMetadata, { force: true }),
      ]);
    }
  }

  async #read(id: string): Promise<MaterializedOutputArtifact | null> {
    try {
      const metadata = JSON.parse(
        await readFile(this.#path(id, 'json'), 'utf8'),
      ) as Partial<StoredArtifactMetadata>;
      if (
        metadata.id !== id ||
        (metadata.format !== 'csv' &&
          metadata.format !== 'jsonl' &&
          metadata.format !== 'parquet') ||
        !Number.isInteger(metadata.delivered) ||
        typeof metadata.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(metadata.sha256) ||
        !Number.isInteger(metadata.bytes) ||
        !Array.isArray(metadata.fields) ||
        metadata.fields.some((field) => typeof field !== 'string')
      ) {
        throw new Error(`Output artifact metadata is invalid: ${id}`);
      }
      const artifact = this.#artifact(metadata as StoredArtifactMetadata);
      const file = await stat(artifact.path);
      if (!file.isFile() || file.size !== artifact.bytes) {
        throw new Error(`Output artifact file is invalid: ${id}`);
      }
      return artifact;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  #artifact(metadata: StoredArtifactMetadata): MaterializedOutputArtifact {
    return {
      ...metadata,
      path: this.#path(metadata.id, metadata.format),
    };
  }

  #path(id: string, suffix: string): string {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Output artifact ID is invalid');
    return join(this.rootPath, `${id}.${suffix}`);
  }
}
