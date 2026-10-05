import * as cheerio from 'cheerio';
import { JSDOM } from 'jsdom';
import { JSONPath } from 'jsonpath-plus';
export { validateCrawlPlan, validateExtractionRule } from './validation.js';
import {
  ExtractionError,
  createWarningBuffer,
  type DomFieldRule,
  type ExtractionRuleDefinition,
  type ExtractionSource,
  type PreviewInspection,
} from '@zhiyun/shared';

export interface ExtractionOutput {
  records: Array<Record<string, unknown>>;
  warnings: string[];
  inspections?: PreviewInspection[];
}

export interface ExtractionOptions {
  inspect?: boolean;
}

function inspectField(raw: unknown, value: unknown, matches: number) {
  const status =
    matches === 0
      ? 'missing'
      : raw == null || (typeof raw === 'string' && raw.trim() === '')
        ? 'empty'
        : value === null
          ? 'invalid_type'
          : 'valid';
  return { status, matches } as PreviewInspection['fields'][string];
}

function containerHint(element: Element | null): PreviewInspection['containerHint'] {
  if (element?.closest('nav,header,footer,[role="navigation"]')) return 'navigation';
  if (element?.closest('.ad,.ads,.advertisement,[data-ad],[aria-label="Advertisement"]'))
    return 'advertisement';
  return 'content';
}

function toNumber(value: string): number | null {
  const normalized = value.replace(/[^0-9.,+-]/g, '').replace(/,(?=\d{3}(?:\D|$))/g, '');
  if (!normalized.trim()) return null;
  const result = Number(normalized.replace(',', '.'));
  return Number.isFinite(result) ? result : null;
}

function convertValue(
  raw: unknown,
  dataType: 'string' | 'url' | 'number' | 'date' | 'json',
  sourceUrl: string,
  warnings: string[],
  field: string,
): unknown {
  if (raw === null || raw === undefined) return null;
  if (dataType === 'json') return raw;
  const text = typeof raw === 'string' ? raw.trim() : String(raw);
  if (dataType === 'string') return text;
  if (!text) return null;
  if (dataType === 'url') {
    try {
      return new URL(text, sourceUrl).toString();
    } catch {
      warnings.push(`Field ${field} is not a valid URL`);
      return null;
    }
  }
  if (dataType === 'number') {
    const result = toNumber(text);
    if (result === null) warnings.push(`Field ${field} is not a valid number`);
    return result;
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    warnings.push(`Field ${field} is not a valid date`);
    return null;
  }
  return date.toISOString();
}

function jsonAssignmentValue(source: string, marker: string): unknown {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`JSON assignment marker was not found: ${marker}`);
  const valueStart = source.slice(markerIndex + marker.length).search(/[[{]/);
  if (valueStart < 0) throw new Error(`JSON assignment has no object or array value: ${marker}`);
  const start = markerIndex + marker.length + valueStart;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') stack.push(character);
    else if (character === '}' || character === ']') {
      const opening = stack.pop();
      if ((character === '}' && opening !== '{') || (character === ']' && opening !== '[')) {
        throw new Error(`JSON assignment is unbalanced: ${marker}`);
      }
      if (stack.length === 0) return JSON.parse(source.slice(start, index + 1)) as unknown;
    }
  }
  throw new Error(`JSON assignment is incomplete: ${marker}`);
}

export function extractSourceData(input: string, source: ExtractionSource): unknown {
  if (source.type === 'script-json-assignment') {
    const $ = cheerio.load(input);
    for (const element of $(source.selector).toArray()) {
      const text = $(element).text();
      if (text.includes(source.marker)) return jsonAssignmentValue(text, source.marker);
    }
    throw new Error(`No ${source.selector} element contains marker ${source.marker}`);
  }
  return input;
}

function readCheerioField(
  root: ReturnType<cheerio.CheerioAPI>,
  field: DomFieldRule,
  index: number,
): string | null {
  if (field.value === 'index') return String(index + 1);
  const element = (field.selector.trim() === ':scope' ? root : root.find(field.selector)).first();
  if (element.length === 0) return null;
  if (field.value === 'html') return element.html();
  if (field.value === 'attribute') return element.attr(field.attribute ?? '') ?? null;
  return element.text();
}

function extractCss(
  html: string,
  rule: Extract<ExtractionRuleDefinition, { type: 'css' }>,
  sourceUrl: string,
  options?: ExtractionOptions,
): ExtractionOutput {
  const $ = cheerio.load(html);
  const records: Array<Record<string, unknown>> = [];
  const warnings = createWarningBuffer();
  const inspections: PreviewInspection[] = [];
  $(rule.container).each((index, element) => {
    const container = $(element);
    const record: Record<string, unknown> = {};
    const inspection: PreviewInspection = { fields: {}, containerHint: 'content' };
    if (options?.inspect) {
      if (container.closest('nav,header,footer,[role="navigation"]').length)
        inspection.containerHint = 'navigation';
      else if (
        container.closest('.ad,.ads,.advertisement,[data-ad],[aria-label="Advertisement"]').length
      )
        inspection.containerHint = 'advertisement';
    }
    for (const [name, field] of Object.entries(rule.fields)) {
      const raw = readCheerioField(container, field, index);
      record[name] = convertValue(raw, field.dataType, sourceUrl, warnings, name);
      if (options?.inspect) {
        const matches =
          field.value === 'index' || field.selector.trim() === ':scope'
            ? 1
            : container.find(field.selector).length;
        inspection.fields[name] = inspectField(raw, record[name], matches);
        if (field.value === 'attribute' && raw === null) inspection.fields[name].status = 'missing';
      }
    }
    records.push(record);
    if (options?.inspect) inspections.push(inspection);
  });
  return { records, warnings, ...(options?.inspect ? { inspections } : {}) };
}

