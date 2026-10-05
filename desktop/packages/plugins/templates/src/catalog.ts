import { type CrawlPlanDefinition, type QualityPolicy, type TaskTemplate } from '@zhiyun/shared';
import { validateTaskTemplateCatalog } from './catalog-validation.js';

const listRule = (
  pagination: CrawlPlanDefinition['pagination'] = { type: 'none' },
): CrawlPlanDefinition => ({
  version: 1,
  list: {
    mode: 'auto',
    actions: [],
    rule: {
      type: 'css',
      container: '{{container}}',
      fields: {
        title: { selector: '{{titleSelector}}', value: 'text', dataType: 'string' },
        url: {
          selector: '{{linkSelector}}',
          value: 'attribute',
          attribute: 'href',
          dataType: 'url',
        },
      },
    },
  },
  pagination,
  dedupe: { strategy: 'fields', fields: ['url'] },
  limits: { maxRecords: 1_000_000 },
});

const commonParameters = [
  { key: 'container', label: '记录容器选择器', type: 'selector' as const, required: true },
  { key: 'titleSelector', label: '标题选择器', type: 'selector' as const, required: true },
  { key: 'linkSelector', label: '链接选择器', type: 'selector' as const, required: true },
];

const changeQuality: QualityPolicy = {
  enabled: true,
  baselineRuns: 5,
  minimumBaselineRuns: 3,
  rules: [
    { kind: 'run-failed', enabled: true, fields: [] },
    { kind: 'empty-result', enabled: true, fields: [] },
    { kind: 'record-count-drop', enabled: true, threshold: 0.5, fields: [] },
    { kind: 'field-missing', enabled: true, threshold: 0.1, fields: [] },
    { kind: 'null-rate-spike', enabled: true, threshold: 0.5, fields: [] },
    { kind: 'type-change', enabled: true, threshold: 0.8, fields: [] },
    { kind: 'content-change', enabled: true, threshold: 0.2, fields: [] },
  ],
};

