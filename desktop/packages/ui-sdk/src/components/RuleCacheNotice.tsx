import {
  browserActionCacheSummarySchema,
  ruleCacheResultSchema,
  type AnalysisResult,
  type AssistantMessageBlock,
} from '@zhiyun/shared';
import { useTranslation } from 'react-i18next';
import { productCopy } from '../product-copy.js';

const reasons: Record<NonNullable<AnalysisResult['cache']>['reason'], string> = {
  matched: '已在当前页面验证并复用规则',
  empty: '首次创建已验证规则缓存',
  structure_changed: '页面结构已变化，已重新验证旧规则',
  rule_changed: '规则版本已变化',
  configuration_changed: '采集配置或动作已变化',
  session_changed: '登录或请求上下文已变化',
  provider_changed: '模型配置已变化',
  prompt_changed: '提示词或工具版本已变化',
  expired: '缓存已过期',
  corrupt: '缓存已损坏，已回退到重新生成',
  validation_failed: '当前数据或未执行的步骤尚未通过缓存验证',
  privacy_rejected: '规则包含不适合持久缓存的值',
  provider_unknown: '模型未提供可验证的缓存身份',
  scope_missing: '此次分析没有独立缓存范围',
  cleared_during_analysis: '分析期间缓存已被手动清理',
  storage_unavailable: '缓存存储暂不可用，已继续分析',
  generation_failed: '规则生成失败，未缓存备用规则',
  fingerprint_limit: '页面结构超过缓存指纹限制',
};
const actionReasons: Partial<Record<NonNullable<AnalysisResult['cache']>['reason'], string>> = {
  matched: '已执行并验证当前页面动作',
  empty: '首次创建已验证动作缓存',
  structure_changed: '页面结构已变化，已验证当前动作',
  validation_failed: '动作缺少验证条件或未达到预期状态',
  privacy_rejected: '动作包含不适合持久缓存的选择器',
};

export function AssistantCacheNotice({
  block,
}: {
  block: Extract<AssistantMessageBlock, { type: 'fields' }>;
}) {
  const zh = useTranslation().i18n.language.startsWith('zh');
  const cache = ruleCacheResultSchema.strict().safeParse(block.cache);
  const actionCache = ruleCacheResultSchema.strict().safeParse(block.actionCache);
  if (!cache.success && !actionCache.success) return null;
  return (
    <section
      aria-label={zh ? '本次字段生成的缓存结果' : 'Cache results for this field generation'}
      data-testid="assistant-cache-results"
    >
      {cache.success && <RuleCacheNotice result={cache.data} />}
      {actionCache.success && <RuleCacheNotice result={actionCache.data} kind="action" />}
    </section>
  );
}

export function ActionCacheSummary({ value }: { value: unknown }) {
  const zh = useTranslation().i18n.language.startsWith('zh');
  const parsed = browserActionCacheSummarySchema.safeParse(value);
  if (!parsed.success) return null;
  const result = parsed.data;
  return (
    <div className="notice" role="status" data-testid="action-cache-summary">
      <strong>{zh ? '本次动作缓存' : 'Browser action cache for this execution'}</strong>
      <div>
        {zh ? '执行阶段' : 'Stages'} {result.stages} · {zh ? '命中' : 'Hits'} {result.hitStages} ·{' '}
        {zh ? '保存' : 'Stored'} {result.storedStages} · {zh ? '跳过' : 'Bypassed'}{' '}
        {result.bypassedStages} · {zh ? '修复调用' : 'Repair calls'} {result.providerCalls}
      </div>
      {Object.entries(result.reasons).map(([reason, count]) => (
        <div key={reason}>
          {productCopy(
            actionReasons[reason as keyof typeof actionReasons] ??
              reasons[reason as keyof typeof reasons],
          )}{' '}
          × {count}
        </div>
      ))}
    </div>
  );
}

export function RuleCacheNotice({
  result,
  kind = 'rule',
}: {
  result: NonNullable<AnalysisResult['cache']>;
  kind?: 'rule' | 'action';
}) {
  const state = {
    hit: '缓存命中',
    stored: '缓存已保存',
    miss: '未使用缓存',
    bypassed: '本次跳过缓存',
  }[result.status];
  const actionState = {
    hit: '动作缓存命中',
    stored: '动作缓存已保存',
    miss: '未使用动作缓存',
    bypassed: '本次跳过动作缓存',
  }[result.status];
  const reason =
    kind === 'action'
      ? (actionReasons[result.reason] ?? reasons[result.reason])
      : reasons[result.reason];
  return (
    <div
      className="notice"
      role="status"
      data-testid={kind === 'action' ? 'action-cache-status' : 'rule-cache-status'}
    >
      {productCopy(kind === 'action' ? actionState : state)} · {productCopy(reason)}
      <div>
        {productCopy('累计复用')} {result.hitCount} ·{' '}
        {productCopy(kind === 'action' ? '本次动作修复调用' : '本次规则生成调用')}{' '}
        {result.providerCalls}
      </div>
    </div>
  );
}
