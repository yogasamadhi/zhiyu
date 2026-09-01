import { createHash } from 'node:crypto';
import type {
  RecruitmentImportField,
  RecruitmentPosting,
  RecruitmentPostingStatus,
  RecruitmentSearchProfile,
  RecruitmentSource,
  RecruitmentSourceKey,
} from '@zhiyun/shared';

export const RECRUITMENT_NORMALIZER_VERSION = '1.0.0';
export const RECRUITMENT_SEARCH_LINK_VERSION = '1.0.0';
export const RECRUITMENT_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const RECRUITMENT_MAX_ROWS = 100_000;
export const RECRUITMENT_IMPORT_BATCH_SIZE = 500;

export interface RecruitmentSourceCatalogEntry extends RecruitmentSource {
  searchBaseUrl: string;
  cityCodes: Readonly<Record<string, string>>;
  keywordParameter: string | null;
  cityParameter: string | null;
}

export const RECRUITMENT_SOURCE_CATALOG: readonly RecruitmentSourceCatalogEntry[] = [
  {
    key: 'boss',
    name: 'BOSS 直聘',
    officialHost: 'www.zhipin.com',
    allowedHosts: ['www.zhipin.com', 'zhipin.com', 'm.zhipin.com'],
    termsUrl: 'https://www.zhipin.com/web/common/protocol/protocol-2019-09-30.html',
    robotsUrl: 'https://www.zhipin.com/robots.txt',
    checkedAt: '2026-09-01T00:00:00.000Z',
    mode: 'import_deeplink',
    authorizationStatus: 'pending',
    liveSyncAvailable: false,
    adapterVersion: null,
    authorizationScope: null,
    credentialRef: null,
    lastSyncAt: null,
    lastImportAt: null,
    lastError: null,
    searchBaseUrl: 'https://www.zhipin.com/web/geek/jobs',
    keywordParameter: 'query',
    cityParameter: 'city',
    cityCodes: {
      全国: '100010000',
      北京: '101010100',
      上海: '101020100',
      广州: '101280100',
      深圳: '101280600',
      杭州: '101210100',
      成都: '101270100',
      重庆: '101040100',
    },
  },
  {
    key: 'liepin',
    name: '猎聘',
    officialHost: 'www.liepin.com',
    allowedHosts: ['www.liepin.com', 'liepin.com', 'm.liepin.com'],
    termsUrl: 'https://www.liepin.com/',
    robotsUrl: 'https://www.liepin.com/robots.txt',
    checkedAt: '2026-09-01T00:00:00.000Z',
    mode: 'import_deeplink',
    authorizationStatus: 'pending',
    liveSyncAvailable: false,
    adapterVersion: null,
    authorizationScope: null,
    credentialRef: null,
    lastSyncAt: null,
    lastImportAt: null,
    lastError: null,
    searchBaseUrl: 'https://www.liepin.com/zhaopin/',
    keywordParameter: 'key',
    cityParameter: null,
    cityCodes: {},
  },
  {
    key: 'huibo',
    name: '汇博招聘',
    officialHost: 'www.huibo.com',
    allowedHosts: ['www.huibo.com', 'huibo.com', 'm.huibo.com'],
    termsUrl: 'https://person.huibo.com/register',
    robotsUrl: 'https://www.huibo.com/robots.txt',
    checkedAt: '2026-09-01T00:00:00.000Z',
    mode: 'import_deeplink',
    authorizationStatus: 'pending',
    liveSyncAvailable: false,
    adapterVersion: null,
    authorizationScope: null,
    credentialRef: null,
    lastSyncAt: null,
    lastImportAt: null,
    lastError: null,
    searchBaseUrl: 'https://www.huibo.com/jobsearch/',
    keywordParameter: 'key',
    cityParameter: null,
    cityCodes: {},
  },
] as const;

export function sourceCatalogEntry(key: RecruitmentSourceKey): RecruitmentSourceCatalogEntry {
  return RECRUITMENT_SOURCE_CATALOG.find((source) => source.key === key)!;
}

