import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { CheerioCrawler } from '@crawlee/cheerio';
import { ProxyConfiguration, RequestQueueV1 } from '@crawlee/core';
import { PlaywrightCrawler } from '@crawlee/playwright';
import { parseSitemap } from '@crawlee/utils';
import type { BrowserContext, Page } from 'playwright';
import robotsParser from 'robots-parser';
import { applyBrowserActions, PlaywrightAdapter } from '@zhiyun/browser-runtime';
import { extractData } from '@zhiyun/extraction';
import {
  CrawlerError,
  NavigationError,
  NetworkPolicyError,
  ZhiYunError,
  type BrowserSettings,
  type CrawlPlanDefinition,
  type Pagination,
  type NetworkPolicy,
  type RequestSettings,
  type RunRequestEntry,
} from '@zhiyun/shared';

export interface CrawlRequest {
  url: string;
  plan: CrawlPlanDefinition;
  mode?: 'auto' | 'http' | 'browser';
  requestSettings: RequestSettings;
  browserSettings: BrowserSettings;
  pagination: Pagination;
  networkPolicy?: NetworkPolicy;
  previewLimit?: number;
  signal?: AbortSignal;
  onProgress?: (event: {
    phase: string;
    progress: number;
    url?: string;
    requestCount?: number;
    recordCount?: number;
  }) => void | Promise<void>;
  onRequest?: (event: Omit<RunRequestEntry, 'id' | 'runId' | 'createdAt'>) => void | Promise<void>;
}

export interface CrawlRecord {
  sourceUrl: string;
  data: Record<string, unknown>;
}

export interface CrawlResult {
  records: CrawlRecord[];
  metadata: {
    durationMs: number;
    requestCount: number;
    recordCount: number;
    browserUsed: boolean;
    aiUsed: boolean;
    warnings: string[];
    urls: string[];
  };
}

export interface PageSourceRequest {
  rootUrl?: string;
  requestSettings: RequestSettings;
  networkPolicy?: NetworkPolicy;
  signal?: AbortSignal;
}

export interface PageSource {
  text: string;
  contentType: string;
  finalUrl: string;
  statusCode: number;
}

const paginationFor = (request: CrawlRequest) =>
  request.plan.pagination.type === 'none' ? request.pagination : request.plan.pagination;

function pageUrls(url: string, pagination: Pagination): string[] {
  if (pagination.type !== 'page') return [url];
  return Array.from({ length: pagination.maxPages }, (_, index) =>
    pagination.urlTemplate.replace('{page}', String(pagination.startPage + index)),
  );
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function dedupe(records: CrawlRecord[], plan: CrawlPlanDefinition): CrawlRecord[] {
  if (plan.dedupe.strategy === 'none') return records;
  const seen = new Set<string>();
  return records.filter((record) => {
    const value =
      plan.dedupe.strategy === 'fields' && plan.dedupe.fields.length > 0
        ? Object.fromEntries(plan.dedupe.fields.map((field) => [field, record.data[field]]))
        : record.data;
    const key = createHash('sha256').update(canonical(value)).digest('hex');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ZhiYunError('CANCELED', 'Crawl was canceled');
}

async function pause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ZhiYunError('CANCELED', 'Crawl was canceled'));
      },
      { once: true },
    );
  });
}

function headers(
  settings: RequestSettings,
  targetUrl?: string,
  rootUrl?: string,
): Record<string, string> {
  const result = { ...settings.headers };
  if (targetUrl && rootUrl && new URL(targetUrl).origin !== new URL(rootUrl).origin) {
    for (const name of Object.keys(result)) {
      if (['authorization', 'cookie', 'proxy-authorization'].includes(name.toLowerCase())) {
        delete result[name];
      }
    }
  }
  if (
    settings.userAgent &&
    !Object.keys(result).some((key) => key.toLowerCase() === 'user-agent')
  ) {
    result['user-agent'] = settings.userAgent;
  }
  if (
    settings.cookies.length > 0 &&
    (!targetUrl || !rootUrl || new URL(targetUrl).origin === new URL(rootUrl).origin) &&
    !Object.keys(result).some((key) => key.toLowerCase() === 'cookie')
  ) {
    result.cookie = settings.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }
  return result;
}

function publicHeaders(settings: RequestSettings): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers(settings)).filter(
      ([name]) => !['authorization', 'cookie', 'proxy-authorization'].includes(name.toLowerCase()),
    ),
  );
}

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, part) => (value * 256 + Number(part)) >>> 0, 0);
}

