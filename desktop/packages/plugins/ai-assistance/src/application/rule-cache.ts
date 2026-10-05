import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { CrawlerRuntime } from '@zhiyun/crawler-runtime';
import { extractData, validateCrawlPlan } from '@zhiyun/extraction';
import {
  crawlPlanDefinitionSchema,
  type AiProvider,
  type AnalysisResult,
  type CrawlPlanDefinition,
  type ValidatedCacheEntry,
  type ValidatedCacheKey,
  type ValidatedCacheRepository,
  type BrowserActionCacheContext,
} from '@zhiyun/contracts';
import type { AnalyzeTaskRuleInput } from '../contracts/index.js';
import {
  projectRuleActionValues,
  readRuleActionProjection,
  restoreRuleActionValues,
  type RuleActionProjection,
} from './rule-action-values.js';

export const RULE_CACHE_VERSIONS = {
  prompt: 'rule-analysis-v2-private-samples',
  tools: 'crawl-plan-v2-stage-qualification',
} as const;
const structuralAttributes = [
  'id',
  'class',
  'role',
  'name',
  'type',
  'data-testid',
  'data-test',
  'data-qa',
  'data-cy',
];
type CacheResult = NonNullable<AnalysisResult['cache']>;
type Source = {
  input: unknown;
  structure: unknown;
  format: 'html' | 'json';
  url: string;
  session?: { fingerprint?: string; privateValues: string[] };
};
export interface CachedRuleResult {
  candidate: CrawlPlanDefinition;
  preview: AnalysisResult['preview'];
  cache: CacheResult;
}
type GenerateRule = () => Promise<{
  candidate: CrawlPlanDefinition;
  providerCalls: number;
  generated: boolean;
}>;