export function buildRecruitmentSearchUrl(
  sourceKey: RecruitmentSourceKey,
  profile?: Pick<RecruitmentSearchProfile, 'includeKeywords' | 'cities'>,
): string {
  const source = sourceCatalogEntry(sourceKey);
  const url = new URL(source.searchBaseUrl);
  const requestedCities = profile?.cities ?? [];
  const city = requestedCities.find((candidate) => source.cityCodes[candidate]);
  if (requestedCities.length > 0 && !city) return url.toString();
  const keyword = profile?.includeKeywords.join(' ').trim();
  if (keyword && source.keywordParameter) url.searchParams.set(source.keywordParameter, keyword);
  if (city && source.cityParameter) {
    url.searchParams.set(source.cityParameter, source.cityCodes[city]!);
  }
  return url.toString();
}

export function assertOfficialSourceUrl(sourceKey: RecruitmentSourceKey, value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('职位链接必须使用 HTTP 或 HTTPS');
  const source = sourceCatalogEntry(sourceKey);
  if (!source.allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new Error(`职位链接必须属于 ${source.name} 官方域名`);
  }
  url.hash = '';
  for (const name of [...url.searchParams.keys()]) {
    if (/^(utm_|spm|from|source|track)/i.test(name)) url.searchParams.delete(name);
  }
  return url.toString();
}

export interface ParsedRecruitmentFile {
  headers: string[];
  rows: Array<Record<string, unknown>>;
}

export function parseRecruitmentFile(
  format: 'csv' | 'json',
  content: string,
): ParsedRecruitmentFile {
  const size = Buffer.byteLength(content);
  if (size > RECRUITMENT_MAX_FILE_BYTES) throw new Error('文件不能超过 50 MB');
  const parsed = format === 'csv' ? parseCsv(content) : parseJsonRows(content);
  if (parsed.rows.length > RECRUITMENT_MAX_ROWS) throw new Error('单次导入不能超过 100,000 行');
  return parsed;
}

function parseCsv(content: string): ParsedRecruitmentFile {
  const value = content.replace(/^\uFEFF/, '');
  const matrix: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quoted) {
      if (character === '"' && value[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else field += character;
      continue;
    }
    if (character === '"' && field.length === 0) quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && value[index + 1] === '\n') index += 1;
      row.push(field);
      field = '';
      if (row.some((cell) => cell.length > 0)) matrix.push(row);
      row = [];
    } else field += character;
  }
  if (quoted) throw new Error('CSV 存在未闭合的引号');
  row.push(field);
  if (row.some((cell) => cell.length > 0)) matrix.push(row);
  const rawHeaders = matrix.shift() ?? [];
  const headers = uniqueHeaders(rawHeaders);
  if (headers.length === 0) throw new Error('CSV 必须包含表头');
  return {
    headers,
    rows: matrix.map((cells) =>
      Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])),
    ),
  };
}

function parseJsonRows(content: string): ParsedRecruitmentFile {
  const parsed = JSON.parse(content.replace(/^\uFEFF/, '')) as unknown;
  assertJsonDepth(parsed, 0);
  if (!Array.isArray(parsed)) throw new Error('JSON 顶层必须是数组');
  const rows = parsed.map((item, index) => {
    if (!isObject(item)) throw new Error(`JSON 第 ${index + 1} 项必须是对象`);
    return item;
  });
  const headers = uniqueHeaders(rows.flatMap((item) => Object.keys(item)));
  return { headers, rows };
}

function assertJsonDepth(value: unknown, depth: number): void {
  if (depth > 8) throw new Error('JSON 嵌套层级不能超过 8 层');
  if (Array.isArray(value)) for (const item of value) assertJsonDepth(item, depth + 1);
  else if (isObject(value))
    for (const item of Object.values(value)) assertJsonDepth(item, depth + 1);
}

