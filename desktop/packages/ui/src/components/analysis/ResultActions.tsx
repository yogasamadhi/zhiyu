import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runtimeClient, type AnalyticsResult } from '@zhiyun/client';
import { useWorkspaceAuth } from '../../auth.js';
import { hasValidAnalysisParameters } from '../../analysis-questions.js';
import { SchemaForm } from '../SchemaForm.js';
import { Button, Card, ErrorNotice, Input } from '../ui.js';
import { ResultTable, formatAnalysisValue } from './ResultCollection.js';

export function ResultProvenance({ result }: { result: AnalyticsResult }) {
  const { t } = useTranslation();
  const provenance = result.provenance;
  const datasetPath = `/datasets/${result.datasetId}`;
  return (
    <Card className="analysis-provenance">
      <h2>{t('analytics.frozenInput')}</h2>
      <p>{t('analytics.frozenHint')}</p>
      <dl className="diagnostics-grid">
        <dt>{t('analytics.snapshotId')}</dt>
        <dd>
          <Link
            to={`${datasetPath}?snapshotId=${result.snapshotId}${provenance?.cleaningRecipeVersionId ? `&cleaningVersionId=${provenance.cleaningRecipeVersionId}` : ''}`}
          >
            {result.snapshotId}
          </Link>
        </dd>
        {provenance && (
          <>
            <dt>{t('analytics.sourceSnapshot')}</dt>
            <dd>
              <Link to={`${datasetPath}?snapshotId=${provenance.sourceSnapshotId}`}>
                {provenance.sourceSnapshotId}
              </Link>
            </dd>
            <dt>{t('analytics.cleaningVersion')}</dt>
            <dd>
              {provenance.cleaningRecipeVersionId ? (
                <Link
                  to={`${datasetPath}?snapshotId=${result.snapshotId}&cleaningVersionId=${provenance.cleaningRecipeVersionId}`}
                >
                  {provenance.cleaningRecipeVersionId} ·{' '}
                  {t('analytics.cleaningStep', { step: provenance.cleaningStep })}
                </Link>
              ) : (
                t('analytics.noCleaning')
              )}
            </dd>
            <dt>{t('analytics.recipe')}</dt>
            <dd>
              {provenance.analysisRecipeId ? (
                <Link to={`/analytics/recipes/${provenance.analysisRecipeId}`}>
                  {provenance.analysisRecipeId} · v{provenance.analysisRecipeRevision}
                </Link>
              ) : (
                '—'
              )}
            </dd>
            {provenance.parentResultId && (
              <>
                <dt>{t('analytics.parentResult')}</dt>
                <dd>
                  <Link to={`/analytics/results/${provenance.parentResultId}`}>
                    {provenance.parentResultId}
                  </Link>
                </dd>
              </>
            )}
          </>
        )}
        <dt>{t('analytics.methodVersion')}</dt>
        <dd>
          {result.methodId}@{result.methodVersion}
        </dd>
        <dt>{t('analytics.resultState')}</dt>
        <dd>{t(`ux.state.${result.state}`)}</dd>
        <dt>{t('analytics.createdAt')}</dt>
        <dd>{new Date(result.createdAt).toLocaleString()}</dd>
        <dt>{t('analytics.resultLink')}</dt>
        <dd>
          <Link to={`/analytics/results/${result.id}`}>{result.id}</Link>
        </dd>
      </dl>
      {!provenance && <p>{t('analytics.legacyProvenance')}</p>}
      <details>
        <summary>{t('analytics.frozenParameters')}</summary>
        <pre>{JSON.stringify(result.parameters, null, 2)}</pre>
      </details>
    </Card>
  );
}

