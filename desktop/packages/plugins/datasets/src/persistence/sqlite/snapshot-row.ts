import type { DatasetStats } from '@zhiyun/shared';
import type { DatasetSnapshot } from '../../contracts/index.js';

export function snapshotRow(row: Record<string, unknown>): DatasetSnapshot {
  return {
    id: String(row.id),
    datasetId: String(row.dataset_id),
    sourceRunId: row.source_run_id ? String(row.source_run_id) : null,
    fingerprint: String(row.fingerprint),
    schemaVersion: Number(row.schema_version),
    projectionSettings: objectValue(row.projection_settings),
    status: row.status as DatasetSnapshot['status'],
    stats: objectValue(row.stats) as unknown as DatasetStats,
    rowCount: Number(row.row_count),
    parquetArtifactId: row.parquet_artifact_id ? String(row.parquet_artifact_id) : null,
    manifestArtifactId: row.manifest_artifact_id ? String(row.manifest_artifact_id) : null,
    warnings: JSON.parse(String(row.warnings)) as string[],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}