function uniqueHeaders(headers: readonly string[]): string[] {
  const result: string[] = [];
  const used = new Set<string>();
  for (const [index, raw] of headers.entries()) {
    const base = String(raw).trim() || `column_${index + 1}`;
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${base}_${suffix++}`;
    used.add(candidate);
    result.push(candidate);
  }
  return result;
}

const aliases: Readonly<Record<RecruitmentImportField, readonly string[]>> = {
  externalId: ['externalid', 'jobid', 'positionid', '职位id', '岗位id', '编号'],
  sourceUrl: ['sourceurl', 'url', 'link', 'joburl', '职位链接', '岗位链接', '链接'],
  title: ['title', 'jobtitle', 'position', '职位', '职位名称', '岗位', '岗位名称'],
  company: ['company', 'companyname', '企业', '公司', '公司名称', '企业名称'],
  location: ['location', 'city', 'address', '地区', '城市', '工作地点'],
  salaryRaw: ['salary', 'salaryraw', '薪资', '薪酬', '工资'],
  description: ['description', 'detail', 'jd', '职位描述', '岗位描述', '详情'],
  publishedAt: ['publishedat', 'publishtime', '发布日期', '发布时间'],
  expiresAt: ['expiresat', 'expiry', '截止日期', '过期时间'],
  experience: ['experience', '经验', '工作经验'],
  education: ['education', '学历', '学历要求'],
  employmentType: ['employmenttype', 'jobtype', '类型', '雇佣类型', '职位类型'],
  skills: ['skills', 'skill', '技能', '技能标签'],
  status: ['status', '状态', '职位状态'],
};

export function guessRecruitmentMapping(headers: readonly string[]): Record<string, string> {
  const normalized = new Map(headers.map((header) => [normalizeHeader(header), header]));
  const mapping: Record<string, string> = {};
  for (const [field, candidates] of Object.entries(aliases)) {
    const header = candidates
      .map((candidate) => normalized.get(normalizeHeader(candidate)))
      .find(Boolean);
    if (header) mapping[field] = header;
  }
  return mapping;
}

function normalizeHeader(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_\-.()[\]（）]/g, '');
}

export function headerFingerprint(headers: readonly string[]): string {
  return sha256([...headers].map(normalizeHeader).sort().join('\n'));
}

export interface NormalizedPostingInput {
  sourceKey: RecruitmentSourceKey;
  stableKey: string;
  externalId: string | null;
  sourceUrl: string | null;
  title: string;
  company: string;
  location: string | null;
  salaryRaw: string | null;
  salaryMinMonthly: number | null;
  salaryMaxMonthly: number | null;
  salaryMonths: number | null;
  description: string | null;
  publishedAt: string | null;
  expiresAt: string | null;
  experience: string | null;
  education: string | null;
  employmentType: string | null;
  skills: string[];
  status: RecruitmentPostingStatus;
  normalizedTitle: string;
  normalizedCompany: string;
  normalizedLocation: string;
  contentHash: string;
  normalizerVersion: string;
}

export function normalizeRecruitmentRow(
  sourceKey: RecruitmentSourceKey,
  row: Record<string, unknown>,
  mapping: Readonly<Record<string, string>>,
): NormalizedPostingInput {
  const read = (field: RecruitmentImportField): unknown => {
    const header = mapping[field];
    return header ? row[header] : undefined;
  };
  const title = cleanRequired(read('title'), 'title');
  const company = cleanRequired(read('company'), 'company');
  const externalId = cleanOptional(read('externalId'));
  const rawUrl = cleanOptional(read('sourceUrl'));
  const sourceUrl = rawUrl ? assertOfficialSourceUrl(sourceKey, rawUrl) : null;
  if (!externalId && !sourceUrl) throw new Error('externalId 和 sourceUrl 至少需要一个');
  const salaryRaw = cleanOptional(read('salaryRaw'));
  const salary = parseSalary(salaryRaw);
  const expiresAt = parseDate(read('expiresAt'));
  const explicitStatus = cleanOptional(read('status'))?.toLowerCase();
  const closed =
    Boolean(
      explicitStatus && /closed|expired|inactive|已关闭|已下线|已过期/.test(explicitStatus),
    ) || Boolean(expiresAt && Date.parse(expiresAt) <= Date.now());
  const skills = stringList(read('skills')).slice(0, 100);
  const description = sanitizeDescription(cleanOptional(read('description')));
  const normalizedTitle = normalizeText(title);
  const normalizedCompany = normalizeCompany(company);
  const normalizedLocation = normalizeLocation(cleanOptional(read('location')));
  const business = {
    title,
    company,
    location: cleanOptional(read('location')),
    salaryRaw,
    description,
    publishedAt: parseDate(read('publishedAt')),
    expiresAt,
    experience: cleanOptional(read('experience')),
    education: cleanOptional(read('education')),
    employmentType: cleanOptional(read('employmentType')),
    skills,
    status: closed ? ('closed' as const) : ('active' as const),
  };
  return {
    sourceKey,
    stableKey: externalId ? `id:${normalizeText(externalId)}` : `url:${sha256(sourceUrl!)}`,
    externalId,
    sourceUrl,
    ...business,
    ...salary,
    normalizedTitle,
    normalizedCompany,
    normalizedLocation,
    contentHash: sha256(JSON.stringify(business)),
    normalizerVersion: RECRUITMENT_NORMALIZER_VERSION,
  };
}

function cleanRequired(value: unknown, field: string): string {
  const cleaned = cleanOptional(value);
  if (!cleaned) throw new Error(`${field} 不能为空`);
  return cleaned;
}

function cleanOptional(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const string = typeof value === 'string' ? value : String(value);
  const cleaned = string.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

function stringList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : (cleanOptional(value)?.split(/[,，、;；|/]+/) ?? []);
  return [...new Set(values.map(cleanOptional).filter((item): item is string => Boolean(item)))];
}

function parseDate(value: unknown): string | null {
  const cleaned = cleanOptional(value);
  if (!cleaned) return null;
  const timestamp = Date.parse(cleaned);
  if (!Number.isFinite(timestamp)) throw new Error(`无法识别日期：${cleaned}`);
  return new Date(timestamp).toISOString();
}

export function parseSalary(value: string | null): {
  salaryMinMonthly: number | null;
  salaryMaxMonthly: number | null;
  salaryMonths: number | null;
} {
  if (!value || /面议|negotiable/i.test(value)) {
    return { salaryMinMonthly: null, salaryMaxMonthly: null, salaryMonths: null };
  }
  const normalized = value.normalize('NFKC').toLowerCase().replace(/,/g, '');
  const numbers = [...normalized.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  if (numbers.length === 0) {
    return { salaryMinMonthly: null, salaryMaxMonthly: null, salaryMonths: null };
  }
  let [minimum, maximum = minimum] = numbers;
  const multiplier = /k|千/.test(normalized) ? 1_000 : /万/.test(normalized) ? 10_000 : 1;
  minimum = Math.round(minimum! * multiplier);
  maximum = Math.round(maximum! * multiplier);
  if (/年|year/.test(normalized)) {
    minimum = Math.round(minimum / 12);
    maximum = Math.round(maximum / 12);
  } else if (/天|day/.test(normalized)) {
    minimum = Math.round(minimum * 21.75);
    maximum = Math.round(maximum * 21.75);
  } else if (/时|hour/.test(normalized)) {
    minimum = Math.round(minimum * 174);
    maximum = Math.round(maximum * 174);
  }
  const months = normalized.match(/(?:·|x|\*|×)\s*(1[0-9]|2[0-4])\s*薪?/)?.[1];
  return {
    salaryMinMonthly: Math.min(minimum, maximum),
    salaryMaxMonthly: Math.max(minimum, maximum),
    salaryMonths: months ? Number(months) : 12,
  };
}

export function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .trim();
}

export function normalizeCompany(value: string): string {
  return normalizeText(value).replace(
    /(?:有限责任公司|股份有限公司|有限公司|集团有限公司|集团|公司|co(?:ltd)?|inc)$/i,
    '',
  );
}

export function normalizeLocation(value: string | null): string {
  if (!value) return '';
  return normalizeText(value)
    .replace(/(?:壮族自治区|回族自治区|维吾尔自治区|特别行政区|自治区|省|市|区|县)$/g, '')
    .replace(/远程办公|远程工作/g, '远程');
}

function sanitizeDescription(value: string | null): string | null {
  if (!value) return null;
  const stripped = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[已移除邮箱]')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[已移除电话]')
    .replace(/(?:微信|wechat|wx)\s*[:：]?\s*[A-Za-z][\w-]{5,19}/gi, '[已移除联系方式]')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped || null;
}

export interface RecruitmentMatchResult {
  matched: boolean;
  score: number;
  reasons: string[];
}

export function matchRecruitmentProfile(
  profile: RecruitmentSearchProfile,
  posting: Pick<
    RecruitmentPosting,
    | 'title'
    | 'company'
    | 'location'
    | 'description'
    | 'skills'
    | 'salaryMinMonthly'
    | 'salaryMaxMonthly'
    | 'experience'
    | 'education'
    | 'employmentType'
    | 'publishedAt'
  >,
): RecruitmentMatchResult {
  const haystack = normalizeText(
    [posting.title, posting.description ?? '', posting.skills.join(' ')].join(' '),
  );
  const bodyHaystack = normalizeText(
    [posting.description ?? '', posting.skills.join(' ')].join(' '),
  );
  const company = normalizeCompany(posting.company);
  if (profile.excludeKeywords.some((keyword) => haystack.includes(normalizeText(keyword)))) {
    return { matched: false, score: 0, reasons: ['命中排除关键词'] };
  }
  if (profile.excludeCompanies.some((value) => company.includes(normalizeCompany(value)))) {
    return { matched: false, score: 0, reasons: ['公司位于排除列表'] };
  }
  if (
    profile.includeCompanies.length > 0 &&
    !profile.includeCompanies.some((value) => company.includes(normalizeCompany(value)))
  ) {
    return { matched: false, score: 0, reasons: ['公司不在包含列表'] };
  }
  const keywordMatches = profile.includeKeywords.map((keyword) =>
    haystack.includes(normalizeText(keyword)),
  );
  if (
    keywordMatches.length > 0 &&
    (profile.keywordMode === 'all'
      ? keywordMatches.some((value) => !value)
      : !keywordMatches.some(Boolean))
  ) {
    return { matched: false, score: 0, reasons: ['未满足关键词规则'] };
  }
  const location = normalizeLocation(posting.location);
  const remote = /远程|remote/i.test(posting.location ?? '');
  const locationMatched =
    profile.cities.length === 0 ||
    profile.cities.some((city) => location.includes(normalizeLocation(city))) ||
    (remote && profile.remoteAllowed);
  if (!locationMatched) return { matched: false, score: 0, reasons: ['工作地点不匹配'] };
  if (
    posting.publishedAt &&
    Date.now() - Date.parse(posting.publishedAt) > profile.freshnessDays * 86_400_000
  ) {
    return { matched: false, score: 0, reasons: ['职位发布时间超出新鲜度范围'] };
  }
  const reasons: string[] = [];
  const title = normalizeText(posting.title);
  const titleMatches = profile.includeKeywords.filter((keyword) =>
    title.includes(normalizeText(keyword)),
  );
  const bodyMatches = profile.includeKeywords.filter((keyword) =>
    bodyHaystack.includes(normalizeText(keyword)),
  );
  const titleScore =
    profile.includeKeywords.length === 0
      ? 40
      : Math.round((40 * titleMatches.length) / profile.includeKeywords.length);
  const bodyScore =
    profile.includeKeywords.length === 0
      ? 20
      : Math.round((20 * bodyMatches.length) / profile.includeKeywords.length);
  if (titleMatches.length) reasons.push(`标题命中：${titleMatches.join('、')}`);
  if (bodyMatches.length) reasons.push(`技能/描述命中：${bodyMatches.join('、')}`);
  if (locationMatched) reasons.push(remote ? '支持远程' : '地点匹配');
  const salaryMatched = salaryMatches(profile, posting);
  if (salaryMatched) reasons.push('薪资范围匹配');
  const qualificationMatches =
    listMatches(profile.experience, posting.experience) &&
    listMatches(profile.education, posting.education) &&
    listMatches(profile.employmentTypes, posting.employmentType);
  if (qualificationMatches) reasons.push('经验/学历/类型匹配');
  return {
    matched: true,
    score: Math.min(
      100,
      titleScore + bodyScore + 15 + (salaryMatched ? 15 : 0) + (qualificationMatches ? 10 : 0),
    ),
    reasons,
  };
}

function salaryMatches(
  profile: RecruitmentSearchProfile,
  posting: Pick<RecruitmentPosting, 'salaryMinMonthly' | 'salaryMaxMonthly'>,
): boolean {
  if (profile.salaryMinMonthly === null && profile.salaryMaxMonthly === null) return true;
  if (posting.salaryMinMonthly === null || posting.salaryMaxMonthly === null) return false;
  return (
    (profile.salaryMinMonthly === null || posting.salaryMaxMonthly >= profile.salaryMinMonthly) &&
    (profile.salaryMaxMonthly === null || posting.salaryMinMonthly <= profile.salaryMaxMonthly)
  );
}

function listMatches(expected: readonly string[], actual: string | null): boolean {
  return (
    expected.length === 0 ||
    Boolean(actual && expected.some((item) => normalizeText(actual).includes(normalizeText(item))))
  );
}

export function recruitmentClusterSimilarity(
  left: Pick<
    RecruitmentPosting,
    | 'normalizedTitle'
    | 'normalizedCompany'
    | 'normalizedLocation'
    | 'skills'
    | 'description'
    | 'publishedAt'
  >,
  right: Pick<
    RecruitmentPosting,
    | 'normalizedTitle'
    | 'normalizedCompany'
    | 'normalizedLocation'
    | 'skills'
    | 'description'
    | 'publishedAt'
  >,
): { score: number; evidence: Record<string, unknown> } {
  if (left.normalizedCompany !== right.normalizedCompany)
    return { score: 0, evidence: { company: false } };
  if (!locationsCompatible(left.normalizedLocation, right.normalizedLocation))
    return { score: 0, evidence: { company: true, location: false } };
  if (
    left.publishedAt &&
    right.publishedAt &&
    Math.abs(Date.parse(left.publishedAt) - Date.parse(right.publishedAt)) > 45 * 86_400_000
  ) {
    return { score: 0, evidence: { company: true, location: true, publishedWindow: false } };
  }
  const title = similarity(left.normalizedTitle, right.normalizedTitle);
  const skills =
    left.skills.length && right.skills.length
      ? similarity(left.skills.join(''), right.skills.join(''))
      : title;
  const description =
    left.description && right.description
      ? similarity(normalizeText(left.description), normalizeText(right.description))
      : title;
  const score = Number((title * 0.7 + skills * 0.2 + description * 0.1).toFixed(4));
  return { score, evidence: { company: true, location: true, title, skills, description } };
}

function locationsCompatible(left: string, right: string): boolean {
  return (
    !left ||
    !right ||
    left === right ||
    left.includes(right) ||
    right.includes(left) ||
    left === '远程' ||
    right === '远程'
  );
}

function similarity(left: string, right: string): number {
  if (left === right) return 1;
  const leftTokens = bigrams(left);
  const rightTokens = bigrams(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

function bigrams(value: string): Set<string> {
  if (value.length < 2) return new Set(value ? [value] : []);
  return new Set([...Array(value.length - 1)].map((_, index) => value.slice(index, index + 2)));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