export function ResultBranch({ result }: { result: AnalyticsResult }) {
  const { t } = useTranslation();
  const auth = useWorkspaceAuth();
  const canWrite = !auth.identityEnabled || auth.permissions.includes('analysis.write');
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [parameters, setParameters] = useState<Record<string, unknown>>(() =>
    structuredClone(result.parameters),
  );
  const methods = useQuery({
    queryKey: ['analytics', 'methods'],
    queryFn: () => runtimeClient.listAnalysisMethods(),
    enabled: open,
  });
  const fields = useQuery({
    queryKey: ['analysis-fields', result.datasetId, result.snapshotId],
    queryFn: () => runtimeClient.getDatasetFields(result.datasetId, result.snapshotId),
    enabled: open,
  });
  const method = methods.data?.find(
    (item) => item.id === result.methodId && item.version === result.methodVersion,
  );
  const branch = useMutation({
    mutationFn: () => runtimeClient.branchAnalysisResult(result.id, parameters),
    onSuccess: async (job) => {
      await cache.invalidateQueries({ queryKey: ['analytics', 'jobs'] });
      await navigate(`/analytics/jobs/${job.id}?compareWith=${result.id}`);
    },
  });
  if (!canWrite) return null;
  return (
    <Card className="analysis-provenance" data-testid="analysis-branch">
      <h2>{t('analytics.branchTitle')}</h2>
      <p>{t('analytics.branchHint')}</p>
      <Button className="button-secondary" aria-expanded={open} onClick={() => setOpen(!open)}>
        {t(open ? 'analytics.closeBranch' : 'analytics.openBranch')}
      </Button>
      {open && (
        <>
          <ErrorNotice message={(methods.error ?? fields.error ?? branch.error)?.message} />
          {(methods.isPending || fields.isPending) && <p role="status">{t('loading')}</p>}
          {methods.data && !method && <p>{t('analytics.branchMethodUnavailable')}</p>}
          {method && fields.data && (
            <SchemaForm
              schema={method.parameterSchema as Record<string, unknown>}
              value={parameters}
              fields={fields.data.fields}
              methodId={method.id}
              supportedFieldTypes={method.supportedFieldTypes}
              onChange={setParameters}
              disabled={branch.isPending}
            />
          )}
          <div className="analysis-branch-actions">
            <Button
              disabled={
                branch.isPending ||
                fields.isPending ||
                fields.isError ||
                !hasValidAnalysisParameters(method, parameters, fields.data?.fields ?? [])
              }
              onClick={() => branch.mutate()}
            >
              {t('analytics.runBranch')}
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

export function ResultComparison({
  result,
  initialOtherId = '',
}: {
  result: AnalyticsResult;
  initialOtherId?: string;
}) {
  const { t } = useTranslation();
  const [otherId, setOtherId] = useState(initialOtherId || result.provenance?.parentResultId || '');
  const [submitted, setSubmitted] = useState('');
  const jobs = useQuery({
    queryKey: ['analytics', 'jobs'],
    queryFn: () => runtimeClient.listAnalysisJobs(),
  });
  const comparison = useQuery({
    queryKey: ['analytics', 'comparison', result.id, submitted],
    queryFn: () => runtimeClient.compareAnalysisResults(result.id, submitted),
    enabled: Boolean(submitted),
    retry: false,
  });
  return (
    <Card className="analysis-comparison" data-testid="analysis-comparison">
      <h2>{t('analytics.compareTitle')}</h2>
      <p>{t('analytics.compareHint')}</p>
      <label>
        <span>{t('analytics.compareSelect')}</span>
        <select
          value={otherId}
          onChange={(event) => {
            setOtherId(event.target.value);
            setSubmitted('');
          }}
        >
          <option value="">—</option>
          {otherId && !jobs.data?.some((job) => job.resultId === otherId) && (
            <option value={otherId}>{otherId}</option>
          )}
          {(jobs.data ?? [])
            .filter((job) => job.resultId && job.resultId !== result.id)
            .map((job) => (
              <option key={job.id} value={job.resultId!}>
                {t(`analytics.methods.${job.methodId}.title`)} ·{' '}
                {new Date(job.createdAt).toLocaleString()} · {job.resultId}
              </option>
            ))}
        </select>
      </label>
      <label>
        <span>{t('analytics.compareId')}</span>
        <Input
          value={otherId}
          onChange={(event) => {
            setOtherId(event.target.value);
            setSubmitted('');
          }}
        />
      </label>
      <Button
        className="button-secondary"
        disabled={!otherId.trim() || otherId === result.id || comparison.isFetching}
        onClick={() => setSubmitted(otherId.trim())}
      >
        {t('analytics.compareRun')}
      </Button>
      <ErrorNotice
        message={(comparison.error ?? jobs.error)?.message}
        onRetry={() => (submitted ? void comparison.refetch() : void jobs.refetch())}
      />
      {comparison.isFetching && <p role="status">{t('loading')}</p>}
      {comparison.data && (
        <>
          <p>
            {t('analytics.changedParameters')}:{' '}
            {comparison.data.changedParameters
              .map((key) => t(`analytics.parameters.${key}`, { defaultValue: key }))
              .join(', ') || t('analytics.sameParameters')}
          </p>
          <div className="two-column">
            {[comparison.data.left, comparison.data.right].map((item) => (
              <div key={item.id}>
                <h3>
                  <Link to={`/analytics/results/${item.id}`}>{item.id}</Link>
                </h3>
                <dl className="diagnostics-grid">
                  {Object.entries(item.summary)
                    .slice(0, 8)
                    .map(([key, value]) => (
                      <div key={key}>
                        <dt>{t(`analytics.outputs.${key}`, { defaultValue: key })}</dt>
                        <dd>{formatAnalysisValue(value)}</dd>
                      </div>
                    ))}
                </dl>
                <details>
                  <summary>{t('analytics.frozenParameters')}</summary>
                  <pre>{JSON.stringify(item.parameters, null, 2)}</pre>
                </details>
                {item.tables.map((table) => (
                  <ResultTable key={`${item.id}:${table.id}`} resultId={item.id} table={table} />
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
