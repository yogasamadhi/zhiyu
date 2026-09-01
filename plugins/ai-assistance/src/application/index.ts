import { fetchPageSource } from '@zhiyun/crawler-runtime';
import type { AnalysisResult, CrawlPlanDefinition } from '@zhiyun/contracts';
import type {
  AiAssistanceServiceContract,
  AiProviderPort,
  CollectionForAiPort,
  CrawlerPort,
  DefinitionChange,
} from '../contracts/index.js';
import { analyzePage } from './analyzer.js';

export class AiAssistanceService implements AiAssistanceServiceContract {
  constructor(
    private readonly collection: CollectionForAiPort,
    private readonly ai: AiProviderPort,
    private readonly crawler: CrawlerPort,
  ) {}

  async analyzeDraftTaskRule(
    task: Parameters<AiAssistanceServiceContract['analyzeDraftTaskRule']>[0],
    options: { useAi: boolean; forceBrowser: boolean },
  ): Promise<AnalysisResult> {
    return analyzePage(
      {
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

  async extractTask(
    taskId: string,
    options: { definition?: CrawlPlanDefinition; instruction?: string },
  ) {
    const task = await this.requireTask(taskId);
    let definition = options.definition;
    if (!definition) {
      const rules = await this.collection.getActiveRule(taskId);
      definition = rules?.versions.find(
        (version) => version.id === rules.activeVersionId,
      )?.definition;
    }
    if (!definition) throw new Error('No candidate or active Rule is available');
    const source = await fetchPageSource(task.startUrl, {
      rootUrl: task.startUrl,
      requestSettings: task.requestSettings,
      networkPolicy: task.networkPolicy,
    });
    const records = await this.ai.extract({
      html: source.text,
      instruction: options.instruction ?? task.instruction,
      schema: definition,
      context: { taskId },
    });
    return { records: records.slice(0, 10), sourceUrl: source.finalUrl, persisted: false as const };
  }

  async extractDraftTask(
    task: Parameters<AiAssistanceServiceContract['extractDraftTask']>[0],
    options: Parameters<AiAssistanceServiceContract['extractDraftTask']>[1],
  ) {
    const source = await fetchPageSource(task.startUrl, {
      rootUrl: task.startUrl,
      requestSettings: task.requestSettings,
      networkPolicy: task.networkPolicy,
    });
    const records = await this.ai.extract({
      html: source.text,
      instruction: options.instruction ?? task.instruction,
      schema: options.definition,
      context: {},
    });
    return { records: records.slice(0, 10), sourceUrl: source.finalUrl, persisted: false as const };
  }

  async createRepairProposal(
    taskId: string,
    ruleId: string,
    input: { error: string; runId: string | null },
  ) {
    const task = await this.requireTask(taskId);
    const rule = await this.collection.getRule(taskId, ruleId);
    const current = rule?.versions.find((version) => version.id === rule.activeVersionId);
    if (!current) throw new Error('Task or Rule was not found');
    const source = await fetchPageSource(task.startUrl, {
      rootUrl: task.startUrl,
      requestSettings: task.requestSettings,
      networkPolicy: task.networkPolicy,
    });
    const suggestion = await this.ai.suggestRepair({
      html: source.text.slice(0, 200_000),
      instruction: task.instruction,
      current: current.definition,
      error: input.error,
      context: { taskId, ...(input.runId ? { runId: input.runId } : {}) },
    });
    const proposal = await this.collection.createRepairProposal({
      taskId,
      ruleId,
      runId: input.runId,
      definition: suggestion.definition,
      explanation: suggestion.explanation,
    });
    return { ...proposal, diff: definitionDiff(current.definition, suggestion.definition) };
  }

  async testRepairProposal(taskId: string, ruleId: string, proposalId: string) {
    const task = await this.requireTask(taskId);
    const proposal = (await this.collection.listRepairProposals(ruleId)).find(
      (candidate) => candidate.id === proposalId && candidate.taskId === taskId,
    );
    if (!proposal) throw new Error('Repair Proposal was not found');
    if (proposal.status !== 'pending') throw new Error('Repair Proposal was already reviewed');
    const result = await this.crawler.crawl({
      url: task.startUrl,
      plan: proposal.definition,
      requestSettings: task.requestSettings,
      browserSettings: task.browserSettings,
      pagination: task.pagination,
      networkPolicy: task.networkPolicy,
      previewLimit: 10,
    });
    const tested = await this.collection.markRepairProposalTested(proposal.id);
    return { records: result.records, proposal: tested };
  }

  async applyRepairProposal(taskId: string, ruleId: string, proposalId: string) {
    const proposal = (await this.collection.listRepairProposals(ruleId)).find(
      (candidate) => candidate.id === proposalId && candidate.taskId === taskId,
    );
    if (!proposal) throw new Error('Repair Proposal was not found');
    if (proposal.status !== 'pending') throw new Error('Repair Proposal was already reviewed');
    if (!proposal.testedAt) throw new Error('Repair Proposal must be tested before applying');
    const version = await this.collection.createRuleVersion(taskId, ruleId, proposal.definition);
    if (!version) throw new Error('Rule was not found');
    await this.collection.updateRepairProposal(proposal.id, 'applied');
    return version;
  }

  async rejectRepairProposal(taskId: string, ruleId: string, proposalId: string) {
    const proposal = (await this.collection.listRepairProposals(ruleId)).find(
      (candidate) => candidate.id === proposalId && candidate.taskId === taskId,
    );
    if (!proposal) throw new Error('Repair Proposal was not found');
    const updated = await this.collection.updateRepairProposal(proposal.id, 'rejected');
    if (!updated) throw new Error('Repair Proposal was not found');
    return updated;
  }

  private async requireTask(taskId: string) {
    const task = await this.collection.getTask(taskId);
    if (!task) throw new Error(`Collection task ${taskId} was not found`);
    return task;
  }
}

function definitionDiff(before: unknown, after: unknown, path = ''): DefinitionChange[] {
  if (canonicalJson(before) === canonicalJson(after)) return [];
  if (isObject(before) && isObject(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      definitionDiff(before[key], after[key], `${path}/${key}`),
    );
  }
  return [{ path: path || '/', before, after }];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export * from './analyzer.js';
export * from './crawler-assistant.js';
export * from './pi-adapter.js';
export * from './provider-catalog.js';
export * from './provider.js';
export * from './provider-settings.js';
export * from './web-search.js';
