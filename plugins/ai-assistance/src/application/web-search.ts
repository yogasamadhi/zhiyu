import * as cheerio from 'cheerio';
import { PlaywrightAdapter, type BrowserAdapter } from '@zhiyun/browser-runtime';
import { assertNetworkAllowed } from '@zhiyun/crawler-runtime';
import type { WebSearchPort } from '../contracts/index.js';
import type { SiteCandidate } from '../domain/index.js';

export class AnonymousBrowserWebSearch implements WebSearchPort {
  constructor(private readonly browser: BrowserAdapter = new PlaywrightAdapter()) {}

  async search(query: string, signal: AbortSignal): Promise<SiteCandidate[]> {
    const normalized = query.trim().slice(0, 300);
    if (!normalized) throw new Error('Search query is required');
    const bing = await this.run('bing', normalized, signal).catch(() => []);
    if (bing.length > 0) return bing;
    return this.run('duckduckgo', normalized, signal).catch(() => []);
  }

  private async run(
    source: 'bing' | 'duckduckgo',
    query: string,
    signal: AbortSignal,
  ): Promise<SiteCandidate[]> {
    const url =
      source === 'bing'
        ? `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=5`
        : `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const page = await this.browser.load(url, {
      browser: { enabled: true, waitUntil: 'domcontentloaded', actions: [] },
      request: {
        headers: {},
        cookies: [],
        timeoutMs: 20_000,
        retries: 0,
        retryBackoffMs: 1_000,
        concurrency: 1,
        delayMs: 0,
        maxRequests: 1,
        maxRuntimeMs: 30_000,
        domainRateLimitPerMinute: 10,
        respectRobotsTxt: true,
        maxResponseBytes: 2 * 1024 * 1024,
        redirectLimit: 3,
        userAgent: 'Mozilla/5.0 (compatible; ZhiYun/1.0; public-site-discovery)',
      },
      signal,
      allowRequest: (target) => assertNetworkAllowed(target),
    });
    return parseResults(page.html, source).slice(0, 5);
  }
}

export function parseResults(html: string, source: 'bing' | 'duckduckgo'): SiteCandidate[] {
  const $ = cheerio.load(html);
  const selectors =
    source === 'bing'
      ? { item: 'li.b_algo', link: 'h2 a', summary: '.b_caption p' }
      : { item: '.result', link: '.result__a', summary: '.result__snippet' };
  const results: SiteCandidate[] = [];
  $(selectors.item).each((_index, element) => {
    if (results.length >= 5) return;
    const anchor = $(element).find(selectors.link).first();
    const raw = anchor.attr('href');
    const url = publicResultUrl(raw, source);
    if (!url) return;
    results.push({
      title: anchor.text().replace(/\s+/g, ' ').trim().slice(0, 200) || new URL(url).hostname,
      url,
      summary: $(element)
        .find(selectors.summary)
        .first()
        .text()
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500),
      source,
    });
  });
  return results;
}

function publicResultUrl(raw: string | undefined, source: 'bing' | 'duckduckgo'): string | null {
  if (!raw) return null;
  try {
    const initial = new URL(
      raw,
      source === 'bing' ? 'https://www.bing.com' : 'https://duckduckgo.com',
    );
    const target =
      source === 'duckduckgo' && initial.searchParams.get('uddg')
        ? new URL(initial.searchParams.get('uddg')!)
        : initial;
    if (!['http:', 'https:'].includes(target.protocol)) return null;
    if (/^(?:www\.)?(?:bing\.com|duckduckgo\.com)$/i.test(target.hostname)) return null;
    target.username = '';
    target.password = '';
    target.hash = '';
    for (const key of [...target.searchParams.keys()]) {
      if (/token|key|secret|password|auth|cookie|signature/i.test(key)) {
        target.searchParams.delete(key);
      }
    }
    return target.toString();
  } catch {
    return null;
  }
}
