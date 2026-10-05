import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import { assistantMessageBlockSchema, type AssistantMessageBlock } from '@zhiyun/shared';
import i18n from '../src/i18n.js';
import { AssistantCacheNotice } from '../src/components/RuleCacheNotice.js';

type Fields = Extract<AssistantMessageBlock, { type: 'fields' }>;
const base: Fields = {
  type: 'fields',
  id: 'fields-one',
  draftId: 'draft-one',
  fields: ['name', 'price'],
};
const render = (block: Fields) =>
  renderToStaticMarkup(createElement(AssistantCacheNotice, { block }));
beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
});

describe('default assistant field-generation cache feedback', () => {
  it('shows separate verified rule and action results, counts and regeneration reasons in historical field cards', () => {
    const first = assistantMessageBlockSchema.parse({
      ...base,
      cache: { status: 'stored', reason: 'empty', hitCount: 0, providerCalls: 2 },
      actionCache: { status: 'stored', reason: 'empty', hitCount: 0, providerCalls: 1 },
    }) as Fields;
    const firstHtml = render(first);
    expect(firstHtml).toContain('本次字段生成的缓存结果');
    expect(firstHtml).toContain('data-testid="rule-cache-status"');
    expect(firstHtml).toContain('data-testid="action-cache-status"');
    expect(firstHtml).toContain('本次规则生成调用');
    expect(firstHtml).toContain('本次动作修复调用');
    expect(firstHtml).not.toContain('费用');
    const repeated: Fields = {
      ...first,
      cache: { status: 'hit', reason: 'matched', hitCount: 1, providerCalls: 0 },
      actionCache: { status: 'hit', reason: 'matched', hitCount: 1, providerCalls: 0 },
    };
    const hitHtml = render(repeated);
    expect(hitHtml).toContain('缓存命中');
    expect(hitHtml).toContain('动作缓存命中');
    expect(hitHtml).toContain('累计复用 1');
    expect(hitHtml).toContain('本次规则生成调用');
    const regenerated: Fields = {
      ...base,
      cache: { status: 'stored', reason: 'corrupt', hitCount: 0, providerCalls: 2 },
    };
    expect(render(regenerated)).toContain('缓存已损坏，已回退到重新生成');
  });

  it('rejects unrecognized or private cache metadata while retaining an independently valid action result', () => {
    const untrusted = {
      ...base,
      cache: {
        status: 'hit',
        reason: 'FAKE_ASSISTANT_PRIVATE_REASON',
        hitCount: 1,
        providerCalls: 0,
      },
      actionCache: { status: 'hit', reason: 'matched', hitCount: 1, providerCalls: 0 },
    } as unknown as Fields;
    const html = render(untrusted);
    expect(html).not.toContain('FAKE_ASSISTANT_PRIVATE_REASON');
    expect(html).not.toContain('data-testid="rule-cache-status"');
    expect(html).toContain('动作缓存命中');
    const extra = {
      ...base,
      cache: {
        status: 'hit',
        reason: 'matched',
        hitCount: 1,
        providerCalls: 0,
        dom: 'FAKE_PRIVATE_DOM',
      },
    } as unknown as Fields;
    expect(render(extra)).toBe('');
    expect(assistantMessageBlockSchema.safeParse(extra).success).toBe(false);
  });

  it('restores legacy field cards without inventing cache counts and supports English', async () => {
    expect(assistantMessageBlockSchema.safeParse(base).success).toBe(true);
    expect(render(base)).toBe('');
    await i18n.changeLanguage('en');
    try {
      const html = render({
        ...base,
        cache: { status: 'hit', reason: 'matched', hitCount: 1, providerCalls: 0 },
      });
      expect(html).toContain('Cache results for this field generation');
      expect(html).toContain('Cache hit');
      expect(html).not.toContain('undefined');
    } finally {
      await i18n.changeLanguage('zh-CN');
    }
  });
});