function firstXPathNode(document: Document, context: Node, expression: string): Node | null {
  return document.evaluate(
    expression,
    context,
    null,
    document.defaultView?.XPathResult.FIRST_ORDERED_NODE_TYPE ?? 9,
    null,
  ).singleNodeValue;
}

function readXPathField(
  document: Document,
  container: Node,
  field: DomFieldRule,
  index: number,
): string | null {
  if (field.value === 'index') return String(index + 1);
  const node = firstXPathNode(document, container, field.selector);
  if (!node) return null;
  if (field.value === 'html' && node instanceof document.defaultView!.Element) {
    return node.innerHTML;
  }
  if (field.value === 'attribute' && node instanceof document.defaultView!.Element) {
    return node.getAttribute(field.attribute ?? '');
  }
  return node.textContent;
}

function extractXPath(
  html: string,
  rule: Extract<ExtractionRuleDefinition, { type: 'xpath' }>,
  sourceUrl: string,
  options?: ExtractionOptions,
): ExtractionOutput {
  const dom = new JSDOM(html, { url: sourceUrl });
  const { document } = dom.window;
  const snapshot = document.evaluate(
    rule.container,
    document,
    null,
    dom.window.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );
  const records: Array<Record<string, unknown>> = [];
  const warnings = createWarningBuffer();
  const inspections: PreviewInspection[] = [];
  for (let index = 0; index < snapshot.snapshotLength; index += 1) {
    const container = snapshot.snapshotItem(index);
    if (!container) continue;
    const record: Record<string, unknown> = {};
    const inspection: PreviewInspection = {
      fields: {},
      containerHint: containerHint(
        container.nodeType === 1 ? (container as Element) : container.parentElement,
      ),
    };
    for (const [name, field] of Object.entries(rule.fields)) {
      const raw = readXPathField(document, container, field, index);
      record[name] = convertValue(raw, field.dataType, sourceUrl, warnings, name);
      if (options?.inspect) {
        const matches =
          field.value === 'index'
            ? 1
            : document.evaluate(
                field.selector,
                container,
                null,
                dom.window.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
                null,
              ).snapshotLength;
        inspection.fields[name] = inspectField(raw, record[name], matches);
        if (field.value === 'attribute' && raw === null) inspection.fields[name].status = 'missing';
      }
    }
    records.push(record);
    if (options?.inspect) inspections.push(inspection);
  }
  dom.window.close();
  return { records, warnings, ...(options?.inspect ? { inspections } : {}) };
}

function jsonPath(path: string, json: unknown): unknown[] {
  return JSONPath({ path, json: json as object, wrap: true }) as unknown[];
}

function extractJson(
  input: unknown,
  rule: Extract<ExtractionRuleDefinition, { type: 'json' }>,
  sourceUrl: string,
  options?: ExtractionOptions,
): ExtractionOutput {
  const containers = jsonPath(rule.container, input);
  const warnings = createWarningBuffer();
  const inspections: PreviewInspection[] = [];
  const records = containers.map((container) => {
    const record: Record<string, unknown> = {};
    const inspection: PreviewInspection = { fields: {}, containerHint: 'content' };
    for (const [name, field] of Object.entries(rule.fields)) {
      const values = jsonPath(field.path, container);
      const raw = values[0] ?? null;
      record[name] = convertValue(raw, field.dataType, sourceUrl, warnings, name);
      if (options?.inspect)
        inspection.fields[name] = inspectField(raw, record[name], values.length);
    }
    if (options?.inspect) inspections.push(inspection);
    return record;
  });
  return { records, warnings, ...(options?.inspect ? { inspections } : {}) };
}

export function extractData(
  input: string | unknown,
  rule: ExtractionRuleDefinition,
  sourceUrl: string,
  source?: ExtractionSource,
  options?: ExtractionOptions,
): ExtractionOutput {
  try {
    const prepared = source
      ? typeof input === 'string'
        ? extractSourceData(input, source)
        : input
      : input;
    if (rule.type === 'json') {
      const json = typeof prepared === 'string' ? (JSON.parse(prepared) as unknown) : prepared;
      return extractJson(json, rule, sourceUrl, options);
    }
    if (source) throw new Error('Embedded JSON sources require a JSON extraction rule');
    if (typeof prepared !== 'string') throw new Error('HTML extraction requires a string input');
    return rule.type === 'css'
      ? extractCss(prepared, rule, sourceUrl, options)
      : extractXPath(prepared, rule, sourceUrl, options);
  } catch (error) {
    throw new ExtractionError('Could not extract data', error);
  }
}
