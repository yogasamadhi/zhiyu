import {
  defaultAnalysisParameters,
  hasValidAnalysisParameters,
  recommendAnalysisQuestions,
  type AnalysisQuestionId,
} from '@zhiyun/ui-sdk/analysis-questions';
import { useWorkspaceAuth } from '@zhiyun/ui-sdk/auth';
import '@zhiyun/ui-sdk/components/analysis/analysis.css';
import { DatasetVersionPicker } from '@zhiyun/ui-sdk/components/DatasetVersionPicker';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runtimeClient, type AnalysisJobInput } from '@zhiyun/client';
import { SchemaForm } from '@zhiyun/ui-sdk/components/SchemaForm';
import { Badge, Button, Card, ErrorNotice, Input } from '@zhiyun/ui-sdk/components/ui';
import { StatusNotice } from '@zhiyun/ui-sdk/components/experience';

export function AnalyticsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const auth = useWorkspaceAuth();
  const canWrite = !auth.identityEnabled || auth.permissions.includes('analysis.write');
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [methodId, setMethodId] = useState('');
  const [datasetId, setDatasetId] = useState(searchParams.get('datasetId') ?? '');
  const [snapshotId, setSnapshotId] = useState(searchParams.get('snapshotId') ?? '');
  const [recipeName, setRecipeName] = useState('');
  const [intent, setIntent] = useState('all');
  const [questionId, setQuestionId] = useState<AnalysisQuestionId | null>(null);
  const fields = useQuery({
    queryKey: ['analysis-fields', datasetId, snapshotId],
    queryFn: () => runtimeClient.getDatasetFields(datasetId, snapshotId),
    enabled: Boolean(datasetId && snapshotId),
  });
  const [parameters, setParameters] = useState<Record<string, unknown>>({});

  const methods = useQuery({
    queryKey: ['analytics', 'methods'],
    queryFn: () => runtimeClient.listAnalysisMethods(),
    retry: 1,
  });
  const recipes = useQuery({
    queryKey: ['analytics', 'recipes'],
    queryFn: () => runtimeClient.listAnalysisRecipes(),
  });
  const jobs = useQuery({
    queryKey: ['analytics', 'jobs'],
    queryFn: () => runtimeClient.listAnalysisJobs(),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((job) => isActive(job.state)) ? 1_000 : 5_000,
  });
  const selectedMethod = useMemo(
    () => methods.data?.find((method) => method.id === methodId),
    [methodId, methods.data],
  );
  const questions = recommendAnalysisQuestions(fields.data?.fields ?? [], methods.data ?? []);
  const unavailable = new Map<string, string[]>();
  if (snapshotId && fields.isSuccess)
    for (const question of questions)
      if (question.reason)
        unavailable.set(question.reason, [
          ...(unavailable.get(question.reason) ?? []),
          t(`analytics.questions.${question.id}.title`),
        ]);
  const validParameters =
    !fields.isPending &&
    !fields.isError &&
    hasValidAnalysisParameters(selectedMethod, parameters, fields.data?.fields ?? []);

  const createJob = useMutation({
    mutationFn: async (input: AnalysisJobInput) => {
      if (input.questionId) {
        const recipe = await runtimeClient.createAnalysisRecipe({
          name: recipeName.trim() || t(`analytics.questions.${input.questionId}.title`),
          datasetId: input.datasetId,
          methodId: input.methodId,
          methodVersion: input.methodVersion,
          parameters: input.parameters,
        });
        input = { ...input, recipeId: recipe.id };
      }
      return runtimeClient.createAnalysisJob(input);
    },
    onSuccess: async (job) => {
      await queryClient.invalidateQueries({ queryKey: ['analytics'] });
      await navigate(`/analytics/jobs/${job.id}`);
    },
  });
  const createRecipe = useMutation({
    mutationFn: () => {
      if (!selectedMethod) throw new Error(t('analytics.selectMethod'));
      return runtimeClient.createAnalysisRecipe({
        name: recipeName.trim(),
        datasetId,
        methodId: selectedMethod.id,
        methodVersion: selectedMethod.version,
        parameters,
      });
    },
    onSuccess: async () => {
      setRecipeName('');
      await queryClient.invalidateQueries({ queryKey: ['analytics', 'recipes'] });
    },
  });

  const run = () => {
    if (!selectedMethod || !validParameters || !canWrite) return;
    createJob.mutate({
      datasetId,
      snapshotId,
      methodId: selectedMethod.id,
      methodVersion: selectedMethod.version,
      parameters,
      questionId,
    });
  };
  const error =
    methods.error ?? recipes.error ?? jobs.error ?? createJob.error ?? createRecipe.error;

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{t('analytics.title')}</h1>
          <p>{t('analytics.intro')}</p>
        </div>
      </div>
      <ErrorNotice message={error instanceof Error ? error.message : error ? String(error) : ''} />
      {methods.isError ? (
        <Card className="degraded-card">
          <Badge tone="danger">{t('analytics.degraded')}</Badge>
          <h2>{t('analytics.workerUnavailable')}</h2>
          <p>{t('analytics.workerUnavailableHint')}</p>
        </Card>
      ) : (
        <div className="analytics-flow">
          <Card className="analysis-launcher">
            <DatasetVersionPicker
              datasetId={datasetId}
              snapshotId={snapshotId}
              onDatasetChange={(id) => {
                setDatasetId(id);
                setSnapshotId('');
                setQuestionId(null);
                setParameters(defaultAnalysisParameters(selectedMethod));
              }}
              onSnapshotChange={(id) => {
                setSnapshotId(id);
                setQuestionId(null);
                setParameters(defaultAnalysisParameters(selectedMethod));
              }}
              disabled={createJob.isPending}
            />
            <ErrorNotice message={fields.error?.message} />
            <section className="analysis-questions" aria-label={t('analytics.questionsTitle')}>
              <h2>{t('analytics.questionsTitle')}</h2>
              <p>{t('analytics.questionsHint')}</p>
              {fields.isPending && datasetId && snapshotId && <p role="status">{t('loading')}</p>}
              <div className="analysis-question-grid">
                {questions.map((question) => (
                  <div key={question.id}>
                    <Button
                      className="button-secondary"
                      aria-pressed={questionId === question.id}
                      disabled={
                        !snapshotId ||
                        fields.isPending ||
                        fields.isError ||
                        Boolean(question.reason) ||
                        createJob.isPending
                      }
                      onClick={() => {
                        setQuestionId(question.id);
                        setMethodId(question.methodId);
                        setParameters(question.parameters);
                      }}
                    >
                      {t(`analytics.questions.${question.id}.title`)}
                    </Button>
                    {!question.reason && (
                      <small>{t(`analytics.questions.${question.id}.hint`)}</small>
                    )}
                  </div>
                ))}
              </div>
              {unavailable.size > 0 && (
                <StatusNotice tone="info">
                  <span>
                    {[...unavailable]
                      .map(
                        ([reason, titles]) =>
                          `${t(`analytics.questionReasons.${reason}`)}（${titles.join('、')}）`,
                      )
                      .join(' ')}
                  </span>
                </StatusNotice>
              )}
            </section>
          </Card>
          {selectedMethod && (
            <Card className="analysis-launcher">
              <h2>{t(selectedMethod.titleKey, { defaultValue: selectedMethod.id })}</h2>
              <p>{t(selectedMethod.descriptionKey, { defaultValue: selectedMethod.id })}</p>
              <SchemaForm
                fields={fields.data?.fields}
                methodId={selectedMethod.id}
                supportedFieldTypes={selectedMethod.supportedFieldTypes}
                schema={selectedMethod.parameterSchema as Record<string, unknown>}
                value={parameters}
                onChange={setParameters}
                disabled={createJob.isPending}
              />
              <div className="launcher-actions">
                <Button
                  disabled={
                    !canWrite ||
                    !datasetId ||
                    !snapshotId ||
                    createJob.isPending ||
                    !validParameters
                  }
                  onClick={run}
                >
                  {createJob.isPending ? t('analytics.starting') : t('analytics.start')}
                </Button>
                <Input
                  value={recipeName}
                  placeholder={t('analytics.recipeName')}
                  aria-label={t('analytics.recipeName')}
                  onChange={(event) => setRecipeName(event.target.value)}
                />
                <Button
                  className="button-secondary"
                  disabled={
                    !canWrite ||
                    !validParameters ||
                    !recipeName.trim() ||
                    !datasetId ||
                    createRecipe.isPending ||
                    createJob.isPending
                  }
                  onClick={() => createRecipe.mutate()}
                >
                  {t('analytics.saveRecipe')}
                </Button>
              </div>
              {snapshotId && !fields.isPending && !validParameters && (
                <p className="field-help">{t('analytics.invalidParameters')}</p>
              )}
            </Card>
          )}
          <details className="card method-browser">
            <summary>{t('analytics.browseMethods', { count: methods.data?.length ?? 0 })}</summary>
            <div className="intent-choices">
              {['all', 'quality', 'comparison', 'time', 'anomaly'].map((key) => (
                <Button
                  key={key}
                  className={intent === key ? 'button-secondary' : 'button-ghost'}
                  aria-pressed={intent === key}
                  onClick={() => setIntent(key)}
                >
                  {t(`analytics.intent.${key}`)}
                </Button>
              ))}
            </div>
            <div className="method-list" role="listbox" aria-label={t('analytics.methodCatalog')}>
              {(methods.data ?? [])
                .filter(
                  (method) =>
                    intent === 'all' ||
                    (intent === 'quality'
                      ? method.id.startsWith('data.')
                      : intent === 'time'
                        ? method.id.startsWith('time.')
                        : intent === 'anomaly'
                          ? ['stats.outliers', 'ml.isolation_forest'].includes(method.id)
                          : !method.id.startsWith('time.') && !method.id.startsWith('data.')),
                )
                .map((method) => (
                  <button
                    type="button"
                    role="option"
                    aria-selected={method.id === methodId}
                    className={method.id === methodId ? 'method-item active' : 'method-item'}
                    key={method.id}
                    onClick={() => {
                      setMethodId(method.id);
                      setQuestionId(null);
                      setParameters(defaultAnalysisParameters(method));
                    }}
                    disabled={createJob.isPending}
                  >
                    <strong>{t(method.titleKey, { defaultValue: method.id })}</strong>
                    <small>
                      {t(`analytics.categories.${method.category}`, {
                        defaultValue: t('analytics.categories.other'),
                      })}
                    </small>
                  </button>
                ))}
            </div>
          </details>
        </div>
      )}
      <div className="two-column analytics-sections">
        <Card>
          <h2>{t('analytics.recipes')}</h2>
          {!recipes.data?.items.length ? (
            <div className="empty-small">{t('analytics.emptyRecipes')}</div>
          ) : (
            <div className="compact-list">
              {recipes.data.items.map((recipe) => (
                <Link key={recipe.id} to={`/analytics/recipes/${recipe.id}`}>
                  <span>
                    <strong>{recipe.name}</strong>
                    <small>{t(`analytics.methods.${recipe.methodId}.title`)}</small>
                  </span>
                  <Badge>v{recipe.revision}</Badge>
                </Link>
              ))}
            </div>
          )}
        </Card>
        <Card>
          <h2>{t('analytics.jobs')}</h2>
          {!jobs.data?.length ? (
            <div className="empty-small">{t('analytics.emptyJobs')}</div>
          ) : (
            <div className="compact-list">
              {jobs.data.slice(0, 20).map((job) => (
                <Link key={job.id} to={`/analytics/jobs/${job.id}`}>
                  <span>
                    <strong>{t(`analytics.methods.${job.methodId}.title`)}</strong>
                    <small>{t(`analytics.phase.${job.phase}`, { defaultValue: job.phase })}</small>
                  </span>
                  <Badge tone={statusTone(job.state)}>
                    {t(`ux.state.${job.state}`, { defaultValue: job.state })}
                  </Badge>
                </Link>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function isActive(state: string): boolean {
  return ['queued', 'claimed', 'running', 'persisting', 'canceling', 'interrupted'].includes(state);
}

function statusTone(state: string): string {
  if (state === 'succeeded') return 'success';
  if (state === 'failed' || state === 'canceled') return 'danger';
  return 'neutral';
}
