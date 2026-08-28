import type { DatasetRecord, DatasetSettings, DatasetStats, RecordChange } from '@zhiyun/shared';

export interface Dataset {
  id: string;
  sourceTaskId: string;
  settings: DatasetSettings;
  schemaVersion: number;
  currentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DatasetSnapshot {
  id: string;
  datasetId: string;
  sourceRunId: string | null;
  fingerprint: string;
  schemaVersion: number;
  projectionSettings: Record<string, unknown>;
  status: 'projected' | 'preparing' | 'ready' | 'failed';
  stats: DatasetStats;
  rowCount: number;
  parquetArtifactId: string | null;
  manifestArtifactId: string | null;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DatasetCommitInput {
  sourceTaskId: string;
  sourceRunId: string;
  settings: DatasetSettings;
  records: Array<{ sourceUrl: string; data: Record<string, unknown> }>;
}

export interface DatasetCommitResult {
  dataset: Dataset;
  snapshot: DatasetSnapshot;
  stats: DatasetStats;
  reused: boolean;
}

export interface DatasetRecordPage {
  items: DatasetRecord[];
  nextCursor: string | null;
  stats: DatasetStats;
}

export interface RecordChangePage {
  items: RecordChange[];
  nextCursor: string | null;
}

export interface SnapshotExportRecord {
  recordKey: string;
  sourceUrl: string;
  data: Record<string, unknown>;
  contentHash: string;
  removed: boolean;
}

export interface ConsistentSnapshotRead {
  dataset: Dataset;
  records: AsyncIterable<SnapshotExportRecord>;
}

export interface SnapshotMaterializationClaim {
  snapshot: DatasetSnapshot;
  claimed: boolean;
  reused: boolean;
}

export interface SnapshotWorkerJob {
  id: string;
  state: 'queued' | 'running' | 'canceling' | 'canceled' | 'succeeded' | 'failed';
  outputArtifactRef?: string | null;
  error?: { code: string; message: string; retryable: boolean } | null;
}

export interface SnapshotWorkerClient {
  submit(input: {
    jobId: string;
    methodId: string;
    methodVersion: string;
    inputArtifactRef?: string | null;
    outputArtifactRef?: string;
    parameters?: Record<string, unknown>;
  }): Promise<SnapshotWorkerJob>;
  job(jobId: string): Promise<SnapshotWorkerJob>;
  cancel(jobId: string): Promise<SnapshotWorkerJob>;
}

export interface DatasetRepository {
  migrate(): Promise<void>;
  close(): Promise<void>;
  commitRunRecords(input: DatasetCommitInput): Promise<DatasetCommitResult>;
  listDatasets(
    cursor?: string,
    limit?: number,
  ): Promise<{
    items: Dataset[];
    nextCursor: string | null;
  }>;
  getDataset(id: string): Promise<Dataset | null>;
  getDatasetBySourceTask(sourceTaskId: string): Promise<Dataset | null>;
  listRecords(
    datasetId: string,
    cursor?: string,
    limit?: number,
    options?: { includeRemoved?: boolean },
  ): Promise<DatasetRecordPage>;
  listChanges(
    datasetId: string,
    cursor?: string,
    limit?: number,
    sourceRunId?: string,
  ): Promise<RecordChangePage>;
  listSnapshots(datasetId: string): Promise<DatasetSnapshot[]>;
  getSnapshot(id: string): Promise<DatasetSnapshot | null>;
  findSnapshotByFingerprint(
    datasetId: string,
    fingerprint: string,
  ): Promise<DatasetSnapshot | null>;
  withConsistentSnapshotRead<T>(
    datasetId: string,
    consume: (read: ConsistentSnapshotRead) => Promise<T>,
  ): Promise<T>;
  claimSnapshotMaterialization(
    datasetId: string,
    fingerprint: string,
  ): Promise<SnapshotMaterializationClaim>;
  completeSnapshotMaterialization(input: {
    snapshotId: string;
    parquetArtifactId: string;
    manifestArtifactId: string;
    rowCount: number;
    warnings: string[];
  }): Promise<DatasetSnapshot>;
  failSnapshotMaterialization(snapshotId: string, warning: string): Promise<DatasetSnapshot>;
}

export interface DatasetsServiceContract {
  getDataset(id: string): Promise<Dataset | null>;
  createProjection(input: DatasetCommitInput): Promise<DatasetCommitResult>;
  getSnapshot(id: string): Promise<DatasetSnapshot | null>;
}

export type { DatasetRecord, DatasetSettings, DatasetStats, RecordChange };
