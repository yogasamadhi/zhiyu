import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { CheerioCrawler } from '@crawlee/cheerio';
import { Configuration, ProxyConfiguration, RequestQueueV1 } from '@crawlee/core';
import { PlaywrightCrawler } from '@crawlee/playwright';
import { parseSitemap } from '@crawlee/utils';
import type { BrowserContext, Page } from 'playwright';
import robotsParser from 'robots-parser';
import {
  applyBrowserActions,
  browserPageCacheSession,
  PlaywrightAdapter,
} from '@zhiyun/browser-runtime';
import { extractData, validateCrawlPlan, type ExtractionOutput } from '@zhiyun/extraction';
import {
  CrawlerError,
  NavigationError,
  NetworkPolicyError,
  ZhiYunError,
  emitDiagnosticStep,
  observeDiagnosticOperation,
  classifyDiagnosticError,
  createWarningBuffer,
  appendWarnings,
  warningTotal,
  BROWSER_ROUND_BATCH_STRIDE,
  type CrawlBrowserPagination,
  type CrawlBrowserRoundState,
  type DiagnosticObserver,
  type DiagnosticStep,
  type DiagnosticErrorCode,
  type CrawlBatchObserver,
  type CrawlBatch,
  type CrawlDetailCache,
  type CrawlDetailData,
  type CrawlListSpool,
  type CrawlCheckpoint,
  type CrawlSitemapSpool,
  type CrawlSitemapBatch,
  type CrawlRequestSeed,
  type CrawlRequestStage,
  type BrowserSettings,
  type BrowserActionCacheContext,
  type BrowserActionCacheSummary,
  type CrawlPlanDefinition,
  type Pagination,
  type NetworkPolicy,
  type RequestSettings,
  type RunRequestEntry,
  type CollectionPreviewRecord,
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
  onDiagnostic?: DiagnosticObserver;
  actionCache?: BrowserActionCacheContext;
  /** Internal, transient page evidence for bounded rule qualification; no source is persisted. */
  onVerificationSource?: (source: {
    input: unknown;
    url: string;
    target: 'list' | 'detail' | 'discovery';
    phase: 'extraction' | 'before-pagination';
    session?: { fingerprint?: string; privateValues: string[] };
    discovery?: { parsedEntries: number; acceptedUrls: number };
  }) => void | Promise<void>;
  /** Explicit disabled controls are transient termination evidence, not a missing-selector inference. */
  onVerificationPagination?: (evidence: {
    url: string;
    type: 'next' | 'loadMore';
    terminal: boolean;
  }) => void | Promise<void>;
  onBatch?: CrawlBatchObserver;
  detailCache?: CrawlDetailCache;
  listSpool?: CrawlListSpool;
  initialRecordCount?: number;
  checkpoint?: CrawlCheckpoint;
  sitemapSpool?: CrawlSitemapSpool;
  browserPagination?: CrawlBrowserPagination;
  onProgress?: (event: {
    phase: string;
    progress: number;
    url?: string;
    requestCount?: number;
    recordCount?: number;
  }) => void | Promise<void>;
  onRequest?: (event: Omit<RunRequestEntry, 'id' | 'runId' | 'createdAt'>) => void | Promise<void>;
}

export type CrawlRecord = CollectionPreviewRecord;

async function extractForRequest(
  request: CrawlRequest,
  input: unknown,
  rule: CrawlPlanDefinition['list']['rule'],
  sourceUrl: string,
  source: CrawlPlanDefinition['list']['source'],
  target: 'list' | 'detail',
  session?: { fingerprint?: string; privateValues: string[] },
): Promise<ExtractionOutput> {
  await request.onVerificationSource?.({
    input,
    url: sourceUrl,
    target,
    phase: 'extraction',
    ...(session ? { session } : {}),
  });
  const result = await observeDiagnosticOperation(
    request.onDiagnostic,
    { kind: 'extraction', target },
    () =>
      extractData(input, rule, sourceUrl, source, {
        inspect: Boolean(request.previewLimit || request.onDiagnostic),
      }),
    (output) => ({
      recordCount: output.records.length,
      ...(output.records.length === 0 ? { status: 'failed', errorCode: 'EMPTY_PREVIEW' } : {}),
    }),
    request.signal,
  );
  const startedAt = new Date().toISOString();
  await emitDiagnosticStep(request.onDiagnostic, {
    kind: 'selector',
    target,
    startedAt,
    durationMs: 0,
    status: result.records.length ? 'succeeded' : 'failed',
    matchedCount: result.records.length,
    ...(result.records.length ? {} : { errorCode: 'SELECTOR_UNMATCHED' }),
  });
  if (request.onDiagnostic)
    for (const [fieldIndex, name] of Object.keys(rule.fields).entries()) {
      const values = result.inspections?.map((inspection) => inspection.fields[name]);
      const missing = !values?.length || values.some((value) => value?.status === 'missing');
      const invalid = values?.some((value) => value?.status === 'invalid_type') ?? false;
      await emitDiagnosticStep(request.onDiagnostic, {
        kind: 'selector',
        target,
        fieldIndex,
        startedAt,
        durationMs: 0,
        matchedCount: values?.reduce((sum, value) => sum + (value?.matches ?? 0), 0) ?? 0,
        status: missing || invalid ? 'failed' : 'succeeded',
        ...(missing
          ? { errorCode: 'SELECTOR_UNMATCHED' }
          : invalid
            ? { errorCode: 'EXTRACTION_ERROR' }
            : {}),
      });
    }
  // Production diagnostics must not add preview-only metadata to stored records.
  return request.previewLimit ? result : { records: result.records, warnings: result.warnings };
}

function extractedRecords(result: ExtractionOutput, sourceUrl: string): CrawlRecord[] {
  return result.records.map((data, index) => ({
    sourceUrl,
    data,
    ...(result.inspections?.[index] ? { inspection: result.inspections[index] } : {}),
  }));
}

