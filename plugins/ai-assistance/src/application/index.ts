import type { AnalysisResult } from '@zhiyun/contracts';
import type {
  AiAssistanceServiceContract,
  AiProviderPort,
  CollectionForAiPort,
} from '../contracts/index.js';
import { analyzePage } from './analyzer.js';

export class AiAssistanceService implements AiAssistanceServiceContract {
  constructor(
    private readonly collection: CollectionForAiPort,
    private readonly ai: AiProviderPort,
  ) {}

  async analyzeTaskRule(
    taskId: string,
    options: { useAi: boolean; forceBrowser: boolean },
  ): Promise<AnalysisResult> {
    const task = await this.collection.getTask(taskId);
    if (!task) throw new Error(`Collection task ${taskId} was not found`);
    return analyzePage(
      {
        taskId,
        url: task.startUrl,
        instruction: task.instruction,
        requestSettings: task.requestSettings,
        browserSettings: task.browserSettings,
        networkPolicy: task.networkPolicy,
        useAi: options.useAi,
        forceBrowser: options.forceBrowser,
      },
      this.ai,
    );
  }

  async explainRunFailure(runId: string): Promise<string> {
    const run = await this.collection.getRun(runId);
    if (!run) throw new Error(`Collection run ${runId} was not found`);
    if (!run.error) throw new Error(`Collection run ${runId} does not contain a failure`);
    return this.ai.explainFailure({
      error: run.error,
      failureContext: {
        phase: run.phase,
        errorCode: run.errorCode,
        warningCount: run.warningCount,
      },
      context: { taskId: run.taskId, runId },
    });
  }
}

export * from './analyzer.js';
