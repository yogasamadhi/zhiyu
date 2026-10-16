import type { AnalysisResult, CrawlRun, RuleVersionRecord, TaskDetail } from '@zhiyun/contracts';

export type Run = CrawlRun;
export type RuleVersion = RuleVersionRecord;
export type Task = TaskDetail & { latestRun?: CrawlRun | null };
export type Analysis = AnalysisResult;