function inCidr(address: string, cidr: string): boolean {
  const [network, prefixText] = cidr.split('/');
  if (!network || isIP(network) !== 4 || isIP(address) !== 4) return false;
  const prefix = Number(prefixText ?? 32);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(network) & mask);
}

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    return [
      '0.0.0.0/8',
      '10.0.0.0/8',
      '100.64.0.0/10',
      '127.0.0.0/8',
      '169.254.0.0/16',
      '172.16.0.0/12',
      '192.0.0.0/24',
      '192.168.0.0/16',
      '198.18.0.0/15',
      '224.0.0.0/4',
      '240.0.0.0/4',
    ].some((cidr) => inCidr(address, cidr));
  }
  const normalized = address.toLowerCase();
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('ff')
  );
}

export async function assertNetworkAllowed(url: string, policy?: NetworkPolicy): Promise<void> {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new NetworkPolicyError('Only HTTP and HTTPS URLs are allowed');
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const hostAllowed = policy?.allowedHosts.some(
    (host) => hostname === host.toLowerCase() || hostname.endsWith(`.${host.toLowerCase()}`),
  );
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true }).catch((error) => {
        throw new NetworkPolicyError(`DNS resolution failed for ${hostname}`, error);
      });
  for (const { address } of addresses) {
    if (address === '169.254.169.254')
      throw new NetworkPolicyError('Cloud metadata endpoints are blocked');
    const cidrAllowed = policy?.allowedCidrs.some((cidr) => inCidr(address, cidr));
    if (privateAddress(address) && !policy?.allowPrivateNetworks && !hostAllowed && !cidrAllowed) {
      throw new NetworkPolicyError(`Private or reserved address is blocked: ${address}`);
    }
  }
}

class OriginThrottle {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly lastStartedAt = new Map<string, number>();

  constructor(private readonly intervalMs: number) {}

  async acquire(url: string, signal?: AbortSignal): Promise<void> {
    const origin = new URL(url).origin;
    const previous = this.tails.get(origin) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        const waitMs = Math.max(
          0,
          (this.lastStartedAt.get(origin) ?? 0) + this.intervalMs - Date.now(),
        );
        await pause(waitMs, signal);
        this.lastStartedAt.set(origin, Date.now());
      });
    this.tails.set(origin, current);
    await current;
  }
}

interface CrawlControl {
  throttle: OriginThrottle;
  robots: Map<string, Promise<ReturnType<typeof robotsParser> | null>>;
}

function createCrawlControl(settings: RequestSettings): CrawlControl {
  return {
    throttle: new OriginThrottle(
      Math.max(settings.delayMs, Math.ceil(60_000 / settings.domainRateLimitPerMinute)),
    ),
    robots: new Map(),
  };
}

function robotsUserAgent(settings: RequestSettings): string {
  const header = Object.entries(settings.headers).find(
    ([name]) => name.toLowerCase() === 'user-agent',
  )?.[1];
  return settings.userAgent ?? header ?? '*';
}

async function robotsAllowsUrl(
  url: string,
  request: CrawlRequest,
  control: CrawlControl,
): Promise<boolean> {
  if (!request.requestSettings.respectRobotsTxt) return true;
  const target = new URL(url);
  const origin = target.origin;
  let pending = control.robots.get(origin);
  if (!pending) {
    pending = (async () => {
      try {
        const robotsUrl = new URL('/robots.txt', origin).toString();
        await control.throttle.acquire(robotsUrl, request.signal);
        const response = await controlledFetch(robotsUrl, {
          url: request.url,
          requestSettings: {
            ...request.requestSettings,
            headers: publicHeaders(request.requestSettings),
            cookies: [],
            timeoutMs: Math.min(request.requestSettings.timeoutMs, 5_000),
          },
          ...(request.networkPolicy ? { networkPolicy: request.networkPolicy } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
        });
        if (!response.ok) return null;
        const contents = new TextDecoder().decode(
          await body(response, Math.min(request.requestSettings.maxResponseBytes, 1024 * 1024)),
        );
        return robotsParser(robotsUrl, contents);
      } catch {
        checkAbort(request.signal);
        return null;
      }
    })();
    control.robots.set(origin, pending);
  }
  const rules = await pending;
  return rules?.isAllowed(url, robotsUserAgent(request.requestSettings)) !== false;
}

async function prepareCrawlTarget(
  url: string,
  request: CrawlRequest,
  control: CrawlControl,
): Promise<void> {
  await assertNetworkAllowed(url, request.networkPolicy);
  if (!(await robotsAllowsUrl(url, request, control))) {
    throw new NavigationError(`robots.txt disallows ${url}`);
  }
  await control.throttle.acquire(url, request.signal);
}

function proxy(settings: RequestSettings): ProxyConfiguration | undefined {
  if (!settings.proxy) return undefined;
  const url = new URL(settings.proxy.url);
  if (settings.proxy.username) url.username = settings.proxy.username;
  if (settings.proxy.password) url.password = settings.proxy.password;
  return new ProxyConfiguration({ proxyUrls: [url.toString()] });
}

function retryDelay(response: Response | undefined, attempt: number, settings: RequestSettings) {
  const retryAfter = response?.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1_000, 120_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 120_000));
  }
  return Math.min(
    settings.retryBackoffMs * 2 ** attempt + Math.random() * settings.retryBackoffMs,
    120_000,
  );
}