const rawCatalog: TaskTemplate[] = [
  {
    id: 'list-page',
    version: 1,
    name: '普通列表页',
    description: '从重复的列表卡片中提取标题和链接。',
    category: 'list',
    parameters: commonParameters,
    compatibility: { browserRequired: false, loginSupported: false, capabilities: [] },
    taskDefaults: { instruction: '提取列表中的标题和链接' },
    ruleDefinition: listRule(),
  },
  {
    id: 'list-detail',
    version: 1,
    name: '列表加详情页',
    description: '先发现详情链接，再进入详情页补充正文。',
    category: 'detail',
    parameters: [
      ...commonParameters,
      { key: 'detailContainer', label: '详情容器', type: 'selector', required: true },
      { key: 'contentSelector', label: '正文选择器', type: 'selector', required: true },
    ],
    compatibility: { browserRequired: false, loginSupported: false, capabilities: [] },
    taskDefaults: { instruction: '提取列表标题、链接和详情正文' },
    ruleDefinition: {
      ...listRule(),
      detail: {
        urlField: 'url',
        mode: 'auto',
        actions: [],
        rule: {
          type: 'css',
          container: '{{detailContainer}}',
          fields: {
            content: { selector: '{{contentSelector}}', value: 'text', dataType: 'string' },
          },
        },
        mergeStrategy: 'detailWins',
        onError: 'keep-list-record',
        concurrency: 2,
      },
    },
  },
  {
    id: 'next-pagination',
    version: 1,
    name: '下一页分页',
    description: '重复点击下一页，采集多页列表。',
    category: 'pagination',
    parameters: [
      ...commonParameters,
      { key: 'nextSelector', label: '下一页按钮', type: 'selector', required: true },
    ],
    compatibility: { browserRequired: false, loginSupported: false, capabilities: [] },
    taskDefaults: { instruction: '翻页提取列表数据' },
    ruleDefinition: listRule({ type: 'next', selector: '{{nextSelector}}', maxPages: 10 }),
  },
  {
    id: 'infinite-scroll',
    version: 1,
    name: '无限滚动',
    description: '滚动加载动态列表后提取记录。',
    category: 'browser',
    parameters: commonParameters,
    compatibility: { browserRequired: true, loginSupported: false, capabilities: ['browser'] },
    taskDefaults: {
      instruction: '滚动页面并提取列表数据',
      browserSettings: { enabled: true, waitUntil: 'domcontentloaded', actions: [] },
    },
    ruleDefinition: listRule({ type: 'infinite', maxScrolls: 10, waitMs: 500 }),
  },
  {
    id: 'json-api',
    version: 1,
    name: 'JSON API',
    description: '从公开 JSON 数组中提取结构化字段。',
    category: 'api',
    parameters: [
      { key: 'containerPath', label: '数组 JSON Path', type: 'string', required: true },
      { key: 'idPath', label: 'ID Path', type: 'string', required: true },
      { key: 'titlePath', label: '标题 Path', type: 'string', required: true },
    ],
    compatibility: { browserRequired: false, loginSupported: false, capabilities: [] },
    taskDefaults: { instruction: '从 JSON API 提取 ID 和标题' },
    ruleDefinition: {
      version: 1,
      list: {
        mode: 'http',
        actions: [],
        rule: {
          type: 'json',
          container: '{{containerPath}}',
          fields: {
            id: { path: '{{idPath}}', dataType: 'string' },
            title: { path: '{{titlePath}}', dataType: 'string' },
          },
        },
      },
      pagination: { type: 'none' },
      dedupe: { strategy: 'fields', fields: ['id'] },
      limits: { maxRecords: 1_000_000 },
    },
  },
  {
    id: 'sitemap-details',
    version: 1,
    name: 'Sitemap 批量详情',
    description: '从 Sitemap 发现 URL 并抽取详情页。',
    category: 'discovery',
    parameters: [
      { key: 'detailContainer', label: '详情容器', type: 'selector', required: true },
      { key: 'titleSelector', label: '标题选择器', type: 'selector', required: true },
    ],
    compatibility: { browserRequired: false, loginSupported: false, capabilities: [] },
    taskDefaults: { instruction: '从 Sitemap 发现页面并提取标题' },
    ruleDefinition: {
      version: 1,
      list: {
        mode: 'http',
        actions: [],
        rule: { type: 'json', container: '$', fields: { url: { path: '$.url', dataType: 'url' } } },
      },
      discovery: {
        type: 'sitemap',
        urlField: 'url',
        include: [],
        exclude: [],
        sameOrigin: true,
        maxDepth: 1,
        maxSitemaps: 50,
        maxUrls: 1000,
      },
      pagination: { type: 'none' },
      detail: {
        urlField: 'url',
        mode: 'auto',
        actions: [],
        rule: {
          type: 'css',
          container: '{{detailContainer}}',
          fields: { title: { selector: '{{titleSelector}}', value: 'text', dataType: 'string' } },
        },
        mergeStrategy: 'detailWins',
        onError: 'skip',
        concurrency: 2,
      },
      dedupe: { strategy: 'fields', fields: ['url'] },
      limits: { maxRecords: 1_000_000 },
    },
  },
  {
    id: 'authenticated-browser',
    version: 1,
    name: '已登录浏览器采集',
    description: '使用受保护的浏览器登录会话访问需要登录的页面。',
    category: 'browser',
    parameters: commonParameters,
    compatibility: { browserRequired: true, loginSupported: true, capabilities: ['browser'] },
    taskDefaults: {
      instruction: '使用已登录会话提取列表数据',
      browserSettings: { enabled: true, waitUntil: 'domcontentloaded', actions: [] },
    },
    ruleDefinition: { ...listRule(), list: { ...listRule().list, mode: 'browser' } },
  },
  {
    id: 'change-monitor',
    version: 1,
    name: '价格、库存或内容变化监控',
    description: '定时提取稳定键和目标字段，并在变化比例达到阈值时通知。',
    category: 'monitoring',
    parameters: commonParameters,
    compatibility: { browserRequired: false, loginSupported: false, capabilities: ['monitoring'] },
    taskDefaults: {
      instruction: '监控目标字段变化',
      schedule: {
        mode: 'cron',
        cron: '0 * * * *',
        timezone: 'Asia/Shanghai',
        misfirePolicy: 'skip',
      },
    },
    ruleDefinition: listRule(),
    qualityPolicy: changeQuality,
  },
];

export const taskTemplateCatalog = validateTaskTemplateCatalog(rawCatalog);

export function getTaskTemplate(id: string): TaskTemplate | null {
  return taskTemplateCatalog.find((template) => template.id === id) ?? null;
}
