import {
  normalizeCrawlPlan,
  taskCreateSchema,
  type CrawlPlanDefinition,
  type TaskCreate,
} from '@zhiyun/shared';

export const BUILT_IN_EXAMPLE_URL = 'https://movie.douban.com/top250';

const EXAMPLE_NAMES = new Set(['示例：豆瓣电影 Top 250', 'Example: Douban Movie Top 250']);

export const BUILT_IN_EXAMPLE_PLAN: CrawlPlanDefinition = normalizeCrawlPlan({
  version: 1,
  list: {
    mode: 'browser',
    actions: [],
    rule: {
      type: 'css',
      container: '.item',
      fields: {
        rank: { selector: '.pic em', value: 'text', dataType: 'number' },
        title: {
          selector: '.title',
          value: 'text',
          dataType: 'string',
        },
        rating: { selector: '.rating_num', value: 'text', dataType: 'number' },
        votes: {
          selector: '.bd > div span:nth-child(4)',
          value: 'text',
          dataType: 'number',
        },
        quote: { selector: '.quote span', value: 'text', dataType: 'string' },
        coverUrl: {
          selector: '.pic img',
          value: 'attribute',
          attribute: 'src',
          dataType: 'url',
        },
        url: {
          selector: '.hd a',
          value: 'attribute',
          attribute: 'href',
          dataType: 'url',
        },
      },
    },
  },
  pagination: { type: 'none' },
  dedupe: { strategy: 'fields', fields: ['url'] },
  limits: { maxRequests: 1, maxRuntimeMs: 60_000, maxRecords: 25 },
});

export function builtInExampleTask(language: string): TaskCreate {
  const chinese = language.toLowerCase().startsWith('zh');
  return taskCreateSchema.parse({
    name: chinese ? '示例：豆瓣电影 Top 250' : 'Example: Douban Movie Top 250',
    startUrl: BUILT_IN_EXAMPLE_URL,
    instruction: chinese
      ? '采集当前页电影排名、中文片名、评分、评价人数、短评、海报和详情链接。'
      : 'Collect each movie rank, Chinese title, rating, vote count, quote, poster, and detail URL.',
    schedule: { mode: 'manual', timezone: 'Asia/Shanghai', misfirePolicy: 'skip' },
    requestSettings: {
      headers: {},
      cookies: [],
      timeoutMs: 20_000,
      retries: 0,
      retryBackoffMs: 1_000,
      concurrency: 1,
      delayMs: 5_000,
      maxRequests: 1,
      maxRuntimeMs: 60_000,
      domainRateLimitPerMinute: 12,
      respectRobotsTxt: true,
      maxResponseBytes: 5 * 1024 * 1024,
      redirectLimit: 5,
      userAgent: 'Mozilla/5.0 (compatible; ZhiYunExample/0.2)',
    },
    browserSettings: { enabled: true, waitUntil: 'domcontentloaded', actions: [] },
    pagination: { type: 'none' },
    outputSettings: { persistRecords: true },
    credentialBindings: {},
    datasetSettings: { mode: 'snapshot', keyFields: ['url'], detectRemoved: true },
    retentionPolicy: { runDays: null, maxRuns: 10, artifactDays: null, logDays: null },
    networkPolicy: { allowPrivateNetworks: false, allowedHosts: [], allowedCidrs: [] },
    outputBindings: [],
  });
}

export function isBuiltInExampleTask(task: { name: string; startUrl: string }): boolean {
  return task.startUrl === BUILT_IN_EXAMPLE_URL && EXAMPLE_NAMES.has(task.name);
}

interface ExampleTaskClient {
  createTask(input: TaskCreate): Promise<{ id: string }>;
  createRule(
    taskId: string,
    input: { name: string; definition: CrawlPlanDefinition; generatedBy: 'system' },
  ): Promise<unknown>;
  deleteTask(taskId: string): Promise<void>;
}

export async function installBuiltInExampleTask(
  client: ExampleTaskClient,
  language: string,
): Promise<string> {
  const task = await client.createTask(builtInExampleTask(language));
  try {
    await client.createRule(task.id, {
      name: language.toLowerCase().startsWith('zh') ? '豆瓣电影榜单规则' : 'Douban movie list rule',
      definition: BUILT_IN_EXAMPLE_PLAN,
      generatedBy: 'system',
    });
    return task.id;
  } catch (error) {
    await client.deleteTask(task.id).catch(() => undefined);
    throw error;
  }
}