async function controlledFetch(
  url: string,
  request: Pick<CrawlRequest, 'url' | 'requestSettings' | 'networkPolicy' | 'signal'>,
): Promise<Response> {
  let target = url;
  for (let redirect = 0; redirect <= request.requestSettings.redirectLimit; redirect += 1) {
    await assertNetworkAllowed(target, request.networkPolicy);
    let lastError: unknown;
    let redirected = false;
    for (let attempt = 0; attempt <= request.requestSettings.retries; attempt += 1) {
      checkAbort(request.signal);
      let response: Response | undefined;
      try {
        response = await fetch(target, {
          headers: headers(request.requestSettings, target, request.url),
          redirect: 'manual',
          signal: AbortSignal.any([
            AbortSignal.timeout(request.requestSettings.timeoutMs),
            ...(request.signal ? [request.signal] : []),
          ]),
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) throw new NavigationError(`Redirect from ${target} has no location`);
          target = new URL(location, target).toString();
          redirected = true;
          break;
        }
        if (
          ([408, 425, 429].includes(response.status) || response.status >= 500) &&
          attempt < request.requestSettings.retries
        ) {
          await pause(retryDelay(response, attempt, request.requestSettings), request.signal);
          continue;
        }
        return response;
      } catch (error) {
        checkAbort(request.signal);
        lastError = error;
        if (attempt < request.requestSettings.retries) {
          await pause(retryDelay(response, attempt, request.requestSettings), request.signal);
        }
      }
    }
    if (!redirected) throw new NavigationError(`Request failed for ${target}`, lastError);
  }
  throw new NavigationError(`Too many redirects for ${url}`);
}

