import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  normalizeCrawlPlan,
  type DiagnosticErrorCode,
  type DiagnosticStep,
  type RunDiagnostics as Report,
} from '@zhiyun/contracts';
import i18n from '../src/i18n.js';
import { RunDiagnostics } from '../src/components/RunDiagnostics.js';
import { ActionCacheSummary } from '../src/components/RuleCacheNotice.js';
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});
const id = '8b3745d3-4a5b-4a52-8246-dd4e87d70dc8';
const timestamp = '2026-10-03T07:00:00.000Z';
function render(code: DiagnosticErrorCode, kind: DiagnosticStep['kind'], permission = true) {
  const report: Report = {
    formatVersion: 1,
    run: {
      id,
      taskId: id,
      traceId: id,
      ruleVersionId: id,
      status: code === 'CANCELED' ? 'canceled' : 'failed',
      startedAt: timestamp,
      finishedAt: timestamp,
      errorCode: code,
    },
    available: true,
    truncated: false,
    stepCount: 1,
    steps: [
      {
        kind,
        target: 'list',
        status: code === 'CANCELED' ? 'canceled' : 'failed',
        startedAt: timestamp,
        durationMs: 1000,
        errorCode: code,
        ...(kind === 'selector' ? { fieldIndex: 0, matchedCount: 0 } : {}),
      },
    ],
  };
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      {},
      createElement(RunDiagnostics, {
        report,
        taskId: id,
        running: false,
        canEdit: permission,
        canRetry: permission,
        retryable: true,
        definition: normalizeCrawlPlan({
          type: 'css',
          container: 'article',
          fields: { 价格: { selector: '.price', dataType: 'number' } },
        }),
        refresh: () => undefined,
        retry: () => undefined,
        clear: async () => undefined,
        export: async () => undefined,
      }),
    ),
  );
}
describe('offline diagnostic recovery interface', () => {
  it('shows verified action counts and rejects unrecognized diagnostic content', () => {
    const value = {
      stages: 3,
      hitStages: 3,
      storedStages: 0,
      bypassedStages: 0,
      providerCalls: 0,
      reasons: { matched: 3 },
    };
    const html = renderToStaticMarkup(createElement(ActionCacheSummary, { value }));
    expect(html).toContain('命中 3');
    expect(html).toContain('修复调用 0');
    expect(html).toContain('已执行并验证当前页面动作');
    expect(
      renderToStaticMarkup(
        createElement(ActionCacheSummary, {
          value: {
            ...value,
            reasons: { FAKE_TOKEN_BAD_REASON: 3 },
          },
        }),
      ),
    ).toBe('');
  });
  it.each([
    ['NAVIGATION_ERROR', 'navigation', '页面访问失败', '新建重试运行'],
    ['SELECTOR_UNMATCHED', 'selector', '字段未匹配', '修改字段规则'],
    ['ACTION_STATE_INVALID', 'action', '动作未达到预期页面状态', '修改字段规则'],
    ['TIMEOUT', 'action', '步骤超时', '调整超时与资源上限'],
    ['CANCELED', 'navigation', '已取消', '新建重试运行'],
  ] as const)('shows the actual %s step and its recovery entry', (code, kind, reason, recovery) => {
    const html = render(code, kind);
    expect(html).toContain(reason);
    expect(html).toContain(recovery);
    if (code === 'SELECTOR_UNMATCHED') {
      expect(html).toContain('价格');
      expect(html).toContain(`/tasks/${id}/edit`);
    }
    if (code === 'TIMEOUT') expect(html).toContain(`/tasks/${id}/edit`);
    expect(html).toContain('1000 ms');
  });
  it('does not offer write or execution actions to a reader', () => {
    const html = render('SELECTOR_UNMATCHED', 'selector', false);
    expect(html).not.toContain('修改字段规则');
    expect(html).not.toContain('清理本次诊断');
    expect(html).toContain('导出诊断包');
  });
});