export function cacheDigest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function canonical(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(',')}}`;
}

/** Hash structural tokens directly; no text, input values, URLs or whole DOM are returned/stored. */
export function pageStructureFingerprint(value: unknown, format: Source['format']): string | null {
  let visited = 0;
  const maximum = 20_000;
  try {
    if (format === 'json') {
      const shape = (item: unknown, depth: number): string => {
        if (++visited > maximum || depth > 64) throw new Error('Structure limit');
        if (item === null) return 'null';
        if (Array.isArray(item))
          return `array[${[...new Set(item.map((child) => shape(child, depth + 1)))].sort().join(',')}]`;
        if (typeof item === 'object')
          return `{${Object.entries(item)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => `${cacheDigest(key)}:${shape(child, depth + 1)}`)
            .join(',')}}`;
        return typeof item;
      };
      return cacheDigest(shape(value, 0));
    }
    const $ = cheerio.load(String(value));
    const digest = createHash('sha256');
    const walk = (node: ReturnType<typeof $>['0'], depth: number): void => {
      if (++visited > maximum || depth > 64) throw new Error('Structure limit');
      if ('tagName' in node) {
        digest.update(
          canonical([
            node.tagName,
            Object.entries(node.attribs)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([name, attribute]) => [
                name,
                structuralAttributes.includes(name) ? cacheDigest(attribute) : null,
              ]),
          ]),
        );
      }
      if ('children' in node)
        for (const child of node.children)
          if (child.type !== 'text' && child.type !== 'comment') walk(child, depth + 1);
      digest.update('end');
    };
    for (const child of $.root().children().toArray()) walk(child, 0);
    return digest.digest('hex');
  } catch {
    return null;
  }
}

function validatedPreview(
  plan: CrawlPlanDefinition,
  source: Source,
): AnalysisResult['preview'] | null {
  try {
    validateCrawlPlan(plan);
    const output = extractData(source.input, plan.list.rule, source.url, plan.list.source, {
      inspect: true,
    });
    const records = output.records.slice(0, 10);
    if (!records.length || output.warnings.length) return null;
    const fields = Object.keys(plan.list.rule.fields);
    if (
      records.some((row) =>
        fields.some(
          (field) => row[field] == null || (typeof row[field] === 'string' && !row[field].trim()),
        ),
      )
    )
      return null;
    if (
      output.inspections
        ?.slice(0, 10)
        .some((row) => Object.values(row.fields).some((field) => field.status !== 'valid'))
    )
      return null;
    return records;
  } catch {
    return null;
  }
}

export function ruleCachePrivateValues(input: AnalyzeTaskRuleInput, source: Source): string[] {
  const values: string[] = [...(source.session?.privateValues ?? [])];
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) values.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(input.requestSettings.headers);
  for (const [name, value] of Object.entries(input.requestSettings.headers)) {
    if (/authorization/i.test(name)) collect(value.replace(/^(?:Bearer|Basic)\s+/i, ''));
    if (/cookie/i.test(name))
      for (const cookie of value.split(';')) collect(cookie.slice(cookie.indexOf('=') + 1).trim());
  }
  input.requestSettings.cookies.forEach((cookie) => collect(cookie.value));
  collect(input.requestSettings.proxy);
  collect(input.browserSettings.storageState);
  input.browserSettings.actions.forEach((action) => {
    if ('value' in action) collect(action.value);
  });
  const collectUrl = (value: string) => {
    try {
      const url = new URL(value, input.url);
      collect(url.username);
      collect(url.password);
      // Known pagination/search parameters are public configuration. Treat other parameters
      // conservatively, including sites with a nonstandard authentication parameter name.
      // The entire URL still participates in the hashed session/configuration key.
      for (const [name, value] of url.searchParams)
        if (
          !/^(?:page|page_?no|page_?size|offset|limit|sort|sort_?by|order|q|query|search|category|lang|locale)$/i.test(
            name,
          )
        )
          collect(value);
    } catch {
      /* Invalid URL text has no authentication parameters to collect. */
    }
  };
  collectUrl(input.url);
  // Embedded JSON uses a JSON structure fingerprint but still supplies an HTML model sample.
  const html =
    source.format === 'html'
      ? String(source.structure)
      : typeof source.input === 'string'
        ? source.input
        : undefined;
  if (html !== undefined) {
    const $ = cheerio.load(html);
    $('loc').each((_index, element) => collectUrl($(element).text()));
    $('input[value],textarea,[data-token],[data-secret],[data-password]').each(
      (_index, element) => {
        for (const attribute of ['value', 'data-token', 'data-secret', 'data-password'])
          collect($(element).attr(attribute));
        if (element.tagName === 'textarea') collect($(element).text());
      },
    );
    for (const match of html.matchAll(/Bearer\s+([A-Za-z0-9._~+/-]+=*)/gi)) collect(match[1]);
  }
  if (source.format === 'json') {
    const walk = (value: unknown, depth: number) => {
      if (depth > 64 || !value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (/token|secret|password|cookie|authorization|credential|api.?key/i.test(key))
          collect(child);
        else walk(child, depth + 1);
      }
    };
    walk(source.structure, 0);
  }
  return values;
}

/** Permit structural attribute literals, while keeping page text and form values ineligible. */
function safeSelector(value: string, type: 'css' | 'xpath' = 'css'): boolean {
  if (value.length > 1024 || /[\\<`]/.test(value)) return false;
  const attributes = structuralAttributes.join('|');
  const literal = '[\\p{L}\\p{N}_ .:#/\\-]{1,128}';
  const structural =
    type === 'css'
      ? new RegExp(
          `\\[\\s*(?:${attributes})\\s*[~|^$*]?=\\s*(?:"${literal}"|'${literal}'|[\\p{L}\\p{N}_-]+)\\s*(?:[is]\\s*)?\\]`,
          'giu',
        )
      : new RegExp(`@(?:${attributes})\\s*=\\s*(?:"${literal}"|'${literal}')`, 'giu');
  const remainder = value.replace(structural, type === 'css' ? '[structure]' : '@structure');
  return (
    !/["'=]/.test(remainder) && !/:contains|:has-text|text\s*\(|contains\s*\(/i.test(remainder)
  );
}

