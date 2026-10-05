import type {
  AnalysisResult,
  ArtifactDescriptor,
  CrawlRun,
  CrawlPlanDefinition,
  GeneratedBy,
  RecordPage,
  RuleVersionRecord,
  RuntimeCapabilities,
  RuntimeMetadata,
  TaskCreate,
  TaskDetail,
  TaskListItem,
  TaskUpdate,
} from '@zhiyun/contracts';

export interface ApiOperations {
  createRuntimeSession: {
    body: { nonce?: string; adminToken?: string };
    response: { token: string; runtime: RuntimeMetadata; capabilities: RuntimeCapabilities };
  };
  listTasks: { response: { items: TaskListItem[]; nextCursor: string | null } };
  createTask: { body: TaskCreate; response: TaskDetail };
  getTask: { response: TaskDetail };
  updateTask: { body: TaskUpdate; response: TaskDetail };
  analyzeTask: {
    body: { useAi: boolean; forceBrowser: boolean };
    response: AnalysisResult;
  };
  createRule: {
    body: { name: string; definition: CrawlPlanDefinition; generatedBy: GeneratedBy };
    response: { rule: unknown; version: RuleVersionRecord };
  };
  createRun: { response: { runId: string; status: CrawlRun['status'] } };
  getRun: { response: CrawlRun };
  listRunRecords: { response: RecordPage };
  createRunExport: {
    body: {
      format: ArtifactDescriptor['format'];
      fields?: string[];
      bom?: boolean;
      jsonMode?: 'array' | 'jsonl';
    };
    response: { artifactRef: string; artifact: ArtifactDescriptor };
  };
  createDatasetExport: {
    body: {
      format: ArtifactDescriptor['format'];
      fields?: string[];
      bom?: boolean;
      jsonMode?: 'array' | 'jsonl';
      includeRemoved?: boolean;
      query?: string;
      filter?: Record<string, string | number | boolean | null>;
    };
    response: { artifactRef: string; artifact: ArtifactDescriptor };
  };
}
