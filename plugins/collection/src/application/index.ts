import type {
  CollectionRepository,
  CollectionServiceContract,
  CollectionTaskDetail,
  DatasetIngestionPort,
} from '../contracts/index.js';

export class CollectionService implements CollectionServiceContract {
  constructor(
    private readonly repository: CollectionRepository,
    private readonly datasets: DatasetIngestionPort,
  ) {}

  getTask(id: string): Promise<CollectionTaskDetail | null> {
    return this.repository.getTask(id);
  }

  async persistRun(input: {
    runId: string;
    taskId: string;
    records: Array<{ sourceUrl: string; data: Record<string, unknown> }>;
    requestCount: number;
    browserUsed: boolean;
    aiUsed: boolean;
    metadata: Record<string, unknown>;
  }) {
    const task = await this.repository.getTask(input.taskId);
    if (!task) throw new Error(`Collection task ${input.taskId} was not found`);
    const run = await this.repository.getRun(input.runId);
    if (!run || run.taskId !== input.taskId) {
      throw new Error(`Collection run ${input.runId} was not found`);
    }
    if (run.status === 'succeeded') return run;
    if (run.status !== 'running') {
      throw new Error(`Collection run ${input.runId} is not persistable from ${run.status}`);
    }
    const marked = await this.repository.markRunPersisting(input.runId, input.taskId);
    if (!marked) throw new Error(`Collection run ${input.runId} could not enter persisting`);
    const projected = await this.datasets.commitRunRecords({
      sourceTaskId: input.taskId,
      sourceRunId: input.runId,
      settings: task.datasetSettings,
      records: input.records,
    });
    const completed = await this.repository.completeRun(input.runId, input.taskId, {
      requestCount: input.requestCount,
      recordCount: input.records.length,
      browserUsed: input.browserUsed,
      aiUsed: input.aiUsed,
      metadata: { ...input.metadata, datasetProjectionReused: projected.reused },
      datasetId: projected.dataset.id,
      datasetSnapshotId: projected.snapshot.id,
      datasetStats: projected.stats,
    });
    if (!completed) throw new Error(`Collection run ${input.runId} could not be completed`);
    return completed;
  }
}
