import { qualityRuleSchema, type QualityPolicy } from '@zhiyun/contracts';
import { productCopy } from './product-copy.js';

export type MonitoringRule = QualityPolicy['rules'][number];
export const conditionalMonitoringKinds = [
  'field-value-change',
  'record-count-drop',
  'null-rate-spike',
] as const;
export type ConditionalMonitoringKind = (typeof conditionalMonitoringKinds)[number];
export type MonitoringThresholdMode = 'percentage' | 'absolute' | 'legacy';

export function qualityRuleLabel(kind: string): string {
  const labels: Record<string, string> = {
    'run-failed': '运行失败',
    'empty-result': '空结果',
    'record-count-drop': '记录数骤降',
    'field-missing': '字段消失',
    'null-rate-spike': '空值率骤升',
    'type-change': '字段类型改变',
    'content-change': '内容变化阈值',
    'field-value-change': '字段值变化',
  };
  return productCopy(labels[kind] ?? kind);
}

export function defaultMonitoringRule(kind: ConditionalMonitoringKind): MonitoringRule {
  return qualityRuleSchema.parse({
    kind,
    enabled: false,
    threshold: kind === 'field-value-change' ? 0.2 : kind === 'record-count-drop' ? 0.5 : 0.3,
    thresholdMode: 'percentage',
    fields: [],
    excludeFields: [],
    consecutiveRuns: 1,
    cooldownSeconds: 300,
    aggregationSeconds: 3600,
  });
}

export function editableMonitoringPolicy(policy: QualityPolicy): QualityPolicy {
  return {
    ...policy,
    rules: [
      ...policy.rules.map((rule) => ({
        ...rule,
        fields: [...rule.fields],
        ...(rule.excludeFields ? { excludeFields: [...rule.excludeFields] } : {}),
      })),
      ...conditionalMonitoringKinds
        .filter((kind) => !policy.rules.some((rule) => rule.kind === kind))
        .map(defaultMonitoringRule),
    ],
  };
}

export function monitoringThresholdMode(rule: MonitoringRule): MonitoringThresholdMode {
  return rule.thresholdMode ?? (rule.kind === 'null-rate-spike' ? 'legacy' : 'percentage');
}

export function monitoringThreshold(rule: MonitoringRule): number {
  if (rule.threshold !== undefined) return rule.threshold;
  if (monitoringThresholdMode(rule) === 'absolute') return 1;
  return rule.kind === 'record-count-drop' || monitoringThresholdMode(rule) === 'legacy'
    ? 0.5
    : rule.kind === 'field-value-change'
      ? 0.2
      : 0.3;
}

export function setMonitoringThresholdMode(
  rule: MonitoringRule,
  mode: MonitoringThresholdMode,
): MonitoringRule {
  if (mode === 'legacy') {
    const { thresholdMode: _mode, ...legacy } = rule;
    void _mode;
    return { ...legacy, threshold: 0.5 };
  }
  return {
    ...rule,
    thresholdMode: mode,
    threshold:
      mode === 'absolute'
        ? 1
        : defaultMonitoringRule(rule.kind as ConditionalMonitoringKind).threshold!,
  };
}

export function parseMonitoringThreshold(value: string, mode: MonitoringThresholdMode): number {
  const number = value.trim() ? Number(value) : NaN;
  return mode === 'absolute' ? number : number / 100;
}

export function monitoringRulePreview(rule: MonitoringRule) {
  const mode = monitoringThresholdMode(rule),
    number = monitoringThreshold(rule);
  const amount = Number.isFinite(number)
    ? String(Number((number * (mode === 'absolute' ? 1 : 100)).toFixed(6)))
    : '—';
  let condition: string;
  if (rule.kind === 'field-value-change')
    condition =
      mode === 'absolute'
        ? `${productCopy('每个字段发生新增、更新或删除的记录数量至少')} ${amount}`
        : `${productCopy('每个字段发生新增、更新或删除的记录占比至少')} ${amount}%`;
  else if (rule.kind === 'record-count-drop')
    condition =
      mode === 'absolute'
        ? `${productCopy('记录数比基线中位数至少减少')} ${amount}`
        : `${productCopy('记录数比基线中位数至少减少')} ${amount}%`;
  else
    condition =
      mode === 'absolute'
        ? `${productCopy('空值数量比按基线比例预计的数量至少增加')} ${amount}`
        : mode === 'legacy'
          ? `${productCopy('保留旧策略：空值比例至少')} ${amount}%${productCopy('，并比基线至少上升')} ${Number(((rule.deltaThreshold ?? 0.3) * 100).toFixed(6))} ${productCopy('个百分点')}`
          : `${productCopy('空值比例比基线至少上升')} ${amount} ${productCopy('个百分点')}`;
  return {
    condition,
    fields:
      rule.kind === 'record-count-drop'
        ? productCopy('按整个任务的记录数量比较，字段过滤不参与此规则。')
        : `${productCopy('包含：')} ${rule.fields.join(', ') || productCopy('所有字段')} · ${productCopy('排除：')} ${(rule.excludeFields ?? []).join(', ') || productCopy('无')}。${productCopy(rule.kind === 'null-rate-spike' ? '排除优先；缺失字段计入空值。' : '排除优先。')}${rule.kind === 'field-value-change' && mode === 'percentage' ? productCopy('变化占比以本次记录数加删除数为分母。') : ''}`,
    delivery: `${productCopy('连续异常次数')} ${rule.consecutiveRuns ?? 1} · ${productCopy('冷却时间（秒）')} ${rule.cooldownSeconds ?? 0} · ${productCopy('聚合窗口（秒）')} ${rule.aggregationSeconds ?? 0}`,
  };
}
