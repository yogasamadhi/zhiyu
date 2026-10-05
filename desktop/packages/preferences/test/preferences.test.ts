import { describe, expect, it } from 'vitest';
import { extractData } from '@zhiyun/extraction';
import {
  crawlPlanDefinitionSchema,
  preferenceSignalInputSchema,
  taskCreateSchema,
  trendItemSchema,
  type PreferenceContent,
  type PreferenceSignal,
} from '@zhiyun/shared';
import {
  BILIBILI_SOURCE_KEY,
  BILIBILI_TREND_PLAN,
  FANQIE_SOURCE_KEY,
  FANQIE_TREND_PLAN,
  HONGGUO_SOURCE_KEY,
  QIDIAN_BOOK_PLAN,
  QIDIAN_SOURCE_KEY,
  QIDIAN_TREND_PLAN,
  TREND_SOURCE_CATALOG,
  buildPreferenceProfile,
  buildTrendTerms,
  contentResolver,
  normalizeTrendRecords,
} from '../src/index.js';

const content: PreferenceContent = {
  platform: 'fanqie',
  contentType: 'novel',
  externalId: 'book-1',
  title: '重生之后',
  url: 'https://fanqienovel.com/page/1',
  coverUrl: null,
  author: '作者甲',
  summary: null,
  tags: ['重生', '都市'],
  metadata: {},
};

function signal(
  id: string,
  kind: PreferenceSignal['kind'],
  value: PreferenceContent,
  updatedAt: string,
): PreferenceSignal {
  return {
    id,
    targetKey: `${value.platform}:${value.contentType}:${value.externalId}`,
    kind,
    content: value,
    createdAt: updatedAt,
    updatedAt,
  };
}

