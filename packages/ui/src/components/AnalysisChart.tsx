import ReactEChartsCore from 'echarts-for-react/lib/core';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, ScatterChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  LineChart,
  ScatterChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export function AnalysisChart({ series }: { series: unknown }) {
  const items = Array.isArray(series) ? series : [];
  const mapped = items
    .filter(isObject)
    .slice(0, 20)
    .map((item) => {
      const data = (Array.isArray(item.data) ? item.data : []).slice(0, 10_000);
      const points = data.filter(isObject);
      const keys = Object.keys(points[0] ?? {});
      const categoryKey = keys.find((key) => typeof points[0]?.[key] === 'string') ?? keys[0];
      const valueKey = keys.find((key) => typeof points[0]?.[key] === 'number') ?? keys[1];
      return {
        name: String(item.id ?? 'series'),
        type: allowedType(item.type),
        data: points.map((point) =>
          categoryKey && valueKey ? [point[categoryKey], point[valueKey]] : point,
        ),
      };
    });
  if (!mapped.length) return null;
  return (
    <div className="analysis-chart" role="img" aria-label="Analysis visualization">
      <ReactEChartsCore
        echarts={echarts}
        notMerge
        lazyUpdate
        option={{
          animation: false,
          tooltip: { trigger: 'axis' },
          legend: { type: 'scroll' },
          grid: { left: 48, right: 24, top: 48, bottom: 48 },
          xAxis: { type: 'category' },
          yAxis: { type: 'value' },
          series: mapped,
        }}
      />
    </div>
  );
}

function allowedType(value: unknown): 'line' | 'bar' | 'scatter' {
  return value === 'line' || value === 'scatter' ? value : 'bar';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
