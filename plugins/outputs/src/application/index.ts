import type {
  OutputRepository,
  OutputsServiceContract,
  OutputDestination,
} from '../contracts/index.js';

export class OutputsService implements OutputsServiceContract {
  constructor(private readonly repository: OutputRepository) {}

  listDestinations(): Promise<OutputDestination[]> {
    return this.repository.listDestinations();
  }

  getDestination(id: string): Promise<OutputDestination | null> {
    return this.repository.getDestination(id);
  }

  bindTask(taskId: string, destinationIds: readonly string[]): Promise<void> {
    return this.repository.replaceTaskBindings(taskId, [...new Set(destinationIds)]);
  }

  clearCollectionTask(taskId: string): Promise<number> {
    return this.repository.clearTaskBindings(taskId);
  }
}
