import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { AnalysisMethodDescriptor, AnalyticsResult } from '@zhiyun/client';
import type { DatasetFieldDescription } from '@zhiyun/shared';
import {
  hasValidAnalysisParameters,
  recommendAnalysisQuestions,
} from '../src/analysis-questions.js';
import { analysisChartOption } from '../src/analysis-chart.js';
import { ResultTable } from '../src/components/analysis/ResultCollection.js';
import { ResultProvenance } from '../src/components/analysis/ResultActions.js';
import '../src/i18n.js';

const field = (name: string, type: DatasetFieldDescription['type']): DatasetFieldDescription => ({
  name,
  type,
  sampleCount: 10,
  missingCount: 0,
});
const descriptor = (
  id: string,
  parameterSchema: Record<string, unknown> = {},
): AnalysisMethodDescriptor =>
  ({
    id,
    version: '1.0.0',
    category: 'statistics',
    titleKey: id,
    descriptionKey: id,
    supportedFieldTypes: ['number'],
    parameterSchema,
    outputSchema: {},
    recommendedVisualizations: ['table'],
    resourceLimits: {},
    supportsSampling: false,
  }) as AnalysisMethodDescriptor;
const catalog = ['group.aggregate', 'time.trend', 'stats.descriptive', 'stats.outliers'].map((id) =>
  descriptor(id),
);

