import {
  normalizeCrawlPlan,
  preferenceContentSchema,
  preferenceProfileSchema,
  taskCreateSchema,
  trendItemSchema,
  trendTermSchema,
  type CrawlPlanDefinition,
  type DatasetRecord,
  type PreferenceContent,
  type PreferenceContentType,
  type PreferencePlatform,
  type PreferenceProfile,
  type PreferenceSignal,
  type TaskCreate,
  type TrendItem,
  type TrendTerm,
} from '@zhiyun/shared';

export const HONGGUO_SOURCE_KEY = 'hongguo.latest';
export const FANQIE_SOURCE_KEY = 'fanqie.read-ranking';
export const BILIBILI_SOURCE_KEY = 'bilibili.popular';
export const DOUYIN_SOURCE_KEY = 'douyin.official';

export interface TrendSourceCatalogEntry {
  key: string;
  platform: PreferencePlatform;
  name: string;
  description: string;
  scheduleLabel: string | null;
  cron: string | null;
  supported: boolean;
  task?: TaskCreate;
  plan?: CrawlPlanDefinition;
}

const commonTask = {
  schedule: { mode: 'cron' as const, timezone: 'Asia/Shanghai', misfirePolicy: 'skip' as const },
  outputSettings: { persistRecords: true },
  credentialBindings: {},
  retentionPolicy: { runDays: null, maxRuns: 10, artifactDays: null, logDays: null },
  networkPolicy: { allowPrivateNetworks: false, allowedHosts: [], allowedCidrs: [] },
  outputBindings: [],
};

export const HONGGUO_TREND_PLAN: CrawlPlanDefinition = normalizeCrawlPlan({
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
    maxUrls: 2_000,
  },
  pagination: { type: 'none' },
  detail: {
    urlField: 'detailUrl',
    mode: 'http',
    actions: [],
    source: { type: 'script-json-assignment', selector: 'script', marker: '_ROUTER_DATA =' },
    rule: {
      type: 'json',
      container: '$.loaderData.detail_page.seriesDetail',
      fields: {
        seriesId: { path: '$.series_id', dataType: 'string' },
        title: { path: '$.series_name', dataType: 'string' },
        summary: { path: '$.series_intro', dataType: 'string' },
        coverUrl: { path: '$.series_cover', dataType: 'url' },
        episodeCount: { path: '$.episode_cnt', dataType: 'number' },
        tags: { path: '$.tags', dataType: 'json' },
        celebrities: { path: '$.celebrities', dataType: 'json' },
      },
    },
    mergeStrategy: 'detailWins',
    onError: 'keep-list-record',
    concurrency: 1,
  },
  dedupe: { strategy: 'fields', fields: ['seriesId'] },
  limits: { maxRequests: 25, maxRuntimeMs: 600_000, maxRecords: 20 },
});

export const FANQIE_TREND_PLAN: CrawlPlanDefinition = normalizeCrawlPlan({
  version: 1,
  list: {
    mode: 'browser',
    actions: [],
    rule: {
      type: 'css',
      container: '.rank-book-item',
      fields: {
        rank: { selector: '.book-item-index h1', value: 'text', dataType: 'number' },
        detailUrl: {
          selector: '.book-item-text .title a',
          value: 'attribute',
          attribute: 'href',
          dataType: 'url',
        },
      },
    },
  },
  pagination: {
    type: 'page',
    urlTemplate: 'https://fanqienovel.com/rank/{page}_2',
    startPage: 0,
    maxPages: 2,
  },
  detail: {
    urlField: 'detailUrl',
    mode: 'http',
    actions: [],
    source: { type: 'script-json-assignment', selector: 'script', marker: '__INITIAL_STATE__=' },
    rule: {
      type: 'json',
      container: '$.page',
      fields: {
        bookId: { path: '$.bookId', dataType: 'string' },
        title: { path: '$.bookName', dataType: 'string' },
        author: { path: '$.author', dataType: 'string' },
        summary: { path: '$.abstract', dataType: 'string' },
        coverUrl: { path: '$.thumbUri', dataType: 'url' },
        wordCount: { path: '$.wordNumber', dataType: 'number' },
        readCount: { path: '$.readCount', dataType: 'number' },
        creationStatus: { path: '$.creationStatus', dataType: 'string' },
        categoryV2: { path: '$.categoryV2', dataType: 'json' },
        lastChapterTitle: { path: '$.lastChapterTitle', dataType: 'string' },
      },
    },
    mergeStrategy: 'detailWins',
    onError: 'skip',
    concurrency: 1,
  },
  dedupe: { strategy: 'fields', fields: ['bookId'] },
  limits: { maxRequests: 24, maxRuntimeMs: 600_000, maxRecords: 20 },
});

