import { chromium, errors, type Browser, type BrowserContext, type Page } from 'playwright';
import { localBrowser, Stagehand } from '@browserbasehq/stagehand';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BrowserSettings,
  RequestSettings,
  DiagnosticObserver,
  DiagnosticStep,
  BrowserActionCacheContext,
  AnalysisResult,
} from '@zhiyun/shared';
import {
  CrawlerError,
  NavigationError,
  ZhiYunError,
  observeDiagnosticOperation,
} from '@zhiyun/shared';
import { executeBrowserAction, type BrowserActionExecutor } from './action-execution.js';
import { performStagehandAction } from './stagehand-native.js';
import { VerifiedBrowserActionCache, browserPageCacheSession } from './action-cache.js';
export {
  VerifiedBrowserActionCache,
  ACTION_CACHE_VERSIONS,
  actionCacheDigest,
  browserPageCacheSession,
} from './action-cache.js';

export interface BrowserLoadOptions {
  browser: BrowserSettings;
  request: RequestSettings;
  signal?: AbortSignal;
  allowRequest?: (url: string) => Promise<void>;
  onDiagnostic?: DiagnosticObserver;
  diagnosticTarget?: DiagnosticStep['target'];
  /** Optional, bounded readiness probe for preview heuristics; a missing match is not a failed action. */
  previewReadiness?: { selector: string; timeoutMs: number };
  actionCache?: BrowserActionCacheContext;
  /** Transient privacy inputs for complete rule validation; never serialized in crawl metadata. */
  collectCacheSession?: boolean;
}

export interface BrowserPageResult {
  url: string;
  html: string;
  durationMs: number;
  apiCandidates: Array<{ url: string; method: string; contentType: string; sample: string }>;
  actionCache?: NonNullable<AnalysisResult['cache']>;
  /** Internal transient inputs for rule-cache privacy checks, never a public response field. */
  cacheSession?: { fingerprint?: string; privateValues: string[] };
}

export interface BrowserAdapter {
  load(url: string, options: BrowserLoadOptions): Promise<BrowserPageResult>;
}

export async function applyBrowserActions(
  page: Page,
  settings: BrowserSettings,
  onDiagnostic?: DiagnosticObserver,
  target: DiagnosticStep['target'] = 'list',
  signal?: AbortSignal,
  cacheContext?: BrowserActionCacheContext,
  request?: RequestSettings,
  perform?: BrowserActionExecutor,
): Promise<NonNullable<AnalysisResult['cache']> | undefined> {
  if (cacheContext && request && settings.actions.length)
    return new VerifiedBrowserActionCache().execute(
      page,
      settings,
      request,
      cacheContext,
      target,
      onDiagnostic,
      signal,
      perform,
    );
  for (const action of settings.actions) {
    await observeDiagnosticOperation(
      onDiagnostic,
      { kind: 'action', target, actionType: action.type },
      async () => {
        await executeBrowserAction(page, action, request?.timeoutMs ?? 30_000, signal, perform);
      },
      undefined,
      signal,
    );
  }
}

async function restoreSession(context: BrowserContext, url: string, options: BrowserLoadOptions) {
  const cookies = options.request.cookies.map((cookie) => {
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
  });
  if (cookies.length > 0) await context.addCookies(cookies);
  const state = options.browser.storageState;
  const stateCookies = Array.isArray(state?.cookies) ? state.cookies.filter(isBrowserCookie) : [];
  if (stateCookies.length > 0) {
    await context.addCookies(stateCookies);
  }
}

type BrowserCookie = Parameters<BrowserContext['addCookies']>[0][number];

function isBrowserCookie(value: unknown): value is BrowserCookie {
  if (typeof value !== 'object' || value === null) return false;
  const cookie = value as Record<string, unknown>;
  return (
    typeof cookie.name === 'string' &&
    typeof cookie.value === 'string' &&
    (typeof cookie.url === 'string' || typeof cookie.domain === 'string')
  );
}

async function restoreOriginState(page: Page, state: BrowserSettings['storageState']) {
  if (!Array.isArray(state?.origins)) return;
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
    for (const entry of current?.localStorage ?? []) {
      window.localStorage.setItem(entry.name, entry.value);
    }
  }, state.origins);
}

const sensitiveHeader = (name: string) =>
  ['authorization', 'cookie', 'proxy-authorization'].includes(name.toLowerCase());

