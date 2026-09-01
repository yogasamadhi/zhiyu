import { describe, expect, it } from 'vitest';
import type { RecruitmentPosting, RecruitmentSearchProfile } from '@zhiyun/shared';
import {
  assertOfficialSourceUrl,
  buildRecruitmentSearchUrl,
  guessRecruitmentMapping,
  headerFingerprint,
  matchRecruitmentProfile,
  normalizeRecruitmentRow,
  parseRecruitmentFile,
  parseSalary,
  recruitmentClusterSimilarity,
} from '../src/domain/index.js';

describe('recruitment domain', () => {
  it('builds encoded first-party deep links without requesting them', () => {
    const profile = makeProfile({ includeKeywords: ['TypeScript', '数据平台'], cities: ['上海'] });
    const url = new URL(buildRecruitmentSearchUrl('boss', profile));
    expect(url.hostname).toBe('www.zhipin.com');
    expect(url.searchParams.get('query')).toBe('TypeScript 数据平台');
    expect(url.searchParams.get('city')).toBe('101020100');
    expect(buildRecruitmentSearchUrl('huibo', profile)).toBe('https://www.huibo.com/jobsearch/');
  });

  it('only accepts official source hosts and removes tracking parameters', () => {
    expect(
      assertOfficialSourceUrl('boss', 'https://www.zhipin.com/job/123?utm_source=test&keep=1#x'),
    ).toBe('https://www.zhipin.com/job/123?keep=1');
    expect(() => assertOfficialSourceUrl('boss', 'https://evil.example/job/123')).toThrow(
      '官方域名',
    );
  });

  it('parses quoted CSV newlines, JSON arrays and stable header fingerprints', () => {
    const csv = parseRecruitmentFile(
      'csv',
      '\uFEFF职位名称,公司名称,职位链接,职位描述\r\n"后端,工程师",织云,https://www.zhipin.com/job/1,"第一行\n第二行"',
    );
    expect(csv.rows).toEqual([
      {
        职位名称: '后端,工程师',
        公司名称: '织云',
        职位链接: 'https://www.zhipin.com/job/1',
        职位描述: '第一行\n第二行',
      },
    ]);
    expect(parseRecruitmentFile('json', '[{"title":"工程师","company":"织云"}]').headers).toEqual([
      'title',
      'company',
    ]);
    expect(headerFingerprint(['Title', 'Company'])).toBe(headerFingerprint([' company ', 'TITLE']));
  });

  it('guesses common Chinese mappings and normalizes salary, HTML and contact data', () => {
    const mapping = guessRecruitmentMapping([
      '职位名称',
      '公司名称',
      '职位链接',
      '薪资',
      '职位描述',
    ]);
    expect(mapping).toMatchObject({
      title: '职位名称',
      company: '公司名称',
      sourceUrl: '职位链接',
      salaryRaw: '薪资',
    });
    const posting = normalizeRecruitmentRow(
      'boss',
      {
        职位名称: ' TypeScript  工程师 ',
        公司名称: '织云科技有限公司',
        职位链接: 'https://www.zhipin.com/job/123?utm_source=x',
        薪资: '20-30K·14薪',
        职位描述: '<b>平台建设</b> 联系 13800138000 或 dev@example.com',
      },
      mapping,
    );
    expect(posting.salaryMinMonthly).toBe(20_000);
    expect(posting.salaryMaxMonthly).toBe(30_000);
    expect(posting.salaryMonths).toBe(14);
    expect(posting.normalizedCompany).toBe('织云科技');
    expect(posting.description).toContain('[已移除电话]');
    expect(posting.description).toContain('[已移除邮箱]');
    expect(posting.description).not.toContain('<b>');
    expect(parseSalary('24-36万/年')).toMatchObject({
      salaryMinMonthly: 20_000,
      salaryMaxMonthly: 30_000,
    });
  });

  it('applies explainable matching and high-precision clustering thresholds', () => {
    const profile = makeProfile({
      includeKeywords: ['TypeScript'],
      cities: ['上海'],
      salaryMinMonthly: 20_000,
      salaryMaxMonthly: 40_000,
    });
    const posting = makePosting();
    expect(matchRecruitmentProfile(profile, posting)).toMatchObject({ matched: true, score: 100 });
    expect(
      matchRecruitmentProfile(
        { ...profile, excludeKeywords: ['外包'] },
        { ...posting, description: '外包驻场' },
      ),
    ).toMatchObject({ matched: false, reasons: ['命中排除关键词'] });
    expect(recruitmentClusterSimilarity(posting, { ...posting }).score).toBe(1);
    expect(
      recruitmentClusterSimilarity(posting, {
        ...posting,
        normalizedCompany: '另一家公司',
      }).score,
    ).toBe(0);
  });
});

function makeProfile(patch: Partial<RecruitmentSearchProfile> = {}): RecruitmentSearchProfile {
  const timestamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: '工程岗位',
    includeKeywords: [],
    keywordMode: 'any',
    excludeKeywords: [],
    cities: [],
    remoteAllowed: true,
    salaryMinMonthly: null,
    salaryMaxMonthly: null,
    experience: [],
    education: [],
    employmentTypes: [],
    includeCompanies: [],
    excludeCompanies: [],
    sourceKeys: ['boss', 'liepin', 'huibo'],
    freshnessDays: 30,
    priority: 'normal',
    enabled: true,
    digestTime: '08:00',
    timezone: 'Asia/Shanghai',
    outputDestinationIds: [],
    revision: 1,
    lastDigestAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...patch,
  };
}

function makePosting(): RecruitmentPosting {
  const timestamp = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    sourceKey: 'boss',
    stableKey: 'id:123',
    externalId: '123',
    sourceUrl: 'https://www.zhipin.com/job/123',
    title: 'TypeScript 工程师',
    company: '织云科技有限公司',
    location: '上海',
    salaryRaw: '20-30K',
    salaryMinMonthly: 20_000,
    salaryMaxMonthly: 30_000,
    salaryMonths: 12,
    description: 'TypeScript 数据平台建设',
    publishedAt: timestamp,
    expiresAt: null,
    experience: null,
    education: null,
    employmentType: null,
    skills: ['TypeScript'],
    status: 'active',
    normalizedTitle: 'typescript工程师',
    normalizedCompany: '织云科技',
    normalizedLocation: '上海',
    contentHash: 'a'.repeat(64),
    firstSeenAt: timestamp,
    lastSeenAt: timestamp,
    importJobId: null,
    importRow: null,
    normalizerVersion: '1.0.0',
  };
}
