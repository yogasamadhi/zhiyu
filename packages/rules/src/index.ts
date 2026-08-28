import {
  crawlPlanDefinitionSchema,
  extractionRuleDefinitionSchema,
  normalizeCrawlPlan,
  RuleError,
  type CrawlPlanDefinition,
  type ExtractionRuleDefinition,
} from '@zhiyun/shared';

export function validateRule(definition: unknown): ExtractionRuleDefinition {
  const result = extractionRuleDefinitionSchema.safeParse(definition);
  if (!result.success) {
    throw new RuleError('Invalid extraction rule', result.error.flatten());
  }
  if (Object.keys(result.data.fields).length === 0) {
    throw new RuleError('An extraction rule must contain at least one field');
  }
  return result.data;
}

export function describeRule(definition: ExtractionRuleDefinition): string[] {
  return Object.keys(definition.fields);
}

export function validateCrawlPlan(definition: unknown): CrawlPlanDefinition {
  let result;
  try {
    result = crawlPlanDefinitionSchema.safeParse(normalizeCrawlPlan(definition));
  } catch (error) {
    throw new RuleError('Invalid crawl plan', error);
  }
  if (!result.success) throw new RuleError('Invalid crawl plan', result.error.flatten());
  validateRule(result.data.list.rule);
  if (result.data.detail) validateRule(result.data.detail.rule);
  return result.data;
}

export function describeCrawlPlan(definition: CrawlPlanDefinition): string[] {
  return [
    ...describeRule(definition.list.rule),
    ...(definition.detail ? describeRule(definition.detail.rule) : []),
  ];
}
