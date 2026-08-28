import type {
  AiProvider,
  AnalysisResult,
  BrowserSettings,
  CrawlRun,
  DatasetSettings,
  NetworkPolicy,
  RequestSettings,
} from '@zhiyun/contracts';

export interface AnalyzeTaskRuleInput {
  taskId?: string;
  url: string;
  instruction: string;
  requestSettings: RequestSettings;
  browserSettings: BrowserSettings;
  useAi: boolean;
  forceBrowser: boolean;
  networkPolicy?: NetworkPolicy;
}

export interface CollectionTaskForAi {
  id: string;
  startUrl: string;
  instruction: string;
  requestSettings: RequestSettings;
  browserSettings: BrowserSettings;
  networkPolicy: NetworkPolicy;
  datasetSettings: DatasetSettings;
}

export interface CollectionForAiPort {
  getTask(id: string): Promise<CollectionTaskForAi | null>;
  getRun(id: string): Promise<CrawlRun | null>;
}

export interface AiAssistanceServiceContract {
  analyzeTaskRule(
    taskId: string,
    options: { useAi: boolean; forceBrowser: boolean },
  ): Promise<AnalysisResult>;
  explainRunFailure(runId: string): Promise<string>;
}

export type AiProviderPort = AiProvider;