export const BILIBILI_TREND_PLAN: CrawlPlanDefinition = normalizeCrawlPlan({
  version: 1,
  list: {
    mode: 'browser',
    actions: [],
    rule: {
      type: 'css',
      container: '.video-card',
      fields: {
        rank: { selector: ':scope', value: 'index', dataType: 'number' },
        detailUrl: {
          selector: 'a[href*="/video/"]',
          value: 'attribute',
          attribute: 'href',
          dataType: 'url',
        },
      },
    },
  },
  pagination: { type: 'none' },
  detail: {
    urlField: 'detailUrl',
    mode: 'http',
    actions: [],
    source: { type: 'script-json-assignment', selector: 'script', marker: '__INITIAL_STATE__=' },
    rule: {
      type: 'json',
      container: '$.videoData',
      fields: {
        bvid: { path: '$.bvid', dataType: 'string' },
        title: { path: '$.title', dataType: 'string' },
        summary: { path: '$.desc', dataType: 'string' },
        coverUrl: { path: '$.pic', dataType: 'url' },
        category: { path: '$.tname', dataType: 'string' },
        categoryV2: { path: '$.tname_v2', dataType: 'string' },
        publishedAt: { path: '$.pubdate', dataType: 'number' },
        owner: { path: '$.owner', dataType: 'json' },
        stat: { path: '$.stat', dataType: 'json' },
      },
    },
    mergeStrategy: 'detailWins',
    onError: 'skip',
    concurrency: 1,
  },
  dedupe: { strategy: 'fields', fields: ['bvid'] },
  limits: { maxRequests: 22, maxRuntimeMs: 600_000, maxRecords: 20 },
});

function sourceTask(input: {
  name: string;
  startUrl: string;
  instruction: string;
  cron: string;
  browser: boolean;
  maxRequests: number;
  keyFields: string[];
}): TaskCreate {
  return taskCreateSchema.parse({
    ...commonTask,
    name: input.name,
    startUrl: input.startUrl,
    instruction: input.instruction,
    schedule: { ...commonTask.schedule, cron: input.cron },
    requestSettings: {
      headers: {},
      cookies: [],
      timeoutMs: 60_000,
      retries: 0,
      retryBackoffMs: 1_000,
      concurrency: 1,
      delayMs: 1_500,
      maxRequests: input.maxRequests,
      maxRuntimeMs: 600_000,
      domainRateLimitPerMinute: 40,
      respectRobotsTxt: true,
      maxResponseBytes: 10 * 1024 * 1024,
      redirectLimit: 5,
      userAgent: 'Mozilla/5.0 (compatible; ZhiYun/0.2; public-metadata-crawl)',
    },
    browserSettings: {
      enabled: input.browser,
      waitUntil: 'domcontentloaded',
      actions: [],
    },
    pagination: { type: 'none' },
    datasetSettings: { mode: 'snapshot', keyFields: input.keyFields, detectRemoved: true },
  });
}