export function classifyBrowserFailure(error: unknown): ZhiYunError {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /executable.*(?:doesn['’]t exist|not found)|browser.*not installed|playwright install/gi.test(
      message,
    )
  ) {
    return new ZhiYunError('BROWSER_MISSING', 'Bundled Chromium is missing or unavailable', error);
  }
  if (
    /target .*closed|browser.*closed|browser.*crash|page.*closed|connection closed/gi.test(message)
  ) {
    return new ZhiYunError('BROWSER_CRASHED', 'Chromium closed unexpectedly', error);
  }
  return new NavigationError('Browser navigation failed', error);
}

export class PlaywrightAdapter implements BrowserAdapter {
  async load(url: string, options: BrowserLoadOptions): Promise<BrowserPageResult> {
    const started = Date.now();
    const launchOptions = options.request.proxy
      ? {
          headless: true,
          proxy: {
            server: options.request.proxy.url,
            ...(options.request.proxy.username ? { username: options.request.proxy.username } : {}),
            ...(options.request.proxy.password ? { password: options.request.proxy.password } : {}),
          },
        }
      : { headless: true };
    let browser: Browser;
    try {
      browser = await chromium.launch(launchOptions);
    } catch (error) {
      throw classifyBrowserFailure(error);
    }
    const abort = () => void browser.close();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      if (options.signal?.aborted) throw new ZhiYunError('CANCELED', 'Browser load was canceled');
      const publicHeaders = Object.fromEntries(
        Object.entries(options.request.headers).filter(([name]) => !sensitiveHeader(name)),
      );
      const sensitiveHeaders = Object.fromEntries(
        Object.entries(options.request.headers).filter(([name]) => sensitiveHeader(name)),
      );
      const context = await browser.newContext({ extraHTTPHeaders: publicHeaders });
      await restoreSession(context, url, options);
      const page = await context.newPage();
      await page.route('**/*', async (route) => {
        try {
          await options.allowRequest?.(route.request().url());
          const sameOrigin = new URL(route.request().url()).origin === new URL(url).origin;
          await route.continue({
            headers: sameOrigin
              ? { ...route.request().headers(), ...sensitiveHeaders }
              : route.request().headers(),
          });
        } catch {
          await route.abort('blockedbyclient');
        }
      });
      const apiCandidates: BrowserPageResult['apiCandidates'] = [];
      page.on('response', (response) => {
        const resourceType = response.request().resourceType();
        const contentType = response.headers()['content-type'] ?? '';
        if (
          apiCandidates.length < 10 &&
          ['xhr', 'fetch'].includes(resourceType) &&
          contentType.includes('json')
        ) {
          void response
            .text()
            .then((sample) =>
              apiCandidates.push({
                url: response.url(),
                method: response.request().method(),
                contentType,
                sample: sample.slice(0, 20_000),
              }),
            )
            .catch(() => undefined);
        }
      });
      await restoreOriginState(page, options.browser.storageState);
      await observeDiagnosticOperation(
        options.onDiagnostic,
        { kind: 'navigation', target: options.diagnosticTarget ?? 'list' },
        () =>
          page.goto(url, {
            waitUntil: options.browser.waitUntil,
            timeout: options.request.timeoutMs,
          }),
        (response) => (response ? { statusCode: response.status() } : {}),
        options.signal,
      );
      const actionCache = await applyBrowserActions(
        page,
        options.browser,
        options.onDiagnostic,
        options.diagnosticTarget ?? 'list',
        options.signal,
        options.actionCache,
        options.request,
      );
      if (options.previewReadiness) {
        options.signal?.throwIfAborted();
        try {
          await page
            .locator(options.previewReadiness.selector)
            .first()
            .waitFor({
              state: 'attached',
              timeout: Math.max(
                1,
                Math.min(options.previewReadiness.timeoutMs, options.request.timeoutMs),
              ),
            });
        } catch (error) {
          options.signal?.throwIfAborted();
          if (!(error instanceof errors.TimeoutError)) throw error;
        }
      }
      await page.waitForTimeout(100);
      const html = await page.content();
      if (Buffer.byteLength(html, 'utf8') > options.request.maxResponseBytes) {
        throw new CrawlerError(
          `Browser response exceeded ${options.request.maxResponseBytes} bytes`,
        );
      }
      return {
        url: page.url(),
        html,
        durationMs: Date.now() - started,
        apiCandidates,
        ...(actionCache ? { actionCache } : {}),
        ...(options.actionCache || options.collectCacheSession
          ? { cacheSession: await browserPageCacheSession(page, options.request, options.browser) }
          : {}),
      };
    } catch (error) {
      if (options.signal?.aborted) throw new ZhiYunError('CANCELED', 'Browser load was canceled');
      if (error instanceof ZhiYunError) throw error;
      const classified = classifyBrowserFailure(error);
      if (classified.code !== 'NAVIGATION_ERROR') throw classified;
      throw new NavigationError(`Browser navigation failed for ${url}`, error);
    } finally {
      options.signal?.removeEventListener('abort', abort);
      await browser.close();
    }
  }
}

