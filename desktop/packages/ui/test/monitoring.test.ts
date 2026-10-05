import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { qualityPolicySchema } from '@zhiyun/contracts';
import i18n from '../src/i18n.js';
import { productCopy } from '../src/product-copy.js';
import { QualityPolicyEditor } from '../src/components/monitoring/QualityPolicyEditor.js';
import {
  defaultMonitoringRule,
  editableMonitoringPolicy,
  monitoringRulePreview,
  monitoringThresholdMode,
  parseMonitoringThreshold,
  qualityRuleLabel,
  setMonitoringThresholdMode,
} from '../src/monitoring.js';

afterEach(async () => {
  await i18n.changeLanguage('zh-CN');
});
describe('monitoring configuration semantics', () => {
  it('adds disabled conditions with stable defaults without mutating or migrating a legacy null rule', () => {
    const saved = qualityPolicySchema.parse({
      rules: [
        { kind: 'null-rate-spike', threshold: 0.5, deltaThreshold: 0.3, fields: ['__proto__'] },
      ],
    });
    const before = JSON.stringify(saved),
      editable = editableMonitoringPolicy(saved);
    expect(JSON.stringify(saved)).toBe(before);
    expect(editable.rules.map((rule) => rule.kind)).toEqual([
      'null-rate-spike',
      'field-value-change',
      'record-count-drop',
    ]);
    const legacy = editable.rules[0]!;
    expect(legacy.thresholdMode).toBeUndefined();
    expect(monitoringThresholdMode(legacy)).toBe('legacy');
    expect(monitoringRulePreview(legacy).condition).toContain('50%');
    expect(monitoringRulePreview(legacy).condition).toContain('30');
    expect(monitoringRulePreview(legacy).delivery).toContain('0');
    expect(editable.rules[1]).toMatchObject({
      enabled: false,
      threshold: 0.2,
      thresholdMode: 'percentage',
      consecutiveRuns: 1,
      cooldownSeconds: 300,
      aggregationSeconds: 3600,
    });
    legacy.fields.push('literal.field');
    expect(saved.rules[0]!.fields).toEqual(['__proto__']);
  });

  it('converts displayed percent units exactly and rejects invalid whole-count, percent and duration inputs', () => {
    expect(parseMonitoringThreshold('0.5', 'percentage')).toBe(0.005);
    expect(parseMonitoringThreshold('4', 'absolute')).toBe(4);
    expect(parseMonitoringThreshold('', 'percentage')).toBeNaN();
    for (const rule of [
      {
        ...defaultMonitoringRule('field-value-change'),
        threshold: parseMonitoringThreshold('101', 'percentage'),
      },
      {
        ...setMonitoringThresholdMode(defaultMonitoringRule('field-value-change'), 'absolute'),
        threshold: 1.5,
      },
      { ...defaultMonitoringRule('null-rate-spike'), cooldownSeconds: -1 },
      { ...defaultMonitoringRule('record-count-drop'), consecutiveRuns: 0 },
    ])
      expect(qualityPolicySchema.safeParse({ rules: [rule] }).success).toBe(false);
    expect(qualityPolicySchema.safeParse({ baselineRuns: 2, minimumBaselineRuns: 3 }).success).toBe(
      false,
    );
  });

  it('previews field counts, record-count ratios, null percentage points and baseline-adjusted null counts', async () => {
    await i18n.changeLanguage('en');
    expect(qualityRuleLabel('field-value-change')).toBe('Field value changes');
    expect(['已恢复', '已关闭', '首次', '下一页'].map((key) => productCopy(key))).toEqual([
      'Recovered',
      'Closed',
      'First occurrence',
      'Next page',
    ]);
    const change = {
      ...defaultMonitoringRule('field-value-change'),
      fields: ['price', 'secret'],
      excludeFields: ['secret'],
    };
    const preview = monitoringRulePreview(change);
    expect(preview.condition).toContain('20%');
    expect(preview.fields).toContain('Exclusions take priority');
    expect(preview.fields).toContain("this run's record count plus removed records");
    expect(monitoringRulePreview(defaultMonitoringRule('record-count-drop')).condition).toContain(
      'baseline median',
    );
    expect(
      monitoringRulePreview(setMonitoringThresholdMode(change, 'absolute')).condition,
    ).toContain('number of added, updated or removed records');
    expect(monitoringRulePreview(defaultMonitoringRule('record-count-drop')).fields).toContain(
      'Field filters do not apply',
    );
    expect(monitoringRulePreview(defaultMonitoringRule('null-rate-spike')).condition).toContain(
      '30 percentage points',
    );
    expect(
      monitoringRulePreview(
        setMonitoringThresholdMode(defaultMonitoringRule('null-rate-spike'), 'absolute'),
      ).condition,
    ).toContain('count expected from its baseline rate');
    expect(
      monitoringThresholdMode(
        setMonitoringThresholdMode(defaultMonitoringRule('null-rate-spike'), 'legacy'),
      ),
    ).toBe('legacy');
  });

  it('renders a disabled policy without write actions for a viewer and preserves field labels safely', () => {
    const policy = qualityPolicySchema.parse({});
    const html = renderToStaticMarkup(
      createElement(QualityPolicyEditor, {
        policy,
        fields: ['price', '<private-field>'],
        canWrite: false,
        busy: false,
        onSave: () => {
          throw new Error('Viewer cannot save');
        },
      }),
    );
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('保存监控策略');
    expect(html).not.toContain('<private-field>');
    expect(html).toContain('&lt;private-field&gt;');
  });
});
