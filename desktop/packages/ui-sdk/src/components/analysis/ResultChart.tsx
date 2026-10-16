import { Component, lazy, Suspense, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnalyticsResult } from '@zhiyun/client';
import { Button, Card } from '../ui.js';
import { ResultCollection } from './ResultCollection.js';

const AnalysisChart = lazy(() =>
  import('../AnalysisChart.js').then((module) => ({ default: module.AnalysisChart })),
);
export class ChartErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
export function ResultChart({
  resultId,
  series,
  context,
}: {
  resultId: string;
  series: AnalyticsResult['series'][number];
  context: Pick<AnalyticsResult, 'methodId' | 'parameters'>;
}) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  return (
    <Card className="analysis-result-chart" data-testid={`analysis-chart-${series.id}`}>
      <h2>{t(`analytics.outputs.${series.id}`, { defaultValue: series.id })}</h2>
      <p>{t('analytics.chartPreview')}</p>
      <ResultCollection
        key={`${resultId}:series:${series.id}`}
        resultId={resultId}
        section="series"
        id={series.id}
        initial={series.data}
        total={series.totalRows ?? series.data.length}
        nextCursor={series.nextCursor ?? null}
      >
        {(rows) => (
          <ChartErrorBoundary
            key={attempt}
            fallback={
              <div role="status" className="notice notice-warning">
                <p>{t('analytics.chartFailed')}</p>
                <Button className="button-secondary" onClick={() => setAttempt(attempt + 1)}>
                  {t('analytics.retryChart')}
                </Button>
              </div>
            }
          >
            <Suspense fallback={<p role="status">{t('loading')}</p>}>
              <AnalysisChart series={{ ...series, data: rows }} context={context} />
            </Suspense>
          </ChartErrorBoundary>
        )}
      </ResultCollection>
    </Card>
  );
}
