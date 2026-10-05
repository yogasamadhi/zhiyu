import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

interface Braces {
  (pattern: string): string[];
  compile(pattern: unknown): string;
  expand(pattern: unknown): string[];
  parse(pattern: string): unknown;
  stringify(pattern: unknown): string;
}
interface Request {
  url: string;
  method: string;
  headers: Record<string, string>;
}
interface Policy {
  now(): number;
  satisfiesWithoutRevalidation(request: Request): boolean;
  evaluateRequest(request: Request): {
    response?: unknown;
    revalidation?: { synchronous: boolean };
  };
  toObject(): unknown;
}
interface PolicyConstructor {
  new (request: Request, response: { status: number; headers: Record<string, string> }): Policy;
  fromObject(value: unknown): Policy;
}

const desktop = createRequire(new URL('../../../desktop/package.json', import.meta.url));
const forge = createRequire(desktop.resolve('@electron-forge/cli/package.json'));
const core = createRequire(forge.resolve('@electron-forge/core'));
const glob = createRequire(core.resolve('fast-glob'));
const micromatch = createRequire(glob.resolve('micromatch'));
const braces = micromatch('braces') as Braces;
const electron = createRequire(desktop.resolve('electron'));
const get = createRequire(electron.resolve('@electron/get'));
const got = createRequire(get.resolve('got'));
const cache = createRequire(got.resolve('cacheable-request'));
const CachePolicy = cache('http-cache-semantics') as PolicyConstructor;
const crawler = createRequire(
  new URL('../../../desktop/packages/crawler-runtime/package.json', import.meta.url),
);
// These consumers publish import-only exports; resolve their actual ESM graph.
const scraperPath = Bun.resolveSync('got-scraping', dirname(crawler.resolve('@crawlee/core')));
const crawlGotPath = Bun.resolveSync('got', dirname(scraperPath));
const crawlCache = createRequire(Bun.resolveSync('cacheable-request', dirname(crawlGotPath)));
const CrawlCachePolicy = crawlCache('http-cache-semantics') as PolicyConstructor;

test('actual Forge and download dependency graph resolves the documented local patches', () => {
  expect(micromatch('braces/package.json').name).toBe('@zhiyun-patches/braces');
  expect(cache('http-cache-semantics/package.json').name).toBe(
    '@zhiyun-patches/http-cache-semantics',
  );
  expect(crawlCache('http-cache-semantics/package.json').name).toBe(
    '@zhiyun-patches/http-cache-semantics',
  );
});

test('brace patch preserves ordinary expansion and compiled patterns', () => {
  expect(braces.expand('file-{1..3}.{ts,js}')).toEqual([
    'file-1.ts',
    'file-1.js',
    'file-2.ts',
    'file-2.js',
    'file-3.ts',
    'file-3.js',
  ]);
  expect(braces('a/{b,c}/d')).toEqual(['a/(b|c)/d']);
  expect(braces.compile('a/{b,{c,d}}')).toBe('a/(b|(c|d))');
});

for (const method of ['parse', 'compile', 'expand', 'stringify'] as const) {
  test(`brace ${method} rejects deep input without a stack overflow`, () => {
    const pattern = '{'.repeat(4000) + 'a,b' + '}'.repeat(4000);
    expect(() => braces[method](pattern)).toThrow(SyntaxError);
    expect(() => braces[method](pattern)).toThrow('Maximum brace nesting depth');
  });
}

test('brace walkers reject a cyclic caller AST and bound supplied AST depth', () => {
  const cyclic: { type: string; nodes: unknown[] } = { type: 'root', nodes: [] };
  cyclic.nodes.push(cyclic);
  let deep: unknown = { type: 'text', value: 'fixture' };
  for (let level = 0; level < 500; level++) deep = { type: 'root', nodes: [deep] };
  for (const method of ['compile', 'expand', 'stringify'] as const) {
    expect(() => braces[method](cyclic)).toThrow('Cyclic');
    expect(() => braces[method](deep)).toThrow('Maximum brace nesting depth');
  }
});

const request: Request = {
  url: 'https://fixture.invalid/account',
  method: 'GET',
  headers: { host: 'fixture.invalid' },
};
test('actual crawler cache path refuses shared session-cookie reuse', () => {
  const policy = new CrawlCachePolicy(request, {
    status: 200,
    headers: { 'set-cookie': 'session=fixture', 'cache-control': 'max-age=60' },
  });
  expect(
    policy.satisfiesWithoutRevalidation({
      ...request,
      headers: { ...request.headers, 'cache-control': 'max-stale=99999' },
    }),
  ).toBe(false);
});
const restrictedPolicies: Array<Record<string, string>> = [
  { 'set-cookie': 'session=fixture', 'cache-control': 'max-age=60' },
  { 'cache-control': 'proxy-revalidate, max-age=60' },
  { 'cache-control': 'no-cache, stale-while-revalidate=60' },
  { 'cache-control': 'private, max-age=60' },
  { 'cache-control': 'no-store, max-age=60' },
];
for (const headers of restrictedPolicies) {
  test(`max-stale cannot bypass ${headers['cache-control']} revalidation rules`, () => {
    const policy = new CachePolicy(request, { status: 200, headers });
    const stale = {
      ...request,
      headers: { ...request.headers, 'cache-control': 'max-stale=99999' },
    };
    const base = policy.now();
    policy.now = () => base + 5000;
    expect(policy.satisfiesWithoutRevalidation(stale)).toBe(false);
    expect(policy.evaluateRequest(stale).response).toBeUndefined();
    expect(policy.evaluateRequest(stale).revalidation?.synchronous).toBe(true);
    const restored = CachePolicy.fromObject(policy.toObject());
    expect(restored.satisfiesWithoutRevalidation(stale)).toBe(false);
  });
}

test('ordinary expired public responses still honor max-stale', () => {
  const policy = new CachePolicy(request, {
    status: 200,
    headers: { 'cache-control': 'public, max-age=1' },
  });
  const base = policy.now();
  policy.now = () => base + 5000;
  expect(
    policy.satisfiesWithoutRevalidation({
      ...request,
      headers: { ...request.headers, 'cache-control': 'max-stale=60' },
    }),
  ).toBe(true);
});