describe('built-in trend sources', () => {
  it('uses shared schemas, low concurrency and safe public crawling defaults', () => {
    for (const source of TREND_SOURCE_CATALOG.filter((entry) => entry.supported)) {
      expect(() => crawlPlanDefinitionSchema.parse(source.plan)).not.toThrow();
      const task = taskCreateSchema.parse(source.task);
      expect(task.requestSettings).toMatchObject({
        concurrency: 1,
        respectRobotsTxt: true,
      });
      expect(task.requestSettings.delayMs).toBeGreaterThanOrEqual(1_000);
    }
    expect(FANQIE_TREND_PLAN.pagination).toEqual({
      type: 'page',
      urlTemplate: 'https://fanqienovel.com/rank/{page}_2',
      startPage: 0,
      maxPages: 2,
    });
    expect(BILIBILI_TREND_PLAN.list.rule).toMatchObject({
      fields: { rank: { value: 'index' } },
    });
    const qidian = TREND_SOURCE_CATALOG.find((source) => source.key === QIDIAN_SOURCE_KEY)!;
    expect(qidian).toMatchObject({
      platform: 'qidian',
      supported: true,
      task: {
        startUrl: 'https://m.qidian.com/rank/yuepiao/',
        credentialBindings: {},
        browserSettings: { enabled: false },
      },
    });
  });

  it('extracts Fanqie book metadata from the detail state instead of obfuscated rank text', () => {
    const html = `<html><body>
      <div class="rank-book-item">&#xe001;&#xe002;</div>
      <script>__INITIAL_STATE__={"page":{"bookId":"123","bookName":"真名不会乱码","author":"作者甲","abstract":"简介","thumbUri":"https://img.test/cover.jpg","wordNumber":880000,"readCount":42000,"categoryV2":[{"Name":"悬疑"}]}};</script>
    </body></html>`;
    const result = extractData(
      html,
      FANQIE_TREND_PLAN.detail!.rule,
      'https://fanqienovel.com/page/123',
      FANQIE_TREND_PLAN.detail!.source,
    );
    expect(result.records[0]).toMatchObject({
      bookId: '123',
      title: '真名不会乱码',
      author: '作者甲',
      readCount: 42000,
      categoryV2: [{ Name: '悬疑' }],
    });
  });

  it('extracts the public Qidian monthly-ticket list without a browser or login state', () => {
    const html = `<html><body>
      <a href="//m.qidian.com/book/1041637443/" title="捞尸人最新章节在线阅读">
        <img data-src="//bookcover.yuewen.com/qdbimg/349573/1041637443/180">
        <div>
          <div><span>1</span><h2>捞尸人</h2><div>11.12万月票</div></div>
          <p>人知鬼恐怖，鬼晓人心毒。</p>
          <p>纯洁滴小龙 · 都市 · 650.41万字</p>
        </div>
      </a>
    </body></html>`;
    const result = extractData(
      html,
      QIDIAN_TREND_PLAN.list.rule,
      'https://m.qidian.com/rank/yuepiao/',
    );
    expect(result.records).toEqual([
      {
        rank: 1,
        detailUrl: 'https://m.qidian.com/book/1041637443/',
        title: '捞尸人',
        rankCountText: '11.12万月票',
        summary: '人知鬼恐怖，鬼晓人心毒。',
        metadataText: '纯洁滴小龙 · 都市 · 650.41万字',
        coverUrl: 'https://bookcover.yuewen.com/qdbimg/349573/1041637443/180',
      },
    ]);
  });

  it('extracts stable Open Graph metadata from a public Qidian book page', () => {
    const html = `<html><head>
      <meta property="og:url" content="//m.qidian.com/book/1041637443/">
      <meta property="og:title" content="捞尸人">
      <meta property="og:description" content="公开简介">
      <meta property="og:image" content="//bookcover.yuewen.com/qdbimg/349573/1041637443/180">
      <meta property="og:novel:category" content="异术超能">
      <meta property="og:novel:author" content="纯洁滴小龙">
      <meta property="og:novel:status" content="连载">
      <meta property="og:novel:update_time" content="2026-08-29 12:04:09">
      <meta property="og:novel:latest_chapter_name" content="第七百二十九章 北爷爷">
    </head><body></body></html>`;
    const result = extractData(
      html,
      QIDIAN_BOOK_PLAN.list.rule,
      'https://m.qidian.com/book/1041637443/',
    );
    expect(result.records[0]).toMatchObject({
      detailUrl: 'https://m.qidian.com/book/1041637443/',
      title: '捞尸人',
      author: '纯洁滴小龙',
      category: '异术超能',
      creationStatus: '连载',
      lastChapterTitle: '第七百二十九章 北爷爷',
    });
  });

  it('normalizes rankings and public metrics within each source', () => {
    const seen = '2026-08-28T00:00:00.000Z';
    const fanqie = normalizeTrendRecords(FANQIE_SOURCE_KEY, [
      {
        sourceUrl: 'https://fanqienovel.com/rank/0_2',
        lastSeenAt: seen,
        data: {
          bookId: '1',
          title: '第一名',
          rank: 1,
          readCount: 100,
          categoryV2: [{ Name: '悬疑' }],
          detailUrl: 'https://fanqienovel.com/page/1',
        },
      },
      {
        sourceUrl: 'https://fanqienovel.com/rank/1_2',
        lastSeenAt: seen,
        data: {
          bookId: '2',
          title: '第二名',
          rank: 2,
          readCount: 100_000,
          detailUrl: 'https://fanqienovel.com/page/2',
        },
      },
    ]);
    expect(fanqie[0]).toMatchObject({ rank: 1, tags: ['女频', '悬疑'] });
    expect(fanqie[1]).toMatchObject({ rank: 2, tags: ['男频'] });
    expect(fanqie.every((item) => item.score >= 0 && item.score <= 100)).toBe(true);

    const qidian = normalizeTrendRecords(QIDIAN_SOURCE_KEY, [
      {
        sourceUrl: 'https://m.qidian.com/rank/yuepiao/',
        lastSeenAt: seen,
        data: {
          rank: 1,
          detailUrl: 'https://m.qidian.com/book/1041637443/',
          title: '捞尸人',
          rankCountText: '11.12万月票',
          metadataText: '纯洁滴小龙 · 都市 · 650.41万字',
        },
      },
    ]);
    expect(qidian[0]).toMatchObject({
      platform: 'qidian',
      contentType: 'novel',
      externalId: '1041637443',
      author: '纯洁滴小龙',
      tags: ['男生月票榜', '都市'],
      rank: 1,
      score: 100,
      metrics: { monthlyTickets: 111_200, wordCount: 6_504_100 },
    });

    const bilibili = normalizeTrendRecords(BILIBILI_SOURCE_KEY, [
      {
        sourceUrl: 'https://www.bilibili.com/v/popular/ranking/',
        lastSeenAt: seen,
        data: {
          bvid: 'BV1TEST',
          title: '热门视频',
          rank: 1,
          stat: { view: 1_000_000, like: 50_000, favorite: 9_000, share: 2_000 },
        },
      },
    ]);
    expect(bilibili[0]).toMatchObject({ score: 100, metrics: { view: 1_000_000 } });

    const latest = new Date().toISOString();
    const old = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const hongguo = normalizeTrendRecords(HONGGUO_SOURCE_KEY, [
      {
        sourceUrl: 'https://hongguoduanju.com/detail?series_id=1',
        lastSeenAt: latest,
        data: { seriesId: '1', title: '今天更新', lastModified: latest },
      },
      {
        sourceUrl: 'https://hongguoduanju.com/detail?series_id=2',
        lastSeenAt: old,
        data: { seriesId: '2', title: '七天前更新', lastModified: old },
      },
    ]);
    expect(hongguo[0]!.score).toBeGreaterThan(hongguo[1]!.score);
    expect(hongguo[1]!.score).toBeCloseTo(50, 0);
  });

  it('accepts only the explicitly supported content link shapes', () => {
    expect(contentResolver('https://fanqienovel.com/page/123')?.platform).toBe('fanqie');
    expect(contentResolver('https://hongguoduanju.com/detail?series_id=42')?.platform).toBe(
      'hongguo',
    );
    expect(contentResolver('https://www.bilibili.com/video/BV1TEST')?.platform).toBe('bilibili');
    expect(contentResolver('https://b23.tv/abc123')?.platform).toBe('bilibili');
    expect(contentResolver('https://m.qidian.com/book/1041637443/')?.platform).toBe('qidian');
    expect(contentResolver('https://www.qidian.com/book/1041637443/')).toMatchObject({
      platform: 'qidian',
      crawlUrl: 'https://m.qidian.com/book/1041637443/',
    });
    expect(contentResolver('https://book.qidian.com/info/1041637443')).toMatchObject({
      platform: 'qidian',
      crawlUrl: 'https://m.qidian.com/book/1041637443/',
    });
    expect(contentResolver('https://example.com/page/123')).toBeNull();
    expect(contentResolver('https://fanqienovel.com/rank/0_2')).toBeNull();
    expect(contentResolver('https://m.qidian.com/rank/yuepiao/')).toBeNull();
  });
});

