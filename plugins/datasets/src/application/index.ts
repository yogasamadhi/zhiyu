import type {
  Dataset,
  DatasetCommitInput,
  DatasetCommitResult,
  DatasetRepository,
  DatasetSnapshot,
  DatasetsServiceContract,
} from '../contracts/index.js';

export class DatasetsService implements DatasetsServiceContract {
  constructor(private readonly repository: DatasetRepository) {}

  getDataset(id: string): Promise<Dataset | null> {
    return this.repository.getDataset(id);
  }

  createProjection(input: DatasetCommitInput): Promise<DatasetCommitResult> {
    return this.repository.commitRunRecords(input);
  }

  getSnapshot(id: string): Promise<DatasetSnapshot | null> {
    return this.repository.getSnapshot(id);
  }
}
