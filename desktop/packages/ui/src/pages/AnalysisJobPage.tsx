import { useWorkspaceAuth } from '../auth.js';
import {
  ResultTable,
  formatAnalysisValue as formatValue,
} from '../components/analysis/ResultCollection.js';
import { ResultChart } from '../components/analysis/ResultChart.js';
import {
  ResultBranch,
  ResultComparison,
  ResultProvenance,
} from '../components/analysis/ResultActions.js';
import '../components/analysis/analysis.css';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runtimeClient } from '@zhiyun/client';
import { Badge, Button, Card, ErrorNotice } from '../components/ui.js';

export function AnalysisJobPage() {
  const { jobId: routeJobId = '', resultId: routeResultId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const auth = useWorkspaceAuth();
  const canWrite = !auth.identityEnabled || auth.permissions.includes('analysis.write');
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const routeJob = useQuery({
    queryKey: ['analytics', 'job', routeJobId],
    queryFn: () => runtimeClient.getAnalysisJob(routeJobId),
    enabled: Boolean(routeJobId),
    refetchInterval: (query) => (isActive(query.state.data?.state) ? 750 : false),
  });
  const resultId = routeResultId || routeJob.data?.resultId || '';
  const result = useQuery({
    queryKey: ['analytics', 'result', resultId],
    queryFn: () => runtimeClient.getAnalysisResult(resultId),
    enabled: Boolean(resultId),
  });
  const resultJob = useQuery({
    queryKey: ['analytics', 'job', result.data?.jobId],
    queryFn: () => runtimeClient.getAnalysisJob(result.data!.jobId),
    enabled: Boolean(routeResultId && result.data?.jobId),
  });
  const job = routeJobId ? routeJob : resultJob;
  const jobId = routeJobId || result.data?.jobId || '';
  const cancel = useMutation({
    mutationFn: () => runtimeClient.cancelAnalysisJob(jobId),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['analytics', 'job', jobId] }),
  });
  const retry = useMutation({
    mutationFn: () => runtimeClient.retryAnalysisJob(jobId),
    onSuccess: async (next) => {
      await queryClient.invalidateQueries({ queryKey: ['analytics'] });
      await navigate(`/analytics/jobs/${next.id}`);
    },
  });
  const exportResult = useMutation({
    mutationFn: () => runtimeClient.exportAnalysisResult(resultId),
  });
  const download = useMutation({
    mutationFn: (artifact: { id: string; filename: string }) =>
      runtimeClient.saveArtifact(artifact),
  });
  const error =
    job.error ??
    result.error ??
    cancel.error ??
    retry.error ??
    exportResult.error ??
    download.error;
  if ((routeJobId && routeJob.isPending) || (routeResultId && result.isPending))
    return <p role="status">{t('loading')}</p>;
  return (
    <>
      <Link className="back-link" to="/analytics">
        ← {t('back')}
      </Link>
      <div className="page-heading">
        <div>
          <h1>{t('analytics.job')}</h1>
          <p>{job.data ? t(`analytics.methods.${job.data.methodId}.title`) : ''}</p>
        </div>
        <div className="heading-actions">
          {canWrite && job.data && isActive(job.data.state) && (
            <Button
              className="button-danger"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              {t('analytics.cancel')}
            </Button>
          )}
          {canWrite &&
            job.data &&
            ['failed', 'canceled', 'interrupted'].includes(job.data.state) && (
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
              {t(`ux.state.${job.data.state}`, { defaultValue: job.data.state })}
            </Badge>
            <span>{t(`analytics.phase.${job.data.phase}`, { defaultValue: job.data.phase })}</span>
            <span>{Math.round(job.data.progress * 100)}%</span>
          </div>
          <div className="run-progress" aria-label={t('analytics.progress')}>
            <span style={{ width: `${Math.round(job.data.progress * 100)}%` }} />
            <small>{Math.round(job.data.progress * 100)}%</small>
          </div>
          <details>
            <summary>
              {t('analytics.provenanceDetails', { defaultValue: '技术与溯源详情' })}
            </summary>
            <dl className="diagnostics-grid">
              <dt>{t('analytics.snapshotId')}</dt>
              <dd>{job.data.snapshotId}</dd>
              <dt>{t('analytics.methodVersion')}</dt>
              <dd>{job.data.methodVersion}</dd>
              <dt>{t('analytics.attempt')}</dt>
              <dd>{job.data.attempt}</dd>
              <dt>ID</dt>
              <dd>{jobId}</dd>
            </dl>
          </details>
        </Card>
      )}
      {result.isPending && job.data?.resultId && <p role="status">{t('loading')}</p>}
      {result.data && (
        <>
          <div className="page-heading result-heading">
            <div>
              <h2>{t('analytics.result')}</h2>
              <p>
                {t('analytics.resultSummary', {
                  count: Number(result.data.summary.rowCount ?? 0),
                  method: t(`analytics.methods.${result.data.methodId}.title`),
                })}
              </p>
              <details>
                <summary>{t('analytics.provenanceDetails')}</summary>
                {t('analytics.provenance', {
                  method: `${result.data.methodId}@${result.data.methodVersion}`,
                  worker: result.data.workerVersion,
                })}
              </details>
            </div>
            <Button
              className="button-secondary"
              disabled={exportResult.isPending}
              onClick={() => exportResult.mutate()}
            >
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
                  <small>{t(`analytics.outputs.${key}`, { defaultValue: key })}</small>
                  <strong>{formatValue(value)}</strong>
                </Card>
              ))}
          </div>
          <ResultProvenance result={result.data} />
          <ResultBranch key={`branch:${result.data.id}`} result={result.data} />
          <ResultComparison
            key={`compare:${result.data.id}`}
            result={result.data}
            initialOtherId={searchParams.get('compareWith') ?? ''}
          />
          {result.data.series.map((series) => (
            <ResultChart
              key={`${result.data.id}:${series.id}`}
              resultId={result.data.id}
              series={series}
              context={result.data!}
            />
          ))}
          {result.data.tables.map((table) => (
            <ResultTable
              key={`${result.data.id}:${table.id}`}
              resultId={result.data.id}
              table={table}
            />
          ))}
          {result.data.artifacts.length > 0 && (
            <Card className="analysis-artifacts">
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
                      <small>{artifact.id}</small>
                    </span>
                    <Badge>{artifact.kind}</Badge>
                    <Button
                      className="button-secondary"
                      disabled={download.isPending}
                      onClick={() =>
                        download.mutate({ id: artifact.id, filename: artifact.filename })
                      }
                    >
                      {t('analytics.downloadArtifact')}
                    </Button>
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

function isActive(state: string | undefined): boolean {
  return Boolean(
    state &&
    ['queued', 'claimed', 'running', 'persisting', 'canceling', 'interrupted'].includes(state),
  );
}
