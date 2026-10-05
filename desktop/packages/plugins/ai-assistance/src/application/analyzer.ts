import { createMockRule, sanitizeHtmlForAi } from '@zhiyun/ai-runtime';
import * as cheerio from 'cheerio';
import { PlaywrightAdapter, type BrowserPageResult } from '@zhiyun/browser-runtime';
import { extractData, extractSourceData } from '@zhiyun/extraction';
import { assertNetworkAllowed, fetchPageSource } from '@zhiyun/crawler-runtime';
import {
  analysisResultSchema,
  crawlPlanDefinitionSchema,
  extractionRuleDefinitionSchema,
  normalizeCrawlPlan,
  type AiProvider,
  type AnalysisResult,
  type CrawlPlanDefinition,
  ZhiYunError,
} from '@zhiyun/contracts';
import type { AnalyzeTaskRuleInput } from '../contracts/index.js';
import { ruleCachePrivateValues, type RuleAnalysisCache } from './rule-cache.js';
import { TurnCostLimitError } from './cost-accounting.js';

export type AnalyzeInput = AnalyzeTaskRuleInput & { signal?: AbortSignal };

function jsonCandidate(payload: unknown): CrawlPlanDefinition {
  const object = payload as { items?: unknown[] };
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(object?.items)
      ? object.items
      : null;
  const sample = rows ? rows[0] : payload;
  const keys = sample && typeof sample === 'object' ? Object.keys(sample) : [];
  const fields = Object.fromEntries(
    keys.slice(0, 12).map((key) => [
      key,
      {
        path: jsonPathSegment('$', key),
        dataType: key === 'price' ? 'number' : key === 'url' ? 'url' : 'string',
      },
    ]),
  );
  return crawlPlanDefinitionSchema.parse({
    list: {
      rule: extractionRuleDefinitionSchema.parse({
        type: 'json',
        container: Array.isArray(payload)
          ? '$[*]'
          : Array.isArray(object?.items)
            ? '$.items[*]'
            : '$',
        fields,
      }),
      mode: 'http',
    },
  });
}

function jsonPathSegment(path: string, key: string | number): string {
  return typeof key === 'number' ? `${path}[${key}]` : `${path}[${JSON.stringify(key)}]`;
}

function embeddedRecordCandidate(payload: unknown): {
  value: Record<string, unknown>;
  path: string;
} {
  let best: { value: Record<string, unknown>; path: string; score: number } | undefined;
  const visit = (value: unknown, path: string, depth: number, keyHint = '') => {
    if (depth > 8 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value
        .slice(0, 3)
        .forEach((item, index) => visit(item, jsonPathSegment(path, index), depth + 1, keyHint));
      return;
    }
    const object = value as Record<string, unknown>;
    const entries = Object.entries(object);
    const primitiveCount = entries.filter(
      ([, item]) => item === null || ['string', 'number', 'boolean'].includes(typeof item),
    ).length;
    const structuredCount = entries.filter(([, item]) => item && typeof item === 'object').length;
    const semanticFieldCount = entries.filter(([key]) =>
      /^(?:id|name|title|description|intro|cover|image|url|tags?|celebrities|actors?|episode(?:_?cnt|_?count|_?total)?|series_(?:id|name|intro|cover))$/i.test(
        key,
      ),
    ).length;
    const semanticBonus = /(?:detail|record|product|article|series|item)/i.test(keyHint) ? 20 : 0;
    const administrativePenalty = /^(?:req|request|config|context|headers?|options?)$/i.test(
      keyHint,
    )
      ? 20
      : 0;
    const score =
      Math.min(primitiveCount, 12) * 2 +
      Math.min(structuredCount, 5) +
      semanticFieldCount * 5 +
      semanticBonus -
      administrativePenalty;
    if (primitiveCount >= 2 && (!best || score > best.score)) best = { value: object, path, score };
    for (const [key, item] of entries) visit(item, jsonPathSegment(path, key), depth + 1, key);
  };
  visit(payload, '$', 0);
  return best ?? { value: payload as Record<string, unknown>, path: '$' };
}

