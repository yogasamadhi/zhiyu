import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AssistantDetail, AiTurnAccounting } from '@zhiyun/shared';
import { AssistantCostPanel } from '../src/components/assistant/AssistantCostPanel.js';
let started = 0;
beforeEach(() => {
  started = performance.now();
});
afterEach(({ task }) =>
  console.info(
    'UI_CASE_METRICS',
    JSON.stringify({
      fixtureVersion: 'repair-quality-v3',
      name: task.name,
      providerCalls: 0,
      operations: {},
      durationMs: performance.now() - started,
    }),
  ),
);
const turn: NonNullable<AssistantDetail['turn']> = {
  id: 'turn',
  conversationId: 'conversation',
  status: 'succeeded',
  attempt: 1,
  modelRounds: 1,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  error: null,
  createdAt: '2026-10-04T00:00:00Z',
  startedAt: null,
  finishedAt: null,
};
const base: AiTurnAccounting = {
  calls: 1,
  inputTokens: null,
  outputTokens: null,
  tokensSource: 'unknown',
  costs: [],
  unknownCostCalls: 1,
  estimatedCost: null,
  budget: null,
  stopReason: null,
  operations: { chat: 1 },
};
const render = (accounting?: AiTurnAccounting, language: 'zh' | 'en' = 'zh') =>
  renderToStaticMarkup(
    createElement(AssistantCostPanel, {
      turn: { ...turn, ...(accounting ? { accounting } : {}) },
      language,
    }),
  );
describe('assistant cost provenance', () => {
  it('shows missing and historical zero placeholders as unknown and not settled', () => {
    for (const html of [render(), render(base)]) {
      expect(html).toContain('Token：未知');
      expect(html).toContain('费用未知 / 未结算');
      expect(html).not.toContain('¥0');
      expect(html).not.toContain('输入 0');
    }
  });
  it('separates Mock values, estimates and settlement with their currencies', () => {
    const html = render({
      ...base,
      inputTokens: 12,
      outputTokens: 8,
      tokensSource: 'mixed',
      unknownCostCalls: 0,
      costs: [
        { source: 'mock', amount: 0, currency: 'CNY' },
        { source: 'estimate', amount: 0.08, currency: 'CNY' },
        { source: 'settled', amount: 0.06, currency: 'USD' },
      ],
    });
    expect(html).toContain('Provider 报告');
    expect(html).toContain('混合来源');
    expect(html).toContain('输入 12 / 输出 8');
    for (const label of ['Mock 值', '估算', '实际结算']) expect(html).toContain(label);
    expect(html).toContain('US$0.06');
  });
  it('retains an offline turn budget without inventing usage or a zero estimate', () => {
    const html = renderToStaticMarkup(
      createElement(AssistantCostPanel, {
        turn: {
          ...turn,
          costBudget: { maximum: 1, perCallEstimate: 0.25, currency: 'USD' },
        },
      }),
    );
    expect(html).toContain('Token：未知');
    expect(html).toContain('费用未知 / 未结算');
    expect(html).toContain('估算：未知 / 预估上限 US$1.00');
    expect(html).not.toContain('$0.00');
  });
  it('shows the stopped estimate budget and supports English', () => {
    const html = render(
      {
        ...base,
        budget: { maximum: 0.25, perCallEstimate: 0.25, currency: 'CNY' },
        estimatedCost: 0.25,
        stopReason: 'cost_limit',
      },
      'en',
    );
    expect(html).toContain('Estimate');
    expect(html).toContain('Estimated limit');
    expect(html).toContain('Further model and tool calls stopped');
    expect(html).toContain('Token：Unknown');
  });
});
