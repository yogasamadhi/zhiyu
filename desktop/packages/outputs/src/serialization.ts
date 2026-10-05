import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ExportError } from '@zhiyun/contracts';
import type { OutputRecord } from './types.js';

export type FileOutputFormat = 'csv' | 'jsonl' | 'parquet';

export interface TabularOptions {
  format: FileOutputFormat;
  fields: string[];
  includeSourceUrl: boolean;
}

export interface MaterializedRecords {
  path: string;
  delivered: number;
  sha256: string;
  bytes: number;
  fields: string[];
}

export function parseFormat(
  value: unknown,
  fallback: FileOutputFormat = 'jsonl',
): FileOutputFormat {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === 'csv' || value === 'jsonl' || value === 'parquet') return value;
  throw new ExportError('Output format must be csv, jsonl, or parquet');
}

export function parseFields(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((field) => typeof field !== 'string' || !field.trim())) {
    throw new ExportError('Output fields must be a list of non-empty field names');
  }
  const fields = value.map((field) => String(field).trim());
  if (new Set(fields).size !== fields.length) {
    throw new ExportError('Output fields must not contain duplicates');
  }
  if (fields.includes('__zhiyun_run_id')) {
    throw new ExportError('__zhiyun_run_id is reserved by ZhiYun');
  }
  return fields;
}

export function booleanConfig(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new ExportError('Boolean output setting is invalid');
  return value;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text =
    typeof value === 'string'
      ? value
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function recordObject(
  record: OutputRecord,
  includeSourceUrl: boolean,
  fields: readonly string[] = Object.keys(record.data),
): Record<string, unknown> {
  const object = Object.fromEntries(
    fields
      .filter((field) => field !== '_source_url')
      .map((field) => [field, record.data[field] ?? null]),
  );
  return includeSourceUrl ? { ...object, _source_url: record.sourceUrl } : object;
}

export function stableFields(configured: readonly string[], includeSourceUrl: boolean) {
  const fields = configured.filter((field) => field !== '_source_url');
  if (includeSourceUrl && !fields.includes('_source_url')) fields.push('_source_url');
  return fields;
}

interface ReplayableRecords {
  fields: string[];
  records: AsyncIterable<OutputRecord> | Iterable<OutputRecord>;
  cleanup(): Promise<void>;
}

async function replayableRecords(
  records: AsyncIterable<OutputRecord> | Iterable<OutputRecord>,
  configuredFields: string[],
  signal?: AbortSignal,
): Promise<ReplayableRecords> {
  if (configuredFields.length > 0) {
    return { fields: [...configuredFields], records, cleanup: async () => undefined };
  }

  const directory = await mkdtemp(join(tmpdir(), 'zhiyun-output-schema-'));
  const path = join(directory, 'records.ndjson');
  const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  const fields = new Set<string>();
  try {
    for await (const record of records) {
      if (signal?.aborted) throw signal.reason ?? new Error('Output delivery aborted');
      for (const field of Object.keys(record.data)) {
        if (field) fields.add(field);
      }
      if (!output.write(`${JSON.stringify(record)}\n`)) await once(output, 'drain');
    }
    output.end();
    await once(output, 'close');
  } catch (error) {
    output.destroy();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await rm(directory, { recursive: true, force: true });
  };
  return {
    fields: [...fields].sort(),
    records: readSpooledRecords(path),
    cleanup,
  };
}

async function* readSpooledRecords(path: string): AsyncGenerator<OutputRecord> {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== 'object') throw new ExportError('Invalid spooled output record');
    const record = value as Partial<OutputRecord>;
    if (
      typeof record.sourceUrl !== 'string' ||
      !record.data ||
      typeof record.data !== 'object' ||
      Array.isArray(record.data)
    ) {
      throw new ExportError('Invalid spooled output record');
    }
    yield record as OutputRecord;
  }
}

async function writeChunk(handle: FileHandle, hash: ReturnType<typeof createHash>, chunk: string) {
  const bytes = Buffer.from(chunk);
  hash.update(bytes);
  await handle.write(bytes);
  return bytes.byteLength;
}

export async function materializeRecords(
  destinationPath: string,
  records: AsyncIterable<OutputRecord> | Iterable<OutputRecord>,
  options: TabularOptions,
  signal?: AbortSignal,
): Promise<MaterializedRecords> {
  if (options.format === 'parquet') {
    throw new ExportError(
      'Parquet output requires artifact materialization support from the analytics worker',
    );
  }

  const replayable = await replayableRecords(records, options.fields, signal);
  const fields = stableFields(replayable.fields, options.includeSourceUrl);
  const dataFields = fields.filter((field) => field !== '_source_url');
  const hash = createHash('sha256');
  let handle: FileHandle;
  try {
    handle = await open(destinationPath, 'wx', 0o600);
  } catch (error) {
    await replayable.cleanup();
    throw error;
  }
  let bytes = 0;
  let delivered = 0;
  const writeRecord = async (record: OutputRecord) => {
    const object = recordObject(record, options.includeSourceUrl, dataFields);
    const chunk =
      options.format === 'csv'
        ? `${fields.map((field) => csvCell(object[field])).join(',')}\n`
        : `${JSON.stringify(object)}\n`;
    bytes += await writeChunk(handle, hash, chunk);
    delivered += 1;
  };

  try {
    if (options.format === 'csv') {
      bytes += await writeChunk(handle, hash, `${fields.map(csvCell).join(',')}\n`);
    }
    for await (const record of replayable.records) {
      if (signal?.aborted) throw signal.reason ?? new Error('Output delivery aborted');
      await writeRecord(record);
    }
    await handle.sync();
  } finally {
    await handle.close();
    await replayable.cleanup();
  }
  return { path: destinationPath, delivered, sha256: hash.digest('hex'), bytes, fields };
}

export async function prepareTabularRows(
  records: AsyncIterable<OutputRecord> | Iterable<OutputRecord>,
  configuredFields: string[],
  includeSourceUrl: boolean,
  runId?: string,
  signal?: AbortSignal,
): Promise<{
  fields: string[];
  rows: AsyncIterable<unknown[]>;
  cleanup(): Promise<void>;
}> {
  const replayable = await replayableRecords(records, configuredFields, signal);
  const dataFields = replayable.fields.filter((field) => field !== '_source_url');
  const outputFields = [...dataFields];
  if (includeSourceUrl && !outputFields.includes('_source_url')) outputFields.push('_source_url');
  if (runId) outputFields.push('__zhiyun_run_id');
  const toRow = (record: OutputRecord) => [
    ...dataFields.map((field) => record.data[field] ?? null),
    ...(includeSourceUrl ? [record.sourceUrl] : []),
    ...(runId ? [runId] : []),
  ];
  return {
    fields: outputFields,
    rows: (async function* () {
      try {
        for await (const record of replayable.records) {
          if (signal?.aborted) throw signal.reason ?? new Error('Output delivery aborted');
          yield toRow(record);
        }
      } finally {
        await replayable.cleanup();
      }
    })(),
    cleanup: replayable.cleanup,
  };
}
