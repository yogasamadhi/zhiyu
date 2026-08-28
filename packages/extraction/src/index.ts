import * as cheerio from 'cheerio';
import { JSDOM } from 'jsdom';
import { JSONPath } from 'jsonpath-plus';
import {
  ExtractionError,
  type DomFieldRule,
  type ExtractionRuleDefinition,
  type ExtractionSource,
} from '@zhiyun/shared';

export interface ExtractionOutput {
  records: Array<Record<string, unknown>>;
  warnings: string[];
}

function toNumber(value: string): number | null {
  const normalized = value.replace(/[^0-9.,+-]/g, '').replace(/,(?=\d{3}(?:\D|$))/g, '');
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
  const element = root.find(field.selector).first();
  if (element.length === 0) return null;
  if (field.value === 'html') return element.html();
  if (field.value === 'attribute') return element.attr(field.attribute ?? '') ?? null;
  return element.text();
}

function extractCss(
  html: string,
  rule: Extract<ExtractionRuleDefinition, { type: 'css' }>,
  sourceUrl: string,
): ExtractionOutput {
  const $ = cheerio.load(html);
  const records: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  $(rule.container).each((index, element) => {
    const container = $(element);
    const record: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(rule.fields)) {
      record[name] = convertValue(
        readCheerioField(container, field, index),
        field.dataType,
        sourceUrl,
        warnings,
        name,
      );
    }
    records.push(record);
  });
  return { records, warnings };
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
  const warnings: string[] = [];
  for (let index = 0; index < snapshot.snapshotLength; index += 1) {
    const container = snapshot.snapshotItem(index);
    if (!container) continue;
    const record: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(rule.fields)) {
      record[name] = convertValue(
        readXPathField(document, container, field, index),
        field.dataType,
        sourceUrl,
        warnings,
        name,
      );
    }
    records.push(record);
  }
  dom.window.close();
  return { records, warnings };
}

function jsonPath(path: string, json: unknown): unknown[] {
  return JSONPath({ path, json: json as object, wrap: true }) as unknown[];
}

function extractJson(
  input: unknown,
  rule: Extract<ExtractionRuleDefinition, { type: 'json' }>,
  sourceUrl: string,
): ExtractionOutput {
  const containers = jsonPath(rule.container, input);
  const warnings: string[] = [];
  const records = containers.map((container) => {
    const record: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(rule.fields)) {
      const raw = jsonPath(field.path, container)[0] ?? null;
      record[name] = convertValue(raw, field.dataType, sourceUrl, warnings, name);
    }
    return record;
  });
  return { records, warnings };
}

export function extractData(
  input: string | unknown,
  rule: ExtractionRuleDefinition,
  sourceUrl: string,
  source?: ExtractionSource,
): ExtractionOutput {
  try {
    const prepared = source
      ? typeof input === 'string'
        ? extractSourceData(input, source)
        : input
      : input;
    if (rule.type === 'json') {
      const json = typeof prepared === 'string' ? (JSON.parse(prepared) as unknown) : prepared;
      return extractJson(json, rule, sourceUrl);
    }
    if (source) throw new Error('Embedded JSON sources require a JSON extraction rule');
    if (typeof prepared !== 'string') throw new Error('HTML extraction requires a string input');
    return rule.type === 'css'
      ? extractCss(prepared, rule, sourceUrl)
      : extractXPath(prepared, rule, sourceUrl);
  } catch (error) {
    throw new ExtractionError('Could not extract data', error);
  }
}
