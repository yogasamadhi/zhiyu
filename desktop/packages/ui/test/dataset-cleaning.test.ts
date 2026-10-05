import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { cleaningResultSchema, cleaningStepSchema } from '@zhiyun/shared';
import {
  buildCleaningStep,
  cleaningExpectedFields,
  newCleaningStepDraft,
  projectedCleaningFields,
} from '../src/dataset-cleaning.js';
import { CleaningReport } from '../src/components/dataset-cleaning/CleaningReport.js';

describe('cleaning forms and bounded report presentation', () => {
  it('keeps source type expectations while later steps use newly derived columns', () => {
    const initial = { contact: 'string', value: 'string', unrelated: 'bool' } as const;
    const steps = [
      cleaningStepSchema.parse({
        type: 'split',
        field: 'contact',
        delimiter: '|',
        targets: ['first', 'last'],
      }),
      cleaningStepSchema.parse({ type: 'convert', fields: ['value'], targetType: 'number' }),
      cleaningStepSchema.parse({ type: 'merge', fields: ['first', 'last'], target: 'label' }),
    ];
    expect(cleaningExpectedFields(initial, steps)).toEqual({ contact: 'string', value: 'string' });
    expect(projectedCleaningFields(initial, steps)).toEqual({
      ...initial,
      value: 'float',
      first: 'string',
      last: 'string',
      label: 'string',
    });
    expect(initial.value).toBe('string');
  });
  it('preserves literal field names, whitespace tokens and empty null tokens', () => {
    const draft = {
      ...newCleaningStepDraft(),
      operation: 'normalize_null' as const,
      fields: ['a,b', '字段'],
      tokens: '\n null \nN/A',
    };
    expect(buildCleaningStep(draft)).toEqual({
      type: 'normalize_null',
      fields: ['a,b', '字段'],
      tokens: ['', ' null ', 'N/A'],
    });
    const columns = Object.fromEntries([
      ['__proto__', 'string' as const],
      ['constructor', 'string' as const],
    ]);
    const steps = [
      cleaningStepSchema.parse({ type: 'trim', fields: ['__proto__', 'constructor'] }),
    ];
    const expected = cleaningExpectedFields(columns, steps);
    expect(Object.keys(expected)).toEqual(['__proto__', 'constructor']);
    expect(Object.hasOwn(expected, '__proto__')).toBe(true);
    expect(
      projectedCleaningFields({}, [
        cleaningStepSchema.parse({ type: 'merge', fields: ['a', 'b'], target: '__proto__' }),
      ]),
    ).toEqual(Object.fromEntries([['__proto__', 'string']]));
  });
  it('rejects invalid targets and missing selections without offering an execution language', () => {
    expect(() => buildCleaningStep(newCleaningStepDraft())).toThrow();
    expect(() =>
      buildCleaningStep({
        ...newCleaningStepDraft(),
        operation: 'split',
        fields: ['name'],
        targets: ['a', 'a'],
      }),
    ).toThrow();
    expect(() =>
      buildCleaningStep({
        ...newCleaningStepDraft(),
        operation: 'merge',
        fields: ['a', 'b'],
        target: '__zhiyun_record_key',
      }),
    ).toThrow();
    expect(() =>
      buildCleaningStep({ ...newCleaningStepDraft(), operation: 'python' as never, fields: ['a'] }),
    ).toThrow();
  });
  const fingerprint = 'a'.repeat(64);
  const quality = {
    rowCount: 100,
    fields: {
      value: {
        type: 'string',
        nullCount: 10,
        blankCount: 0,
        invalidCount: 0,
        stringCount: 90,
        otherCount: 10,
        trackedDistinctCount: 50,
        omittedTrackedCount: 88,
        facetScope: 'first-50-distinct-values',
        facets: [{ value: '<script>sample</script>', valueTruncated: true, count: 2 }],
      },
    },
  };
  const report = cleaningResultSchema.parse({
    version: '1.0.0',
    inputFingerprint: fingerprint,
    fingerprint,
    inputRowCount: 100,
    rowCount: 100,
    parquetArtifactRef: 'sample',
    manifestArtifactRef: 'manifest',
    inputQuality: quality,
    outputQuality: quality,
    steps: [],
  });
  it('shows facet scope, omitted counts and ratios honestly in both languages', () => {
    for (const zh of [true, false]) {
      const html = renderToStaticMarkup(
        createElement(CleaningReport, {
          report,
          selectedStep: 0,
          onStepChange: () => undefined,
          zh,
        }),
      );
      expect(html).not.toContain('NaN');
      expect(html).not.toContain('Infinity');
      expect(html).toContain('50');
      expect(html).toContain('&lt;script&gt;sample&lt;/script&gt;');
      expect(html).toContain(zh ? '未跟踪值次数' : 'Untracked occurrences');
      expect(html).toContain(zh ? '已跟踪但未展示次数' : 'Tracked occurrences omitted');
      expect(html).toContain(zh ? '已截断' : 'truncated');
      expect(html).toContain('10.0%');
    }
  });
  it('does not invent a percentage for an empty Snapshot', () => {
    const emptyQuality = {
      rowCount: 0,
      fields: {
        value: {
          ...quality.fields.value,
          nullCount: 0,
          stringCount: 0,
          otherCount: 0,
          trackedDistinctCount: 0,
          omittedTrackedCount: 0,
          facets: [],
        },
      },
    };
    const empty = cleaningResultSchema.parse({
      ...report,
      inputRowCount: 0,
      rowCount: 0,
      inputQuality: emptyQuality,
      outputQuality: emptyQuality,
    });
    const html = renderToStaticMarkup(
      createElement(CleaningReport, {
        report: empty,
        selectedStep: 0,
        onStepChange: () => undefined,
        zh: true,
      }),
    );
    expect(html).not.toContain('NaN');
    expect(html).not.toContain('Infinity');
    expect(html).not.toContain('%');
    expect(html).toContain('0 / —');
  });
});
