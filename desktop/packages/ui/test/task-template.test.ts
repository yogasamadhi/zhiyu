import { describe, expect, it } from 'vitest';
import type { TaskTemplate } from '@zhiyun/shared';
import {
  applyTemplateParameters,
  missingTemplateParameters,
  templateParameterDefaults,
} from '../src/task-template.js';

const template = {
  parameters: [
    { key: 'container', label: 'Container', type: 'selector', required: true },
    { key: 'title', label: 'Title', type: 'selector', required: true, defaultValue: '.title' },
  ],
  ruleDefinition: {
    version: 1,
    list: {
      mode: 'auto',
      actions: [],
      rule: {
        type: 'css',
        container: '{{container}}',
        fields: { title: { selector: '{{title}}', value: 'text', dataType: 'string' } },
      },
    },
    pagination: { type: 'none' },
    dedupe: { strategy: 'recordHash', fields: [] },
    limits: { maxRecords: 100 },
  },
} as unknown as TaskTemplate;

describe('task template helpers', () => {
  it('collects defaults and safely preserves unresolved placeholders', () => {
    expect(templateParameterDefaults(template)).toEqual({ container: '', title: '.title' });
    const definition = applyTemplateParameters(template, { container: '.item', title: '' });
    expect(definition.list.rule).toMatchObject({
      container: '.item',
      fields: { title: { selector: '{{title}}' } },
    });
  });

  it('names required parameters that still need user input', () => {
    expect(missingTemplateParameters(template, { container: '', title: '.title' })).toEqual([
      'Container',
    ]);
    expect(missingTemplateParameters(template, { container: '.item', title: '.title' })).toEqual(
      [],
    );
  });
});
