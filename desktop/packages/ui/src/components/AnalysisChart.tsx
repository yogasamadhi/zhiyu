import { useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, ScatterChart, BoxplotChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { useTranslation } from 'react-i18next';
import type { AnalyticsResult } from '@zhiyun/client';
import { analysisChartOption } from '../analysis-chart.js';

echarts.use([
  BarChart,
  LineChart,
  ScatterChart,
  BoxplotChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);
export function AnalysisChart({
  series,
  context,
}: {
  series: AnalyticsResult['series'][number];
  context: Pick<AnalyticsResult, 'methodId' | 'parameters'>;
}) {
  const { t } = useTranslation();
  const element = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const chart = useMemo(() => analysisChartOption(series, context), [series, context]);
  useEffect(() => {
    const container = element.current;
    if (!container || !chart.option) return;
    let instance: echarts.ECharts | undefined;
    let observer: ResizeObserver | undefined;
    try {
      instance = echarts.init(container, undefined, { renderer: 'canvas' });
      instance.setOption(chart.option, { notMerge: true });
      observer = new ResizeObserver(() => {
        try {
          instance?.resize();
        } catch {
          setFailed(true);
        }
      });
      observer.observe(container);
    } catch {
      setFailed(true);
    }
    return () => {
      observer?.disconnect();
      try {
        echarts.dispose(container);
      } catch {
        /* A failed initialization may have disposed itself. */
      }
    };
  }, [chart]);
  if (failed) throw new Error('Analysis chart renderer failed');
  if (!chart.option) return <p role="status">{t(`analytics.${chart.reason}`)}</p>;
  return (
    <div
      className="analysis-chart"
      role="img"
      aria-label={t('analytics.chartLabel', { name: series.id })}
    >
      <div ref={element} style={{ height: 360, width: '100%' }} />
    </div>
  );
}
