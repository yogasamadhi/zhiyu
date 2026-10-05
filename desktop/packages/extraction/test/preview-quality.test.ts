import { describe, expect, it } from 'vitest';
import { normalizeCrawlPlan, summarizeCollectionPreview } from '@zhiyun/shared';
import { extractData, validateCrawlPlan } from '../src/index.js';
import { previewFixturePages } from '../../../tooling/fixtures/src/preview-pages.js';

describe('structured preview quality', () => {
  for (const type of ['css', 'xpath', 'json'] as const) {
    it(`distinguishes unmatched, blank and invalid ${type} values without retaining raw input`, () => {
      const plan = normalizeCrawlPlan(
        type === 'json'
          ? {
              type,
              container: '$.items[*]',
              fields: {
                name: { path: '$.name', dataType: 'string' },
                price: { path: '$.price', dataType: 'number' },
                absent: { path: '$.absent', dataType: 'date' },
              },
            }
          : {
              type,
              container: type === 'css' ? '.preview-item' : '//article',
              fields: {
                name: {
                  selector: type === 'css' ? 'h2' : './/h2',
                  value: 'text',
                  dataType: 'string',
                },
                price: {
                  selector: type === 'css' ? '.price' : './/span',
                  value: 'text',
                  dataType: 'number',
                },
                absent: {
                  selector: type === 'css' ? '.absent' : './/time',
                  value: 'text',
                  dataType: 'date',
                },
              },
            },
      );
      const input =
        type === 'json'
          ? {
              items: [
                { name: '导航入口' },
                { name: '广告商品', price: 5 },
                { name: '正常商品', price: 42 },
                { name: '空值商品', price: ' ' },
                { name: '异常商品', price: '价格待协商' },
              ],
            }
          : previewFixturePages['/preview/noise'];
      const output = extractData(input, plan.list.rule, 'http://fixture.invalid', undefined, {
        inspect: true,
      });
      const summary = summarizeCollectionPreview(
        plan,
        output.records.map((data, index) => ({
          data,
          sourceUrl: 'http://fixture.invalid',
          inspection: output.inspections![index],
        })),
      );
      expect(summary.find((field) => field.name === 'price')).toMatchObject({
        measured: true,
        missingCount: 1,
        invalidTypeCount: 1,
        emptyCount: 3,
        emptyRatio: 0.6,
      });
      expect(summary.find((field) => field.name === 'absent')).toMatchObject({
        missingCount: 5,
        invalidTypeCount: 0,
      });
      expect(output.records[4]?.price).toBeNull();
      expect(JSON.stringify(output.inspections)).not.toContain('价格待协商');
      if (type !== 'json')
        expect(output.inspections?.map((row) => row.containerHint)).toEqual([
          'navigation',
          'advertisement',
          'content',
          'content',
          'content',
        ]);
    });
  }
  it('does not invent conversion diagnostics for a legacy preview', () => {
    const plan = normalizeCrawlPlan({
      type: 'css',
      container: 'article',
      fields: { number: { selector: '.n', value: 'text', dataType: 'number' } },
    });
    expect(
      summarizeCollectionPreview(plan, [
        { data: { number: null }, sourceUrl: 'http://fixture.invalid' },
      ])[0],
    ).toMatchObject({ measured: false, missingCount: null, invalidTypeCount: null, emptyRatio: 1 });
  });
  it('rejects malformed selectors, empty fields and invalid detail bindings before any navigation', () => {
    for (const rule of [
      { type: 'css', container: '[broken', fields: { name: { selector: 'h2' } } },
      { type: 'css', container: 'article', fields: { name: { selector: 'h2[' } } },
      { type: 'xpath', container: '//article', fields: { name: { selector: './/[' } } },
      { type: 'json', container: '$.items[', fields: { name: { path: '$.name' } } },
      { type: 'json', container: '$.items[*]', fields: { name: { path: '$.name[' } } },
      { type: 'css', container: 'article', fields: {} },
    ])
      expect(() => validateCrawlPlan(normalizeCrawlPlan(rule))).toThrow();
    const plan = normalizeCrawlPlan({
      type: 'css',
      container: 'article',
      fields: { name: { selector: 'h2' } },
    });
    expect(() =>
      validateCrawlPlan(
        normalizeCrawlPlan({ ...plan, detail: { urlField: 'missing', rule: plan.list.rule } }),
      ),
    ).toThrow('detail URL field');
  });
});
