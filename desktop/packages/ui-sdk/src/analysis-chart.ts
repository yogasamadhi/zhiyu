import type { AnalyticsResult } from '@zhiyun/client';

export function analysisChartOption(
  series: AnalyticsResult['series'][number],
  context?: Pick<AnalyticsResult, 'methodId' | 'parameters'>,
) {
  const { type } = series;
  const encoding = series.encoding ?? legacyEncoding(series.id, context);
  if (!['bar', 'line', 'scatter', 'boxplot'].includes(type))
    return { reason: 'unsupportedChart' } as const;
  if (
    !encoding?.xFields.length ||
    !encoding.yFields.length ||
    (type === 'boxplot' && encoding.yFields.length !== 5)
  )
    return { reason: 'missingEncoding' } as const;
  const points = series.data.slice(0, 200);
  if (!points.length) return { reason: 'emptyChart' } as const;
  if (
    points.some((row) =>
      [...encoding.xFields, ...encoding.yFields].some((field) => !Object.hasOwn(row, field)),
    )
  )
    return { reason: 'missingEncoding' } as const;
  const label = (row: Record<string, unknown>) =>
    encoding.xFields.length === 1
      ? String(row[encoding.xFields[0]!] ?? '—')
      : JSON.stringify(encoding.xFields.map((field) => row[field]));
  const numeric = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (
    type === 'scatter' &&
    (encoding.xFields.length !== 1 ||
      points.some((row) => numeric(row[encoding.xFields[0]!]) === null))
  )
    return { reason: 'missingEncoding' } as const;
  const data =
    type === 'boxplot'
      ? [
          {
            name: series.id,
            type,
            data: points.map((row) => {
              const values = encoding.yFields.map((field) => numeric(row[field]));
              return values.every((value) => value !== null) ? values : null;
            }),
          },
        ]
      : encoding.yFields.map((field) => ({
          name: field,
          type,
          data: points.map((row) =>
            type === 'scatter'
              ? [numeric(row[encoding.xFields[0]!]), numeric(row[field])]
              : numeric(row[field]),
          ),
        }));
  if (
    !data.some((item) =>
      item.data.some((value) =>
        Array.isArray(value) ? value.every((item) => item !== null) : value !== null,
      ),
    )
  )
    return { reason: 'emptyChart' } as const;
  // Axes follow metadata, and rich text tooltips never execute field values as HTML.
  return {
    option: {
      animation: false,
      tooltip: { trigger: 'axis', renderMode: 'richText' },
      legend: { type: 'scroll' },
      grid: { left: 64, right: 24, top: 48, bottom: 80, containLabel: true },
      xAxis: {
        type: type === 'scatter' ? 'value' : 'category',
        ...(type === 'scatter' ? {} : { data: points.map(label) }),
        axisLabel: { hideOverlap: true },
      },
      yAxis: { type: 'value', scale: type === 'boxplot' },
      series: data,
    },
  };
}

function legacyEncoding(id: string, context?: Pick<AnalyticsResult, 'methodId' | 'parameters'>) {
  if (!context) return undefined;
  const { parameters } = context;
  if (context.methodId === 'group.aggregate' && id === 'groups') {
    const xFields = stringFields(parameters.groupFields),
      values = stringFields(parameters.valueFields),
      operations = stringFields(parameters.aggregations);
    if (xFields && values && operations)
      return {
        xFields,
        yFields: [
          ...values.flatMap((field) =>
            operations
              .filter((operation) => operation !== 'count')
              .map((operation) => `${field}_${operation}`),
          ),
          ...(operations.includes('count') ? ['count'] : []),
        ],
      };
  }
  if (
    context.methodId === 'time.trend' &&
    id === 'trend' &&
    typeof parameters.timeField === 'string'
  )
    return { xFields: [parameters.timeField], yFields: ['value', 'movingAverage'] };
  const known: Record<string, { id: string; xFields: string[]; yFields: string[] }> = {
    'category.frequency': { id: 'frequency', xFields: ['value'], yFields: ['count'] },
    'text.profile': { id: 'keywords', xFields: ['token'], yFields: ['count'] },
    'text.tfidf': { id: 'keywords', xFields: ['term'], yFields: ['score'] },
    'time.arima': { id: 'forecast', xFields: ['step'], yFields: ['forecast', 'lower', 'upper'] },
    'ml.pca': { id: 'projection', xFields: ['component1'], yFields: ['component2'] },
    'stats.outliers': { id: 'outlierSummary', xFields: ['field'], yFields: ['outlierCount'] },
  };
  const selected = Object.hasOwn(known, context.methodId) ? known[context.methodId] : undefined;
  return selected?.id === id ? { xFields: selected.xFields, yFields: selected.yFields } : undefined;
}

function stringFields(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.length && value.every((item) => typeof item === 'string')
    ? (value as string[])
    : undefined;
}