describe('analysis recommendations and frozen result presentation', () => {
  it('recommends literal names and explains absent types without interpreting comma-separated names', () => {
    const questions = recommendAnalysisQuestions(
      [field('a,b', 'text'), field('__proto__', 'number'), field('日期', 'date')],
      catalog,
    );
    expect(questions.every((question) => question.reason === null)).toBe(true);
    expect(questions[0]!.parameters).toEqual({
      groupFields: ['a,b'],
      valueFields: ['__proto__'],
      aggregations: ['mean'],
    });
    expect(questions[1]!.parameters).toMatchObject({
      timeField: '日期',
      valueField: '__proto__',
      aggregation: 'mean',
    });
    expect(
      recommendAnalysisQuestions([field('label', 'text')], catalog).map(
        (question) => question.reason,
      ),
    ).toEqual(['noNumber', 'noDate', 'noNumber', 'noNumber']);
    expect(
      recommendAnalysisQuestions([], catalog).every((question) => question.reason === 'noFields'),
    ).toBe(true);
    expect(
      recommendAnalysisQuestions([field('date', 'date')], catalog)[1]!.parameters,
    ).toMatchObject({ aggregation: 'count' });
    expect(recommendAnalysisQuestions([field('value', 'number')], [])[0]!.reason).toBe(
      'methodUnavailable',
    );
  });
  it('rejects bounds, NaN, duplicate and invalid field selections and optional empty strings', () => {
    const method = descriptor('stats.outliers', {
      type: 'object',
      additionalProperties: false,
      required: ['fields'],
      properties: {
        fields: {
          type: 'array',
          format: 'field-list',
          minItems: 1,
          maxItems: 2,
          uniqueItems: true,
          items: { type: 'string' },
        },
        threshold: { type: 'number', minimum: 0.1, maximum: 10 },
        order: { type: 'integer', minimum: 1, maximum: 10 },
        choice: { type: 'string', enum: ['one'] },
      },
    });
    const fields = [field('value', 'number'), field('text', 'text')];
    expect(hasValidAnalysisParameters(method, { fields: ['value'], threshold: 1.5 }, fields)).toBe(
      true,
    );
    for (const parameters of [
      { fields: [] },
      { fields: ['text'] },
      { fields: ['value', 'value'] },
      { fields: ['missing'] },
      { fields: ['value'], threshold: NaN },
      { fields: ['value'], threshold: 11 },
      { fields: ['value'], order: 1.5 },
      { fields: ['value'], choice: '' },
      { fields: ['value'], code: 'print(1)' },
    ])
      expect(hasValidAnalysisParameters(method, parameters, fields)).toBe(false);
    const trend = descriptor('time.trend', {
      required: ['timeField'],
      properties: {
        timeField: { type: 'string', format: 'field-selector' },
        valueField: { type: 'string', minLength: 1, format: 'field-selector' },
      },
    });
    expect(
      hasValidAnalysisParameters(trend, { timeField: 'date', aggregation: 'mean' }, [
        field('date', 'date'),
      ]),
    ).toBe(false);
    expect(
      hasValidAnalysisParameters(trend, { timeField: 'date', aggregation: 'count' }, [
        field('date', 'date'),
      ]),
    ).toBe(true);
  });
  it('maps multiple values and composite groups independently of JSON key order', () => {
    const series = {
      id: 'groups',
      type: 'bar',
      encoding: { xFields: ['group', 'other'], yFields: ['mean', 'sum'] },
      data: [{ sum: 12, mean: 3, group: '<script>unsafe</script>', other: 'b' }],
    };
    const chart = analysisChartOption(series).option!;
    expect(chart.xAxis.data).toEqual(['["<script>unsafe</script>","b"]']);
    expect(chart.series.map((item) => item.data)).toEqual([[3], [12]]);
    expect(chart.tooltip.renderMode).toBe('richText');
    expect(
      analysisChartOption({
        ...series,
        data: [{ other: 'b', group: '<script>unsafe</script>', mean: 3, sum: 12 }],
      }).option,
    ).toEqual(chart);
  });
  it('maps quartiles and numerical scatter axes and falls back honestly for unknown or empty output', () => {
    const box = {
      id: 'descriptive',
      type: 'boxplot',
      encoding: { xFields: ['field'], yFields: ['min', 'q25', 'median', 'q75', 'max'] },
      data: [{ field: 'value', min: 0, q25: 1, median: 2, q75: 3, max: 4 }],
    };
    expect(analysisChartOption(box).option!.series[0]!.data).toEqual([[0, 1, 2, 3, 4]]);
    expect(analysisChartOption({ ...box, data: [] }).reason).toBe('emptyChart');
    expect(analysisChartOption({ ...box, type: 'pie' }).reason).toBe('unsupportedChart');
    expect(analysisChartOption({ id: 'unknown', type: 'bar', data: [{ guess: 1 }] }).reason).toBe(
      'missingEncoding',
    );
    const scatter = analysisChartOption(
      { id: 'projection', type: 'scatter', data: [{ component2: 5, component1: 2 }] },
      { methodId: 'ml.pca', parameters: {} },
    ).option!;
    expect(scatter.xAxis.type).toBe('value');
    expect(scatter.series[0]!.data).toEqual([[2, 5]]);
    expect(
      analysisChartOption(
        { id: 'frequency', type: 'bar', data: [{ value: 'x', count: 3 }] },
        { methodId: 'category.frequency', parameters: {} },
      ).option!.series[0]!.data,
    ).toEqual([3]);
  });
  it('renders typed empty tables and bounded first pages without leaking markup from values', () => {
    const table: AnalyticsResult['tables'][number] = {
      id: 'samples',
      columns: [{ name: 'value' }],
      rows: [{ value: '<script>sample</script>' }],
      totalRows: 550,
      nextCursor: 'opaque-cursor',
    };
    const query = new QueryClient();
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: query },
        createElement(ResultTable, { resultId: 'result', table }),
      ),
    );
    expect(html).toContain('&lt;script&gt;sample&lt;/script&gt;');
    expect(html).toContain('550');
    expect(html).toContain('下一页');
    const empty = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: query },
        createElement(ResultTable, {
          resultId: 'result',
          table: { ...table, rows: [], totalRows: 0, nextCursor: null },
        }),
      ),
    );
    expect(empty).toContain('<th>数值</th>');
    expect(empty).toContain('data-testid="analysis-table-samples"');
    expect(empty).toContain('没有记录');
    query.clear();
  });
  it('links the saved Snapshot and cleaning version rather than a mutable latest version', () => {
    const result: AnalyticsResult = {
      id: 'result',
      snapshotId: 'frozen-input',
      datasetId: 'dataset',
      methodId: 'stats.outliers',
      methodVersion: '1.0.0',
      state: 'succeeded',
      createdAt: '2026-01-01T00:00:00Z',
      jobId: 'job',
      summary: {},
      metrics: {},
      warnings: [],
      tables: [],
      series: [],
      artifacts: [],
      sampling: { applied: false, inputRows: 1, sampleRows: 1, seed: null },
      workerVersion: '1.0.0',
      parameters: { fields: ['<script>field</script>'], threshold: 1.5 },
      provenance: {
        version: 1,
        inputFingerprint: null,
        questionId: 'outliers',
        sourceSnapshotId: 'source',
        cleaningRecipeVersionId: 'version-1',
        cleaningStep: 3,
        parentResultId: 'parent',
        analysisRecipeId: 'recipe',
        analysisRecipeRevision: 1,
      },
    };
    const html = renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(ResultProvenance, { result })),
    );
    expect(html).toContain(
      '/datasets/dataset?snapshotId=frozen-input&amp;cleaningVersionId=version-1',
    );
    expect(html).toContain('/analytics/results/parent');
    expect(html).toContain('&lt;script&gt;field&lt;/script&gt;');
  });
});