export interface StagehandConfig {
  enabled: boolean;
  /** @deprecated Model selection comes from the explicitly authorized action repair context. */
  model?: string;
  /** @deprecated Native Stagehand execution does not require or forward a model key. */
  apiKey?: string;
  executablePath?: string;
  selfHeal?: boolean;
}

export class StagehandAdapter implements BrowserAdapter {
  constructor(private readonly config: StagehandConfig) {}

  async load(url: string, options: BrowserLoadOptions): Promise<BrowserPageResult> {
    if (!this.config.enabled) throw new NavigationError('Stagehand is optional and is not enabled');
    options.signal?.throwIfAborted();
    await options.allowRequest?.(url);
    const started = Date.now();
    const target = new URL(url);
    let browser: Awaited<ReturnType<typeof localBrowser.launch>> | undefined;
    let stagehand: Stagehand | undefined;
    let bridge: Browser | undefined;
    let profile: string | undefined;
    const abort = () => {
      void browser?.close().catch(() => undefined);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      profile = await mkdtemp(join(tmpdir(), 'zhiyun-stagehand-'));
      browser = await localBrowser.launch({
        headless: true,
        executablePath: this.config.executablePath ?? chromium.executablePath(),
        userDataDir: profile,
        ...(options.request.proxy
          ? {
              proxy: {
                server: options.request.proxy.url,
                ...(options.request.proxy.username
                  ? { username: options.request.proxy.username }
                  : {}),
                ...(options.request.proxy.password
                  ? { password: options.request.proxy.password }
                  : {}),
              },
            }
          : {}),
      });
      options.signal?.throwIfAborted();
      stagehand = await Stagehand.create({
        browser,
        // Native execution never receives an implicit model authorization or an API key.
        // Repair is possible only through the explicitly scoped action-cache callback below.
        model: {
          generate: async () => {
            throw new Error(
              'Automatic Stagehand inference is disabled; use the bounded action repair context',
            );
          },
        },
        selfHeal: false,
        cache: false,
        logging: { level: 'off', format: 'json' },
      });
      options.signal?.throwIfAborted();
      const endpoint = stagehand.rpcClient?.browserWebSocketDebuggerUrl;
      if (!endpoint) throw new NavigationError('Stagehand local browser connection is unavailable');
      bridge = await chromium.connectOverCDP(endpoint, { timeout: options.request.timeoutMs });
      const nativeContext = browser.context;
      await nativeContext.setDomainPolicy({ allowedDomains: [target.hostname] });
      const nativePages = await nativeContext.pages();
      const nativePage = nativePages[0] ?? (await nativeContext.newPage());
      // Bind observation to the exact native tab before navigation; do not assume tab order.
      const originalName = await nativePage.evaluate(() => window.name);
      const marker = `zhiyun-stagehand-${randomUUID()}`;
      await nativePage.evaluate((name) => {
        window.name = name;
      }, marker);
      let page: Page | undefined;
      try {
        for (const candidate of bridge.contexts().flatMap((context) => context.pages()))
          if ((await candidate.evaluate(() => window.name).catch(() => undefined)) === marker) {
            page = candidate;
            break;
          }
      } finally {
        await nativePage.evaluate((name) => {
          window.name = name;
        }, originalName);
      }
      if (!page)
        throw new NavigationError('Stagehand native tab could not be bound for state validation');
      const context = page.context();
      const publicHeaders = Object.fromEntries(
        Object.entries(options.request.headers).filter(([name]) => !sensitiveHeader(name)),
      );
      const sensitiveHeaders = Object.fromEntries(
        Object.entries(options.request.headers).filter(([name]) => sensitiveHeader(name)),
      );
      const responsePolicies = new WeakMap<Page, Promise<void>>();
      const guardRedirects = (boundPage: Page) => {
        const existing = responsePolicies.get(boundPage);
        if (existing) return existing;
        const ready = (async () => {
          const session = await context.newCDPSession(boundPage);
          session.on('Fetch.requestPaused', (event) => {
            void (async () => {
              try {
                const location = event.responseHeaders?.find(
                  (header) => header.name.toLowerCase() === 'location',
                )?.value;
                if (
                  location &&
                  event.responseStatusCode &&
                  event.responseStatusCode >= 300 &&
                  event.responseStatusCode < 400
                ) {
                  const next = new URL(location, event.request.url);
                  if (next.origin !== target.origin)
                    throw new Error('Stagehand redirect leaves its configured origin');
                  await options.allowRequest?.(next.href);
                }
                await session.send('Fetch.continueResponse', { requestId: event.requestId });
              } catch {
                await session
                  .send('Fetch.failRequest', {
                    requestId: event.requestId,
                    errorReason: 'BlockedByClient',
                  })
                  .catch(() => undefined);
              }
            })();
          });
          await session.send('Fetch.enable', {
            patterns: [{ urlPattern: '*', requestStage: 'Response' }],
          });
        })();
        responsePolicies.set(boundPage, ready);
        return ready;
      };
      await guardRedirects(page);
      await context.setExtraHTTPHeaders(publicHeaders);
      await context.route('**/*', async (route) => {
        try {
          await guardRedirects(route.request().frame().page());
          const requestUrl = route.request().url();
          if (new URL(requestUrl).origin !== target.origin)
            throw new Error('Stagehand request leaves its configured origin');
          await options.allowRequest?.(requestUrl);
          await route.continue({ headers: { ...route.request().headers(), ...sensitiveHeaders } });
        } catch {
          await route.abort('blockedbyclient').catch(() => undefined);
        }
      });
      await restoreSession(context, url, options);
      await restoreOriginState(page, options.browser.storageState);
      await observeDiagnosticOperation(
        options.onDiagnostic,
        { kind: 'navigation', target: options.diagnosticTarget ?? 'list' },
        async () => {
          const response = await nativePage.goto(url, {
            waitUntil: options.browser.waitUntil,
            timeout: options.request.timeoutMs,
          });
          if (new URL(await nativePage.url()).origin !== target.origin)
            throw new NavigationError('Stagehand navigation was blocked by the request policy');
          return response;
        },
        (response) => (response ? { statusCode: response.status() } : {}),
        options.signal,
      );
      const suppliedCache = options.actionCache;
      const actionContext = suppliedCache
        ? (() => {
            const { repair, ...context } = suppliedCache;
            return {
              ...context,
              configuration: {
                context: context.configuration,
                adapter: {
                  version: 'stagehand-4.0.2-native-v1',
                  executablePath: this.config.executablePath,
                  repairEnabled: this.config.selfHeal !== false,
                },
              },
              ...(repair && this.config.selfHeal !== false ? { repair } : {}),
            };
          })()
        : undefined;
      const actionCache = await applyBrowserActions(
        page,
        options.browser,
        options.onDiagnostic,
        options.diagnosticTarget ?? 'list',
        options.signal,
        actionContext,
        options.request,
        (action, signal) =>
          performStagehandAction(
            nativePage,
            action,
            options.request.timeoutMs,
            () => browser!.close(),
            signal,
          ),
      );
      if (options.previewReadiness) {
        try {
          await page
            .locator(options.previewReadiness.selector)
            .first()
            .waitFor({
              state: 'attached',
              timeout: Math.max(
                1,
                Math.min(options.previewReadiness.timeoutMs, options.request.timeoutMs),
              ),
            });
        } catch (error) {
          options.signal?.throwIfAborted();
          if (!(error instanceof errors.TimeoutError)) throw error;
        }
      }
      await nativePage.waitForTimeout(100);
      if (new URL(await nativePage.url()).origin !== target.origin)
        throw new NavigationError('Stagehand page leaves its configured origin');
      const html = await nativePage.evaluate(() => document.documentElement.outerHTML);
      if (Buffer.byteLength(html, 'utf8') > options.request.maxResponseBytes)
        throw new CrawlerError(
          `Browser response exceeded ${options.request.maxResponseBytes} bytes`,
        );
      return {
        url: await nativePage.url(),
        html,
        durationMs: Date.now() - started,
        apiCandidates: [],
        ...(actionCache ? { actionCache } : {}),
        ...(options.actionCache || options.collectCacheSession
          ? {
              cacheSession: await browserPageCacheSession(page, options.request, options.browser),
            }
          : {}),
      };
    } catch (error) {
      if (options.signal?.aborted)
        throw new ZhiYunError('CANCELED', 'Stagehand browser load was canceled');
      if (error instanceof ZhiYunError) throw error;
      const classified = classifyBrowserFailure(error);
      if (classified.code !== 'NAVIGATION_ERROR') throw classified;
      throw new NavigationError(`Stagehand navigation failed for ${url}`, error);
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (stagehand) await stagehand.close().catch(() => undefined);
      if (browser && !browser.closed) await browser.close().catch(() => undefined);
      await bridge?.close().catch(() => undefined);
      if (profile) await rm(profile, { recursive: true, force: true });
    }
  }
}