async function body(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > limit) throw new CrawlerError(`Response exceeds ${limit} bytes`);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel('response size limit exceeded');
        throw new CrawlerError(`Response exceeds ${limit} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function fetchPageSource(
  url: string,
  request: PageSourceRequest,
): Promise<PageSource> {
  const response = await controlledFetch(url, {
    url: request.rootUrl ?? url,
    requestSettings: request.requestSettings,
    ...(request.networkPolicy ? { networkPolicy: request.networkPolicy } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  });
  if (!response.ok) throw new NavigationError(`HTTP ${response.status} for ${url}`);
  return {
    text: new TextDecoder().decode(await body(response, request.requestSettings.maxResponseBytes)),
    contentType: response.headers.get('content-type') ?? '',
    finalUrl: response.url || url,
    statusCode: response.status,
  };
}

async function logRequest(
  request: CrawlRequest,
  event: Omit<RunRequestEntry, 'id' | 'runId' | 'createdAt'>,
) {
  await request.onRequest?.(event);
}

async function crawlJson(
  request: CrawlRequest,
  urls: string[],
  control: CrawlControl,
): Promise<CrawlRecord[]> {
  const records: CrawlRecord[] = [];
  for (const [index, url] of pageUrls(request.url, paginationFor(request)).entries()) {
    if (urls.length >= request.requestSettings.maxRequests) break;
    const started = Date.now();
    try {
      await prepareCrawlTarget(url, request, control);
      const response = await controlledFetch(url, request);
      if (!response.ok) throw new NavigationError(`HTTP ${response.status} for ${url}`);
      const payload = JSON.parse(
        new TextDecoder().decode(await body(response, request.requestSettings.maxResponseBytes)),
      ) as unknown;
      const sourceUrl = response.url || url;
      urls.push(sourceUrl);
      records.push(
        ...extractData(payload, request.plan.list.rule, sourceUrl).records.map((data) => ({
          sourceUrl,
          data,
        })),
      );
      await logRequest(request, {
        url: sourceUrl,
        kind: index === 0 ? 'api' : 'pagination',
        status: 'succeeded',
        statusCode: response.status,
        durationMs: Date.now() - started,
        errorCode: null,
        error: null,
      });
    } catch (error) {
      await logRequest(request, {
        url,
        kind: index === 0 ? 'api' : 'pagination',
        status: 'failed',
        statusCode: null,
        durationMs: Date.now() - started,
        errorCode: error instanceof ZhiYunError ? error.code : 'NAVIGATION_ERROR',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  return records;
}

async function crawlHttp(
  request: CrawlRequest,
  warnings: string[],
  urls: string[],
  control: CrawlControl,
) {
  const records: CrawlRecord[] = [];
  const pagination = paginationFor(request);
  const requestQueue = await RequestQueueV1.open(`zhiyun-${crypto.randomUUID()}`);
  const proxyConfiguration = proxy(request.requestSettings);
  let pages = 0;
  const maxPages =
    pagination.type === 'next' || pagination.type === 'page' ? pagination.maxPages : 1;
  const crawler = new CheerioCrawler({
    requestQueue,
    maxConcurrency: request.requestSettings.concurrency,
    maxRequestRetries: request.requestSettings.retries,
    maxRequestsPerCrawl: Math.min(request.requestSettings.maxRequests, maxPages),
    requestHandlerTimeoutSecs: Math.ceil(request.requestSettings.timeoutMs / 1_000),
    ...(proxyConfiguration ? { proxyConfiguration } : {}),
    errorHandler: async ({ request: failedRequest }) => {
      await pause(
        Math.min(request.requestSettings.retryBackoffMs * 2 ** failedRequest.retryCount, 120_000),
        request.signal,
      );
    },
    preNavigationHooks: [
      async ({ request: item }, options) => {
        await prepareCrawlTarget(item.url, request, control);
        options.maxRedirects = request.requestSettings.redirectLimit;
        options.hooks = {
          ...options.hooks,
          beforeRedirect: [
            ...(options.hooks?.beforeRedirect ?? []),
            async (redirected) => {
              if (!redirected.url) throw new NavigationError('Redirect target is missing');
              const target = redirected.url.toString();
              await prepareCrawlTarget(target, request, control);
              if (new URL(target).origin !== new URL(request.url).origin) {
                for (const name of ['authorization', 'cookie', 'proxy-authorization']) {
                  delete redirected.headers[name];
                }
              }
            },
          ],
        };
      },
    ],
    requestHandler: async ({ $, request: crawleeRequest, enqueueLinks, response }) => {
      checkAbort(request.signal);
      const started = Date.now();
      const sourceUrl = crawleeRequest.loadedUrl ?? crawleeRequest.url;
      pages += 1;
      urls.push(sourceUrl);
      const html = $.html();
      if (Buffer.byteLength(html) > request.requestSettings.maxResponseBytes) {
        throw new CrawlerError(
          `Response exceeds ${request.requestSettings.maxResponseBytes} bytes`,
        );
      }
      const result = extractData(html, request.plan.list.rule, sourceUrl, request.plan.list.source);
      warnings.push(...result.warnings);
      records.push(...result.records.map((data) => ({ sourceUrl, data })));
      await logRequest(request, {
        url: sourceUrl,
        kind: pages === 1 ? 'list' : 'pagination',
        status: 'succeeded',
        statusCode: response?.statusCode ?? null,
        durationMs: Date.now() - started,
        errorCode: null,
        error: null,
      });
      await request.onProgress?.({
        phase: 'list',
        progress: Math.min(0.7, pages / Math.max(1, maxPages)),
        url: sourceUrl,
        requestCount: urls.length,
        recordCount: records.length,
      });
      if (pagination.type === 'next' && pages < pagination.maxPages && result.records.length > 0) {
        await enqueueLinks({
          selector: pagination.selector,
          limit: 1,
          transformRequestFunction: (item) => ({
            url: item.url,
            headers: headers(request.requestSettings, item.url, request.url),
          }),
        });
      }
    },
  });
  const abort = () => void crawler.autoscaledPool?.abort();
  request.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, request.requestSettings.maxRuntimeMs);
  try {
    await crawler.run(
      pageUrls(request.url, pagination).map((url) => ({
        url,
        headers: headers(request.requestSettings, url, request.url),
      })),
    );
    checkAbort(request.signal);
    return records;
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', abort);
    await requestQueue.drop();
  }
}

async function addCookies(page: Page, url: string, settings: RequestSettings) {
  if (settings.cookies.length === 0) return;
  await page.context().addCookies(
    settings.cookies.map((cookie) => {
      const common = {
        name: cookie.name,
        value: cookie.value,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
        ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
      };
      return cookie.domain
        ? { ...common, domain: cookie.domain, path: cookie.path }
        : { ...common, url };
    }),
  );
}

type BrowserCookie = Parameters<BrowserContext['addCookies']>[0][number];
const isBrowserCookie = (value: unknown): value is BrowserCookie => {
  if (typeof value !== 'object' || value === null) return false;
  const cookie = value as Record<string, unknown>;
  return (
    typeof cookie.name === 'string' &&
    typeof cookie.value === 'string' &&
    (typeof cookie.url === 'string' || typeof cookie.domain === 'string')
  );
};

async function restoreState(page: Page, settings: BrowserSettings) {
  const state = settings.storageState;
  if (Array.isArray(state?.cookies)) {
    const cookies = state.cookies.filter(isBrowserCookie);
    if (cookies.length > 0) await page.context().addCookies(cookies);
  }
  if (Array.isArray(state?.origins)) {
    await page.addInitScript((origins: unknown[]) => {
      const current = origins.find(
        (item): item is { origin: string; localStorage: Array<{ name: string; value: string }> } =>
          typeof item === 'object' &&
          item !== null &&
          'origin' in item &&
          item.origin === window.location.origin &&
          'localStorage' in item &&
          Array.isArray(item.localStorage),
      );
      for (const entry of current?.localStorage ?? [])
        localStorage.setItem(entry.name, entry.value);
    }, state.origins);
  }
}

async function crawlBrowser(
  request: CrawlRequest,
  warnings: string[],
  urls: string[],
  control: CrawlControl,
) {
  const records: CrawlRecord[] = [];
  const pagination = paginationFor(request);
  const requestQueue = await RequestQueueV1.open(`zhiyun-${crypto.randomUUID()}`);
  const proxyConfiguration = proxy(request.requestSettings);
  const routedPages = new WeakSet<Page>();
  let pages = 0;
  const maxPages =
    pagination.type === 'next' || pagination.type === 'page' ? pagination.maxPages : 1;
  const crawler = new PlaywrightCrawler({
    requestQueue,
    maxConcurrency: request.requestSettings.concurrency,
    maxRequestRetries: request.requestSettings.retries,
    maxRequestsPerCrawl: Math.min(request.requestSettings.maxRequests, maxPages),
    requestHandlerTimeoutSecs: Math.ceil(request.requestSettings.timeoutMs / 1_000),
    ...(proxyConfiguration ? { proxyConfiguration } : {}),
    errorHandler: async ({ request: failedRequest }) => {
      await pause(
        Math.min(request.requestSettings.retryBackoffMs * 2 ** failedRequest.retryCount, 120_000),
        request.signal,
      );
    },
    launchContext: { launchOptions: { headless: true } },
    preNavigationHooks: [
      async ({ page, request: item }) => {
        checkAbort(request.signal);
        await prepareCrawlTarget(item.url, request, control);
        if (!routedPages.has(page)) {
          routedPages.add(page);
          await page.route('**/*', async (route) => {
            try {
              await assertNetworkAllowed(route.request().url(), request.networkPolicy);
              await route.continue();
            } catch {
              await route.abort('blockedbyclient');
            }
          });
        }
        if (new URL(item.url).origin === new URL(request.url).origin) {
          await addCookies(page, item.url, request.requestSettings);
        }
        await restoreState(page, request.browserSettings);
        await page.setExtraHTTPHeaders(publicHeaders(request.requestSettings));
      },
    ],
    requestHandler: async ({ page, enqueueLinks, response }) => {
      checkAbort(request.signal);
      const started = Date.now();
      const rule = request.plan.list.rule;
      if (rule.type === 'css')
        await page
          .locator(rule.container)
          .first()
          .waitFor({ timeout: request.requestSettings.timeoutMs });
      await applyBrowserActions(page, {
        ...request.browserSettings,
        actions: [...request.browserSettings.actions, ...request.plan.list.actions],
      });
      if (pagination.type === 'loadMore') {
        let lastHash = '';
        for (let index = 0; index < pagination.maxClicks; index += 1) {
          checkAbort(request.signal);
          const button = page.locator(pagination.selector).first();
          if ((await button.count()) === 0 || !(await button.isVisible())) break;
          const before = createHash('sha256')
            .update(await page.content())
            .digest('hex');
          await button.click();
          await page.waitForTimeout(pagination.waitMs);
          const after = createHash('sha256')
            .update(await page.content())
            .digest('hex');
          if (after === before || after === lastHash) break;
          lastHash = after;
        }
      }
      if (pagination.type === 'infinite') {
        let lastHeight = 0;
        let lastHash = '';
        for (let index = 0; index < pagination.maxScrolls; index += 1) {
          checkAbort(request.signal);
          const height = await page.evaluate(() => document.body.scrollHeight);
          await page.evaluate(() => scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(pagination.waitMs);
          const hash = createHash('sha256')
            .update(await page.content())
            .digest('hex');
          if (height === lastHeight && hash === lastHash) break;
          lastHeight = height;
          lastHash = hash;
        }
      }
      const sourceUrl = page.url();
      pages += 1;
      urls.push(sourceUrl);
      const html = await page.content();
      if (Buffer.byteLength(html) > request.requestSettings.maxResponseBytes) {
        throw new CrawlerError(
          `Response exceeds ${request.requestSettings.maxResponseBytes} bytes`,
        );
      }
      const result = extractData(html, rule, sourceUrl, request.plan.list.source);
      warnings.push(...result.warnings);
      records.push(...result.records.map((data) => ({ sourceUrl, data })));
      await logRequest(request, {
        url: sourceUrl,
        kind: pages === 1 ? 'list' : 'pagination',
        status: 'succeeded',
        statusCode: response?.status() ?? null,
        durationMs: Date.now() - started,
        errorCode: null,
        error: null,
      });
      await request.onProgress?.({
        phase: 'list',
        progress: Math.min(0.7, pages / Math.max(1, maxPages)),
        url: sourceUrl,
        requestCount: urls.length,
        recordCount: records.length,
      });
      if (pagination.type === 'next' && pages < pagination.maxPages && result.records.length > 0) {
        await enqueueLinks({
          selector: pagination.selector,
          limit: 1,
          transformRequestFunction: (item) => ({
            url: item.url,
            headers: headers(request.requestSettings, item.url, request.url),
          }),
        });
      }
    },
  });
  const abort = () => void crawler.autoscaledPool?.abort();
  request.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, request.requestSettings.maxRuntimeMs);
  try {
    await crawler.run(
      pageUrls(request.url, pagination).map((url) => ({
        url,
        headers: headers(request.requestSettings, url, request.url),
      })),
    );
    checkAbort(request.signal);
    return records;
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', abort);
    await requestQueue.drop();
  }
}

type SitemapDiscovery = NonNullable<CrawlPlanDefinition['discovery']>;

function sitemapUrlIncluded(url: string, discovery: SitemapDiscovery): boolean {
  return (
    (discovery.include.length === 0 || discovery.include.some((value) => url.includes(value))) &&
    !discovery.exclude.some((value) => url.includes(value))
  );
}

async function crawlSitemap(
  request: CrawlRequest,
  warnings: string[],
  urls: string[],
  control: CrawlControl,
  recordLimit: number,
): Promise<CrawlRecord[]> {
  const discovery = request.plan.discovery!;
  const rootOrigin = new URL(request.url).origin;
  const queue: Array<{ url: string; depth: number }> = [{ url: request.url, depth: 0 }];
  const visited = new Set<string>();
  const discovered = new Set<string>();
  const records: CrawlRecord[] = [];
  const urlLimit = discovery.maxUrls;
  while (queue.length > 0 && visited.size < discovery.maxSitemaps && records.length < urlLimit) {
    checkAbort(request.signal);
    if (urls.length >= request.requestSettings.maxRequests) {
      warnings.push('Sitemap discovery stopped because maxRequests was reached');
      break;
    }
    const current = queue.shift()!;
    if (visited.has(current.url) || current.depth > discovery.maxDepth) continue;
    if (discovery.sameOrigin && new URL(current.url).origin !== rootOrigin) {
      warnings.push(`Cross-origin sitemap was skipped: ${current.url}`);
      continue;
    }
    visited.add(current.url);
    const started = Date.now();
    try {
      await prepareCrawlTarget(current.url, request, control);
      const response = await controlledFetch(current.url, request);
      if (!response.ok) throw new NavigationError(`HTTP ${response.status} for ${current.url}`);
      const text = new TextDecoder().decode(
        await body(response, request.requestSettings.maxResponseBytes),
      );
      const loadedUrl = response.url || current.url;
      urls.push(loadedUrl);
      let parsedEntries = 0;
      for await (const item of parseSitemap([{ type: 'raw', content: text }], undefined, {
        emitNestedSitemaps: true,
        maxDepth: 0,
        reportNetworkErrors: false,
        enqueueStrategy: 'all',
      })) {
        parsedEntries += 1;
        const target = new URL(item.loc, loadedUrl).toString();
        if (item.originSitemapUrl === null) {
          if (
            current.depth < discovery.maxDepth &&
            !visited.has(target) &&
            (!discovery.sameOrigin || new URL(target).origin === rootOrigin)
          ) {
            queue.push({ url: target, depth: current.depth + 1 });
          }
          continue;
        }
        if (
          records.length >= urlLimit ||
          (discovery.sameOrigin && new URL(target).origin !== rootOrigin) ||
          discovered.has(target) ||
          !sitemapUrlIncluded(target, discovery)
        ) {
          continue;
        }
        discovered.add(target);
        const data: Record<string, unknown> = { [discovery.urlField]: target };
        if (discovery.lastModifiedField && item.lastmod) {
          data[discovery.lastModifiedField] = item.lastmod.toISOString();
        }
        records.push({ sourceUrl: target, data });
      }
      if (parsedEntries === 0) warnings.push(`Sitemap contained no entries: ${loadedUrl}`);
      await logRequest(request, {
        url: loadedUrl,
        kind: visited.size === 1 ? 'list' : 'pagination',
        status: 'succeeded',
        statusCode: response.status,
        durationMs: Date.now() - started,
        errorCode: null,
        error: null,
      });
      await request.onProgress?.({
        phase: 'discovery',
        progress: Math.min(0.65, visited.size / Math.max(1, discovery.maxSitemaps)),
        url: loadedUrl,
        requestCount: urls.length,
        recordCount: records.length,
      });
    } catch (error) {
      await logRequest(request, {
        url: current.url,
        kind: visited.size === 1 ? 'list' : 'pagination',
        status: 'failed',
        statusCode: null,
        durationMs: Date.now() - started,
        errorCode: error instanceof ZhiYunError ? error.code : 'NAVIGATION_ERROR',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  if (queue.length > 0 && visited.size >= discovery.maxSitemaps) {
    warnings.push('Sitemap discovery stopped because maxSitemaps was reached');
  }
  if (discovery.lastModifiedField) {
    records.sort((left, right) => {
      const leftValue = Date.parse(String(left.data[discovery.lastModifiedField!] ?? ''));
      const rightValue = Date.parse(String(right.data[discovery.lastModifiedField!] ?? ''));
      return (
        (Number.isFinite(rightValue) ? rightValue : 0) -
        (Number.isFinite(leftValue) ? leftValue : 0)
      );
    });
  }
  return records.slice(0, recordLimit);
}

async function loadDetail(url: string, request: CrawlRequest, control: CrawlControl) {
  const detail = request.plan.detail!;
  await prepareCrawlTarget(url, request, control);
  const useBrowser =
    detail.mode === 'browser' ||
    (detail.mode === 'auto' && (request.browserSettings.enabled || detail.actions.length > 0));
  if (useBrowser) {
    const loaded = await new PlaywrightAdapter().load(url, {
      browser: {
        ...request.browserSettings,
        enabled: true,
        actions: [...request.browserSettings.actions, ...detail.actions],
      },
      request:
        new URL(url).origin === new URL(request.url).origin
          ? request.requestSettings
          : {
              ...request.requestSettings,
              headers: headers(request.requestSettings, url, request.url),
              cookies: [],
            },
      ...(request.signal ? { signal: request.signal } : {}),
      allowRequest: (target) => assertNetworkAllowed(target, request.networkPolicy),
    });
    return {
      data: extractData(loaded.html, detail.rule, loaded.url, detail.source).records[0] ?? {},
      browserUsed: true,
    };
  }
  const response = await controlledFetch(url, request);
  if (!response.ok) throw new NavigationError(`HTTP ${response.status} for ${url}`);
  const bytes = await body(response, request.requestSettings.maxResponseBytes);
  const text = new TextDecoder().decode(bytes);
  const source =
    !detail.source && (response.headers.get('content-type') ?? '').includes('json')
      ? (JSON.parse(text) as unknown)
      : text;
  return {
    data: extractData(source, detail.rule, response.url || url, detail.source).records[0] ?? {},
    browserUsed: false,
  };
}

async function enrichDetails(
  records: CrawlRecord[],
  request: CrawlRequest,
  warnings: string[],
  urls: string[],
  control: CrawlControl,
) {
  const detail = request.plan.detail;
  if (!detail) return { records, browserUsed: false };
  const cache = new Map<string, Promise<Awaited<ReturnType<typeof loadDetail>>>>();
  const result: Array<CrawlRecord | null> = Array.from({ length: records.length }, () => null);
  let browserUsed = false;
  let nextIndex = 0;
  let completed = 0;
  const worker = async () => {
    while (nextIndex < records.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = records[index]!;
      checkAbort(request.signal);
      const raw = item.data[detail.urlField];
      if (typeof raw !== 'string' || raw.length === 0) {
        warnings.push(`Detail URL field ${detail.urlField} is empty`);
        if (detail.onError !== 'skip') result[index] = item;
        completed += 1;
        continue;
      }
      const url = new URL(raw, item.sourceUrl).toString();
      const isNew = !cache.has(url);
      if (isNew) {
        if (urls.length >= request.requestSettings.maxRequests) {
          warnings.push('Detail request skipped because maxRequests was reached');
          if (detail.onError !== 'skip') result[index] = item;
          completed += 1;
          continue;
        }
        cache.set(url, loadDetail(url, request, control));
        urls.push(url);
      }
      const started = Date.now();
      try {
        const loaded = await cache.get(url)!;
        browserUsed ||= loaded.browserUsed;
        if (isNew) {
          await logRequest(request, {
            url,
            kind: 'detail',
            status: 'succeeded',
            statusCode: 200,
            durationMs: Date.now() - started,
            errorCode: null,
            error: null,
          });
        }
        result[index] = {
          ...item,
          data:
            detail.mergeStrategy === 'detailWins'
              ? { ...item.data, ...loaded.data }
              : { ...loaded.data, ...item.data },
        };
      } catch (error) {
        if (isNew) {
          await logRequest(request, {
            url,
            kind: 'detail',
            status: detail.onError === 'skip' ? 'skipped' : 'failed',
            statusCode: null,
            durationMs: Date.now() - started,
            errorCode: error instanceof ZhiYunError ? error.code : 'NAVIGATION_ERROR',
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (detail.onError === 'fail-run') throw error;
        warnings.push(
          `Detail request failed for ${url}: ${error instanceof Error ? error.message : error}`,
        );
        if (detail.onError === 'keep-list-record') result[index] = item;
      }
      completed += 1;
      await request.onProgress?.({
        phase: 'detail',
        progress: 0.7 + 0.25 * (completed / Math.max(1, records.length)),
        url,
        requestCount: urls.length,
        recordCount: result.filter(Boolean).length,
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(detail.concurrency, records.length) }, () => worker()),
  );
  return {
    records: result.filter((item): item is CrawlRecord => item !== null),
    browserUsed,
  };
}

export class CrawlerRuntime {
  async crawl(request: CrawlRequest): Promise<CrawlResult> {
    request = {
      ...request,
      requestSettings: {
        ...request.requestSettings,
        maxRequests: Math.min(
          request.requestSettings.maxRequests,
          request.plan.limits.maxRequests ?? request.requestSettings.maxRequests,
        ),
        maxRuntimeMs: Math.min(
          request.requestSettings.maxRuntimeMs,
          request.plan.limits.maxRuntimeMs ?? request.requestSettings.maxRuntimeMs,
        ),
      },
    };
    const started = Date.now();
    const callerSignal = request.signal;
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(
      () => deadline.abort('Crawl exceeded maxRuntime'),
      request.requestSettings.maxRuntimeMs,
    );
    request = {
      ...request,
      signal: callerSignal ? AbortSignal.any([callerSignal, deadline.signal]) : deadline.signal,
    };
    const warnings: string[] = [];
    const urls: string[] = [];
    const rule = request.plan.list.rule;
    const recordLimit = Math.min(
      request.plan.limits.maxRecords,
      request.previewLimit ?? request.plan.limits.maxRecords,
    );
    const control = createCrawlControl(request.requestSettings);
    let browserUsed = request.plan.discovery
      ? false
      : request.mode === 'browser' ||
        request.plan.list.mode === 'browser' ||
        request.browserSettings.enabled ||
        ['loadMore', 'infinite'].includes(paginationFor(request).type);
    try {
      await assertNetworkAllowed(request.url, request.networkPolicy);
      await request.onProgress?.({ phase: 'preflight', progress: 0 });
      const directJson = rule.type === 'json' && !request.plan.list.source;
      let records = request.plan.discovery
        ? await crawlSitemap(request, warnings, urls, control, recordLimit)
        : directJson
          ? await crawlJson(request, urls, control)
          : browserUsed
            ? await crawlBrowser(request, warnings, urls, control)
            : await crawlHttp(request, warnings, urls, control);
      if (
        records.length === 0 &&
        !directJson &&
        !request.plan.discovery &&
        !browserUsed &&
        request.plan.list.mode === 'auto'
      ) {
        warnings.push('HTTP extraction returned no records; falling back to browser');
        records = await crawlBrowser(request, warnings, urls, control);
        browserUsed = true;
      }
      if (records.length > recordLimit) {
        warnings.push(`List records were limited to ${recordLimit} before detail requests`);
        records = records.slice(0, recordLimit);
      }
      const details = await enrichDetails(records, request, warnings, urls, control);
      browserUsed ||= details.browserUsed;
      records = dedupe(details.records, request.plan).slice(0, request.plan.limits.maxRecords);
      if (request.previewLimit) records = records.slice(0, request.previewLimit);
      await request.onProgress?.({
        phase: 'persisting',
        progress: 0.98,
        requestCount: urls.length,
        recordCount: records.length,
      });
      return {
        records,
        metadata: {
          durationMs: Date.now() - started,
          requestCount: urls.length,
          recordCount: records.length,
          browserUsed,
          aiUsed: false,
          warnings,
          urls,
        },
      };
    } catch (error) {
      if (deadline.signal.aborted && !callerSignal?.aborted) {
        throw new CrawlerError(
          `Crawl exceeded maxRuntimeMs (${request.requestSettings.maxRuntimeMs})`,
          error,
        );
      }
      if (error instanceof ZhiYunError) throw error;
      throw new CrawlerError(`Crawl failed for ${request.url}`, error);
    } finally {
      clearTimeout(deadlineTimer);
    }
  }
}
