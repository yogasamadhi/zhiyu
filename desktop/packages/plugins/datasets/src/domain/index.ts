import { createHash } from 'node:crypto';
import type { DatasetSettings } from '../contracts/index.js';

export interface NormalizedDatasetInput {
  recordKey: string;
  sourceUrl: string;
  data: Record<string, unknown>;
  contentHash: string;
}

export function normalizeDatasetRecord(
  sourceRunId: string,
  settings: DatasetSettings,
  record: { sourceUrl: string; data: Record<string, unknown> },
  index: number,
): NormalizedDatasetInput {
  const hash = hashJson(record.data);
  const baseKey =
    settings.keyFields.length > 0
      ? hashJson(settings.keyFields.map((field) => record.data[field] ?? null))
      : hash;
  return {
    recordKey: settings.mode === 'append' ? `${sourceRunId}:${baseKey}:${index}` : baseKey,
    sourceUrl: record.sourceUrl,
    data: record.data,
    contentHash: hash,
  };
}

export function normalizeDatasetInputs(
  sourceRunId: string,
  settings: DatasetSettings,
  records: Array<{ sourceUrl: string; data: Record<string, unknown> }>,
): NormalizedDatasetInput[] {
  const normalized = new Map<string, NormalizedDatasetInput>();
  records.forEach((record, index) => {
    const value = normalizeDatasetRecord(sourceRunId, settings, record, index);
    normalized.set(value.recordKey, value);
  });
  return [...normalized.values()].sort((left, right) =>
    left.recordKey.localeCompare(right.recordKey),
  );
}

export function datasetFingerprint(
  schemaVersion: number,
  rows: Array<{ recordKey: string; contentHash: string; removed: boolean }>,
  projectionSettings: Record<string, unknown>,
): string {
  const builder = new DatasetFingerprintBuilder(schemaVersion, projectionSettings);
  for (const row of [...rows].sort((left, right) =>
    left.recordKey.localeCompare(right.recordKey),
  )) {
    builder.add(row);
  }
  return builder.digest();
}

export class DatasetFingerprintBuilder {
  private readonly hash = createHash('sha256');
  private lastRecordKey: string | undefined;
  private complete = false;

  constructor(
    schemaVersion: number,
    private readonly projectionSettings: Record<string, unknown>,
  ) {
    this.hash.update(String(schemaVersion));
    this.hash.update('\0');
  }

  add(row: { recordKey: string; contentHash: string; removed: boolean }): void {
    if (this.complete) throw new Error('Dataset fingerprint was already finalized');
    if (this.lastRecordKey !== undefined && row.recordKey.localeCompare(this.lastRecordKey) < 0) {
      throw new Error('Dataset fingerprint rows must be sorted by Record Key');
    }
    this.hash.update(row.recordKey);
    this.hash.update('\0');
    this.hash.update(row.contentHash);
    this.hash.update('\0');
    this.hash.update(row.removed ? '1' : '0');
    this.hash.update('\0');
    this.lastRecordKey = row.recordKey;
  }

  digest(): string {
    if (this.complete) throw new Error('Dataset fingerprint was already finalized');
    this.complete = true;
    this.hash.update(canonicalJson(this.projectionSettings));
    return this.hash.digest('hex');
  }
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