export const TREND_SOURCE_CATALOG: TrendSourceCatalogEntry[] = [
  {
    key: HONGGUO_SOURCE_KEY,
    platform: 'hongguo',
    name: '红果最新短剧',
    description: '从官方 Sitemap 获取最近更新的公开短剧元数据。',
    scheduleLabel: '每天 17:00',
    cron: '0 17 * * *',
    supported: true,
    task: sourceTask({
      name: '趋势源：红果最新短剧',
      startUrl: 'https://hongguoduanju.com/sitemap/hongguoduanju/index.xml',
      instruction: '采集最近更新的公开短剧名称、简介、封面、集数和标签。',
      cron: '0 17 * * *',
      browser: false,
      maxRequests: 25,
      keyFields: ['seriesId'],
    }),
    plan: HONGGUO_TREND_PLAN,
  },
  {
    key: FANQIE_SOURCE_KEY,
    platform: 'fanqie',
    name: '番茄小说阅读榜',
    description: '男频、女频阅读榜各取前 10，并从详情页补齐公开元数据。',
    scheduleLabel: '每天 16:30',
    cron: '30 16 * * *',
    supported: true,
    task: sourceTask({
      name: '趋势源：番茄小说阅读榜',
      startUrl: 'https://fanqienovel.com/rank/0_2',
      instruction: '采集番茄小说男频、女频阅读榜公开书籍元数据。',
      cron: '30 16 * * *',
      browser: true,
      maxRequests: 24,
      keyFields: ['bookId'],
    }),
    plan: FANQIE_TREND_PLAN,
  },
  {
    key: BILIBILI_SOURCE_KEY,
    platform: 'bilibili',
    name: 'B站综合热门',
    description: '综合热门前 20 个视频及其公开分区和互动指标。',
    scheduleLabel: '每 6 小时',
    cron: '15 */6 * * *',
    supported: true,
    task: sourceTask({
      name: '趋势源：B站综合热门',
      startUrl: 'https://www.bilibili.com/v/popular/ranking/',
      instruction: '采集 B站综合热门视频的公开元数据和互动指标。',
      cron: '15 */6 * * *',
      browser: true,
      maxRequests: 22,
      keyFields: ['bvid'],
    }),
    plan: BILIBILI_TREND_PLAN,
  },
  {
    key: DOUYIN_SOURCE_KEY,
    platform: 'douyin',
    name: '抖音官方数据',
    description: '需要开放平台应用和获批权限，第一版暂未连接。',
    scheduleLabel: null,
    cron: null,
    supported: false,
  },
];

export function sourceCatalogEntry(key: string): TrendSourceCatalogEntry | undefined {
  return TREND_SOURCE_CATALOG.find((entry) => entry.key === key);
}

function text(value: unknown): string | null {
  if (typeof value !== 'string')
    return value === null || value === undefined ? null : String(value);
  const result = value.trim();
  return result.length > 0 ? result : null;
}

function number(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(result) ? result : 0;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function tagsFrom(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      return tagsFrom(JSON.parse(trimmed) as unknown);
    } catch {
      return [trimmed];
    }
  }
  if (Array.isArray(value)) return value.flatMap(tagsFrom);
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>;
    for (const key of ['Name', 'name', 'tag_name', 'tagName', 'title']) {
      const candidate = text(item[key]);
      if (candidate) return [candidate];
    }
  }
  return [];
}

function uniqueTags(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(
      values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)),
    ),
  ];
}

