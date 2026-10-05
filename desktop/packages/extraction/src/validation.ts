import * as cheerio from 'cheerio';
import { JSDOM } from 'jsdom';
import { JSONPath } from 'jsonpath-plus';
import {
  ExtractionError,
  type CrawlPlanDefinition,
  type ExtractionRuleDefinition,
} from '@zhiyun/shared';

function validateJsonPath(path: string) {
  if (!path.startsWith('$') && !path.startsWith('@'))
    throw new Error('JSONPath must start with $ or @');
  const stack: string[] = [];
  let quote = '',
    escaped = false;
  for (const character of path) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '[' || character === '(') stack.push(character);
    if (character === ']' && stack.pop() !== '[') throw new Error('Unbalanced JSONPath brackets');
    if (character === ')' && stack.pop() !== '(')
      throw new Error('Unbalanced JSONPath parentheses');
  }
  if (stack.length || quote || escaped) throw new Error('Incomplete JSONPath');
  JSONPath({ path, json: { items: [{ value: 1 }] }, eval: 'safe' });
}

export function validateExtractionRule(rule: ExtractionRuleDefinition): void {
  if (!Object.keys(rule.fields).length)
    throw new ExtractionError('Choose at least one extraction field');
  const expressions = [
    rule.container,
    ...Object.values(rule.fields)
      .filter((field) => !('value' in field) || field.value !== 'index')
      .map((field) => ('selector' in field ? field.selector : field.path)),
  ];
  try {
    if (rule.type === 'css') {
      const $ = cheerio.load('<main><article><a href="/fixture">fixture</a></article></main>');
      for (const expression of expressions) $.root().find(expression);
    } else if (rule.type === 'xpath') {
      const dom = new JSDOM('<main><article>fixture</article></main>');
      try {
        for (const expression of expressions)
          dom.window.document.evaluate(
            expression,
            dom.window.document.body,
            null,
            dom.window.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
            null,
          );
      } finally {
        dom.window.close();
      }
    } else {
      for (const expression of expressions) validateJsonPath(expression);
    }
  } catch (error) {
    throw new ExtractionError(
      `Invalid ${rule.type} selector or field path; correct the rule before previewing`,
      error,
    );
  }
}

export function validateCrawlPlan(plan: CrawlPlanDefinition): void {
  if (!plan.discovery) validateExtractionRule(plan.list.rule);
  if (plan.detail) {
    validateExtractionRule(plan.detail.rule);
    const link = plan.list.rule.fields[plan.detail.urlField];
    if (!link && plan.discovery?.urlField !== plan.detail.urlField)
      throw new ExtractionError('The detail URL field must exist in the list rule');
    if (link && !['string', 'url'].includes(link.dataType))
      throw new ExtractionError('The detail URL field must be a string or URL');
  }
}
