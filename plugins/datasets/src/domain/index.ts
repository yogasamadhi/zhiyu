import { createHash } from 'node:crypto';
import type { DatasetSettings } from '../contracts/index.js';

export interface NormalizedDatasetInput {
  recordKey: string;
  sourceUrl: string;
  data: Record<string, unknown>;
  contentHash: string;
}

export function normalizeDatasetInputs(
  sourceRunId: string,
  settings: DatasetSettings,
  records: Array<{ sourceUrl: string; data: Record<string, unknown> }>,
): NormalizedDatasetInput[] {
  const normalized = new Map<string, NormalizedDatasetInput>();
  records.forEach((record, index) => {
    const hash = hashJson(record.data);
    const baseKey =
      settings.keyFields.length > 0
        ? hashJson(settings.keyFields.map((field) => record.data[field] ?? null))
        : hash;
    const recordKey = settings.mode === 'append' ? `${sourceRunId}:${baseKey}:${index}` : baseKey;
    normalized.set(recordKey, {
      recordKey,
      sourceUrl: record.sourceUrl,
      data: record.data,
      contentHash: hash,
    });
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
  const hash = createHash('sha256');
  hash.update(String(schemaVersion));
  hash.update('\0');
  for (const row of [...rows].sort((left, right) =>
    left.recordKey.localeCompare(right.recordKey),
  )) {
    hash.update(row.recordKey);
    hash.update('\0');
    hash.update(row.contentHash);
    hash.update('\0');
    hash.update(row.removed ? '1' : '0');
    hash.update('\0');
  }
  hash.update(canonicalJson(projectionSettings));
  return hash.digest('hex');
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