function isoFromSeconds(value: unknown): string | null {
  const seconds = number(value);
  if (seconds <= 0) return null;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

type TrendRecord = Pick<DatasetRecord, 'data' | 'sourceUrl' | 'lastSeenAt'>;

function baseTrendItem(sourceKey: string, record: TrendRecord): TrendItem | null {
  const data = record.data;
  if (sourceKey === HONGGUO_SOURCE_KEY) {
    const externalId = text(data.seriesId);
    const title = text(data.title);
    if (!externalId || !title) return null;
    const actorTags = tagsFrom(data.celebrities);
    return trendItemSchema.parse({
      id: `${sourceKey}:${externalId}`,
      sourceKey,
      platform: 'hongguo',
      contentType: 'short_drama',
      externalId,
      title,
      url: text(data.detailUrl),
      coverUrl: text(data.coverUrl),
      author: actorTags.slice(0, 3).join('、') || null,
      summary: text(data.summary ?? data.introduction),
      tags: uniqueTags(tagsFrom(data.tags)),
      metadata: { episodeCount: number(data.episodeCount) },
      rank: null,
      score: 0,
      metrics: { episodeCount: number(data.episodeCount) },
      updatedAt: text(data.lastModified) ?? record.lastSeenAt,
      matchingTags: [],
    });
  }
  if (sourceKey === FANQIE_SOURCE_KEY) {
    const externalId = text(data.bookId);
    const title = text(data.title);
    if (!externalId || !title) return null;
    const board = record.sourceUrl.includes('/rank/0_2')
      ? '女频'
      : record.sourceUrl.includes('/rank/1_2')
        ? '男频'
        : null;
    return trendItemSchema.parse({
      id: `${sourceKey}:${externalId}`,
      sourceKey,
      platform: 'fanqie',
      contentType: 'novel',
      externalId,
      title,
      url: text(data.detailUrl),
      coverUrl: text(data.coverUrl),
      author: text(data.author),
      summary: text(data.summary),
      tags: uniqueTags([board, ...tagsFrom(data.categoryV2)]),
      metadata: {
        board,
        creationStatus: text(data.creationStatus),
        lastChapterTitle: text(data.lastChapterTitle),
      },
      rank: Math.max(1, number(data.rank)),
      score: 0,
      metrics: { readCount: number(data.readCount), wordCount: number(data.wordCount) },
      updatedAt: record.lastSeenAt,
      matchingTags: [],
    });
  }
  if (sourceKey === BILIBILI_SOURCE_KEY) {
    const externalId =
      text(data.bvid) ?? text(data.detailUrl)?.match(/\/video\/(BV[\w]+)/)?.[1] ?? null;
    const title = text(data.title);
    if (!externalId || !title) return null;
    const owner = object(data.owner);
    const stat = object(data.stat);
    return trendItemSchema.parse({
      id: `${sourceKey}:${externalId}`,
      sourceKey,
      platform: 'bilibili',
      contentType: 'video',
      externalId,
      title,
      url: text(data.detailUrl) ?? `https://www.bilibili.com/video/${externalId}`,
      coverUrl: text(data.coverUrl),
      author: text(owner.name),
      summary: text(data.summary),
      tags: uniqueTags([text(data.categoryV2), text(data.category)]),
      metadata: {},
      rank: Math.max(1, number(data.rank)),
      score: 0,
      metrics: {
        view: number(stat.view),
        like: number(stat.like),
        favorite: number(stat.favorite),
        share: number(stat.share),
      },
      updatedAt: isoFromSeconds(data.publishedAt) ?? record.lastSeenAt,
      matchingTags: [],
    });
  }
  return null;
}

function logRatio(value: number, maximum: number): number {
  return maximum <= 0 ? 0 : Math.log1p(Math.max(0, value)) / Math.log1p(maximum);
}

export function normalizeTrendRecords(sourceKey: string, records: TrendRecord[]): TrendItem[] {
  const items = records.flatMap((record) => {
    const item = baseTrendItem(sourceKey, record);
    return item ? [item] : [];
  });
  const maxRank = Math.max(1, ...items.map((item) => item.rank ?? items.length));
  const maxRead = Math.max(0, ...items.map((item) => item.metrics.readCount ?? 0));
  const maxView = Math.max(0, ...items.map((item) => item.metrics.view ?? 0));
  const maxEngagement = Math.max(
    0,
    ...items.map(
      (item) => (item.metrics.like ?? 0) + (item.metrics.share ?? 0) + (item.metrics.favorite ?? 0),
    ),
  );
  const now = Date.now();
  return items.map((item) => {
    const rankScore = item.rank ? (maxRank - item.rank + 1) / maxRank : 0;
    let score: number;
    if (sourceKey === FANQIE_SOURCE_KEY) {
      score = 100 * (rankScore * 0.75 + logRatio(item.metrics.readCount ?? 0, maxRead) * 0.25);
    } else if (sourceKey === BILIBILI_SOURCE_KEY) {
      const engagement =
        (item.metrics.like ?? 0) + (item.metrics.share ?? 0) + (item.metrics.favorite ?? 0);
      score =
        100 *
        (rankScore * 0.6 +
          logRatio(item.metrics.view ?? 0, maxView) * 0.25 +
          logRatio(engagement, maxEngagement) * 0.15);
    } else {
      const ageDays = item.updatedAt
        ? Math.max(0, (now - new Date(item.updatedAt).getTime()) / 86_400_000)
        : 7;
      score = 100 * 0.5 ** (ageDays / 7);
    }
    return trendItemSchema.parse({ ...item, score: Math.max(0, Math.min(100, score)) });
  });
}

export function preferenceTargetKey(content: PreferenceContent): string {
  return `${content.platform}:${content.contentType}:${content.externalId.trim().toLowerCase()}`;
}

const contentTypeLabels: Record<PreferenceContentType, string> = {
  short_drama: '短剧',
  novel: '小说',
  video: '视频',
  topic: '主题',
};

const platformLabels: Record<PreferencePlatform, string> = {
  hongguo: '红果',
  fanqie: '番茄',
  bilibili: 'B站',
  douyin: '抖音',
  manual: '手动',
};

export function buildPreferenceProfile(
  signals: PreferenceSignal[],
  now = new Date(),
): PreferenceProfile {
  const aggregate = (
    entries: Array<{ key: string; label: string; score: number }>,
  ): Array<{ key: string; label: string; score: number; evidenceCount: number }> => {
    const values = new Map<string, { label: string; score: number; evidenceCount: number }>();
    for (const entry of entries) {
      const value = values.get(entry.key) ?? { label: entry.label, score: 0, evidenceCount: 0 };
      value.score += entry.score;
      value.evidenceCount += 1;
      values.set(entry.key, value);
    }
    return [...values.entries()]
      .map(([key, value]) => ({ key, ...value, score: Number(value.score.toFixed(3)) }))
      .sort((left, right) => Math.abs(right.score) - Math.abs(left.score));
  };
  const scored = signals.map((signal) => {
    const manualTopic =
      signal.content.platform === 'manual' && signal.content.contentType === 'topic';
    const base = manualTopic
      ? signal.kind === 'dislike'
        ? -6
        : 6
      : signal.kind === 'like'
        ? 3
        : signal.kind === 'dislike'
          ? -4
          : 4;
    const ageDays = Math.max(
      0,
      (now.getTime() - new Date(signal.updatedAt).getTime()) / 86_400_000,
    );
    return { signal, score: manualTopic ? base : base * 0.5 ** (ageDays / 90) };
  });
  const tagScores = aggregate(
    scored.flatMap(({ signal, score }) =>
      signal.content.tags.map((tag) => ({ key: tag.toLowerCase(), label: tag, score })),
    ),
  );
  return preferenceProfileSchema.parse({
    positiveTags: tagScores.filter((item) => item.score > 0).slice(0, 20),
    negativeTags: tagScores.filter((item) => item.score < 0).slice(0, 20),
    contentTypes: aggregate(
      scored.map(({ signal, score }) => ({
        key: signal.content.contentType,
        label: contentTypeLabels[signal.content.contentType],
        score,
      })),
    ),
    platforms: aggregate(
      scored.map(({ signal, score }) => ({
        key: signal.content.platform,
        label: platformLabels[signal.content.platform],
        score,
      })),
    ),
    signalCount: signals.length,
    updatedAt: signals[0]?.updatedAt ?? null,
    recentSignals: signals.slice(0, 10),
  });
}

const stopWords = new Set([
  '一个',
  '一种',
  '这个',
  '那个',
  '我们',
  '你们',
  '他们',
  '怎么',
  '什么',
  '为何',
  '还是',
  '已经',
  '没有',
  '可以',
  '视频',
  '小说',
  '短剧',
  '最新',
  '今天',
]);

function titleTerms(title: string): string[] {
  const hashtags = [...title.matchAll(/#([^#\s]{2,16})/g)].map((match) => match[1]!);
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  const words = [...segmenter.segment(title)]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment.trim().toLowerCase())
    .filter(
      (part) =>
        part.length >= 2 &&
        part.length <= 16 &&
        !stopWords.has(part) &&
        !/^\d+(?:\.\d+)?$/.test(part),
    );
  return uniqueTags([...hashtags, ...words]);
}

export function buildTrendTerms(items: TrendItem[], limit = 30): TrendTerm[] {
  const terms = new Map<
    string,
    {
      score: number;
      platforms: Set<PreferencePlatform>;
      contentTypes: Set<PreferenceContentType>;
      items: TrendItem[];
      itemCount: number;
      explicit: boolean;
    }
  >();
  for (const item of items) {
    const explicit = new Set(item.tags.map((tag) => tag.toLowerCase()));
    for (const term of uniqueTags([...item.tags, ...titleTerms(item.title)])) {
      const key = term.toLowerCase();
      const value = terms.get(key) ?? {
        score: 0,
        platforms: new Set<PreferencePlatform>(),
        contentTypes: new Set<PreferenceContentType>(),
        items: [],
        itemCount: 0,
        explicit: false,
      };
      value.score += item.score;
      value.itemCount += 1;
      value.platforms.add(item.platform);
      value.contentTypes.add(item.contentType);
      if (value.items.length < 3) value.items.push(item);
      value.explicit ||= explicit.has(key);
      terms.set(key, value);
    }
  }
  return [...terms.entries()]
    .filter(([, value]) => value.itemCount >= 2 || value.explicit)
    .map(([term, value]) =>
      trendTermSchema.parse({
        term,
        score: Number((value.score * (1 + Math.max(0, value.platforms.size - 1) * 0.2)).toFixed(2)),
        platforms: [...value.platforms],
        contentTypes: [...value.contentTypes],
        itemCount: value.itemCount,
        examples: value.items,
      }),
    )
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export function matchPreferenceTags(items: TrendItem[], profile: PreferenceProfile): TrendItem[] {
  const preferred = new Set(profile.positiveTags.map((tag) => tag.key.toLowerCase()));
  return items.map((item) => ({
    ...item,
    matchingTags: item.tags.filter((tag) => preferred.has(tag.toLowerCase())),
  }));
}

export function contentResolver(url: string): {
  platform: Exclude<PreferencePlatform, 'manual' | 'douyin'>;
  plan: CrawlPlanDefinition;
} | null {
  const parsed = new URL(url);
  if (parsed.hostname === 'fanqienovel.com' || parsed.hostname === 'www.fanqienovel.com') {
    if (!/^\/page\/\d+\/?$/.test(parsed.pathname)) return null;
    return {
      platform: 'fanqie',
      plan: normalizeCrawlPlan({
        list: {
          mode: 'http',
          source: {
            type: 'script-json-assignment',
            selector: 'script',
            marker: '__INITIAL_STATE__=',
          },
          rule: FANQIE_TREND_PLAN.detail!.rule,
        },
        limits: { maxRequests: 1, maxRuntimeMs: 30_000, maxRecords: 1 },
      }),
    };
  }
  if (parsed.hostname === 'hongguoduanju.com' || parsed.hostname === 'www.hongguoduanju.com') {
    if (parsed.pathname !== '/detail' || !parsed.searchParams.get('series_id')) return null;
    return {
      platform: 'hongguo',
      plan: normalizeCrawlPlan({
        list: {
          mode: 'http',
          source: { type: 'script-json-assignment', selector: 'script', marker: '_ROUTER_DATA =' },
          rule: HONGGUO_TREND_PLAN.detail!.rule,
        },
        limits: { maxRequests: 1, maxRuntimeMs: 30_000, maxRecords: 1 },
      }),
    };
  }
  if (
    parsed.hostname === 'www.bilibili.com' ||
    parsed.hostname === 'bilibili.com' ||
    parsed.hostname === 'b23.tv'
  ) {
    if (parsed.hostname !== 'b23.tv' && !/^\/video\/BV[\w]+\/?$/i.test(parsed.pathname))
      return null;
    return {
      platform: 'bilibili',
      plan: normalizeCrawlPlan({
        list: {
          mode: 'http',
          source: {
            type: 'script-json-assignment',
            selector: 'script',
            marker: '__INITIAL_STATE__=',
          },
          rule: BILIBILI_TREND_PLAN.detail!.rule,
        },
        limits: { maxRequests: 1, maxRuntimeMs: 30_000, maxRecords: 1 },
      }),
    };
  }
  return null;
}

export function preferenceContentFromResolved(
  platform: Exclude<PreferencePlatform, 'manual' | 'douyin'>,
  data: Record<string, unknown>,
  sourceUrl: string,
): PreferenceContent | null {
  const sourceKey =
    platform === 'hongguo'
      ? HONGGUO_SOURCE_KEY
      : platform === 'fanqie'
        ? FANQIE_SOURCE_KEY
        : BILIBILI_SOURCE_KEY;
  const item = baseTrendItem(sourceKey, {
    data: { ...data, detailUrl: sourceUrl },
    sourceUrl,
    lastSeenAt: new Date().toISOString(),
  });
  return item ? preferenceContentSchema.parse(item) : null;
}