describe('preference profile and trend terms', () => {
  it('limits manual topic evidence to explicit positive or negative labels', () => {
    expect(
      preferenceSignalInputSchema.safeParse({
        kind: 'completed',
        content: {
          platform: 'manual',
          contentType: 'topic',
          externalId: '悬疑',
          title: '悬疑',
          tags: ['悬疑'],
        },
      }).success,
    ).toBe(false);
  });

  it('applies 90-day decay to behavior and fixed manual-topic weight', () => {
    const now = new Date('2026-08-28T00:00:00.000Z');
    const ninetyDaysAgo = new Date(now.getTime() - 90 * 86_400_000).toISOString();
    const manual: PreferenceContent = {
      platform: 'manual',
      contentType: 'topic',
      externalId: '虐恋',
      title: '虐恋',
      url: null,
      coverUrl: null,
      author: null,
      summary: null,
      tags: ['虐恋'],
      metadata: {},
    };
    const profile = buildPreferenceProfile(
      [
        signal('00000000-0000-4000-8000-000000000001', 'like', content, ninetyDaysAgo),
        signal('00000000-0000-4000-8000-000000000002', 'completed', content, ninetyDaysAgo),
        signal(
          '00000000-0000-4000-8000-000000000003',
          'dislike',
          manual,
          '2020-01-01T00:00:00.000Z',
        ),
      ],
      now,
    );
    expect(profile.positiveTags.find((tag) => tag.key === '重生')?.score).toBeCloseTo(3.5);
    expect(profile.negativeTags.find((tag) => tag.key === '虐恋')?.score).toBe(-6);
    expect(profile.signalCount).toBe(3);
  });

  it('merges explicit terms across sources and retains explainable examples', () => {
    const first = trendItemSchema.parse({
      ...content,
      id: 'fanqie:1',
      sourceKey: FANQIE_SOURCE_KEY,
      rank: 1,
      score: 90,
      metrics: {},
      updatedAt: '2026-08-28T00:00:00.000Z',
      matchingTags: [],
      tags: ['悬疑'],
    });
    const second = trendItemSchema.parse({
      platform: 'bilibili',
      contentType: 'video',
      externalId: 'BV1TEST',
      title: '悬疑反转名场面',
      url: 'https://www.bilibili.com/video/BV1TEST',
      coverUrl: null,
      author: 'UP主',
      summary: null,
      tags: ['悬疑'],
      metadata: {},
      id: 'bilibili:BV1TEST',
      sourceKey: BILIBILI_SOURCE_KEY,
      rank: 1,
      score: 80,
      metrics: {},
      updatedAt: '2026-08-28T00:00:00.000Z',
      matchingTags: [],
    });
    const term = buildTrendTerms([first, second]).find((item) => item.term === '悬疑');
    expect(term).toMatchObject({ itemCount: 2, platforms: ['fanqie', 'bilibili'] });
    expect(term!.score).toBeGreaterThan(170);
    expect(term!.examples).toHaveLength(2);
  });
});
