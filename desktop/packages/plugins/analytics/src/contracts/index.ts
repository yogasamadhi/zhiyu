import type { PlatformJob } from '@zhiyun/platform-core';

export interface AnalysisMethodDescriptor {
  id: string;
  version: string;
  category: string;
  titleKey: string;
  descriptionKey: string;
  supportedFieldTypes: string[];
  parameterSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  recommendedVisualizations: string[];
  resourceLimits: Record<string, unknown>;
  supportsSampling: boolean;
}

export interface AnalysisRecipe {
  id: string;
  name: string;
  datasetId: string;
  methodId: string;
  methodVersion: string;
  parameters: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

export interface AnalysisJobMetadata {
  id: string;
  recipeId: string | null;
  datasetId: string;
  snapshotId: string;
  methodId: string;
  methodVersion: string;
  parameters: Record<string, unknown>;
  provenance: AnalysisProvenance | null;
  sampling: AnalysisSampling;
  resultId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AnalysisJob extends AnalysisJobMetadata {
  state: PlatformJob['state'];
  phase: string;
  progress: number;
  attempt: number;
  error: PlatformJob['error'];
}

export interface AnalysisSampling {
  applied: boolean;
  inputRows: number;
  sampleRows: number;
  seed: number | null;
  strategy?: string;
}

export interface AnalysisTable {
  id: string;
  rows: Array<Record<string, unknown>>;
  columns?: Array<Record<string, unknown>>;
  artifactId?: string;
  totalRows?: number;
  nextCursor?: string | null;
}

export interface AnalysisSeries {
  id: string;
  type: string;
  data: Array<Record<string, unknown>>;
  encoding?: { xFields: string[]; yFields: string[] };
  totalRows?: number;
  nextCursor?: string | null;
}

export interface AnalysisArtifactRef {
  id: string;
  kind: string;
  contentType: string;
  filename: string;
}

export interface AnalysisResult {
  id: string;
  state: 'succeeded';
  jobId: string;
  datasetId: string;
  snapshotId: string;
  methodId: string;
  methodVersion: string;
  parameters: Record<string, unknown>;
  provenance: AnalysisProvenance | null;
  summary: Record<string, unknown>;
  metrics: Record<string, unknown>;
  tables: AnalysisTable[];
  series: AnalysisSeries[];
  artifacts: AnalysisArtifactRef[];
  warnings: string[];
  sampling: AnalysisSampling;
  workerVersion: string;
  createdAt: string;
}

export interface CreateAnalysisRecipeInput {
  name: string;
  datasetId: string;
  methodId: string;
  methodVersion: string;
  parameters: Record<string, unknown>;
}

export interface CreateAnalysisJobInput {
  recipeId?: string | null;
  datasetId: string;
  snapshotId: string;
  methodId: string;
  methodVersion: string;
  parameters: Record<string, unknown>;
  parentResultId?: string | null;
  questionId?: AnalysisQuestionId | null;
}

export type AnalysisQuestionId = 'group-comparison' | 'time-trend' | 'distribution' | 'outliers';
export interface AnalysisProvenance {
  version: 1;
  inputFingerprint: string | null;
  sourceSnapshotId: string;
  cleaningRecipeVersionId: string | null;
  cleaningStep: number | null;
  analysisRecipeId: string | null;
  analysisRecipeRevision: number | null;
  parentResultId: string | null;
  questionId: AnalysisQuestionId | null;
}
export interface SaveAnalysisJobMetadataInput extends CreateAnalysisJobInput {
  provenance?: AnalysisProvenance | null;
}
export type SaveAnalysisResultInput = Omit<
  AnalysisResult,
  'id' | 'state' | 'createdAt' | 'parameters' | 'provenance'
>;
export type AnalysisResultSection = 'table' | 'series';
export interface AnalysisResultPage {
  resultId: string;
  section: AnalysisResultSection;
  collectionId: string;
  items: Array<Record<string, unknown>>;
  totalRows: number;
  nextCursor: string | null;
}
export interface AnalysisResultComparison {
  left: AnalysisResult;
  right: AnalysisResult;
  changedParameters: string[];
}
export class AnalysisResultQueryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = code === 'METHOD_INCOMPATIBLE' ? 422 : 400,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface AnalysisRepository {
  migrate(): Promise<void>;
  close(): Promise<void>;
  listRecipes(
    cursor?: string,
    limit?: number,
  ): Promise<{
    items: AnalysisRecipe[];
    nextCursor: string | null;
  }>;
  getRecipe(id: string): Promise<AnalysisRecipe | null>;
  createRecipe(input: CreateAnalysisRecipeInput): Promise<AnalysisRecipe>;
  updateRecipe(
    id: string,
    expectedRevision: number,
    input: CreateAnalysisRecipeInput,
  ): Promise<AnalysisRecipe | 'revision-conflict' | null>;
  deleteRecipe(id: string, expectedRevision: number): Promise<boolean | 'revision-conflict'>;
  createJobMetadata(id: string, input: SaveAnalysisJobMetadataInput): Promise<AnalysisJobMetadata>;
  getJobMetadata(id: string): Promise<AnalysisJobMetadata | null>;
  listJobMetadata(limit?: number): Promise<AnalysisJobMetadata[]>;
  markJobStarted(id: string): Promise<void>;
  saveResult(input: SaveAnalysisResultInput): Promise<AnalysisResult>;
  markJobFailed(id: string, code: string): Promise<void>;
  markJobCanceled(id: string): Promise<void>;
  getResult(id: string): Promise<AnalysisResult | null>;
  getResultPreview(id: string, limit?: number): Promise<AnalysisResult | null>;
  getResultPage(
    id: string,
    section: AnalysisResultSection,
    collectionId: string,
    limit?: number,
    cursor?: string,
  ): Promise<AnalysisResultPage | null>;
}

export interface DatasetSnapshotReference {
  id: string;
  datasetId: string;
  status: string;
  parquetArtifactId: string | null;
  fingerprint?: string;
  projectionSettings?: Record<string, unknown>;
}

export interface DatasetSnapshotLookup {
  getSnapshot(id: string): Promise<DatasetSnapshotReference | null>;
}

export interface AnalyticsWorkerJob {
  id: string;
  state: 'queued' | 'running' | 'canceling' | 'canceled' | 'succeeded' | 'failed';
  phase: string;
  progress: number;
  outputArtifactRef?: string | null;
  error?: { code: string; message: string; retryable: boolean } | null;
}

export interface AnalyticsWorkerControl {
  methods(): Promise<unknown[]>;
  version(): Promise<{ workerVersion: string }>;
  submit(input: {
    jobId: string;
    methodId: string;
    methodVersion: string;
    inputArtifactRef: string;
    outputArtifactRef: string;
    parameters: Record<string, unknown>;
  }): Promise<AnalyticsWorkerJob>;
  job(jobId: string): Promise<AnalyticsWorkerJob>;
  cancel(jobId: string): Promise<AnalyticsWorkerJob>;
}