export interface CrawlResult {
  records: CrawlRecord[];
  metadata: {
    durationMs: number;
    requestCount: number;
    recordCount: number;
    browserUsed: boolean;
    aiUsed: boolean;
    actionCache?: BrowserActionCacheSummary;
    warnings: string[];
    warningTotal?: number;
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

function navigationDiagnostics(request: CrawlRequest) {
  const pending = new Map<object, { started: number; target: DiagnosticStep['target'] }>();
  return {
    start(item: object, url: string) {
      pending.set(item, {
        started: Date.now(),
        target: url === request.url ? 'list' : 'pagination',
      });
    },
    async finish(item: object, statusCode?: number, error?: unknown) {
      const timing = pending.get(item);
      if (!timing) return;
      pending.delete(item);
      if (error === undefined && statusCode && statusCode >= 400)
        error = new NavigationError(`HTTP ${statusCode}`);
      const classified =
        error === undefined ? undefined : classifyDiagnosticError(error, request.signal);
      const errorCode = classified === 'UNEXPECTED_ERROR' ? 'NAVIGATION_ERROR' : classified;
      await emitDiagnosticStep(request.onDiagnostic, {
        kind: 'navigation',
        target: timing.target,
        status: errorCode === 'CANCELED' ? 'canceled' : errorCode ? 'failed' : 'succeeded',
        startedAt: new Date(timing.started).toISOString(),
        durationMs: Date.now() - timing.started,
        ...(statusCode ? { statusCode } : {}),
        ...(errorCode ? { errorCode } : {}),
      });
    },
    async abort(error: unknown) {
      for (const item of pending.keys()) await this.finish(item, undefined, error);
    },
  };
}

function* boundedRecordBatches(records: CrawlRecord[]): Iterable<CrawlRecord[]> {
  let batch: CrawlRecord[] = [];
  let bytes = 2;
  for (const record of records) {
    const size = Buffer.byteLength(JSON.stringify(record)) + 1;
    if (batch.length && (batch.length >= 250 || bytes + size > 1024 * 1024)) {
      yield batch;
      batch = [];
      bytes = 2;
    }
    batch.push(record);
    bytes += size;
  }
  if (batch.length) yield batch;
}

function requestSeed(
  url: string,
  stage: CrawlRequestStage,
  kind: CrawlRequestSeed['kind'],
): CrawlRequestSeed {
  return {
    id: createHash('sha256')
      .update(canonical({ requestedUrl: url, stage }))
      .digest('hex'),
    url,
    stage,
    kind,
  };
}

async function* checkpointRequests(checkpoint: CrawlCheckpoint, stage?: CrawlRequestStage) {
  let after = 0;
  while (true) {
    const page = await checkpoint.requests(stage, after);
    if (!page.length) return;
    for (const item of page) {
      yield item;
      after = item.ordinal;
    }
  }
}

async function openCrawlQueue(
  request: CrawlRequest,
  stage: 'http' | 'browser',
  pagination: Pagination,
) {
  if (!request.checkpoint)
    return {
      queue: await RequestQueueV1.open(`zhiyun-${crypto.randomUUID()}`),
      config: undefined,
      completedPages: 0,
      initial: pageUrls(request.url, pagination).map((url) => ({
        url,
        headers: headers(request.requestSettings, url, request.url),
      })),
      pending: true,
      enqueue: undefined,
    };
  const checkpoint = request.checkpoint;
  // SQLite owns recoverable URL state. Crawlee is an in-memory scheduler;
  // session cookies, request headers and errors are never persisted by it.
  const config = new Configuration({
    purgeOnStart: false,
    persistStorage: false,
    storageClientOptions: {
      localDataDirectory: checkpoint.storageDirectory,
      persistStorage: false,
      writeMetadata: false,
    },
  });
  const queue = await RequestQueueV1.open(`zhiyun-${stage}-${checkpoint.queueScope.slice(0, 40)}`, {
    config,
  });
  const enqueue = async (seed: CrawlRequestSeed) => {
    const state = await checkpoint.ensure(seed, request.requestSettings.maxRequests);
    if (state?.status === 'pending')
      await queue.addRequest({
        url: state.url,
        uniqueKey: state.id,
        userData: { checkpointKind: state.kind },
      });
  };
  const initialUrls = pageUrls(request.url, pagination);
  for (const [index, url] of initialUrls.entries()) {
    const state = await checkpoint.ensure(
      requestSeed(url, stage, index === 0 ? 'list' : 'pagination'),
      request.requestSettings.maxRequests,
    );
    if (!state) break;
  }
  let completedPages = 0;
  for await (const state of checkpointRequests(checkpoint, stage)) {
    if (state.status === 'completed') {
      completedPages++;
      for (const next of state.nextRequests) await enqueue(next);
    } else await enqueue(state);
  }
  return {
    queue,
    config,
    completedPages,
    initial: undefined,
    pending: !(await queue.isEmpty()),
    enqueue,
  };
}

/** Serializes acknowledgements, while Crawlee retains its bounded page concurrency. */
class StreamRecordSink {
  listRecordCount = 0;
  recordCount: number;
  browserUsed = false;
  private tail: Promise<void> = Promise.resolve();
  private readonly reservations = new Map<string, number>();
  private readonly detailMemory = new Map<string, Promise<CachedDetail | null>>();

  constructor(
    private readonly request: CrawlRequest,
    private readonly warnings: string[],
    private readonly urls: string[],
    private readonly control: CrawlControl,
    private readonly limit: number,
    initialRawRecordCount = 0,
  ) {
    this.recordCount = request.initialRecordCount ?? 0;
    this.listRecordCount = initialRawRecordCount;
  }

  async accept(records: CrawlRecord[], requestedUrl: string, stage = 'list'): Promise<void> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((done) => {
      release = done;
    });
    await prior;
    try {
      checkAbort(this.request.signal);
      const requestId = createHash('sha256')
        .update(canonical({ requestedUrl, stage }))
        .digest('hex');
      let count = this.reservations.get(requestId);
      if (count === undefined) {
        count = this.request.checkpoint
          ? await this.request.checkpoint.reserveRecords(requestId, records.length, this.limit)
          : Math.min(records.length, Math.max(0, this.limit - this.listRecordCount));
        this.reservations.set(requestId, count);
        if (this.request.checkpoint)
          this.listRecordCount = (await this.request.checkpoint.summary()).rawRecordCount;
        else this.listRecordCount += count;
        if (count < records.length)
          this.warnings.push(`List records were limited to ${this.limit} before detail requests`);
      }
      let sequence = 0;
      for (const batch of boundedRecordBatches(records.slice(0, count))) {
        checkAbort(this.request.signal);
        const item = {
          requestId,
          sequence: sequence++,
          records: batch.map(({ sourceUrl, data }) => ({ sourceUrl, data })),
        };
        if (this.request.listSpool) await this.request.listSpool.append(item);
        else await this.deliver(item);
      }
    } finally {
      release();
    }
  }

  async drain(): Promise<void> {
    await this.tail;
  }

  async acceptPrepared(
    records: CrawlRecord[],
    requestId: string,
    sequence: number,
  ): Promise<number> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((done) => {
      release = done;
    });
    await prior;
    try {
      checkAbort(this.request.signal);
      this.listRecordCount = (await this.request.checkpoint!.summary()).rawRecordCount;
      let batches = 0;
      for (const batch of boundedRecordBatches(records)) {
        checkAbort(this.request.signal);
        const item = {
          requestId,
          sequence: sequence + batches++,
          records: batch.map(({ sourceUrl, data }) => ({ sourceUrl, data })),
        };
        await this.request.listSpool!.append(item);
      }
      return batches;
    } finally {
      release();
    }
  }

  async finish(): Promise<void> {
    await this.drain();
    if (this.request.listSpool)
      for await (const item of this.request.listSpool.batches()) await this.deliver(item);
  }

  async finishSitemap(): Promise<void> {
    const discovery = this.request.plan.discovery!;
    for await (const item of this.request.sitemapSpool!.batches({
      requestId: requestSeed(this.request.url, 'api', 'api').id,
      urlField: discovery.urlField,
      ...(discovery.lastModifiedField ? { lastModifiedField: discovery.lastModifiedField } : {}),
      limit: this.limit,
    })) {
      this.listRecordCount += item.records.length;
      await this.deliver(item);
    }
  }

  private async deliver(item: CrawlBatch): Promise<void> {
    checkAbort(this.request.signal);
    const detail = await enrichDetails(
      item.records,
      this.request,
      this.warnings,
      this.urls,
      this.control,
      this.detailMemory,
    );
    this.browserUsed ||= detail.browserUsed;
    const outputs = this.request.plan.detail
      ? boundedRecordBatches(detail.records)
      : [item.records];
    let part = 0;
    for (const records of outputs) {
      checkAbort(this.request.signal);
      const committed = await this.request.onBatch!({
        requestId: item.requestId,
        sequence: item.sequence * 256 + part++,
        records: records.map(({ sourceUrl, data }) => ({ sourceUrl, data })),
      });
      if (
        !Number.isSafeInteger(committed.acceptedCount) ||
        committed.acceptedCount < 0 ||
        committed.acceptedCount > records.length ||
        !Number.isSafeInteger(committed.totalCount) ||
        committed.totalCount < this.recordCount ||
        committed.totalCount > this.limit
      )
        throw new ZhiYunError('VALIDATION_ERROR', 'VALIDATION: Invalid batch acknowledgement');
      this.recordCount = committed.totalCount;
      checkAbort(this.request.signal);
    }
  }
}

async function acceptPageRecords(
  records: CrawlRecord[],
  pageRecords: CrawlRecord[],
  request: CrawlRequest,
  requestedUrl: string,
  sink?: StreamRecordSink,
  stage = 'list',
): Promise<void> {
  if (sink) await sink.accept(pageRecords, requestedUrl, stage);
  else
    records.push(
      ...pageRecords.slice(
        0,
        request.previewLimit ? Math.max(0, request.previewLimit - records.length) : undefined,
      ),
    );
}

