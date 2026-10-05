import { assistantExampleHtml as html } from '@zhiyun/shared';
import { extractData } from '@zhiyun/extraction';
import { normalizeCrawlPlan, taskCreateSchema, type CrawlPlanDefinition } from '@zhiyun/shared';
export const productExampleUrl = 'https://sample.zhiyun.invalid/products';
export function productExampleDraft() {
  return {
    task: taskCreateSchema.parse({
      name: '商品价格示例',
      startUrl: productExampleUrl,
      instruction: '采集商品名称、分类、价格和库存',
      datasetSettings: { mode: 'snapshot', keyFields: ['名称'], detectRemoved: true },
    }),
    definition: normalizeCrawlPlan({
      type: 'css',
      container: '.product',
      fields: {
        名称: { selector: 'h2', value: 'text', dataType: 'string' },
        分类: { selector: '.category', value: 'text', dataType: 'string' },
        价格: { selector: '.price', value: 'text', dataType: 'number' },
        库存: { selector: '.stock', value: 'text', dataType: 'number' },
      },
    }),
  };
}
export function executeProductExample(
  exampleId: string,
  definition: CrawlPlanDefinition,
  limit = 1000,
  inspect = false,
) {
  if (exampleId !== 'products') throw new Error('Unknown built-in example');
  if (definition.list.rule.type !== 'css' || definition.detail)
    throw new Error('The product example supports CSS fields on its bundled page');
  const result = extractData(html, definition.list.rule, productExampleUrl, undefined, { inspect });
  return {
    records: result.records.slice(0, limit).map((data, index) => ({
      sourceUrl: productExampleUrl,
      data,
      ...(result.inspections?.[index] ? { inspection: result.inspections[index] } : {}),
    })),
    metadata: {
      requestCount: 0,
      browserUsed: false,
      aiUsed: false,
      durationMs: 0,
      warnings: result.warnings,
      urls: [],
    },
  };
}
