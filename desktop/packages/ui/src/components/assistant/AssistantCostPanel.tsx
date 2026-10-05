import { aiCostBudgetSchema, aiTurnAccountingSchema, type AssistantDetail } from '@zhiyun/shared';

export function AssistantCostPanel({
  turn,
  language = 'zh',
}: {
  turn: AssistantDetail['turn'];
  language?: 'zh' | 'en';
}) {
  if (!turn) return null;
  const text = (zh: string, en: string) => (language === 'zh' ? zh : en);
  const parsed = aiTurnAccountingSchema.safeParse(turn.accounting);
  const accounting = parsed.success ? parsed.data : null;
  const parsedBudget = aiCostBudgetSchema.safeParse(turn.costBudget);
  const budget = accounting?.budget ?? (parsedBudget.success ? parsedBudget.data : null);
  const money = (amount: number, currency: 'CNY' | 'USD') =>
    new Intl.NumberFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    }).format(amount);
  const labels = {
    mock: text('Mock 值', 'Mock value'),
    estimate: text('估算', 'Estimate'),
    settled: text('实际结算', 'Settled'),
  };
  const tokens =
    !accounting || accounting.tokensSource === 'unknown'
      ? text('未知', 'Unknown')
      : `${accounting.tokensSource === 'mock' ? text('Mock 值', 'Mock value') : accounting.tokensSource === 'mixed' ? text('混合来源（Mock 值 / Provider 报告）', 'Mixed sources (Mock / Provider reported)') : text('Provider 报告', 'Provider reported')} · ${text('输入', 'Input')} ${accounting.inputTokens} / ${text('输出', 'Output')} ${accounting.outputTokens}`;
  return (
    <details className="notice assistant-cost-panel" data-testid="assistant-cost-panel">
      <summary>{text('本轮 AI 用量与费用', 'AI usage and costs for this turn')}</summary>
      <p>Token：{tokens}</p>
      {accounting && (
        <p>
          {text('AI 调用', 'AI calls')}：{accounting.calls}
        </p>
      )}
      {(accounting?.costs ?? []).map((cost) => (
        <p key={`${cost.source}:${cost.currency}`}>
          {labels[cost.source]}：{money(cost.amount, cost.currency)}
        </p>
      ))}
      {(!accounting || accounting.unknownCostCalls > 0 || accounting.costs.length === 0) && (
        <p>
          {text('费用未知 / 未结算', 'Cost unknown / Not settled')}
          {accounting?.unknownCostCalls
            ? ` · ${accounting.unknownCostCalls} ${text('次调用', 'calls')}`
            : ''}
        </p>
      )}
      {budget && (
        <p>
          {text('估算', 'Estimate')}：
          {accounting?.estimatedCost == null
            ? text('未知', 'Unknown')
            : money(accounting.estimatedCost, budget.currency)}{' '}
          / {text('预估上限', 'Estimated limit')} {money(budget.maximum, budget.currency)}
        </p>
      )}
      {accounting?.stopReason && (
        <p role="status">
          {accounting.stopReason === 'cost_limit'
            ? text(
                '预估额度不足，已停止后续模型和工具调用。',
                'Estimated budget exhausted. Further model and tool calls stopped.',
              )
            : text(
                '缺少可用估价，已停止本轮模型调用。',
                'No usable estimate. Model calls stopped for this turn.',
              )}
        </p>
      )}
      <small>
        {text(
          '估算与 Mock 值不代表实际账单；结算金额须由服务方提供。',
          'Estimates and Mock values are not bills. Settlement must come from the provider.',
        )}
      </small>
    </details>
  );
}
