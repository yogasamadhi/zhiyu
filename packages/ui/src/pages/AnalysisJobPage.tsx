import { lazy, Suspense } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runtimeClient } from '@zhiyun/client';
import { Badge, Button, Card, ErrorNotice } from '../components/ui.js';

const AnalysisChart = lazy(() =>
  import('../components/AnalysisChart.js').then((module) => ({ default: module.AnalysisChart })),
);

export function AnalysisJobPage() {
  const { jobId = '' } = useParams();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const job = useQuery({
    queryKey: ['analytics', 'job', jobId],
    queryFn: () => runtimeClient.getAnalysisJob(jobId),
    refetchInterval: (query) => (isActive(query.state.data?.state) ? 750 : false),
  });
  const result = useQuery({
    queryKey: ['analytics', 'result', job.data?.resultId],
    queryFn: () => runtimeClient.getAnalysisResult(job.data!.resultId!),
    enabled: Boolean(job.data?.resultId),
  });
  const cancel = useMutation({
    mutationFn: () => runtimeClient.cancelAnalysisJob(jobId),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['analytics', 'job', jobId] }),
  });
  const retry = useMutation({
    mutationFn: () => runtimeClient.retryAnalysisJob(jobId),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['analytics'] }),
  });
  const exportResult = useMutation({
    mutationFn: () => runtimeClient.exportAnalysisResult(job.data!.resultId!),
  });
  const error = job.error ?? result.error ?? cancel.error ?? retry.error ?? exportResult.error;
  if (job.isPending) return <p role="status">{t('loading')}</p>;
  return (
    <>
      <Link className="back-link" to="/analytics">
        ← {t('back')}
      </Link>
      <div className="page-heading">
        <div>
          <span className="eyebrow">{job.data?.methodId}</span>
          <h1>{t('analytics.job')}</h1>
          <p>{jobId}</p>
        </div>
        <div className="heading-actions">
          {job.data && isActive(job.data.state) && (
            <Button
              className="button-danger"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              {t('analytics.cancel')}
            </Button>
          )}
          {job.data && ['failed', 'canceled', 'interrupted'].includes(job.data.state) && (
            <Button disabled={retry.isPending} onClick={() => retry.mutate()}>
              {t('analytics.retry')}
            </Button>
          )}
        </div>
      </div>
      <ErrorNotice message={error instanceof Error ? error.message : error ? String(error) : ''} />
      {job.data && (
        <Card>
          <div className="job-status-line">
            <Badge
              tone={
                job.data.state === 'succeeded'
                  ? 'success'
                  : job.data.state === 'failed'
                    ? 'danger'
                    : 'neutral'
              }
            >
              {job.data.state}
            </Badge>
            <span>{job.data.phase}</span>
            <span>{Math.round(job.data.progress * 100)}%</span>
          </div>
          <div className="run-progress" aria-label={t('analytics.progress')}>
            <span style={{ width: `${Math.round(job.data.progress * 100)}%` }} />
            <small>{Math.round(job.data.progress * 100)}%</small>
          </div>
          <dl className="diagnostics-grid">
            <dt>{t('analytics.snapshotId')}</dt>
            <dd>{job.data.snapshotId}</dd>
            <dt>{t('analytics.methodVersion')}</dt>
            <dd>{job.data.methodVersion}</dd>
            <dt>{t('analytics.attempt')}</dt>
            <dd>{job.data.attempt}</dd>
          </dl>
        </Card>
      )}
      {result.isPending && job.data?.resultId && <p role="status">{t('loading')}</p>}
      {result.data && (
        <>
          <div className="page-heading result-heading">
            <div>
              <h2>{t('analytics.result')}</h2>
              <p>
                {t('analytics.provenance', {
                  method: `${result.data.methodId}@${result.data.methodVersion}`,
                  worker: result.data.workerVersion,
                })}
              </p>
            </div>
            <Button className="button-secondary" onClick={() => exportResult.mutate()}>
              {t('analytics.export')}
            </Button>
          </div>
          {result.data.sampling.applied && (
            <div className="notice notice-warning">
              {t('analytics.sampled', {
                sample: result.data.sampling.sampleRows,
                total: result.data.sampling.inputRows,
              })}
            </div>
          )}
          {result.data.warnings.map((warning) => (
            <div className="notice notice-warning" key={warning}>
              {warning}
            </div>
          ))}
          <div className="stats">
            {Object.entries(result.data.summary)
              .slice(0, 8)
              .map(([key, value]) => (
                <Card key={key}>
                  <small>{key}</small>
                  <strong>{formatValue(value)}</strong>
                </Card>
              ))}
          </div>
          {result.data.series.length > 0 && (
            <Card>
              <Suspense fallback={<p role="status">{t('loading')}</p>}>
                <AnalysisChart series={result.data.series} />
              </Suspense>
            </Card>
          )}
          {(result.data.tables as unknown as Array<{ id: string; rows: unknown[] }>).map(
            (table) => (
              <ResultTable key={table.id} id={table.id} rows={table.rows} />
            ),
          )}
          {result.data.artifacts.length > 0 && (
            <Card>
              <h2>{t('analytics.artifacts')}</h2>
              <div className="compact-list">
                {(
                  result.data.artifacts as unknown as Array<{
                    id: string;
                    filename: string;
                    contentType: string;
                    kind: string;
                  }>
                ).map((artifact) => (
                  <div key={artifact.id}>
                    <span>
                      <strong>{artifact.filename}</strong>
                      <small>{artifact.contentType}</small>
                    </span>
                    <Badge>{artifact.kind}</Badge>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </>
  );
}

function ResultTable({ id, rows }: { id: string; rows: unknown[] }) {
  const safeRows = rows.filter(isObject).slice(0, 10_000);
  const columns = [...new Set(safeRows.flatMap((row) => Object.keys(row)))];
  return (
    <Card>
      <h2>{id}</h2>
      {!safeRows.length ? (
        <div className="empty-small">—</div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {safeRows.map((row, index) => (
                <tr key={`${id}:${index}`}>
                  {columns.map((column) => (
                    <td key={column}>{formatValue(row[column])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number')
    return Number.isInteger(value) ? String(value) : value.toPrecision(6);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function isActive(state: string | undefined): boolean {
  return Boolean(
    state &&
    ['queued', 'claimed', 'running', 'persisting', 'canceling', 'interrupted'].includes(state),
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