function embeddedJsonCandidate(payload: unknown): CrawlPlanDefinition {
  const candidate = embeddedRecordCandidate(payload);
  const fields = Object.fromEntries(
    Object.entries(candidate.value)
      .slice(0, 24)
      .map(([key, value]) => [
        key,
        {
          path: jsonPathSegment('$', key),
          dataType:
            value && typeof value === 'object'
              ? ('json' as const)
              : typeof value === 'number'
                ? ('number' as const)
                : typeof value === 'string' &&
                    (/^(?:https?:)?\/\//.test(value) || /(?:url|cover|image|avatar)$/i.test(key))
                  ? ('url' as const)
                  : ('string' as const),
        },
      ]),
  );
  return crawlPlanDefinitionSchema.parse({
    list: {
      mode: 'http',
      source: {
        type: 'script-json-assignment',
        selector: 'script',
        marker: '_ROUTER_DATA =',
      },
      rule: { type: 'json', container: candidate.path, fields },
    },
  });
}

function applySuggestedSchema(
  candidate: CrawlPlanDefinition,
  fields: Array<{ name: string; type: 'string' | 'url' | 'number' | 'date' }>,
): CrawlPlanDefinition {
  const current = candidate.list.rule;
  const suggested = Object.fromEntries(
    fields.map((field) => {
      const existing = current.fields[field.name];
      if (existing) return [field.name, { ...existing, dataType: field.type }];
      return current.type === 'json'
        ? [field.name, { path: `$.${field.name}`, dataType: field.type }]
        : [
            field.name,
            {
              selector: `.${field.name}`,
              value: field.type === 'url' ? 'attribute' : 'text',
              ...(field.type === 'url' ? { attribute: 'href' } : {}),
              dataType: field.type,
            },
          ];
    }),
  );
  return crawlPlanDefinitionSchema.parse({
    ...candidate,
    list: { ...candidate.list, rule: { ...current, fields: suggested } },
  });
}

async function enrichWithAi(
  candidate: CrawlPlanDefinition,
  html: string,
  input: AnalyzeInput,
  ai: AiProvider,
  onCall: () => void,
  assertSafeSchema: (value: CrawlPlanDefinition) => void,
): Promise<CrawlPlanDefinition> {
  const context = input.taskId ? { taskId: input.taskId } : undefined;
  onCall();
  const fields = await ai.generateSchema({
    instruction: input.instruction,
    sample: html,
    ...(context ? { context } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const schema = applySuggestedSchema(candidate, fields);
  assertSafeSchema(schema);
  onCall();
  return ai.generateRule({
    html,
    instruction: input.instruction,
    schema,
    ...(context ? { context } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

async function analyzeCandidate(
  initial: CrawlPlanDefinition,
  source: {
    input: unknown;
    structure: unknown;
    format: 'html' | 'json';
    url: string;
    session?: NonNullable<BrowserPageResult['cacheSession']>;
  },
  html: string,
  input: AnalyzeInput,
  ai: AiProvider,
  warnings: string[],
  cache?: RuleAnalysisCache,
  transform: (candidate: CrawlPlanDefinition) => CrawlPlanDefinition = (candidate) => candidate,
) {
  let providerCalls = 0;
  let generatedSuccessfully = false;
  const generate = async () => {
    let candidate = initial;
    let generated = false;
    if (input.useAi) {
      try {
        const representations = new Set<string>();
        for (const value of ruleCachePrivateValues(input, source)) {
          representations.add(value);
          representations.add(encodeURIComponent(value));
          representations.add(JSON.stringify(value).slice(1, -1));
          const element = cheerio.load('<span></span>')('span').text(value);
          const escaped = element.html() ?? '';
          representations.add(escaped);
          representations.add(escaped.replaceAll('"', '&quot;'));
        }
        const values = [...representations].filter(Boolean).sort((a, b) => b.length - a.length);
        const scrub = (value: string) =>
          values.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value);
        const safeSample = scrub(sanitizeHtmlForAi(scrub(html)));
        const safeInstruction = scrub(input.instruction);
        const privateString = (value: string) => values.some((secret) => value.includes(secret));
        const assertSafeSchema = (plan: CrawlPlanDefinition) => {
          const inspect = (value: unknown): void => {
            if (typeof value === 'string' && privateString(value))
              throw new Error('Rule schema includes private configuration values');
            if (Array.isArray(value)) value.forEach(inspect);
            else if (value && typeof value === 'object')
              for (const [key, child] of Object.entries(value)) {
                inspect(key);
                inspect(child);
              }
          };
          inspect(plan);
        };
        if (privateString(safeSample) || privateString(safeInstruction))
          throw new Error('The analysis sample could not be safely redacted');
        assertSafeSchema(initial);
        candidate = transform(
          await enrichWithAi(
            initial,
            safeSample,
            { ...input, instruction: safeInstruction },
            ai,
            () => providerCalls++,
            assertSafeSchema,
          ),
        );
        generated = true;
        generatedSuccessfully = true;
      } catch (error) {
        input.signal?.throwIfAborted();
        if (error instanceof TurnCostLimitError) throw error;
        warnings.push(error instanceof Error ? error.message : 'AI analysis failed');
      }
    }
    return { candidate, providerCalls, generated };
  };
  if (cache) {
    const result = await cache.resolve(input, ai, source, generate);
    return { ...result, aiUsed: generatedSuccessfully };
  }
  const result = await generate();
  return {
    candidate: result.candidate,
    preview: extractData(
      source.input,
      result.candidate.list.rule,
      source.url,
      result.candidate.list.source,
    ).records.slice(0, 10),
    aiUsed: result.generated,
  };
}

export async function analyzePage(
  input: AnalyzeInput,
  ai: AiProvider,
  cache?: RuleAnalysisCache,
): Promise<AnalysisResult> {
  input.signal?.throwIfAborted();
  const warnings: string[] = [];
  let source: Awaited<ReturnType<typeof fetchPageSource>> | undefined;
  try {
    source = await fetchPageSource(input.url, {
      requestSettings: input.requestSettings,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.networkPolicy ? { networkPolicy: input.networkPolicy } : {}),
    });
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error instanceof ZhiYunError && ['NETWORK_POLICY_ERROR', 'CANCELED'].includes(error.code)) {
      throw error;
    }
    warnings.push(
      `HTTP analysis failed; falling back to browser: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let html = source?.text ?? '';
  let engine: 'http' | 'browser' = 'http';
  let sourceUrl = source?.finalUrl ?? input.url;
  let page: BrowserPageResult | undefined;
  const browse = async (initial?: CrawlPlanDefinition, hasRecords = false, structured = false) => {
    const rule = initial?.list.rule;
    const container = rule?.type === 'css' ? rule.container : '.product-card';
    const actionContext = cache?.actionContext(input, ai);
    const loaded = await new PlaywrightAdapter().load(input.url, {
      browser: {
        ...input.browserSettings,
        enabled: true,
        actions: [
          ...input.browserSettings.actions,
          ...(hasRecords && !structured ? [{ type: 'waitFor' as const, selector: container }] : []),
        ],
      },
      request: input.requestSettings,
      ...(actionContext ? { actionCache: actionContext } : {}),
      ...(cache ? { collectCacheSession: true } : {}),
      ...(!hasRecords && !structured
        ? {
            previewReadiness: {
              selector: [...new Set([container, '.product-card', '.item', 'article', 'li'])].join(
                ',',
              ),
              timeoutMs: 1000,
            },
          }
        : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      allowRequest: (url) => assertNetworkAllowed(url, input.networkPolicy),
    });
    input.signal?.throwIfAborted();
    html = loaded.html;
    sourceUrl = loaded.url;
    engine = 'browser';
    return loaded;
  };
  // Configured actions apply to all source formats, before inspecting or generating a rule.
  if (input.forceBrowser || input.browserSettings.enabled || input.browserSettings.actions.length) {
    const structured = Boolean(
      source?.contentType.includes('json') || html.includes('_ROUTER_DATA ='),
    );
    const initial = structured
      ? undefined
      : normalizeCrawlPlan(createMockRule(html, input.instruction));
    const hasRecords = initial
      ? extractData(html, initial.list.rule, sourceUrl).records.length > 0
      : false;
    page = await browse(initial, hasRecords, structured);
  }
  const renderedJson = page ? cheerio.load(html)('body > pre').first() : undefined;
  if (source?.contentType.includes('json') && (!page || renderedJson?.length)) {
    // A browser JSON document must be read from its current DOM, never the earlier HTTP sample.
    const json = page ? renderedJson!.text() : source.text;
    const payload = JSON.parse(json) as unknown;
    const initial = jsonCandidate(payload);
    if (page) initial.list.mode = 'browser';
    const result = await analyzeCandidate(
      initial,
      {
        input: payload,
        structure: payload,
        format: 'json',
        url: sourceUrl,
        ...(page?.cacheSession ? { session: page.cacheSession } : {}),
      },
      json,
      input,
      ai,
      warnings,
      cache,
      (candidate) => {
        if (candidate.list.rule.type !== 'json')
          throw new Error('AI returned a DOM rule for a JSON document');
        return candidate;
      },
    );
    input.signal?.throwIfAborted();
    return analysisResultSchema.parse({
      engine: page ? 'browser' : 'json',
      ...result,
      sourceUrl,
      warnings,
      apiCandidates: page?.apiCandidates ?? [],
      ...(page?.actionCache ? { actionCache: page.actionCache } : {}),
      aiUsed: result.aiUsed || (page?.actionCache?.providerCalls ?? 0) > 0,
    });
  }

  if (html.includes('_ROUTER_DATA =')) {
    try {
      const embeddedSource = {
        type: 'script-json-assignment' as const,
        selector: 'script',
        marker: '_ROUTER_DATA =',
      };
      const payload = extractSourceData(html, embeddedSource);
      const embeddedCandidate = embeddedJsonCandidate(payload);
      if (page) embeddedCandidate.list.mode = 'browser';
      const result = await analyzeCandidate(
        embeddedCandidate,
        {
          input: html,
          structure: payload,
          format: 'json',
          url: sourceUrl,
          ...(page?.cacheSession ? { session: page.cacheSession } : {}),
        },
        html,
        input,
        ai,
        warnings,
        cache,
        (enriched) => {
          if (enriched.list.rule.type === 'json')
            return crawlPlanDefinitionSchema.parse({
              ...enriched,
              list: { ...enriched.list, source: embeddedSource },
            });
          throw new Error('AI returned a DOM rule for embedded JSON');
        },
      );
      input.signal?.throwIfAborted();
      return analysisResultSchema.parse({
        engine,
        ...result,
        sourceUrl,
        warnings,
        apiCandidates: page?.apiCandidates ?? [],
        ...(page?.actionCache ? { actionCache: page.actionCache } : {}),
        aiUsed: result.aiUsed || (page?.actionCache?.providerCalls ?? 0) > 0,
      });
    } catch (error) {
      input.signal?.throwIfAborted();
      if (error instanceof TurnCostLimitError) throw error;
      warnings.push(
        `Embedded JSON analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  let candidate = normalizeCrawlPlan(createMockRule(html, input.instruction));
  let preview = extractData(html, candidate.list.rule, sourceUrl).records.slice(0, 10);
  if (
    cache &&
    source &&
    !input.forceBrowser &&
    !input.browserSettings.enabled &&
    !input.browserSettings.actions.length &&
    preview.length === 0
  ) {
    const reused = await cache.reuse({ ...input, useAi: true }, ai, {
      input: html,
      structure: html,
      format: 'html',
      url: sourceUrl,
    });
    if (reused) {
      input.signal?.throwIfAborted();
      return analysisResultSchema.parse({
        engine: 'http',
        ...reused,
        sourceUrl,
        aiUsed: false,
        warnings,
        apiCandidates: [],
      });
    }
  }
  // Sitemap discovery consumes XML directly. A browser XML viewer is a different DOM
  // from the HTTP document used on subsequent deterministic cache lookups.
  const sitemapDocument = Boolean(
    source &&
    !page &&
    cheerio.load(html, { xmlMode: true }).root().children('sitemapindex, urlset').length,
  );
  if (!page && !sitemapDocument && (!source || preview.length === 0)) {
    page = await browse(candidate, preview.length > 0);
    candidate = normalizeCrawlPlan(createMockRule(html, input.instruction));
    preview = extractData(html, candidate.list.rule, sourceUrl).records.slice(0, 10);
  }

  if (!input.useAi && preview.length === 0)
    warnings.push(
      'No records matched the deterministic rule; adjust the fields or explicitly enable AI and retry.',
    );
  const result = await analyzeCandidate(
    candidate,
    {
      input: html,
      structure: html,
      format: 'html',
      url: sourceUrl,
      ...(page?.cacheSession ? { session: page.cacheSession } : {}),
    },
    html,
    input,
    ai,
    warnings,
    cache,
  );
  input.signal?.throwIfAborted();
  return analysisResultSchema.parse({
    engine,
    ...result,
    sourceUrl,
    warnings,
    apiCandidates: page?.apiCandidates ?? [],
    ...(page?.actionCache ? { actionCache: page.actionCache } : {}),
    aiUsed: result.aiUsed || (page?.actionCache?.providerCalls ?? 0) > 0,
  });
}
