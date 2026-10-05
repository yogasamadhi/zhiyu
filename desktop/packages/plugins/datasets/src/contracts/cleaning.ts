import type { CleaningParameters, CleaningStep } from '@zhiyun/shared';
import type { DatasetSnapshot } from './index.js';

export class DatasetCleaningConflictError extends Error {}

export interface DatasetCleaningRecipe {
  id: string;
  datasetId: string;
  name: string;
  revision: number;
  currentVersionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DatasetCleaningRecipeVersion {
  id: string;
  recipeId: string;
  revision: number;
  name: string;
  steps: CleaningStep[];
  expectedFields: CleaningParameters['expectedFields'];
  createdAt: string;
}

export interface DatasetCleaningSession {
  id: string;
  datasetId: string;
  inputSnapshotId: string;
  recipeVersionId: string;
  outputSnapshotIds: string[];
  selectedStep: number;
  selectedSnapshotId: string;
  revision: number;
  reportArtifactId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SaveCleaningRecipeInput {
  datasetId: string;
  name: string;
  steps: CleaningStep[];
  expectedFields: CleaningParameters['expectedFields'];
  recipeId?: string;
  expectedRevision?: number;
}

export interface PublishCleaningSessionInput {
  datasetId: string;
  inputSnapshotId: string;
  recipeVersionId: string;
  reportArtifactId: string;
  steps: Array<{
    fingerprint: string;
    rowCount: number;
    parquetArtifactId: string;
    manifestArtifactId: string;
  }>;
}

export interface DatasetCleaningRepository {
  saveRecipe(
    input: SaveCleaningRecipeInput,
  ): Promise<{ recipe: DatasetCleaningRecipe; version: DatasetCleaningRecipeVersion }>;
  getRecipe(id: string): Promise<DatasetCleaningRecipe | null>;
  getRecipeVersion(id: string): Promise<DatasetCleaningRecipeVersion | null>;
  listRecipes(datasetId: string): Promise<DatasetCleaningRecipe[]>;
  publishSession(
    input: PublishCleaningSessionInput,
  ): Promise<{ session: DatasetCleaningSession; snapshots: DatasetSnapshot[] }>;
  getSession(id: string): Promise<DatasetCleaningSession | null>;
  listSessions(datasetId: string): Promise<DatasetCleaningSession[]>;
  selectStep(
    sessionId: string,
    selectedStep: number,
    expectedRevision: number,
  ): Promise<DatasetCleaningSession>;
  close(): Promise<void>;
}
