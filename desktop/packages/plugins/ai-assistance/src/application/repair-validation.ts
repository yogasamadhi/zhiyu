import { validateCrawlPlan } from '@zhiyun/extraction';
import { crawlPlanDefinitionSchema, type CrawlPlanDefinition } from '@zhiyun/contracts';
import type { CrawlerPort } from '../contracts/index.js';

function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(',')}}`;
}

/** A selector repair keeps the user's output schema, actions and execution policy. */
function protectedConfiguration(plan: CrawlPlanDefinition) {
  const schema = (rule: CrawlPlanDefinition['list']['rule']) =>
    Object.fromEntries(
      Object.entries(rule.fields).map(([name, field]) => [
        name,
        {
          dataType: field.dataType,
          ...('value' in field ? { value: field.value, attribute: field.attribute } : {}),
        },
      ]),
    );
  const pagination = { ...plan.pagination };
  if ('selector' in pagination) pagination.selector = '';
  return {
    ...plan,
    pagination,
    list: { ...plan.list, rule: schema(plan.list.rule) },
    ...(plan.detail ? { detail: { ...plan.detail, rule: schema(plan.detail.rule) } } : {}),
  };
}

export function assertRepairCandidate(
  current: CrawlPlanDefinition,
  candidate: CrawlPlanDefinition,
): void {
  const parsed = crawlPlanDefinitionSchema.parse(candidate);
  validateCrawlPlan(parsed);
  if (canonical(protectedConfiguration(current)) !== canonical(protectedConfiguration(parsed)))
    throw new Error('Repair must preserve the current field schema, actions and execution policy');
}

function matchesType(value: unknown, type: string): boolean {
  if (value == null || (typeof value === 'string' && !value.trim())) return false;
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'json') return true;
  if (typeof value !== 'string') return false;
  if (type === 'date') return Number.isFinite(Date.parse(value));
  if (type === 'url') {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }
  return type === 'string';
}

/** Nonempty rows alone cannot qualify a proposal: inspect the actual extraction and final schema. */
export function assertRepairPreview(
  plan: CrawlPlanDefinition,
  result: Awaited<ReturnType<CrawlerPort['crawl']>>,
): void {
  if (!result.records.length) throw new Error('Repair preview returned no records');
  if (!result.metadata.warnings || result.metadata.warnings.length || result.metadata.warningTotal)
    throw new Error('Repair preview contains extraction warnings');
  const listFields = plan.discovery
    ? { [plan.discovery.urlField]: { dataType: 'url' } }
    : plan.list.rule.fields;
  const detailFields = plan.detail?.rule.fields ?? {};
  const fields =
    plan.detail?.mergeStrategy === 'listWins'
      ? { ...detailFields, ...listFields }
      : { ...listFields, ...detailFields };
  for (const row of result.records) {
    if (
      !row.inspection ||
      row.inspection.containerHint !== 'content' ||
      Object.values(row.inspection.fields).some((field) => field.status !== 'valid') ||
      (plan.detail && row.inspection.detail?.status !== 'resolved')
    )
      throw new Error('Repair preview failed field quality or detail relationship validation');
    for (const [name, field] of Object.entries(fields))
      if (!Object.hasOwn(row.data, name) || !matchesType(row.data[name], field.dataType))
        throw new Error('Repair preview does not satisfy the current record schema');
  }
}
