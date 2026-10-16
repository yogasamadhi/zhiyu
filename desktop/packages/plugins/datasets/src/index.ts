export { datasetsPlugin } from './manifest.js';
export { apply, Config, default, inject } from './plugin.js';
import type { Dataset, DatasetCommitInput, DatasetCommitResult } from './contracts/index.js';

export interface DatasetReadService {
  getDataset(id: string): Promise<Dataset | null>;
}

export interface DatasetSnapshotContract {
  createSnapshot(datasetId: string): Promise<{ id: string; fingerprint: string }>;
}

export interface DatasetIngestionService {
  commitRunRecords(input: DatasetCommitInput): Promise<DatasetCommitResult>;
}

export * from './application/cleaning.js';
export * from './application/index.js';
export * from './contracts/index.js';
export * from './domain/index.js';
export * from './http/index.js';
export * from './persistence/sqlite/cleaning.js';
export * from './persistence/sqlite/index.js';
export * from './ui/index.js';
