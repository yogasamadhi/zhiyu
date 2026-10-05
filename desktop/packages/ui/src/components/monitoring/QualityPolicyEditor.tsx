import { useEffect, useState } from 'react';
import { qualityPolicySchema, type QualityPolicy } from '@zhiyun/contracts';
import { Button, ErrorNotice } from '../ui.js';
import { productCopy } from '../../product-copy.js';
import {
  conditionalMonitoringKinds,
  defaultMonitoringRule,
  editableMonitoringPolicy,
  monitoringRulePreview,
  monitoringThresholdMode,
  monitoringThreshold,
  parseMonitoringThreshold,
  qualityRuleLabel,
  setMonitoringThresholdMode,
  type MonitoringRule,
  type MonitoringThresholdMode,
} from '../../monitoring.js';

export function QualityPolicyEditor(props: {
  policy: QualityPolicy;
  fields: string[];
  canWrite: boolean;
  busy: boolean;
  onSave(policy: QualityPolicy): void;
}) {
  const [draft, setDraft] = useState(() => editableMonitoringPolicy(props.policy)),
    [dirty, setDirty] = useState(false);
  useEffect(() => {
    setDraft(editableMonitoringPolicy(props.policy));
    setDirty(false);
  }, [props.policy]);
  const disabled = !props.canWrite || props.busy;
  const parsed = qualityPolicySchema.safeParse(draft);
  const update = (next: QualityPolicy) => {
    setDraft(next);
    setDirty(true);
  };
  const updateRule = (rule: MonitoringRule) =>
    update({ ...draft, rules: draft.rules.map((old) => (old.kind === rule.kind ? rule : old)) });
  return (
    <div className="monitoring-editor">
      <label className="check">
        <input
          type="checkbox"
          checked={draft.enabled}
          disabled={disabled}
          onChange={(e) => update({ ...draft, enabled: e.target.checked })}
        />
        {productCopy('启用任务质量告警')}
      </label>
      <div className="monitoring-grid">
        <label>
          {productCopy('基线运行次数')}
          <input
            type="number"
            min={1}
            max={20}
            value={finite(draft.baselineRuns)}
            disabled={disabled}
            onChange={(e) => update({ ...draft, baselineRuns: number(e.target.value) })}
          />
        </label>
        <label>
          {productCopy('最少基线运行次数')}
          <input
            type="number"
            min={1}
            max={20}
            value={finite(draft.minimumBaselineRuns)}
            disabled={disabled}
            onChange={(e) => update({ ...draft, minimumBaselineRuns: number(e.target.value) })}
          />
        </label>
      </div>
      <p className="subtle">
        {productCopy(
          '新条件默认：连续 1 次异常、冷却 300 秒、聚合 3600 秒。旧策略保持原语义，只有保存后才生效。',
        )}
      </p>
      {conditionalMonitoringKinds.map((kind) => {
        const rule = draft.rules.find((candidate) => candidate.kind === kind)!,
          mode = monitoringThresholdMode(rule),
          preview = monitoringRulePreview(rule);
        const fields = [
          ...new Set([...props.fields, ...rule.fields, ...(rule.excludeFields ?? [])]),
        ];
        return (
          <fieldset key={kind} disabled={disabled} className="monitoring-rule">
            <legend>{qualityRuleLabel(kind)}</legend>
            <label className="check">
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) => updateRule({ ...rule, enabled: e.target.checked })}
              />
              {productCopy('启用此条件')}
            </label>
            <div className="monitoring-grid">
              <label>
                {productCopy('阈值单位')}
                <select
                  aria-label={productCopy('阈值单位')}
                  value={mode}
                  onChange={(e) =>
                    updateRule(
                      setMonitoringThresholdMode(rule, e.target.value as MonitoringThresholdMode),
                    )
                  }
                >
                  <option value="percentage">
                    {kind === 'null-rate-spike' ? productCopy('百分点增幅') : productCopy('百分比')}
                  </option>
                  <option value="absolute">{productCopy('绝对数量')}</option>
                  {kind === 'null-rate-spike' && (
                    <option value="legacy">{productCopy('旧策略：比例下限和增幅')}</option>
                  )}
                </select>
              </label>
              <label>
                {productCopy('触发阈值')}
                <input
                  type="number"
                  min={0}
                  max={mode === 'absolute' ? 1_000_000_000 : 100}
                  step={mode === 'absolute' ? 1 : 'any'}
                  value={finite(monitoringThreshold(rule) * (mode === 'absolute' ? 1 : 100))}
                  onChange={(e) =>
                    updateRule({
                      ...rule,
                      threshold: parseMonitoringThreshold(e.target.value, mode),
                    })
                  }
                />
              </label>
              <label>
                {productCopy('连续异常次数')}
                <input
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={finite(rule.consecutiveRuns ?? 1)}
                  onChange={(e) => updateRule({ ...rule, consecutiveRuns: number(e.target.value) })}
                />
              </label>
              <label>
                {productCopy('冷却时间（秒）')}
                <input
                  type="number"
                  min={0}
                  max={604800}
                  step={1}
                  value={finite(rule.cooldownSeconds ?? 0)}
                  onChange={(e) => updateRule({ ...rule, cooldownSeconds: number(e.target.value) })}
                />
              </label>
              <label>
                {productCopy('聚合窗口（秒）')}
                <input
                  type="number"
                  min={0}
                  max={604800}
                  step={1}
                  value={finite(rule.aggregationSeconds ?? 0)}
                  onChange={(e) =>
                    updateRule({ ...rule, aggregationSeconds: number(e.target.value) })
                  }
                />
              </label>
            </div>
            {kind !== 'record-count-drop' && (
              <div className="monitoring-grid">
                {(['fields', 'excludeFields'] as const).map((key) => (
                  <label key={key}>
                    {productCopy(key === 'fields' ? '包含字段' : '排除字段')}
                    <select
                      aria-label={productCopy(key === 'fields' ? '包含字段' : '排除字段')}
                      multiple
                      value={rule[key] ?? []}
                      onChange={(e) =>
                        updateRule({
                          ...rule,
                          [key]: Array.from(e.target.selectedOptions, (option) => option.value),
                        })
                      }
                    >
                      {fields.map((field) => (
                        <option key={field} value={field}>
                          {field}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
            <div className="monitoring-preview" aria-label={productCopy('条件预览')}>
              <p>{preview.condition}</p>
              <p>{preview.fields}</p>
              <p>{preview.delivery}</p>
              <p>
                {productCopy(
                  '基线就绪且实际发生变化后评估。冷却期间继续记录异常；聚合不会延长冷却。0 秒表示关闭对应限制。',
                )}
              </p>
            </div>
            <Button
              className="button-secondary"
              onClick={() => updateRule({ ...defaultMonitoringRule(kind), enabled: rule.enabled })}
            >
              {productCopy('使用此条件默认值')}
            </Button>
          </fieldset>
        );
      })}
      <details>
        <summary>{productCopy('其他已有质量规则')}</summary>
        <div className="compact-list">
          {draft.rules
            .filter((rule) => !conditionalMonitoringKinds.some((kind) => kind === rule.kind))
            .map((rule) => (
              <label className="check" key={rule.kind}>
                <input
                  type="checkbox"
                  checked={rule.enabled}
                  disabled={disabled}
                  onChange={(e) => updateRule({ ...rule, enabled: e.target.checked })}
                />
                {qualityRuleLabel(rule.kind)}
              </label>
            ))}
        </div>
      </details>
      <ErrorNotice
        message={
          parsed.success
            ? ''
            : productCopy(
                '请检查阈值、连续次数、时间范围和基线设置。绝对阈值必须是整数；比例为 0–100；最少基线次数不能大于基线次数。',
              )
        }
      />
      {props.canWrite && (
        <div className="row-actions">
          <Button
            disabled={props.busy || !dirty || !parsed.success}
            onClick={() => parsed.success && props.onSave(parsed.data)}
          >
            {productCopy('保存监控策略')}
          </Button>
          <Button
            className="button-secondary"
            disabled={props.busy || !dirty}
            onClick={() => {
              setDraft(editableMonitoringPolicy(props.policy));
              setDirty(false);
            }}
          >
            {productCopy('放弃未保存修改')}
          </Button>
        </div>
      )}
    </div>
  );
}
function finite(value: number): number | '' {
  return Number.isFinite(value) ? value : '';
}
function number(value: string): number {
  return value.trim() ? Number(value) : NaN;
}
