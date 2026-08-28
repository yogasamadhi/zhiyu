import {
  normalizeCrawlPlan,
  taskCreateSchema,
  type CrawlPlanDefinition,
  type TaskCreate,
} from '@zhiyun/shared';

export const HONGGUO_TASK_URL = 'https://hongguoduanju.com/sitemap/hongguoduanju/index.xml';

const HONGGUO_TASK_NAMES = new Set([
  '示例：红果短剧公开信息',
  'Example: Hongguo public short-drama data',
]);

export const HONGGUO_CRAWL_PLAN: CrawlPlanDefinition = normalizeCrawlPlan({
  version: 1,
  list: {
    mode: 'http',
    actions: [],
    rule: {
      type: 'css',
      container: 'body',
      fields: {
        detailUrl: {
          selector: 'a',
          value: 'attribute',
          attribute: 'href',
          dataType: 'url',
        },
      },
    },
  },
  discovery: {
    type: 'sitemap',
    urlField: 'detailUrl',
    lastModifiedField: 'lastModified',
    include: ['/detail?series_id='],
    exclude: ['/player/'],
    sameOrigin: true,
    maxDepth: 1,
    maxSitemaps: 24,
    maxUrls: 20,
  },
  pagination: { type: 'none' },
  detail: {
    urlField: 'detailUrl',
    mode: 'http',
    actions: [],
    source: {
      type: 'script-json-assignment',
      selector: 'script',
      marker: '_ROUTER_DATA =',
    },
    rule: {
      type: 'json',
      container: '$.loaderData.detail_page.seriesDetail',
      fields: {
        seriesId: { path: '$.series_id', dataType: 'string' },
        title: { path: '$.series_name', dataType: 'string' },
        introduction: { path: '$.series_intro', dataType: 'string' },
        coverUrl: { path: '$.series_cover', dataType: 'url' },
        episodeCount: { path: '$.episode_cnt', dataType: 'number' },
        accessibleEpisodeCount: {
          path: '$.accessible_episode_cnt',
          dataType: 'number',
        },
        payType: { path: '$.pay_type', dataType: 'number' },
        episodeLabel: { path: '$.episode_right_text', dataType: 'string' },
        tags: { path: '$.tags', dataType: 'json' },
        celebrities: { path: '$.celebrities', dataType: 'json' },
        episodeInfo: { path: '$.series_episode_info', dataType: 'json' },
      },
    },
    mergeStrategy: 'detailWins',
    onError: 'keep-list-record',
    concurrency: 1,
  },
  dedupe: { strategy: 'fields', fields: ['seriesId'] },
  limits: { maxRequests: 25, maxRuntimeMs: 600_000, maxRecords: 20 },
});

export function hongguoTask(language: string): TaskCreate {
  const chinese = language.toLowerCase().startsWith('zh');
  return taskCreateSchema.parse({
    name: chinese ? '示例：红果短剧公开信息' : 'Example: Hongguo public short-drama data',
    startUrl: HONGGUO_TASK_URL,
    instruction: chinese
      ? '从官方 Sitemap 发现详情页，采集短剧名称、简介、封面、集数、标签和演员等公开元数据。'
      : 'Discover detail pages from the official sitemap and collect public short-drama metadata.',
    schedule: { mode: 'manual', timezone: 'Asia/Shanghai', misfirePolicy: 'skip' },
    requestSettings: {
      headers: {},
      cookies: [],
      timeoutMs: 60_000,
      retries: 0,
      retryBackoffMs: 1_000,
      concurrency: 1,
      delayMs: 1_500,
      maxRequests: 25,
      maxRuntimeMs: 600_000,
      domainRateLimitPerMinute: 40,
      respectRobotsTxt: true,
      maxResponseBytes: 10 * 1024 * 1024,
      redirectLimit: 5,
      userAgent: 'Mozilla/5.0 (compatible; ZhiYun/0.2; public-metadata-crawl)',
    },
    browserSettings: { enabled: false, waitUntil: 'domcontentloaded', actions: [] },
    pagination: { type: 'none' },
    outputSettings: { persistRecords: true },
    credentialBindings: {},
    datasetSettings: { mode: 'snapshot', keyFields: ['seriesId'], detectRemoved: true },
    retentionPolicy: { runDays: null, maxRuns: 10, artifactDays: null, logDays: null },
    networkPolicy: { allowPrivateNetworks: false, allowedHosts: [], allowedCidrs: [] },
    outputBindings: [],
  });
}

export function isHongguoTask(task: { name: string; startUrl: string }): boolean {
  return task.startUrl === HONGGUO_TASK_URL && HONGGUO_TASK_NAMES.has(task.name);
}

interface HongguoTaskClient {
  createTask(input: TaskCreate): Promise<{ id: string }>;
  createRule(
    taskId: string,
    input: { name: string; definition: CrawlPlanDefinition; generatedBy: 'system' },
  ): Promise<unknown>;
  deleteTask(taskId: string): Promise<void>;
}

export async function installHongguoTask(
  client: HongguoTaskClient,
  language: string,
): Promise<string> {
  const task = await client.createTask(hongguoTask(language));
  try {
    await client.createRule(task.id, {
      name: language.toLowerCase().startsWith('zh')
        ? '红果短剧公开信息规则'
        : 'Hongguo public short-drama rule',
      definition: HONGGUO_CRAWL_PLAN,
      generatedBy: 'system',
    });
    return task.id;
  } catch (error) {
    await client.deleteTask(task.id).catch(() => undefined);
    throw error;
  }
}
