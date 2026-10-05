import * as cheerio from 'cheerio';
import { extractSourceData } from '@zhiyun/extraction';
import { redactSensitiveText, type CrawlPlanDefinition } from '@zhiyun/contracts';
import type { CollectionTaskForAi } from '../contracts/index.js';
import { assertRepairCandidate } from './repair-validation.js';

const privateName = /token|secret|password|passwd|cookie|auth|credential|api.?key|csrf|signature/i;
const maximumSourceBytes = 1_048_576;
const maximumSampleBytes = 200_000;
const publicParameters =
  /^(?:page|page_?no|page_?size|offset|limit|sort|sort_?by|order|q|query|search|category|lang|locale)$/i;
const structuralAttributes = new Set([
  'id',
  'class',
  'name',
  'type',
  'data-testid',
  'data-test',
  'data-qa',
  'data-cy',
]);
const roles = new Set(['button', 'link', 'tab', 'checkbox', 'textbox', 'combobox', 'listbox']);

/** The model receives structure, not form state, configured actions or page instructions. */
export function prepareRuleRepairInput(
  task: CollectionTaskForAi,
  original: CrawlPlanDefinition,
  source: { text: string; finalUrl: string; contentType: string },
  error: string,
) {
  if (Buffer.byteLength(source.text) > maximumSourceBytes)
    throw new Error('Repair source exceeds the complete privacy scan limit');
  const secrets = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string' && value) secrets.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(task.requestSettings.headers);
  collect(task.requestSettings.proxy);
  collect(task.browserSettings.storageState);
  for (const [name, value] of Object.entries(task.requestSettings.headers)) {
    if (/authorization/i.test(name)) collect(value.replace(/^(?:Bearer|Basic)\s+/i, ''));
    if (/cookie/i.test(name))
      for (const part of value.split(';')) collect(part.slice(part.indexOf('=') + 1).trim());
  }
  task.requestSettings.cookies.forEach((cookie) => collect(cookie.value));
  for (const action of [
    ...task.browserSettings.actions,
    ...original.list.actions,
    ...(original.detail?.actions ?? []),
  ]) {
    if ('value' in action) collect(action.value);
    if ('expectedState' in action) {
      for (const check of action.expectedState?.checks ?? [])
        if (check.type === 'attribute') collect(check.value);
    }
    if (action.type === 'waitFor') {
      if (action.target?.sensitive) collect(action.selector);
      for (const match of action.selector.matchAll(/["']([^"']+)["']/g)) collect(match[1]);
      if (action.target?.sensitive)
        for (const match of action.selector.matchAll(/[.#]([\w-]+)/g)) collect(match[1]);
    }
  }
  for (const value of [task.startUrl, source.finalUrl]) {
    const url = new URL(value);
    collect(url.username);
    collect(url.password);
    for (const [name, child] of url.searchParams) if (!publicParameters.test(name)) collect(child);
  }
  const $ = cheerio.load(source.text);
  let nodes = 0;
  const scan = (value: unknown, depth = 0): void => {
    if (depth > 64 || ++nodes > 20_000)
      throw new Error('Repair source exceeds the complete privacy scan limit');
    if (!value || typeof value !== 'object') return;
    for (const [name, child] of Object.entries(value)) {
      if (privateName.test(name)) collect(child);
      scan(child, depth + 1);
    }
  };
  let json: unknown;
  const embedded = original.list.rule.type === 'json' && original.list.source;
  if (embedded) json = extractSourceData(source.text, embedded);
  else if (source.contentType.includes('json') || /^[\s]*[[{]/.test(source.text))
    json = JSON.parse(source.text);
  if (json !== undefined) scan(json);
  nodes = 0;
  $('*').each((_index, element) => {
    if (!('attribs' in element)) return;
    if (++nodes > 20_000) throw new Error('Repair source exceeds the complete privacy scan limit');
    for (const [name, value] of Object.entries(element.attribs))
      if (privateName.test(name) || name === 'value') collect(value);
    if (element.tagName === 'textarea') collect($(element).text());
    if (element.tagName === 'meta' && privateName.test($(element).attr('name') ?? ''))
      collect($(element).attr('content'));
  });
  for (const match of source.text.matchAll(/Bearer\s+([A-Za-z0-9._~+/-]+=*)/gi)) collect(match[1]);
  for (const match of source.text.matchAll(
    /(?:token|secret|password|cookie|authorization|credential|api.?key|csrf)["']?\s*[:=]\s*["']([^"']+)["']/gi,
  ))
    collect(match[1]);
  const representations = new Set<string>();
  for (const secret of secrets) {
    representations.add(secret);
    representations.add(encodeURIComponent(secret));
    representations.add(JSON.stringify(secret).slice(1, -1));
    representations.add(cheerio.load('<span></span>')('span').text(secret).html() ?? '');
  }
  const values = [...representations]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const shortPatterns = new Map(
    values
      .filter((value) => value.length < 3)
      .map((value) => [
        value,
        new RegExp(
          `(?<![\\p{L}\\p{N}_])${value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`,
          'u',
        ),
      ]),
  );
  const containsPrivate = (value: string) =>
    values.some((secret) =>
      secret.length < 3 ? shortPatterns.get(secret)!.test(value) : value.includes(secret),
    );
  const scrub = (value: string, replacement = '[REDACTED]') =>
    values.reduce(
      (text, secret) =>
        secret.length < 3
          ? text.replaceAll(new RegExp(shortPatterns.get(secret)!.source, 'gu'), replacement)
          : text.replaceAll(secret, replacement),
      value,
    );
  const masked: Array<{ path: string[]; original: string; projected: string }> = [];
  const project = (value: unknown, path: string[] = []): unknown => {
    if (typeof value === 'string') {
      const safe = scrub(value, 'redacted-private');
      if (safe !== value) masked.push({ path, original: value, projected: safe });
      return safe;
    }
    if (Array.isArray(value))
      return value.map((child, index) => project(child, [...path, String(index)]));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([name, child]) => {
        if (containsPrivate(name))
          throw new Error('Repair field names contain private configuration');
        return [name, project(child, [...path, name])];
      }),
    );
  };
  const local = structuredClone(original);
  local.list.actions = [];
  if (local.detail) local.detail.actions = [];
  const current = project(local) as CrawlPlanDefinition;
  const jsonShape = (value: unknown, depth = 0): unknown => {
    if (depth > 64) throw new Error('Repair source exceeds the complete privacy scan limit');
    if (Array.isArray(value)) return value.slice(0, 3).map((child) => jsonShape(child, depth + 1));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([name, child]) => [scrub(name), jsonShape(child, depth + 1)]),
      );
    return value === null
      ? null
      : typeof value === 'string'
        ? ''
        : typeof value === 'number'
          ? 0
          : typeof value === 'boolean'
            ? false
            : null;
  };
  let html: string;
  if (json !== undefined) html = JSON.stringify(jsonShape(json));
  else {
    $('script,style,noscript,svg,canvas,iframe,template').remove();
    $('*').each((_index, element) => {
      if (!('attribs' in element)) return;
      for (const [name, value] of Object.entries(element.attribs)) {
        if (containsPrivate(name)) $(element).removeAttr(name);
        else if (name === 'role' && roles.has(value)) continue;
        else if (
          structuralAttributes.has(name) &&
          value.length <= 128 &&
          /^[\p{L}\p{N}_ .:#/-]*$/u.test(value)
        )
          $(element).attr(name, scrub(value, 'redacted-private'));
        else $(element).attr(name, '');
      }
      $(element)
        .contents()
        .filter((_index, child) => child.type === 'text' || child.type === 'comment')
        .remove();
    });
    html = $.html();
  }
  if (Buffer.byteLength(html) > maximumSampleBytes)
    throw new Error('Repair structural sample exceeds its model input limit');
  const safeInstruction = scrub(redactSensitiveText(task.instruction)).slice(0, 4000);
  const safeError = scrub(redactSensitiveText(error)).slice(0, 2000);
  if (containsPrivate(html) || containsPrivate(safeInstruction) || containsPrivate(safeError))
    throw new Error('Repair input could not be safely redacted');
  return {
    html,
    current,
    instruction: safeInstruction,
    error: safeError,
    restore(candidate: CrawlPlanDefinition, explanation: string) {
      const inspect = (value: unknown): void => {
        if (typeof value === 'string' && containsPrivate(value))
          throw new Error('Repair response reflects private configuration');
        if (Array.isArray(value)) value.forEach(inspect);
        else if (value && typeof value === 'object')
          for (const [name, child] of Object.entries(value)) {
            inspect(name);
            inspect(child);
          }
      };
      inspect(candidate);
      assertRepairCandidate(current, candidate);
      const restored = structuredClone(candidate);
      for (const field of masked) {
        let parent = restored as unknown as Record<string, unknown>;
        for (const name of field.path.slice(0, -1))
          parent = parent[name] as Record<string, unknown>;
        const name = field.path.at(-1)!;
        if (parent[name] === field.projected) parent[name] = field.original;
      }
      restored.list.actions = structuredClone(original.list.actions);
      if (restored.detail && original.detail)
        restored.detail.actions = structuredClone(original.detail.actions);
      assertRepairCandidate(original, restored);
      return {
        definition: restored,
        explanation: scrub(redactSensitiveText(explanation)).slice(0, 2000),
      };
    },
  };
}
