import type { BrowserAction, CrawlPlanDefinition } from '@zhiyun/contracts';

type ValueBinding = { stage: 'list' | 'detail'; index: number; sourceIndex: number };
export type RuleActionProjection = { plan: CrawlPlanDefinition; bindings: ValueBinding[] };

/** Persist references only to values already supplied in the current task configuration. */
export function projectRuleActionValues(
  plan: CrawlPlanDefinition,
  configured: BrowserAction[],
): RuleActionProjection | null {
  const projected = structuredClone(plan);
  const bindings: ValueBinding[] = [];
  for (const stage of ['list', 'detail'] as const) {
    const target = projected[stage];
    if (!target) continue;
    for (const [index, action] of target.actions.entries()) {
      if (action.type !== 'fill' && action.type !== 'select') continue;
      const sourceIndex = configured.findIndex(
        (source) =>
          source.type === action.type &&
          source.selector === action.selector &&
          source.value === action.value,
      );
      if (sourceIndex < 0 || bindings.length >= 256) return null;
      bindings.push({ stage, index, sourceIndex });
      action.value = '';
    }
  }
  return { plan: projected, bindings };
}

/** A projected payload cannot smuggle a literal value, omit a binding or bind a different action. */
export function readRuleActionProjection(
  plan: CrawlPlanDefinition,
  raw: unknown,
): RuleActionProjection {
  if (!Array.isArray(raw) || !raw.length || raw.length > 256)
    throw new Error('Invalid action value bindings');
  const bindings: ValueBinding[] = [];
  const positions = new Set<string>();
  for (const entry of raw) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Object.keys(entry).sort().join(',') !== 'index,sourceIndex,stage'
    )
      throw new Error('Invalid action value reference');
    const value = entry as Record<string, unknown>;
    if (
      (value.stage !== 'list' && value.stage !== 'detail') ||
      !Number.isSafeInteger(value.index) ||
      Number(value.index) < 0 ||
      !Number.isSafeInteger(value.sourceIndex) ||
      Number(value.sourceIndex) < 0 ||
      Number(value.sourceIndex) > 10_000
    )
      throw new Error('Invalid action value reference');
    const binding = value as ValueBinding;
    const action = plan[binding.stage]?.actions[binding.index];
    const position = `${binding.stage}:${binding.index}`;
    if (
      !action ||
      (action.type !== 'fill' && action.type !== 'select') ||
      action.value !== '' ||
      positions.has(position)
    )
      throw new Error('Invalid projected action');
    positions.add(position);
    bindings.push(binding);
  }
  for (const stage of ['list', 'detail'] as const)
    for (const [index, action] of (plan[stage]?.actions ?? []).entries())
      if (
        (action.type === 'fill' || action.type === 'select') &&
        !positions.has(`${stage}:${index}`)
      )
        throw new Error('Missing action value reference');
  return { plan, bindings };
}

export function restoreRuleActionValues(
  projection: RuleActionProjection,
  configured: BrowserAction[],
): CrawlPlanDefinition | null {
  const plan = structuredClone(projection.plan);
  for (const { stage, index, sourceIndex } of projection.bindings) {
    const action = plan[stage]?.actions[index];
    const source = configured[sourceIndex];
    if (
      !action ||
      (action.type !== 'fill' && action.type !== 'select') ||
      !source ||
      source.type !== action.type ||
      source.selector !== action.selector
    )
      return null;
    action.value = source.value;
  }
  return plan;
}