function persistenceRejection(
  plan: CrawlPlanDefinition,
  input: AnalyzeTaskRuleInput,
  source: Source,
  storedProjection?: RuleActionProjection,
): CacheResult['reason'] | null {
  const projection =
    storedProjection ?? projectRuleActionValues(plan, input.browserSettings.actions);
  if (!projection) return 'privacy_rejected';
  const serialized = JSON.stringify(projection);
  const strings: string[] = [];
  const collectStrings = (value: unknown): void => {
    if (typeof value === 'string') strings.push(value);
    else if (Array.isArray(value)) value.forEach(collectStrings);
    else if (value && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) {
        strings.push(key);
        collectStrings(child);
      }
  };
  collectStrings(projection);
  if (
    Buffer.byteLength(serialized) > (composed(plan, input) ? 32_256 : 32_768) ||
    ruleCachePrivateValues(input, source).some((value) =>
      strings.some((text) => text.includes(value)),
    )
  )
    return 'privacy_rejected';
  const identifier = /^[\p{L}\p{N}_$-]{1,128}$/u;
  if (plan.dedupe.fields.some((field) => !identifier.test(field))) return 'privacy_rejected';
  if (
    plan.dedupe.strategy === 'fields' &&
    (!plan.dedupe.fields.length ||
      plan.dedupe.fields.some(
        (field) =>
          !Object.hasOwn(plan.list.rule.fields, field) &&
          field !== plan.discovery?.urlField &&
          field !== plan.discovery?.lastModifiedField &&
          !Object.hasOwn(plan.detail?.rule.fields ?? {}, field),
      ))
  )
    return 'validation_failed';
  const ruleSafe = (rule: CrawlPlanDefinition['list']['rule']) => {
    const pathSafe = (value: string) =>
      /^(?:\$|@)(?:\.[\p{L}\p{N}_$-]+|\[(?:\d+|\*|"[\p{L}\p{N}_$-]+"|'[\p{L}\p{N}_$-]+')\])*$/u.test(
        value,
      );
    return (
      (rule.type === 'json' ? pathSafe(rule.container) : safeSelector(rule.container, rule.type)) &&
      Object.entries(rule.fields).every(
        ([name, field]) =>
          identifier.test(name) &&
          ('path' in field
            ? pathSafe(field.path)
            : safeSelector(field.selector, rule.type === 'xpath' ? 'xpath' : 'css') &&
              (!field.attribute || identifier.test(field.attribute))),
      )
    );
  };
  const actions = [...plan.list.actions, ...(plan.detail?.actions ?? [])];
  if (
    actions.some(
      (action) =>
        ('target' in action && action.target?.sensitive) ||
        ('selector' in action && !safeSelector(action.selector)) ||
        ('semanticGoal' in action &&
          action.semanticGoal &&
          /<\/?[A-Za-z][^>]*>|<!doctype/i.test(action.semanticGoal.description)) ||
        (action.type === 'press' &&
          ![
            'Enter',
            'Tab',
            'Escape',
            'ArrowDown',
            'ArrowUp',
            'ArrowLeft',
            'ArrowRight',
            'Space',
          ].includes(action.key)),
    )
  )
    return 'privacy_rejected';
  if (
    actions.some(
      (action) => (action.type === 'click' || action.type === 'press') && !action.expectedState,
    )
  )
    return 'validation_failed';
  for (const action of actions) {
    if (!('expectedState' in action) || !action.expectedState) continue;
    if (
      action.expectedState.checks.some(
        (check) =>
          ('selector' in check && !safeSelector(check.selector)) ||
          (check.type === 'attribute' &&
            (!identifier.test(check.name) || !identifier.test(check.value))),
      )
    )
      return 'privacy_rejected';
  }
  if (
    !ruleSafe(plan.list.rule) ||
    (plan.detail && (!ruleSafe(plan.detail.rule) || !identifier.test(plan.detail.urlField))) ||
    (plan.list.source &&
      (!safeSelector(plan.list.source.selector) ||
        !/^(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\s*=$/.test(plan.list.source.marker)))
  )
    return 'privacy_rejected';
  const pagination = plan.pagination.type === 'none' ? input.pagination : plan.pagination;
  if (pagination && 'selector' in pagination && !safeSelector(pagination.selector))
    return 'privacy_rejected';
  if (
    plan.discovery &&
    (!identifier.test(plan.discovery.urlField) ||
      (plan.discovery.lastModifiedField && !identifier.test(plan.discovery.lastModifiedField)) ||
      [...plan.discovery.include, ...plan.discovery.exclude].some(
        (filter) => !/^[\p{L}\p{N}_.:/-]{1,512}$/u.test(filter),
      ))
  )
    return 'privacy_rejected';
  return null;
}

function composed(plan: CrawlPlanDefinition, input: AnalyzeTaskRuleInput): boolean {
  return Boolean(
    plan.detail ||
    plan.list.actions.length ||
    plan.discovery ||
    plan.pagination.type !== 'none' ||
    (input.pagination && input.pagination.type !== 'none'),
  );
}

type Qualification = {
  preview: AnalysisResult['preview'] | null;
  key: ValidatedCacheKey;
  rejection?: CacheResult['reason'];
  noReplay?: boolean;
};
type CachedPayload = {
  plan: CrawlPlanDefinition;
  base?: { structureHash: string; sessionHash: string; actionHash: string };
  projection?: RuleActionProjection;
};
function decodePayload(payload: string): CachedPayload {
  const value: unknown = JSON.parse(payload);
  if (value && typeof value === 'object' && 'cacheVersion' in value) {
    const envelope = value as Record<string, unknown>;
    if (
      (envelope.cacheVersion !== 2 && envelope.cacheVersion !== 3) ||
      Object.keys(envelope).some(
        (name) =>
          ![
            'cacheVersion',
            'plan',
            'baseStructureHash',
            'baseSessionHash',
            'baseActionHash',
            ...(envelope.cacheVersion === 3 ? ['valueBindings'] : []),
          ].includes(name),
      ) ||
      typeof envelope.baseStructureHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(envelope.baseStructureHash) ||
      typeof envelope.baseSessionHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(envelope.baseSessionHash) ||
      typeof envelope.baseActionHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(envelope.baseActionHash)
    )
      throw new Error('Invalid rule cache envelope');
    const plan = crawlPlanDefinitionSchema.parse(envelope.plan);
    if (
      envelope.cacheVersion === 2 &&
      [...plan.list.actions, ...(plan.detail?.actions ?? [])].some(
        (action) => action.type === 'fill' || action.type === 'select',
      )
    )
      throw new Error('Unprojected cached action values');
    return {
      plan,
      ...(envelope.cacheVersion === 3
        ? { projection: readRuleActionProjection(plan, envelope.valueBindings) }
        : {}),
      base: {
        structureHash: envelope.baseStructureHash,
        sessionHash: envelope.baseSessionHash,
        actionHash: envelope.baseActionHash,
      },
    };
  }
  const plan = crawlPlanDefinitionSchema.parse(value);
  if (
    [...plan.list.actions, ...(plan.detail?.actions ?? [])].some(
      (action) => action.type === 'fill' || action.type === 'select',
    )
  )
    throw new Error('Unprojected cached action values');
  return { plan };
}
function encodePayload(
  plan: CrawlPlanDefinition,
  input: AnalyzeTaskRuleInput,
  key: ValidatedCacheKey,
): string {
  const projection = projectRuleActionValues(plan, input.browserSettings.actions);
  if (!projection) throw new Error('Rule action values cannot be safely cached');
  const bound = projection.bindings.length > 0;
  return JSON.stringify(
    composed(plan, input) || bound
      ? {
          cacheVersion: bound ? 3 : 2,
          plan: projection.plan,
          ...(bound ? { valueBindings: projection.bindings } : {}),
          baseStructureHash: key.structureHash,
          baseSessionHash: key.sessionHash,
          baseActionHash: key.actionHash,
        }
      : projection.plan,
  );
}
function entryKey(entry: ValidatedCacheEntry): ValidatedCacheKey {
  const {
    kind,
    scopeHash,
    sessionHash,
    ruleHash,
    configurationHash,
    providerHash,
    promptHash,
    actionHash,
    structureHash,
    keyHash,
  } = entry;
  return {
    kind,
    scopeHash,
    sessionHash,
    ruleHash,
    configurationHash,
    providerHash,
    promptHash,
    actionHash,
    structureHash,
    keyHash,
  };
}
function keyWithEvidence(
  key: ValidatedCacheKey,
  evidence: Partial<Pick<ValidatedCacheKey, 'structureHash' | 'sessionHash' | 'actionHash'>>,
): ValidatedCacheKey {
  const result = { ...key, ...evidence };
  result.keyHash = cacheDigest({ ...result, keyHash: undefined });
  return result;
}

async function qualify(
  plan: CrawlPlanDefinition,
  input: AnalyzeTaskRuleInput & { signal?: AbortSignal },
  source: Source,
  key: ValidatedCacheKey,
): Promise<Qualification> {
  const rejection = persistenceRejection(plan, input, source);
  if (rejection) return { preview: null, key, rejection };
  if (!composed(plan, input)) return { preview: validatedPreview(plan, source), key };
  let failed: CacheResult['reason'] | undefined;
  let noReplay = false;
  const structures: string[] = [],
    sessions: string[] = [];
  const listPages = new Set<string>();
  const listSamples: string[][] = [];
  const terminalPages = new Set<string>();
  let discoveryStages = 0;
  let before: string[] | undefined, after: string[] | undefined;
  const pagination = plan.pagination.type === 'none' ? input.pagination : plan.pagination;
  try {
    const result = await new CrawlerRuntime().crawl({
      url: input.url,
      plan,
      mode: input.forceBrowser ? 'browser' : 'auto',
      requestSettings: input.requestSettings,
      browserSettings: input.browserSettings,
      pagination: input.pagination ?? { type: 'none' },
      ...(input.networkPolicy ? { networkPolicy: input.networkPolicy } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      previewLimit: 10,
      onDiagnostic: (step) => {
        if (
          step.kind === 'action' &&
          step.status === 'failed' &&
          step.errorCode === 'ACTION_STATE_INVALID'
        )
          noReplay = true;
      },
      onVerificationPagination: (evidence) => {
        if (evidence.terminal) terminalPages.add(evidence.url);
        structures.push(
          cacheDigest([
            'pagination-state',
            evidence.type,
            cacheDigest(evidence.url),
            evidence.terminal,
          ]),
        );
      },
      onVerificationSource: (stage) => {
        const stageSource: Source = {
          input: stage.input,
          structure: stage.input,
          format: typeof stage.input === 'string' ? 'html' : 'json',
          url: stage.url,
          ...(stage.session ? { session: stage.session } : {}),
        };
        const secretInput = { ...input, url: stage.url };
        const privacy = persistenceRejection(plan, secretInput, stageSource);
        if (privacy) failed = privacy;
        const fingerprint = pageStructureFingerprint(stage.input, stageSource.format);
        if (!fingerprint) failed = 'fingerprint_limit';
        structures.push(
          cacheDigest([stage.target, stage.phase, cacheDigest(stage.url), fingerprint]),
        );
        if (stage.session?.fingerprint)
          sessions.push(cacheDigest([new URL(stage.url).origin, stage.session.fingerprint]));
        if (stage.target === 'discovery') {
          discoveryStages++;
          if (!plan.discovery || !stage.discovery?.parsedEntries) failed ??= 'validation_failed';
          return;
        }
        const rule = stage.target === 'detail' ? plan.detail!.rule : plan.list.rule;
        const extractionSource = stage.target === 'detail' ? plan.detail?.source : plan.list.source;
        const extraction = extractData(stage.input, rule, stage.url, extractionSource, {
          inspect: true,
        });
        if (
          !extraction.records.length ||
          extraction.warnings.length ||
          extraction.inspections?.some((row) =>
            Object.values(row.fields).some((field) => field.status !== 'valid'),
          ) ||
          extraction.records.some((row) =>
            Object.keys(rule.fields).some(
              (field) =>
                row[field] == null || (typeof row[field] === 'string' && !row[field].trim()),
            ),
          )
        )
          failed ??= 'validation_failed';
        if (stage.target === 'list') {
          const data = extraction.records.map(cacheDigest);
          if (stage.phase === 'before-pagination') before = data;
          else {
            listPages.add(stage.url);
            listSamples.push(data);
            after = data;
          }
        }
      },
    });
    if (
      result.metadata.warnings.length ||
      !result.records.length ||
      !structures.length ||
      (plan.discovery && !discoveryStages) ||
      result.records.some(
        (row) =>
          !row.inspection ||
          Object.values(row.inspection.fields).some((field) => field.status !== 'valid') ||
          (plan.detail && row.inspection.detail?.status !== 'resolved'),
      )
    )
      failed ??= 'validation_failed';
    if (pagination?.type === 'next' || pagination?.type === 'page') {
      if (
        pagination.maxPages > 1 &&
        ((listPages.size < 2 && !(listPages.size === 1 && terminalPages.has([...listPages][0]!))) ||
          (listPages.size >= 2 &&
            !listSamples
              .slice(1)
              .some((sample) => sample.some((value) => !listSamples[0]!.includes(value)))))
      )
        failed ??= 'validation_failed';
    } else if (pagination?.type === 'loadMore' || pagination?.type === 'infinite') {
      if (
        !before ||
        !after ||
        (!after.some((value) => !before!.includes(value)) &&
          !(
            pagination.type === 'loadMore' &&
            listPages.size === 1 &&
            terminalPages.has([...listPages][0]!)
          ))
      )
        failed ??= 'validation_failed';
    }
    return {
      preview: failed ? null : result.records.map((row) => row.data),
      key: keyWithEvidence(key, {
        structureHash: cacheDigest([key.structureHash, structures.sort()]),
        sessionHash: cacheDigest([key.sessionHash, [...new Set(sessions)].sort()]),
        actionHash: cacheDigest([
          key.actionHash,
          plan.list.actions,
          plan.detail?.actions,
          plan.pagination,
          ...(plan.discovery ? [plan.discovery] : []),
        ]),
      }),
      ...(failed ? { rejection: failed } : {}),
      ...(noReplay ? { noReplay: true } : {}),
    };
  } catch {
    input.signal?.throwIfAborted();
    return {
      preview: null,
      key,
      rejection: failed ?? 'validation_failed',
      ...(noReplay ? { noReplay: true } : {}),
    };
  }
}

function invalidation(
  entry: ValidatedCacheEntry,
  key: ValidatedCacheKey,
  now: number,
): CacheResult['reason'] {
  if (entry.sessionHash !== key.sessionHash) return 'session_changed';
  if (entry.ruleHash !== key.ruleHash) return 'rule_changed';
  if (entry.providerHash !== key.providerHash) return 'provider_changed';
  if (entry.promptHash !== key.promptHash) return 'prompt_changed';
  if (entry.actionHash !== key.actionHash || entry.configurationHash !== key.configurationHash)
    return 'configuration_changed';
  if (entry.expiresAt <= now) return 'expired';
  if (entry.structureHash !== key.structureHash) return 'structure_changed';
  return entry.keyHash === key.keyHash ? 'matched' : 'corrupt';
}

function validEntryMetadata(entry: ValidatedCacheEntry): boolean {
  const {
    kind,
    scopeHash,
    sessionHash,
    ruleHash,
    configurationHash,
    providerHash,
    promptHash,
    actionHash,
    structureHash,
    keyHash,
  } = entry;
  return (
    kind === 'rule' &&
    (entry.ownerScopeHash === undefined || entry.ownerScopeHash === scopeHash) &&
    [
      scopeHash,
      sessionHash,
      ruleHash,
      configurationHash,
      providerHash,
      promptHash,
      actionHash,
      structureHash,
      keyHash,
      entry.payloadHash,
    ].every((value) => /^[a-f0-9]{64}$/.test(value)) &&
    [entry.createdAt, entry.expiresAt, entry.hitCount].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) &&
    entry.expiresAt > entry.createdAt &&
    entry.expiresAt - entry.createdAt <= 7 * 86_400_000 &&
    keyHash ===
      cacheDigest({
        kind,
        scopeHash,
        sessionHash,
        ruleHash,
        configurationHash,
        providerHash,
        promptHash,
        actionHash,
        structureHash,
        keyHash: undefined,
      })
  );
}

export class RuleAnalysisCache {
  constructor(
    private readonly repository: ValidatedCacheRepository,
    private readonly options: {
      now?: () => number;
      ttlMs?: number;
      promptVersion?: string;
      toolSchemaVersion?: string;
    } = {},
  ) {}

  async clear(scope: string): Promise<number> {
    return this.repository.clearValidatedCache(cacheDigest(scope));
  }
  actionContext(
    input: AnalyzeTaskRuleInput,
    ai: AiProvider,
  ): BrowserActionCacheContext | undefined {
    const scope = input.cacheScope ?? (input.taskId ? `task:${input.taskId}` : undefined);
    if (!scope) return undefined;
    const repair = ai.repairBrowserAction?.bind(ai);
    return {
      repository: this.repository,
      scope,
      ...(input.ruleVersion ? { ruleVersion: input.ruleVersion } : {}),
      ...(input.taskVersion === undefined ? {} : { taskVersion: input.taskVersion }),
      configuration: {
        network: input.networkPolicy,
        pagination: input.pagination,
        dataset: input.datasetSettings,
      },
      identity: () => ai.cacheIdentity,
      ...(input.useAi && repair
        ? {
            repair: (value, signal) =>
              repair({
                ...value,
                ...(input.taskId ? { context: { taskId: input.taskId } } : {}),
                ...(signal ? { signal } : {}),
              }),
          }
        : {}),
    };
  }

  async resolve(
    input: AnalyzeTaskRuleInput & { signal?: AbortSignal },
    ai: AiProvider,
    source: Source,
    generate: GenerateRule,
  ): Promise<CachedRuleResult> {
    const result = await this.lookupOrGenerate(input, ai, source, generate);
    if (!result) throw new Error('Rule generation did not produce a result');
    return result;
  }

  async reuse(
    input: AnalyzeTaskRuleInput & { signal?: AbortSignal },
    ai: AiProvider,
    source: Source,
  ): Promise<CachedRuleResult | null> {
    return this.lookupOrGenerate(input, ai, source);
  }

  private async lookupOrGenerate(
    input: AnalyzeTaskRuleInput & { signal?: AbortSignal },
    ai: AiProvider,
    source: Source,
    generate?: GenerateRule,
  ): Promise<CachedRuleResult | null> {
    input.signal?.throwIfAborted();
    const now = this.options.now?.() ?? Date.now();
    const scope = input.cacheScope ?? (input.taskId ? `task:${input.taskId}` : null);
    const identity = ai.cacheIdentity;
    const fingerprint = pageStructureFingerprint(source.structure, source.format);
    const bypass: CacheResult['reason'] | null = !scope
      ? 'scope_missing'
      : input.useAi && !identity
        ? 'provider_unknown'
        : !fingerprint
          ? 'fingerprint_limit'
          : null;
    const result: CacheResult = {
      status: bypass ? 'bypassed' : 'miss',
      reason: bypass ?? 'empty',
      hitCount: 0,
      providerCalls: 0,
    };
    const key: ValidatedCacheKey = {
      kind: 'rule',
      scopeHash: cacheDigest(scope),
      sessionHash: cacheDigest({
        headers: input.requestSettings.headers,
        cookies: input.requestSettings.cookies,
        proxy: input.requestSettings.proxy,
        storage: input.browserSettings.storageState,
        url: input.url,
        browserSession: source.session?.fingerprint,
      }),
      ruleHash: cacheDigest({
        taskVersion: input.taskVersion,
        ruleVersion: input.ruleVersion ?? 'no-active-rule',
      }),
      configurationHash: cacheDigest({
        instruction: input.instruction,
        request: {
          ...input.requestSettings,
          headers: undefined,
          cookies: undefined,
          proxy: undefined,
        },
        browser: { ...input.browserSettings, actions: undefined, storageState: undefined },
        network: input.networkPolicy,
        forceBrowser: input.forceBrowser,
        useAi: input.useAi,
        sourceUrl: source.url,
        pagination: input.pagination,
        dataset: input.datasetSettings,
      }),
      providerHash: cacheDigest(
        input.useAi && identity
          ? {
              provider: identity.provider,
              model: identity.model,
              configuration: identity.configuration,
            }
          : 'deterministic',
      ),
      promptHash: cacheDigest([
        this.options.promptVersion ?? RULE_CACHE_VERSIONS.prompt,
        this.options.toolSchemaVersion ?? RULE_CACHE_VERSIONS.tools,
        input.useAi ? identity?.promptVersion : undefined,
        input.useAi ? identity?.toolSchemaVersion : undefined,
      ]),
      actionHash: cacheDigest(input.browserSettings.actions),
      structureHash: fingerprint ?? cacheDigest(null),
      keyHash: '',
    };
    key.keyHash = cacheDigest({ ...key, keyHash: undefined });
    let generation = 0;
    let writable = !bypass;
    if (writable) {
      try {
        const read = await this.repository.readValidatedCache(key.scopeHash, 'rule');
        generation = read.generation;
        if (read.entry) {
          const entry = read.entry;
          let cached: CachedPayload | undefined;
          try {
            if (
              !validEntryMetadata(entry) ||
              Buffer.byteLength(entry.payload) > 32_768 ||
              createHash('sha256').update(entry.payload).digest('hex') !== entry.payloadHash
            )
              throw new Error('Corrupt cache');
            cached = decodePayload(entry.payload);
            if (
              persistenceRejection(cached.plan, input, source, cached.projection) ||
              (composed(cached.plan, { ...input, pagination: { type: 'none' } }) && !cached.base)
            )
              throw new Error('Unsafe cache');
          } catch {
            cached = undefined;
            result.reason = 'corrupt';
          }
          if (cached) {
            result.reason = invalidation(
              cached.base ? { ...entry, ...keyWithEvidence(entryKey(entry), cached.base) } : entry,
              key,
              now,
            );
            if (['matched', 'structure_changed'].includes(result.reason)) {
              const currentPlan = cached.projection
                ? restoreRuleActionValues(cached.projection, input.browserSettings.actions)
                : cached.plan;
              if (!currentPlan) {
                result.reason = 'corrupt';
              } else {
                const validation = await qualify(currentPlan, input, source, key);
                const preview = validation.preview;
                result.previousValidated = preview !== null;
                if (
                  preview &&
                  input.useAi &&
                  cacheDigest(ai.cacheIdentity) !== cacheDigest(identity)
                ) {
                  result.reason = 'provider_changed';
                  writable = false;
                } else if (preview) {
                  const actualReason = invalidation(entry, validation.key, now);
                  if (actualReason === 'session_changed') {
                    result.reason = actualReason;
                  } else {
                    result.reason = actualReason;
                    input.signal?.throwIfAborted();
                    const accepted =
                      actualReason === 'matched'
                        ? await this.repository.hitValidatedCache(
                            entry.keyHash,
                            entry.payloadHash,
                            generation,
                          )
                        : await this.repository.writeValidatedCache(
                            {
                              ...entry,
                              ...validation.key,
                              hitCount: entry.hitCount + 1,
                              payload: encodePayload(currentPlan, input, key),
                              payloadHash: createHash('sha256')
                                .update(encodePayload(currentPlan, input, key))
                                .digest('hex'),
                            },
                            generation,
                          );
                    if (accepted)
                      return {
                        candidate: currentPlan,
                        preview,
                        cache: {
                          ...result,
                          status: actualReason === 'matched' ? 'hit' : 'stored',
                          hitCount: entry.hitCount + 1,
                        },
                      };
                    result.reason = 'cleared_during_analysis';
                    return {
                      candidate: currentPlan,
                      preview,
                      cache: { ...result, status: 'miss' },
                    };
                  }
                } else {
                  if (validation.rejection || result.reason === 'matched')
                    result.reason = validation.rejection ?? 'validation_failed';
                  if (validation.noReplay)
                    return {
                      candidate: currentPlan,
                      preview: [],
                      cache: { ...result, status: 'miss' },
                    };
                }
              }
            }
          }
          // Keep the old entry until a replacement has passed every validation and CAS.
        }
      } catch {
        input.signal?.throwIfAborted();
        result.reason = 'storage_unavailable';
        writable = false;
      }
    }
    if (!generate) return null;
    const generated = await generate();
    input.signal?.throwIfAborted();
    result.providerCalls = generated.providerCalls;
    const candidate = crawlPlanDefinitionSchema.parse(generated.candidate);
    const validation = await qualify(candidate, input, source, key);
    const preview = validation.preview;
    const rejection = validation.rejection;
    if (!generated.generated && input.useAi) {
      result.reason = 'generation_failed';
      writable = false;
    } else if (rejection || !preview) {
      result.reason = rejection ?? 'validation_failed';
      writable = false;
    } else if (input.useAi && cacheDigest(ai.cacheIdentity) !== cacheDigest(identity)) {
      result.reason = 'provider_changed';
      writable = false;
    }
    if (writable) {
      const payload = encodePayload(candidate, input, key);
      const ttl = Math.min(7 * 86_400_000, Math.max(1, this.options.ttlMs ?? 86_400_000));
      try {
        result.status = (await this.repository.writeValidatedCache(
          {
            ...validation.key,
            payload,
            payloadHash: createHash('sha256').update(payload).digest('hex'),
            createdAt: now,
            expiresAt: now + ttl,
            hitCount: 0,
          },
          generation,
        ))
          ? 'stored'
          : 'miss';
        if (result.status === 'miss') result.reason = 'cleared_during_analysis';
      } catch {
        input.signal?.throwIfAborted();
        result.status = 'miss';
        result.reason = 'storage_unavailable';
      }
    }
    return {
      candidate,
      preview:
        preview ??
        extractData(
          source.input,
          candidate.list.rule,
          source.url,
          candidate.list.source,
        ).records.slice(0, 10),
      cache: result,
    };
  }
}
