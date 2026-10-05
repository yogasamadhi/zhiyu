import type { PlatformJob } from '@zhiyun/platform-core';

export type SnapshotPolicy = { mode: 'latest' } | { mode: 'pinned'; snapshotId: string };
export type CorpusDeduplication = 'none' | 'exact' | 'exact-and-near';
export type CorpusLanguagePolicy = 'zh-en-first' | 'generic';
export type CorpusOutputFormat = 'parquet' | 'jsonl' | 'markdown';

export interface Corpus {
  id: string;
  name: string;
  datasetId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CorpusRecipe {
  id: string;
  corpusId: string;
  name: string;
  datasetId: string;
  snapshotPolicy: SnapshotPolicy;
  selectedTextFields: string[];
  metadataFields: string[];
  stripHtml: boolean;
  unicodeNormalization: 'NFC' | 'NFKC';
  deduplication: CorpusDeduplication;
  nearDuplicateThreshold: number;
  chunkSize: number;
  chunkOverlap: number;
  languagePolicy: CorpusLanguagePolicy;
  outputFormats: CorpusOutputFormat[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface CorpusBuildMetadata {
  id: string;
  corpusId: string;
  recipeId: string;
  recipeRevision: number;
  datasetId: string;
  snapshotId: string;
  versionId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CorpusBuild extends CorpusBuildMetadata {
  state: PlatformJob['state'];
  phase: string;
  progress: number;
  attempt: number;
  error: PlatformJob['error'];
}

export interface CorpusArtifactRef {
  id: string;
  kind: string;
  contentType: string;
  filename: string;
  checksum: string;
  size: number;
}

export interface CorpusVersionStats {
  inputRowCount: number;
  documentCount: number;
  chunkCount: number;
  characterCount: number;
  failureCount: number;
  exactDuplicates: number;
  nearDuplicates: number;
  languages: Record<string, number>;
}

export interface CorpusVersion {
  id: string;
  corpusId: string;
  buildId: string;
  datasetId: string;
  snapshotId: string;
  snapshotFingerprint: string;
  recipeId: string;
  recipeRevision: number;
  fingerprint: string;
  workerVersion: string;
  stats: CorpusVersionStats;
  artifacts: CorpusArtifactRef[];
  createdAt: string;
}

export interface CreateCorpusInput {
  name: string;
  datasetId: string;
}

export interface CreateCorpusRecipeInput {
  name: string;
  snapshotPolicy: SnapshotPolicy;
  selectedTextFields: string[];
  metadataFields: string[];
  stripHtml: boolean;
  unicodeNormalization: 'NFC' | 'NFKC';
  deduplication: CorpusDeduplication;
  nearDuplicateThreshold: number;
  chunkSize: number;
  chunkOverlap: number;
  languagePolicy: CorpusLanguagePolicy;
  outputFormats: CorpusOutputFormat[];
}

export interface CreateCorpusBuildInput {
  recipeId: string;
  snapshotId: string;
}

export interface CorpusRepository {
  migrate(): Promise<void>;
  close(): Promise<void>;
  listCorpora(
    cursor?: string,
    limit?: number,
  ): Promise<{ items: Corpus[]; nextCursor: string | null }>;
  getCorpus(id: string): Promise<Corpus | null>;
  createCorpus(input: CreateCorpusInput): Promise<Corpus>;
  updateCorpus(
    id: string,
    expectedRevision: number,
    input: CreateCorpusInput,
  ): Promise<Corpus | 'revision-conflict' | null>;
  deleteCorpus(id: string, expectedRevision: number): Promise<boolean | 'revision-conflict'>;
  listRecipes(corpusId: string): Promise<CorpusRecipe[]>;
  getRecipe(id: string): Promise<CorpusRecipe | null>;
  createRecipe(corpusId: string, input: CreateCorpusRecipeInput): Promise<CorpusRecipe>;
  updateRecipe(
    corpusId: string,
    id: string,
    expectedRevision: number,
    input: CreateCorpusRecipeInput,
  ): Promise<CorpusRecipe | 'revision-conflict' | null>;
  deleteRecipe(
    corpusId: string,
    id: string,
    expectedRevision: number,
  ): Promise<boolean | 'revision-conflict'>;
  createBuildMetadata(
    id: string,
    input: {
      corpusId: string;
      recipeId: string;
      recipeRevision: number;
      datasetId: string;
      snapshotId: string;
    },
  ): Promise<CorpusBuildMetadata>;
  getBuildMetadata(id: string): Promise<CorpusBuildMetadata | null>;
  listBuildMetadata(corpusId?: string, limit?: number): Promise<CorpusBuildMetadata[]>;
  markBuildStarted(id: string): Promise<void>;
  markBuildFailed(id: string, code: string): Promise<void>;
  markBuildCanceled(id: string): Promise<void>;
  saveVersion(input: Omit<CorpusVersion, 'id' | 'createdAt'>): Promise<CorpusVersion>;
  findVersion(corpusId: string, fingerprint: string): Promise<CorpusVersion | null>;
  getVersion(id: string): Promise<CorpusVersion | null>;
  listVersions(corpusId: string, limit?: number): Promise<CorpusVersion[]>;
}

export interface CorpusSnapshotReference {
  id: string;
  datasetId: string;
  sourceRunId: string | null;
  fingerprint: string;
  status: string;
  parquetArtifactId: string | null;
}

export interface CorpusSnapshotLookup {
  getSnapshot(id: string): Promise<CorpusSnapshotReference | null>;
}

export interface CorpusWorkerJob {
  id: string;
  state: 'queued' | 'running' | 'canceling' | 'canceled' | 'succeeded' | 'failed';
  phase: string;
  progress: number;
  outputArtifactRef?: string | null;
  error?: { code: string; message: string; retryable: boolean } | null;
}

export interface CorpusWorkerControl {
  version(): Promise<{ workerVersion: string }>;
  submit(input: {
    jobId: string;
    methodId: string;
    methodVersion: string;
    inputArtifactRef: string;
    outputArtifactRef: string;
    parameters: Record<string, unknown>;
  }): Promise<CorpusWorkerJob>;
  job(jobId: string): Promise<CorpusWorkerJob>;
  cancel(jobId: string): Promise<CorpusWorkerJob>;
}
