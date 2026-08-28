import { createMockRule } from '@zhiyun/ai-runtime';
import { PlaywrightAdapter } from '@zhiyun/browser-runtime';
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

export type AnalyzeInput = AnalyzeTaskRuleInput;

function jsonCandidate(payload: unknown): CrawlPlanDefinition {
  const object = payload as { items?: unknown[] };
  const sample = Array.isArray(object?.items) ? object.items[0] : payload;
  const keys = sample && typeof sample === 'object' ? Object.keys(sample) : [];
  const fields = Object.fromEntries(
    keys.slice(0, 12).map((key) => [
      key,
      {
        path: `$.${key}`,
        dataType: key === 'price' ? 'number' : key === 'url' ? 'url' : 'string',
      },
    ]),
  );
  return crawlPlanDefinitionSchema.parse({
    list: {
      rule: extractionRuleDefinitionSchema.parse({
        type: 'json',
        container: Array.isArray(object?.items) ? '$.items[*]' : '$',
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
): Promise<CrawlPlanDefinition> {
  const context = input.taskId ? { taskId: input.taskId } : undefined;
  const fields = await ai.generateSchema({
    instruction: input.instruction,
    sample: html,
    ...(context ? { context } : {}),
  });
  return ai.generateRule({
    html,
    instruction: input.instruction,
    schema: applySuggestedSchema(candidate, fields),
    ...(context ? { context } : {}),
  });
}

export async function analyzePage(input: AnalyzeInput, ai: AiProvider): Promise<AnalysisResult> {
  const warnings: string[] = [];
  let source: Awaited<ReturnType<typeof fetchPageSource>> | undefined;
  try {
    source = await fetchPageSource(input.url, {
      requestSettings: input.requestSettings,
      ...(input.networkPolicy ? { networkPolicy: input.networkPolicy } : {}),
    });
  } catch (error) {
    if (error instanceof ZhiYunError && ['NETWORK_POLICY_ERROR', 'CANCELED'].includes(error.code)) {
      throw error;
    }
    warnings.push(
      `HTTP analysis failed; falling back to browser: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (source?.contentType.includes('json')) {
    const payload = JSON.parse(source.text) as unknown;
    let candidate = jsonCandidate(payload);
    let aiUsed = false;
    if (input.useAi) {
      try {
        candidate = await enrichWithAi(candidate, source.text, input, ai);
        aiUsed = true;
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : 'AI analysis failed');
      }
    }
    return analysisResultSchema.parse({
      engine: 'json',
      candidate,
      preview: extractData(payload, candidate.list.rule, source.finalUrl).records.slice(0, 10),
      sourceUrl: source.finalUrl,
      aiUsed,
      warnings,
      apiCandidates: [],
    });
  }

  let html = source?.text ?? '';
  let engine: 'http' | 'browser' = 'http';
  let sourceUrl = source?.finalUrl ?? input.url;
  if (html.includes('_ROUTER_DATA =')) {
    try {
      const embeddedSource = {
        type: 'script-json-assignment' as const,
        selector: 'script',
        marker: '_ROUTER_DATA =',
      };
      const payload = extractSourceData(html, embeddedSource);
      let embeddedCandidate = embeddedJsonCandidate(payload);
      let aiUsed = false;
      if (input.useAi) {
        try {
          const enriched = await enrichWithAi(embeddedCandidate, html, input, ai);
          aiUsed = true;
          if (enriched.list.rule.type === 'json') {
            embeddedCandidate = crawlPlanDefinitionSchema.parse({
              ...enriched,
              list: { ...enriched.list, source: embeddedSource },
            });
          } else {
            warnings.push('AI returned a DOM rule for embedded JSON; the structured rule was kept');
          }
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : 'AI analysis failed');
        }
      }
      return analysisResultSchema.parse({
        engine,
        candidate: embeddedCandidate,
        preview: extractData(
          html,
          embeddedCandidate.list.rule,
          sourceUrl,
          embeddedCandidate.list.source,
        ).records.slice(0, 10),
        sourceUrl,
        aiUsed,
        warnings,
        apiCandidates: [],
      });
    } catch (error) {
      warnings.push(
        `Embedded JSON analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  let candidate = normalizeCrawlPlan(createMockRule(html, input.instruction));
  let apiCandidates: AnalysisResult['apiCandidates'] = [];
  let preview = extractData(html, candidate.list.rule, sourceUrl).records.slice(0, 10);
  if (input.forceBrowser || !source || preview.length === 0) {
    const browser = new PlaywrightAdapter();
    const listRule = candidate.list.rule;
    const container = listRule.type === 'css' ? listRule.container : '.product-card';
    const page = await browser.load(input.url, {
      browser: {
        ...input.browserSettings,
        enabled: true,
        actions: [...input.browserSettings.actions, { type: 'waitFor', selector: container }],
      },
      request: input.requestSettings,
      allowRequest: (url) => assertNetworkAllowed(url, input.networkPolicy),
    });
    html = page.html;
    sourceUrl = page.url;
    engine = 'browser';
    apiCandidates = page.apiCandidates;
    candidate = normalizeCrawlPlan(createMockRule(html, input.instruction));
    preview = extractData(html, candidate.list.rule, sourceUrl).records.slice(0, 10);
  }

  let aiUsed = false;
  if (input.useAi || preview.length === 0) {
    try {
      candidate = await enrichWithAi(candidate, html, input, ai);
      preview = extractData(html, candidate.list.rule, sourceUrl).records.slice(0, 10);
      aiUsed = true;
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : 'AI analysis failed');
    }
  }
  return analysisResultSchema.parse({
    engine,
    candidate,
    preview,
    sourceUrl,
    aiUsed,
    warnings,
    apiCandidates,
  });
}
