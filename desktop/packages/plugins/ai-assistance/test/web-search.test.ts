import { describe, expect, it, vi } from 'vitest';
import type { BrowserAdapter } from '@zhiyun/browser-runtime';
import { AnonymousBrowserWebSearch, parseResults } from '../src/application/web-search.js';

describe('experimental anonymous site discovery', () => {
  it('parses at most five public Bing candidates without credential query parameters', () => {
    const html = `<ol>${Array.from(
      { length: 7 },
      (_, index) => `
        <li class="b_algo">
          <h2><a href="https://site${index}.example/list?token=secret&page=${index}">Site ${index}</a></h2>
          <div class="b_caption"><p>Public result ${index}</p></div>
        </li>`,
    ).join('')}</ol>`;
    const results = parseResults(html, 'bing');
    expect(results).toHaveLength(5);
    expect(results[0]).toMatchObject({
      title: 'Site 0',
      url: 'https://site0.example/list?page=0',
      source: 'bing',
    });
    expect(JSON.stringify(results)).not.toContain('secret');
  });

  it('falls back from Bing to DuckDuckGo with an isolated credential-free Browser request', async () => {
    const load = vi
      .fn<BrowserAdapter['load']>()
      .mockRejectedValueOnce(new Error('Bing captcha'))
      .mockResolvedValueOnce({
        url: 'https://html.duckduckgo.com/html/',
        html: `
          <div class="result">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fshop.example%2Fproducts">Shop</a>
            <div class="result__snippet">Public products</div>
          </div>`,
        durationMs: 1,
        apiCandidates: [],
      });
    const search = new AnonymousBrowserWebSearch({ load });
    const results = await search.search('public products', new AbortController().signal);
    expect(load).toHaveBeenCalledTimes(2);
    expect(String(load.mock.calls[0]?.[0])).toContain('bing.com/search');
    expect(String(load.mock.calls[1]?.[0])).toContain('duckduckgo.com/html');
    expect(load.mock.calls[0]?.[1].request).toMatchObject({
      headers: {},
      cookies: [],
      respectRobotsTxt: true,
    });
    expect(results).toEqual([
      {
        title: 'Shop',
        url: 'https://shop.example/products',
        summary: 'Public products',
        source: 'duckduckgo',
      },
    ]);
  });
});