async function crawlJson(
  request: CrawlRequest,
  warnings: string[],
  urls: string[],
  control: CrawlControl,
  sink?: StreamRecordSink,
): Promise<CrawlRecord[]> {
  const records: CrawlRecord[] = [];
  for (const [index, url] of pageUrls(request.url, paginationFor(request)).entries()) {
    const seed = requestSeed(url, 'api', index === 0 ? 'api' : 'pagination');
    if (request.checkpoint) {
      const state = await request.checkpoint.ensure(seed, request.requestSettings.maxRequests);
      if (!state) break;
      if (state.status === 'completed') continue;
    } else if (urls.length >= request.requestSettings.maxRequests) break;
    const started = Date.now();
    try {
      const loaded = await observeDiagnosticOperation(
        request.onDiagnostic,
        { kind: 'navigation', target: index === 0 ? 'list' : 'pagination' },
        async () => {
          await prepareCrawlTarget(url, request, control);
          const response = await controlledFetch(url, request);
          if (!response.ok) throw new NavigationError(`HTTP ${response.status} for ${url}`);
          const text = new TextDecoder().decode(
            await body(response, request.requestSettings.maxResponseBytes),
          );
          return { response, text };
        },
        (value) => ({ statusCode: value.response.status }),
        request.signal,
      );
      const response = loaded.response;
      const payload = await observeDiagnosticOperation(
        request.onDiagnostic,
        { kind: 'extraction', target: 'list' },
        () => JSON.parse(loaded.text) as unknown,
      );
      const sourceUrl = response.url || url;
      urls.push(sourceUrl);
      const extracted = await extractForRequest(
        request,
        payload,
        request.plan.list.rule,
        sourceUrl,
        undefined,
        'list',
      );
      appendWarnings(warnings, extracted.warnings);
      await acceptPageRecords(
        records,
        extractedRecords(extracted, sourceUrl),
        request,
        url,
        sink,
        'api',
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
      await request.checkpoint?.complete(
        seed.id,
        { sourceUrl, browserUsed: false, nextRequests: [] },
        request.requestSettings.maxRequests,
      );
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
  sink?: StreamRecordSink,
) {
  const records: CrawlRecord[] = [];
  const pagination = paginationFor(request);
  const stageQueue = await openCrawlQueue(request, 'http', pagination);
  const requestQueue = stageQueue.queue;
  if (!stageQueue.pending) return records;
  const proxyConfiguration = proxy(request.requestSettings);
  let pages = stageQueue.completedPages;
  let failure: unknown;
  const navigation = navigationDiagnostics(request);
  const maxPages =
    pagination.type === 'next' || pagination.type === 'page' ? pagination.maxPages : 1;
  const crawler = new CheerioCrawler(
    {
      requestQueue,
      maxConcurrency: request.requestSettings.concurrency,
      maxRequestRetries: request.requestSettings.retries,
      maxRequestsPerCrawl: Math.min(request.requestSettings.maxRequests, maxPages),
      requestHandlerTimeoutSecs: Math.ceil(request.requestSettings.timeoutMs / 1_000),
      ...(proxyConfiguration ? { proxyConfiguration } : {}),
      errorHandler: async ({ request: failedRequest }, error) => {
        await navigation.finish(failedRequest, undefined, error);
        await pause(
          Math.min(request.requestSettings.retryBackoffMs * 2 ** failedRequest.retryCount, 120_000),
          request.signal,
        );
      },
      failedRequestHandler: async ({ request: item }, error) => {
        await navigation.finish(item, undefined, error);
        failure = error;
      },
      preNavigationHooks: [
        async ({ request: item }, options) => {
          navigation.start(item, item.url);
          await prepareCrawlTarget(item.url, request, control);
          if (request.checkpoint)
            options.headers = headers(request.requestSettings, item.url, request.url);
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
      postNavigationHooks: [
        async ({ request: item, response }) => {
          await navigation.finish(item, response?.statusCode);
        },
      ],
      requestHandler: async ({ $, request: crawleeRequest, enqueueLinks, response }) => {
        checkAbort(request.signal);
        const started = Date.now();
        const sourceUrl = crawleeRequest.loadedUrl ?? crawleeRequest.url;
        const seed = requestSeed(
          crawleeRequest.url,
          'http',
          (crawleeRequest.userData.checkpointKind ??
            (pages === 0 ? 'list' : 'pagination')) as CrawlRequestSeed['kind'],
        );
        pages += 1;
        urls.push(sourceUrl);
        const html = $.html();
        if (Buffer.byteLength(html) > request.requestSettings.maxResponseBytes) {
          throw new CrawlerError(
            `Response exceeds ${request.requestSettings.maxResponseBytes} bytes`,
          );
        }
        const result = await extractForRequest(
          request,
          html,
          request.plan.list.rule,
          sourceUrl,
          request.plan.list.source,
          'list',
        );
        appendWarnings(warnings, result.warnings);
        await acceptPageRecords(
          records,
          extractedRecords(result, sourceUrl),
          request,
          crawleeRequest.url,
          sink,
          'http',
        );
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
          recordCount: sink?.recordCount ?? records.length,
        });
        const nextRequests: CrawlRequestSeed[] = [];
        const nextControls = pagination.type === 'next' ? $(pagination.selector) : undefined;
        const nextTerminal = Boolean(
          nextControls?.length &&
          nextControls
            .toArray()
            .every((control) => $(control).is('[disabled], [aria-disabled="true"]')),
        );
        if (pagination.type === 'next')
          await request.onVerificationPagination?.({
            url: sourceUrl,
            type: 'next',
            terminal: nextTerminal,
          });
        if (
          request.checkpoint &&
          pagination.type === 'next' &&
          !nextTerminal &&
          pages < pagination.maxPages &&
          result.records.length > 0
        ) {
          await enqueueLinks({
            selector: pagination.selector,
            limit: 1,
            transformRequestFunction: (item) => {
              if (!nextRequests.length)
                nextRequests.push(requestSeed(item.url, 'http', 'pagination'));
              return null;
            },
          });
        }
        await request.checkpoint?.complete(
          seed.id,
          { sourceUrl, browserUsed: false, nextRequests },
          request.requestSettings.maxRequests,
        );
        if (request.checkpoint) {
          for (const next of nextRequests) await stageQueue.enqueue!(next);
        } else if (
          pagination.type === 'next' &&
          !nextTerminal &&
          pages < pagination.maxPages &&
          result.records.length > 0
        ) {
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
    },
    stageQueue.config,
  );
  const abort = () => void crawler.autoscaledPool?.abort();
  request.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, request.requestSettings.maxRuntimeMs);
  try {
    await crawler.run(stageQueue.initial);
    checkAbort(request.signal);
    if (failure) throw failure;
    return records;
  } finally {
    if (request.signal?.aborted)
      await navigation.abort(new ZhiYunError('CANCELED', 'Navigation was canceled'));
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', abort);
    if (!request.checkpoint) await requestQueue.drop();
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

async function prepareInfiniteViewport(page: Page, rule: CrawlPlanDefinition['list']['rule']) {
  const noScrollRange = await page.evaluate(
    () =>
      (document.scrollingElement?.scrollHeight ?? document.body.scrollHeight) <= innerHeight + 1,
  );
  if (noScrollRange && rule.type !== 'json') {
    const last = await page.locator(rule.container).last().boundingBox();
    const viewport =
      page.viewportSize() ??
      (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
    if (last)
      await page.setViewportSize({
        width: viewport.width,
        height: Math.max(1, Math.min(viewport.height - 1, Math.floor(last.y + last.height / 2))),
      });
  }
}

async function scrollForNext(page: Page) {
  await page.evaluate(async () => {
    scrollBy({ top: -(innerHeight + 1), behavior: 'instant' });
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
    scrollTo({
      top: document.scrollingElement?.scrollHeight ?? document.body.scrollHeight,
      behavior: 'instant',
    });
  });
}

async function streamBrowserRounds(
  page: Page,
  request: CrawlRequest,
  requestedUrl: string,
  pagination: Extract<Pagination, { type: 'loadMore' | 'infinite' }>,
  warnings: string[],
  sink: StreamRecordSink,
): Promise<void> {
  const cursor = request.browserPagination!;
  const requestId = requestSeed(requestedUrl, 'browser', 'list').id;
  const limit = request.plan.limits.maxRecords;
  const maxActions = pagination.type === 'loadMore' ? pagination.maxClicks : pagination.maxScrolls;
  const rule = request.plan.list.rule;
  if (pagination.type === 'infinite') await prepareInfiniteViewport(page, rule);
  let previous: CrawlBrowserRoundState | undefined;
  for (let round = 0; round <= maxActions; round++) {
    checkAbort(request.signal);
    let beforeHash: string | undefined;
    if (round > 0) {
      if (pagination.type === 'loadMore') {
        const button = page.locator(pagination.selector).first();
        if ((await button.count()) === 0 || !(await button.isVisible()))
          throw new ZhiYunError(
            'VALIDATION_ERROR',
            'VALIDATION: Browser pagination changed during action replay',
          );
        beforeHash = createHash('sha256')
          .update(await page.content())
          .digest('hex');
        await observeDiagnosticOperation(
          request.onDiagnostic,
          { kind: 'action', target: 'pagination', actionType: 'click' },
          () => button.click(),
          undefined,
          request.signal,
        );
        await page.waitForTimeout(pagination.waitMs);
      } else {
        await observeDiagnosticOperation(
          request.onDiagnostic,
          { kind: 'action', target: 'pagination', actionType: 'scroll' },
          async () => {
            await scrollForNext(page);
            await page.waitForTimeout(pagination.waitMs);
          },
          undefined,
          request.signal,
        );
      }
    }
    checkAbort(request.signal);
    const sourceUrl = page.url();
    const html = await page.content();
    if (Buffer.byteLength(html) > request.requestSettings.maxResponseBytes)
      throw new CrawlerError(`Response exceeds ${request.requestSettings.maxResponseBytes} bytes`);
    const domHash = createHash('sha256').update(html).digest('hex');
    const extracted = await extractForRequest(
      request,
      html,
      rule,
      sourceUrl,
      request.plan.list.source,
      'list',
    );
    appendWarnings(warnings, extracted.warnings);
    const records = extractedRecords(extracted, sourceUrl);
    const checksum = createHash('sha256');
    checksum.update('[');
    const recordHashes = records.map(({ sourceUrl: url, data }, index) => {
      if (index) checksum.update(',');
      checksum.update(canonical({ sourceUrl: url, data }));
      return createHash('sha256').update(canonical(data)).digest('hex');
    });
    checksum.update(']');
    const saved = await cursor.begin({
      requestId,
      round,
      sourceUrl,
      checksum: checksum.digest('hex'),
      recordHashes,
      maxRecords: limit,
    });
    if (saved.status === 'completed') {
      previous = saved.state!;
    } else {
      let after = -1;
      let batchCount = 0;
      for (;;) {
        const positions = await cursor.selected(requestId, round, after);
        if (!positions.length) break;
        const selected = positions.map((position) => {
          const record = records[position];
          if (!record)
            throw new ZhiYunError('VALIDATION_ERROR', 'VALIDATION: Browser selection changed');
          return record;
        });
        batchCount += await sink.acceptPrepared(
          selected,
          requestId,
          round * BROWSER_ROUND_BATCH_STRIDE + batchCount,
        );
        after = positions.at(-1)!;
      }
      const height =
        pagination.type === 'infinite'
          ? await page.evaluate(
              () => document.scrollingElement?.scrollHeight ?? document.body.scrollHeight,
            )
          : 0;
      const stableRounds =
        round > 1 && height === previous?.height && domHash === previous?.domHash
          ? Math.min(2, previous.stableRounds + 1)
          : 0;
      const button =
        pagination.type === 'loadMore' ? page.locator(pagination.selector).first() : undefined;
      const exhausted = button
        ? (await button.count()) === 0 || !(await button.isVisible()) || (await button.isDisabled())
        : stableRounds >= 2;
      const unchanged =
        pagination.type === 'loadMore' &&
        round > 0 &&
        (domHash === beforeHash || domHash === previous?.domHash);
      const full = (await request.checkpoint!.summary()).rawRecordCount >= limit;
      previous = {
        terminal: exhausted || unchanged || full || round === maxActions,
        height,
        domHash,
        stableRounds,
        batchCount,
      };
      await cursor.complete(requestId, round, previous);
      if (saved.availableRecords > saved.reservedRecords)
        warnings.push(`List records were limited to ${limit} before detail requests`);
    }
    await request.onProgress?.({
      phase: 'list',
      progress: previous.terminal ? 0.7 : 0.1 + (0.6 * (round + 1)) / (maxActions + 1),
      url: sourceUrl,
      requestCount: (await request.checkpoint!.summary()).requestCount,
      recordCount: (await request.checkpoint!.summary()).rawRecordCount,
    });
    if (previous.terminal) return;
  }
}

async function crawlBrowser(
  request: CrawlRequest,
  warnings: string[],
  urls: string[],
  control: CrawlControl,
  sink?: StreamRecordSink,
) {
  const records: CrawlRecord[] = [];
  const pagination = paginationFor(request);
  const stageQueue = await openCrawlQueue(request, 'browser', pagination);
  const requestQueue = stageQueue.queue;
  if (!stageQueue.pending) return records;
  const proxyConfiguration = proxy(request.requestSettings);
  const routedPages = new WeakSet<Page>();
  const actionCount = request.browserSettings.actions.length + request.plan.list.actions.length;
  let pages = stageQueue.completedPages;
  let failure: unknown;
  const navigation = navigationDiagnostics(request);
  const maxPages =
    pagination.type === 'next' || pagination.type === 'page' ? pagination.maxPages : 1;
  const crawler = new PlaywrightCrawler(
    {
      requestQueue,
      maxConcurrency: request.requestSettings.concurrency,
      maxRequestRetries: request.requestSettings.retries,
      maxRequestsPerCrawl: Math.min(request.requestSettings.maxRequests, maxPages),
      requestHandlerTimeoutSecs: Math.max(
        1,
        Math.ceil(
          Math.min(
            request.requestSettings.maxRuntimeMs,
            request.requestSettings.timeoutMs * (actionCount + 2),
          ) / 1_000,
        ),
      ),
      ...(proxyConfiguration ? { proxyConfiguration } : {}),
      errorHandler: async ({ request: failedRequest }, error) => {
        await navigation.finish(failedRequest, undefined, error);
        await pause(
          Math.min(request.requestSettings.retryBackoffMs * 2 ** failedRequest.retryCount, 120_000),
          request.signal,
        );
      },
      launchContext: { launchOptions: { headless: true } },
      failedRequestHandler: async ({ request: item }, error) => {
        await navigation.finish(item, undefined, error);
        failure = error;
      },
      preNavigationHooks: [
        async ({ page, request: item }) => {
          navigation.start(item, item.url);
          checkAbort(request.signal);
          await prepareCrawlTarget(item.url, request, control);
          if (!routedPages.has(page)) {
            routedPages.add(page);
            await page.route('**/*', async (route) => {
              try {
                await assertNetworkAllowed(route.request().url(), request.networkPolicy);
                const navigationRequest = route.request();
                if (
                  request.checkpoint &&
                  navigationRequest.isNavigationRequest() &&
                  navigationRequest.frame() === page.mainFrame()
                )
                  await route.continue({
                    headers: {
                      ...navigationRequest.headers(),
                      ...headers(request.requestSettings, navigationRequest.url(), request.url),
                    },
                  });
                else await route.continue();
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
      postNavigationHooks: [
        async ({ request: item, response }) => {
          await navigation.finish(item, response?.status());
        },
      ],
      requestHandler: async ({ page, request: crawleeRequest, enqueueLinks, response }) => {
        checkAbort(request.signal);
        const started = Date.now();
        const rule = request.plan.list.rule;
        await applyBrowserActions(
          page,
          {
            ...request.browserSettings,
            actions: [...request.browserSettings.actions, ...request.plan.list.actions],
          },
          request.onDiagnostic,
          'list',
          request.signal,
          request.actionCache,
          request.requestSettings,
        );
        if (rule.type === 'css')
          await observeDiagnosticOperation(
            request.onDiagnostic,
            { kind: 'selector', target: 'list' },
            () =>
              page
                .locator(rule.container)
                .first()
                .waitFor({ timeout: request.requestSettings.timeoutMs }),
            () => ({ matchedCount: 1 }),
            request.signal,
          );
        const streamedRounds =
          sink && (pagination.type === 'loadMore' || pagination.type === 'infinite');
        if (
          request.onVerificationSource &&
          (pagination.type === 'loadMore' || pagination.type === 'infinite')
        )
          await request.onVerificationSource({
            input: await page.content(),
            url: page.url(),
            target: 'list',
            phase: 'before-pagination',
            session: await browserPageCacheSession(
              page,
              request.requestSettings,
              request.browserSettings,
            ),
          });
        if (streamedRounds)
          await streamBrowserRounds(page, request, crawleeRequest.url, pagination, warnings, sink);
        if (!streamedRounds && pagination.type === 'loadMore') {
          let lastHash = '';
          for (let index = 0; index < pagination.maxClicks; index += 1) {
            checkAbort(request.signal);
            const button = page.locator(pagination.selector).first();
            if (index === 0)
              await request.onVerificationPagination?.({
                url: page.url(),
                type: 'loadMore',
                terminal: (await button.count()) > 0 && (await button.isDisabled()),
              });
            if ((await button.count()) === 0 || !(await button.isVisible())) break;
            if (await button.isDisabled()) break;
            const before = createHash('sha256')
              .update(await page.content())
              .digest('hex');
            await observeDiagnosticOperation(
              request.onDiagnostic,
              { kind: 'action', target: 'pagination', actionType: 'click' },
              () => button.click(),
              undefined,
              request.signal,
            );
            await page.waitForTimeout(pagination.waitMs);
            const after = createHash('sha256')
              .update(await page.content())
              .digest('hex');
            if (after === before || after === lastHash) break;
            lastHash = after;
          }
        }
        if (!streamedRounds && pagination.type === 'infinite') {
          // A fingerprint-selected tall viewport can contain the entire first batch.
          // With no scroll range, scrolling cannot make an intersection sentinel leave
          // and re-enter the viewport. Give this owned page room to scroll first.
          const noScrollRange = await page.evaluate(
            () =>
              (document.scrollingElement?.scrollHeight ?? document.body.scrollHeight) <=
              innerHeight + 1,
          );
          if (noScrollRange && rule.type !== 'json') {
            const last = await page.locator(rule.container).last().boundingBox();
            const viewport =
              page.viewportSize() ??
              (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
            if (last)
              await page.setViewportSize({
                width: viewport.width,
                height: Math.max(
                  1,
                  Math.min(viewport.height - 1, Math.floor(last.y + last.height / 2)),
                ),
              });
          }
          let lastHeight = 0;
          let lastHash = '';
          let stableRounds = 0;
          for (let index = 0; index < pagination.maxScrolls; index += 1) {
            checkAbort(request.signal);
            await observeDiagnosticOperation(
              request.onDiagnostic,
              { kind: 'action', target: 'pagination', actionType: 'scroll' },
              async () => {
                await page.evaluate(async () => {
                  // Let intersection observers see the sentinel leave the viewport.
                  // Scrolling straight to an already visible sentinel can miss a load.
                  // IntersectionObserver still reports an edge-touching sentinel as
                  // intersecting. Move one extra pixel so it fully leaves the viewport.
                  scrollBy({ top: -(innerHeight + 1), behavior: 'instant' });
                  await new Promise<void>((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                  );
                  scrollTo({
                    top: document.scrollingElement?.scrollHeight ?? document.body.scrollHeight,
                    behavior: 'instant',
                  });
                });
                await page.waitForTimeout(pagination.waitMs);
              },
              undefined,
              request.signal,
            );
            const height = await page.evaluate(
              () => document.scrollingElement?.scrollHeight ?? document.body.scrollHeight,
            );
            const hash = createHash('sha256')
              .update(await page.content())
              .digest('hex');
            stableRounds = height === lastHeight && hash === lastHash ? stableRounds + 1 : 0;
            if (stableRounds >= 2) break;
            lastHeight = height;
            lastHash = hash;
          }
        }
        const sourceUrl = page.url();
        const seed = requestSeed(
          crawleeRequest.url,
          'browser',
          (crawleeRequest.userData.checkpointKind ??
            (pages === 0 ? 'list' : 'pagination')) as CrawlRequestSeed['kind'],
        );
        pages += 1;
        urls.push(sourceUrl);
        const html = streamedRounds ? '' : await page.content();
        if (Buffer.byteLength(html) > request.requestSettings.maxResponseBytes) {
          throw new CrawlerError(
            `Response exceeds ${request.requestSettings.maxResponseBytes} bytes`,
          );
        }
        const result = streamedRounds
          ? { records: [], warnings: [] }
          : await extractForRequest(
              request,
              html,
              rule,
              sourceUrl,
              request.plan.list.source,
              'list',
              request.onVerificationSource
                ? await browserPageCacheSession(
                    page,
                    request.requestSettings,
                    request.browserSettings,
                  )
                : undefined,
            );
        appendWarnings(warnings, result.warnings);
        if (!streamedRounds)
          await acceptPageRecords(
            records,
            extractedRecords(result, sourceUrl),
            request,
            crawleeRequest.url,
            sink,
            'browser',
          );
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
          recordCount: sink?.recordCount ?? records.length,
        });
        const nextRequests: CrawlRequestSeed[] = [];
        let nextTerminal = false;
        if (pagination.type === 'next') {
          const controls = page.locator(pagination.selector);
          const count = await controls.count();
          nextTerminal = count > 0 && count <= 32;
          for (let index = 0; nextTerminal && index < count; index++)
            nextTerminal = await controls.nth(index).isDisabled();
          await request.onVerificationPagination?.({
            url: sourceUrl,
            type: 'next',
            terminal: nextTerminal,
          });
        }
        if (
          request.checkpoint &&
          pagination.type === 'next' &&
          !nextTerminal &&
          pages < pagination.maxPages &&
          result.records.length > 0
        ) {
          await enqueueLinks({
            selector: pagination.selector,
            limit: 1,
            transformRequestFunction: (item) => {
              if (!nextRequests.length)
                nextRequests.push(requestSeed(item.url, 'browser', 'pagination'));
              return null;
            },
          });
        }
        await request.checkpoint?.complete(
          seed.id,
          { sourceUrl, browserUsed: true, nextRequests },
          request.requestSettings.maxRequests,
        );
        if (request.checkpoint) {
          for (const next of nextRequests) await stageQueue.enqueue!(next);
        } else if (
          pagination.type === 'next' &&
          !nextTerminal &&
          pages < pagination.maxPages &&
          result.records.length > 0
        ) {
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
    },
    stageQueue.config,
  );
  const abort = () => void crawler.autoscaledPool?.abort();
  request.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, request.requestSettings.maxRuntimeMs);
  try {
    await crawler.run(stageQueue.initial);
    checkAbort(request.signal);
    if (failure) throw failure;
    return records;
  } finally {
    if (request.signal?.aborted)
      await navigation.abort(new ZhiYunError('CANCELED', 'Navigation was canceled'));
    clearTimeout(timer);
    request.signal?.removeEventListener('abort', abort);
    if (!request.checkpoint) await requestQueue.drop();
  }
}

type SitemapDiscovery = NonNullable<CrawlPlanDefinition['discovery']>;

function sitemapModified(record: CrawlRecord, field: string): number {
  const value = Date.parse(String(record.data[field] ?? ''));
  return Number.isFinite(value) ? value : 0;
}

function retainSitemapRecord(
  records: CrawlRecord[],
  record: CrawlRecord,
  limit: number,
  field?: string,
): void {
  if (limit === 0) return;
  if (!field) {
    if (records.length < limit) records.push(record);
    return;
  }
  const modified = sitemapModified(record, field);
  if (records.length === limit) {
    if (modified <= sitemapModified(records.at(-1)!, field)) return;
    records.pop();
  }
  let low = 0,
    high = records.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (sitemapModified(records[middle]!, field) >= modified) low = middle + 1;
    else high = middle;
  }
  records.splice(low, 0, record);
}

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
  while (queue.length > 0 && visited.size < discovery.maxSitemaps && discovered.size < urlLimit) {
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
      const loaded = await observeDiagnosticOperation(
        request.onDiagnostic,
        { kind: 'navigation', target: visited.size === 1 ? 'list' : 'pagination' },
        async () => {
          await prepareCrawlTarget(current.url, request, control);
          const response = await controlledFetch(current.url, request);
          if (!response.ok) throw new NavigationError(`HTTP ${response.status} for ${current.url}`);
          const text = new TextDecoder().decode(
            await body(response, request.requestSettings.maxResponseBytes),
          );
          return { response, text };
        },
        (value) => ({ statusCode: value.response.status }),
        request.signal,
      );
      const { response, text } = loaded;
      const loadedUrl = response.url || current.url;
      urls.push(loadedUrl);
      let parsedEntries = 0;
      const previousRecords = discovered.size;
      await observeDiagnosticOperation(
        request.onDiagnostic,
        { kind: 'extraction', target: 'list' },
        async () => {
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
              discovered.size >= urlLimit ||
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
            retainSitemapRecord(
              records,
              {
                sourceUrl: target,
                data,
                ...(request.previewLimit || request.onVerificationSource || request.onDiagnostic
                  ? {
                      inspection: {
                        containerHint: 'content' as const,
                        fields: Object.fromEntries(
                          [
                            discovery.urlField,
                            ...(discovery.lastModifiedField ? [discovery.lastModifiedField] : []),
                          ].map((field) => [
                            field,
                            {
                              status:
                                data[field] == null ? ('missing' as const) : ('valid' as const),
                              matches: data[field] == null ? 0 : 1,
                            },
                          ]),
                        ),
                      },
                    }
                  : {}),
              },
              recordLimit,
              discovery.lastModifiedField,
            );
          }
        },
        () => ({ recordCount: discovered.size - previousRecords }),
        request.signal,
      );
      if (parsedEntries === 0) warnings.push(`Sitemap contained no entries: ${loadedUrl}`);
      await request.onVerificationSource?.({
        input: text,
        url: loadedUrl,
        target: 'discovery',
        phase: 'extraction',
        discovery: { parsedEntries, acceptedUrls: discovered.size - previousRecords },
      });
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

async function crawlSitemapStreaming(
  request: CrawlRequest,
  warnings: string[],
  urls: string[],
  control: CrawlControl,
): Promise<void> {
  const discovery = request.plan.discovery!;
  const spool = request.sitemapSpool!;
  const checkpoint = request.checkpoint!;
  const rootOrigin = new URL(request.url).origin;
  const root = requestSeed(request.url, 'api', 'list');
  await spool.root({ id: root.id, url: root.url, depth: 0 }, discovery.maxSitemaps);
  const prior = new Map<string, 'pending' | 'completed'>();
  for await (const state of checkpointRequests(checkpoint, 'api'))
    prior.set(state.id, state.status);
  let after = 0;
  let stopped = false;
  while (!stopped) {
    const nodes = await spool.nodes(after);
    if (!nodes.length) break;
    for (const node of nodes) {
      checkAbort(request.signal);
      after = node.ordinal;
      if (prior.get(node.id) === 'completed') continue;
      // Resume an already-started page even when a committed prefix reached maxUrls.
      if ((await spool.summary()).entryCount >= discovery.maxUrls && !prior.has(node.id)) {
        stopped = true;
        break;
      }
      const seed = requestSeed(node.url, 'api', node.depth === 0 ? 'list' : 'pagination');
      const state = await checkpoint.ensure(seed, request.requestSettings.maxRequests);
      if (!state) {
        warnings.push('Sitemap discovery stopped because maxRequests was reached');
        stopped = true;
        break;
      }
      await checkpoint.reserveRecords(seed.id, 0, request.plan.limits.maxRecords);
      const started = Date.now();
      let sequence = 0;
      let batch: CrawlSitemapBatch = { requestId: seed.id, sequence, entries: [], nodes: [] };
      let bytes = 0;
      const flush = async () => {
        if (!batch.entries.length && !batch.nodes.length) return;
        await spool.append(batch, discovery.maxSitemaps, discovery.maxUrls);
        sequence++;
        batch = { requestId: seed.id, sequence, entries: [], nodes: [] };
        bytes = 0;
      };
      try {
        const loaded = await observeDiagnosticOperation(
          request.onDiagnostic,
          { kind: 'navigation', target: node.depth === 0 ? 'list' : 'pagination' },
          async () => {
            await prepareCrawlTarget(node.url, request, control);
            const response = await controlledFetch(node.url, request);
            if (!response.ok) throw new NavigationError(`HTTP ${response.status} for ${node.url}`);
            const text = new TextDecoder().decode(
              await body(response, request.requestSettings.maxResponseBytes),
            );
            return { response, text };
          },
          (value) => ({ statusCode: value.response.status }),
          request.signal,
        );
        const sourceUrl = loaded.response.url || node.url;
        urls.push(sourceUrl);
        let parsedEntries = 0;
        const before = (await spool.summary()).entryCount;
        await observeDiagnosticOperation(
          request.onDiagnostic,
          { kind: 'extraction', target: 'list' },
          async () => {
            for await (const item of parseSitemap(
              [{ type: 'raw', content: loaded.text }],
              undefined,
              {
                emitNestedSitemaps: true,
                maxDepth: 0,
                reportNetworkErrors: false,
                enqueueStrategy: 'all',
              },
            )) {
              checkAbort(request.signal);
              parsedEntries++;
              const target = new URL(item.loc, sourceUrl).toString();
              if (discovery.sameOrigin && new URL(target).origin !== rootOrigin) continue;
              const child = item.originSitemapUrl === null;
              if (child ? node.depth >= discovery.maxDepth : !sitemapUrlIncluded(target, discovery))
                continue;
              const value = child
                ? {
                    id: requestSeed(target, 'api', 'pagination').id,
                    url: target,
                    depth: node.depth + 1,
                  }
                : { url: target, lastModified: item.lastmod?.toISOString() ?? null };
              const size = Buffer.byteLength(JSON.stringify(value));
              if (batch.entries.length + batch.nodes.length && bytes + size > 1024 * 1024)
                await flush();
              if (child) batch.nodes.push(value as CrawlSitemapBatch['nodes'][number]);
              else batch.entries.push(value as CrawlSitemapBatch['entries'][number]);
              bytes += size;
              if (batch.entries.length + batch.nodes.length === 250) await flush();
            }
            await flush();
            return (await spool.summary()).entryCount - before;
          },
          (recordCount) => ({ recordCount }),
          request.signal,
        );
        if (!parsedEntries) warnings.push(`Sitemap contained no entries: ${sourceUrl}`);
        await logRequest(request, {
          url: sourceUrl,
          kind: node.depth === 0 ? 'list' : 'pagination',
          status: 'succeeded',
          statusCode: loaded.response.status,
          durationMs: Date.now() - started,
          errorCode: null,
          error: null,
        });
        await checkpoint.complete(
          seed.id,
          { sourceUrl, browserUsed: false, nextRequests: [], discoveryBatchCount: sequence },
          request.requestSettings.maxRequests,
        );
        prior.set(seed.id, 'completed');
        const summary = await checkpoint.summary();
        await request.onProgress?.({
          phase: 'discovery',
          progress: Math.min(0.65, summary.requestCount / discovery.maxSitemaps),
          url: sourceUrl,
          requestCount: summary.requestCount,
          recordCount: (await spool.summary()).entryCount,
        });
      } catch (error) {
        await logRequest(request, {
          url: node.url,
          kind: node.depth === 0 ? 'list' : 'pagination',
          status: 'failed',
          statusCode: null,
          durationMs: Date.now() - started,
          errorCode: error instanceof ZhiYunError ? error.code : 'NAVIGATION_ERROR',
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }
  }
  const summary = await checkpoint.summary();
  const discoveryState = await spool.summary();
  if (discoveryState.sitemapsTruncated && summary.requestCount >= discovery.maxSitemaps)
    warnings.push('Sitemap discovery stopped because maxSitemaps was reached');
}

async function loadDetail(url: string, request: CrawlRequest, control: CrawlControl) {
  const detail = request.plan.detail!;
  const useBrowser =
    detail.mode === 'browser' ||
    (detail.mode === 'auto' && (request.browserSettings.enabled || detail.actions.length > 0));
  if (useBrowser) {
    await observeDiagnosticOperation(
      request.onDiagnostic,
      { kind: 'navigation', target: 'detail' },
      () => prepareCrawlTarget(url, request, control),
      undefined,
      request.signal,
    );
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
      ...(request.onDiagnostic ? { onDiagnostic: request.onDiagnostic } : {}),
      diagnosticTarget: 'detail',
      ...(request.actionCache ? { actionCache: request.actionCache } : {}),
      ...(request.onVerificationSource ? { collectCacheSession: true } : {}),
    });
    const extracted = await extractForRequest(
      request,
      loaded.html,
      detail.rule,
      loaded.url,
      detail.source,
      'detail',
      loaded.cacheSession,
    );
    return {
      data: extracted.records[0] ?? {},
      inspection: extracted.inspections?.[0],
      recordMatches: extracted.records.length,
      browserUsed: true,
    };
  }
  const loaded = await observeDiagnosticOperation(
    request.onDiagnostic,
    { kind: 'navigation', target: 'detail' },
    async () => {
      await prepareCrawlTarget(url, request, control);
      const response = await controlledFetch(url, request);
      if (!response.ok) throw new NavigationError(`HTTP ${response.status} for ${url}`);
      const bytes = await body(response, request.requestSettings.maxResponseBytes);
      return { response, text: new TextDecoder().decode(bytes) };
    },
    (value) => ({ statusCode: value.response.status }),
    request.signal,
  );
  const { response, text } = loaded;
  const source =
    !detail.source && (response.headers.get('content-type') ?? '').includes('json')
      ? (JSON.parse(text) as unknown)
      : text;
  const extracted = await extractForRequest(
    request,
    source,
    detail.rule,
    response.url || url,
    detail.source,
    'detail',
  );
  return {
    data: extracted.records[0] ?? {},
    inspection: extracted.inspections?.[0],
    recordMatches: extracted.records.length,
    browserUsed: false,
  };
}

type CachedDetail = CrawlDetailData & { fetched: boolean };
class DetailCacheError extends Error {}
class CachedDetailFailure extends Error {
  constructor(readonly code: DiagnosticErrorCode) {
    super('Detail request previously failed');
  }
}

async function completeDetailCheckpoint(
  request: CrawlRequest,
  seed: CrawlRequestSeed,
  loaded: CrawlDetailData,
) {
  await request.checkpoint
    ?.complete(
      seed.id,
      { sourceUrl: seed.url, browserUsed: loaded.browserUsed, nextRequests: [] },
      request.requestSettings.maxRequests,
    )
    .catch((error) => {
      throw new DetailCacheError('Detail checkpoint commit failed', { cause: error });
    });
}

async function enrichDetails(
  records: CrawlRecord[],
  request: CrawlRequest,
  warnings: string[],
  urls: string[],
  control: CrawlControl,
  cache = new Map<string, Promise<CachedDetail | null>>(),
) {
  const detail = request.plan.detail;
  if (!detail) return { records, browserUsed: false };
  const result: Array<CrawlRecord | null> = Array.from({ length: records.length }, () => null);
  let browserUsed = false;
  let nextIndex = 0;
  let completed = 0;
  const worker = async () => {
    while (nextIndex < records.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = records[index]!;
      const linkMatches = item.inspection?.fields[detail.urlField]?.matches ?? 0;
      const relation = (
        status: NonNullable<NonNullable<CrawlRecord['inspection']>['detail']>['status'],
        recordMatches: number | null = null,
      ) => {
        if (item.inspection)
          item.inspection = {
            ...item.inspection,
            fields: {
              ...Object.fromEntries(
                Object.keys(detail.rule.fields).map((name) => [
                  name,
                  { status: 'missing' as const, matches: 0 },
                ]),
              ),
              ...item.inspection.fields,
            },
            detail: { urlField: detail.urlField, linkMatches, recordMatches, status },
          };
      };
      checkAbort(request.signal);
      const raw = item.data[detail.urlField];
      if (typeof raw !== 'string' || raw.length === 0) {
        relation('missing_link');
        warnings.push(`Detail URL field ${detail.urlField} is empty`);
        if (detail.onError !== 'skip') result[index] = item;
        completed += 1;
        continue;
      }
      const url = new URL(raw, item.sourceUrl).toString();
      const isNew = !cache.has(url);
      if (isNew) {
        cache.set(
          url,
          (async () => {
            const seed = requestSeed(url, 'detail', 'detail');
            const state = request.checkpoint
              ? await request.checkpoint
                  .ensure(seed, request.requestSettings.maxRequests)
                  .catch((error) => {
                    throw new DetailCacheError('Detail checkpoint is unavailable', {
                      cause: error,
                    });
                  })
              : undefined;
            if (request.checkpoint && !state) return null;
            const key = createHash('sha256').update(url).digest('hex');
            if (request.detailCache) {
              const stored = await request.detailCache.get(key).catch((error) => {
                throw new DetailCacheError('Detail cache read failed', { cause: error });
              });
              if (stored) {
                await completeDetailCheckpoint(request, seed, stored);
                return { ...stored, fetched: false };
              }
              if (state?.status === 'completed')
                throw new DetailCacheError('VALIDATION: Completed detail Artifact is unavailable');
            }
            if (!request.checkpoint && urls.length >= request.requestSettings.maxRequests)
              return null;
            urls.push(url);
            let loaded: CrawlDetailData;
            try {
              loaded = await loadDetail(url, request, control);
            } catch (error) {
              checkAbort(request.signal);
              if (detail.onError === 'fail-run' || !request.detailCache) throw error;
              loaded = {
                data: {},
                recordMatches: 0,
                browserUsed: false,
                failureCode: classifyDiagnosticError(error, request.signal),
              };
            }
            if (request.detailCache)
              await request.detailCache.put(key, loaded).catch((error) => {
                throw new DetailCacheError('Detail cache write failed', { cause: error });
              });
            await completeDetailCheckpoint(request, seed, loaded);
            return { ...loaded, fetched: true };
          })(),
        );
        if (request.onBatch && cache.size > 500) cache.delete(cache.keys().next().value!);
      }
      const started = Date.now();
      try {
        const loaded = await cache.get(url)!;
        if (!loaded) {
          relation('budget');
          warnings.push('Detail request skipped because maxRequests was reached');
          if (detail.onError !== 'skip') result[index] = item;
          completed += 1;
          continue;
        }
        if (loaded.failureCode) throw new CachedDetailFailure(loaded.failureCode);
        relation(
          linkMatches > 1
            ? 'ambiguous_link'
            : loaded.recordMatches > 1
              ? 'ambiguous_record'
              : loaded.recordMatches === 0
                ? 'empty_detail'
                : 'resolved',
          loaded.recordMatches,
        );
        browserUsed ||= loaded.browserUsed;
        if (isNew && loaded.fetched) {
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
          ...(item.inspection
            ? {
                inspection: {
                  ...item.inspection,
                  fields:
                    detail.mergeStrategy === 'detailWins'
                      ? { ...item.inspection.fields, ...loaded.inspection?.fields }
                      : { ...loaded.inspection?.fields, ...item.inspection.fields },
                },
              }
            : {}),
        };
      } catch (error) {
        if (error instanceof DetailCacheError) throw error;
        relation('failed');
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
    validateCrawlPlan(request.plan);
    if (request.previewLimit) {
      const clamp = (pagination: CrawlRequest['pagination']) => {
        if (!pagination) return pagination;
        if (pagination.type === 'next' || pagination.type === 'page')
          return { ...pagination, maxPages: Math.min(2, pagination.maxPages) };
        if (pagination.type === 'loadMore') return { ...pagination, maxClicks: 1 };
        if (pagination.type === 'infinite') return { ...pagination, maxScrolls: 1 };
        return pagination;
      };
      request = {
        ...request,
        previewLimit: Math.min(10, request.previewLimit),
        requestSettings: {
          ...request.requestSettings,
          maxRequests: Math.min(12, request.requestSettings.maxRequests),
          maxRuntimeMs: Math.min(30_000, request.requestSettings.maxRuntimeMs),
        },
        ...(request.pagination ? { pagination: clamp(request.pagination)! } : {}),
        plan: { ...request.plan, pagination: clamp(request.plan.pagination)! },
      };
    }

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
    const actionCache: BrowserActionCacheSummary = {
      stages: 0,
      hitStages: 0,
      storedStages: 0,
      bypassedStages: 0,
      providerCalls: 0,
      reasons: {},
    };
    if (request.actionCache) {
      const original = request.actionCache;
      request = {
        ...request,
        actionCache: {
          ...original,
          configuration: {
            context: original.configuration,
            plan: request.plan,
            pagination: request.pagination,
            network: request.networkPolicy,
          },
          async onResult(result) {
            actionCache.stages++;
            if (result.status === 'hit') actionCache.hitStages++;
            if (result.status === 'stored') actionCache.storedStages++;
            if (result.status === 'bypassed') actionCache.bypassedStages++;
            actionCache.providerCalls += result.providerCalls;
            actionCache.reasons[result.reason] = (actionCache.reasons[result.reason] ?? 0) + 1;
            await original.onResult?.(result);
          },
        },
      };
    }
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
    const warnings = createWarningBuffer();
    const urls: string[] = [];
    const rule = request.plan.list.rule;
    const recordLimit = Math.min(
      request.plan.limits.maxRecords,
      request.previewLimit ?? request.plan.limits.maxRecords,
    );
    const control = createCrawlControl(request.requestSettings);
    let sink: StreamRecordSink | undefined;
    const listViaBrowser = request.plan.discovery
      ? false
      : request.mode === 'browser' ||
        request.plan.list.mode === 'browser' ||
        request.browserSettings.enabled ||
        request.browserSettings.actions.length > 0 ||
        request.plan.list.actions.length > 0 ||
        ['loadMore', 'infinite'].includes(paginationFor(request).type);
    let browserUsed = listViaBrowser;
    try {
      const restored = await request.checkpoint?.summary();
      if (request.checkpoint) {
        browserUsed = restored!.browserUsed;
        for await (const state of checkpointRequests(request.checkpoint))
          if (state.status === 'completed') urls.push(state.sourceUrl ?? state.url);
      }
      sink =
        request.onBatch && !request.previewLimit
          ? new StreamRecordSink(
              request,
              warnings,
              urls,
              control,
              recordLimit,
              restored?.rawRecordCount,
            )
          : undefined;
      if (
        request.checkpoint &&
        (!sink ||
          !request.listSpool ||
          (request.plan.discovery && !request.sitemapSpool) ||
          (request.plan.detail && !request.detailCache))
      )
        throw new ZhiYunError(
          'VALIDATION_ERROR',
          'VALIDATION: URL checkpoints require a streaming list spool',
        );
      if (
        sink &&
        ['loadMore', 'infinite'].includes(paginationFor(request).type) &&
        (!request.browserPagination || !request.checkpoint || !request.listSpool)
      )
        throw new ZhiYunError(
          'VALIDATION_ERROR',
          'VALIDATION: Streaming browser pagination requires durable round checkpoints',
        );
      if (sink && request.plan.detail && !request.listSpool)
        throw new ZhiYunError(
          'VALIDATION_ERROR',
          'VALIDATION: Streaming detail extraction requires a durable list spool',
        );
      if (sink && request.plan.discovery && (!request.sitemapSpool || !request.checkpoint))
        throw new ZhiYunError(
          'VALIDATION_ERROR',
          'VALIDATION: Streaming sitemap discovery requires a durable spool and checkpoints',
        );
      try {
        await assertNetworkAllowed(request.url, request.networkPolicy);
      } catch (error) {
        await emitDiagnosticStep(request.onDiagnostic, {
          kind: 'navigation',
          target: 'list',
          status: 'failed',
          startedAt: new Date().toISOString(),
          durationMs: 0,
          errorCode: classifyDiagnosticError(error, request.signal),
        });
        throw error;
      }
      await request.onProgress?.({ phase: 'preflight', progress: 0 });
      const directJson = rule.type === 'json' && !request.plan.list.source;
      let records = request.plan.discovery
        ? sink
          ? (await crawlSitemapStreaming(request, warnings, urls, control), [])
          : await crawlSitemap(request, warnings, urls, control, recordLimit)
        : directJson
          ? await crawlJson(request, warnings, urls, control, sink)
          : listViaBrowser
            ? await crawlBrowser(request, warnings, urls, control, sink)
            : await crawlHttp(request, warnings, urls, control, sink);
      if (
        records.length === 0 &&
        (!sink || sink.listRecordCount === 0) &&
        !directJson &&
        !request.plan.discovery &&
        !listViaBrowser &&
        request.plan.list.mode === 'auto'
      ) {
        warnings.push('HTTP extraction returned no records; falling back to browser');
        records = await crawlBrowser(request, warnings, urls, control, sink);
        if (!request.checkpoint) browserUsed = true;
      }
      if (sink) {
        if (request.plan.discovery) await sink.finishSitemap();
        else await sink.finish();
        browserUsed ||= sink.browserUsed;
        records = [];
      } else {
        if (records.length > recordLimit) {
          warnings.push(`List records were limited to ${recordLimit} before detail requests`);
          records = records.slice(0, recordLimit);
        }
        const details = await enrichDetails(records, request, warnings, urls, control);
        browserUsed ||= details.browserUsed;
        records = dedupe(details.records, request.plan).slice(0, request.plan.limits.maxRecords);
        if (request.previewLimit) records = records.slice(0, request.previewLimit);
      }
      const summary = await request.checkpoint?.summary();
      if (request.checkpoint) {
        browserUsed = summary!.browserUsed;
        urls.length = 0;
        for await (const state of checkpointRequests(request.checkpoint))
          urls.push(state.sourceUrl ?? state.url);
      }
      const requestCount = summary?.requestCount ?? urls.length;
      await request.onProgress?.({
        phase: 'persisting',
        progress: 0.98,
        requestCount,
        recordCount: sink?.recordCount ?? records.length,
      });
      return {
        records,
        metadata: {
          durationMs: Date.now() - started,
          requestCount,
          recordCount: sink?.recordCount ?? records.length,
          browserUsed,
          aiUsed: actionCache.providerCalls > 0,
          ...(actionCache.stages ? { actionCache } : {}),
          warnings,
          warningTotal: warningTotal(warnings),
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
      await sink?.drain();
      clearTimeout(deadlineTimer);
    }
  }
}
