import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  runtimeClient,
  type AnalysisJobInput,
  type AnalysisMethodDescriptor,
} from '@zhiyun/client';
import { SchemaForm } from '../components/SchemaForm.js';
import { Badge, Button, Card, ErrorNotice, Input } from '../components/ui.js';

export function AnalyticsPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [methodId, setMethodId] = useState('');
  const [datasetId, setDatasetId] = useState(searchParams.get('datasetId') ?? '');
  const [snapshotId, setSnapshotId] = useState(searchParams.get('snapshotId') ?? '');
  const [recipeName, setRecipeName] = useState('');
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
  useEffect(() => {
    if (!methodId && methods.data?.[0]) setMethodId(methods.data[0].id);
  }, [methodId, methods.data]);
  useEffect(() => {
    setParameters(defaultParameters(selectedMethod));
  }, [selectedMethod?.id]);

  const createJob = useMutation({
    mutationFn: (input: AnalysisJobInput) => runtimeClient.createAnalysisJob(input),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['analytics', 'jobs'] }),
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
    if (!selectedMethod) return;
    createJob.mutate({
      datasetId,
      snapshotId,
      methodId: selectedMethod.id,
      methodVersion: selectedMethod.version,
      parameters,
    });
  };
  const error =
    methods.error ?? recipes.error ?? jobs.error ?? createJob.error ?? createRecipe.error;

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t('analytics.eyebrow')}</span>
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
        <div className="analytics-layout">
          <Card className="method-catalog">
            <div className="section-heading compact">
              <div>
                <h2>{t('analytics.methodCatalog')}</h2>
                <p>{t('analytics.methodCount', { count: methods.data?.length ?? 0 })}</p>
              </div>
            </div>
            <div className="method-list" role="listbox" aria-label={t('analytics.methodCatalog')}>
              {(methods.data ?? []).map((method) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={method.id === methodId}
                  className={method.id === methodId ? 'method-item active' : 'method-item'}
                  key={method.id}
                  onClick={() => setMethodId(method.id)}
                >
                  <strong>{t(method.titleKey, { defaultValue: method.id })}</strong>
                  <small>{method.category}</small>
                </button>
              ))}
            </div>
          </Card>
          <Card className="analysis-launcher">
            <h2>
              {selectedMethod
                ? t(selectedMethod.titleKey, { defaultValue: selectedMethod.id })
                : t('analytics.selectMethod')}
            </h2>
            <p>
              {selectedMethod
                ? t(selectedMethod.descriptionKey, { defaultValue: selectedMethod.id })
                : t('analytics.selectMethodHint')}
            </p>
            <div className="form-grid two">
              <label>
                <span>{t('analytics.datasetId')}</span>
                <Input value={datasetId} onChange={(event) => setDatasetId(event.target.value)} />
              </label>
              <label>
                <span>{t('analytics.snapshotId')}</span>
                <Input value={snapshotId} onChange={(event) => setSnapshotId(event.target.value)} />
              </label>
            </div>
            {selectedMethod && (
              <SchemaForm
                schema={selectedMethod.parameterSchema as Record<string, unknown>}
                value={parameters}
                onChange={setParameters}
                disabled={createJob.isPending}
              />
            )}
            <div className="launcher-actions">
              <Button
                disabled={!selectedMethod || !datasetId || !snapshotId || createJob.isPending}
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
                disabled={!recipeName.trim() || !datasetId || createRecipe.isPending}
                onClick={() => createRecipe.mutate()}
              >
                {t('analytics.saveRecipe')}
              </Button>
            </div>
          </Card>
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
                    <small>{recipe.methodId}</small>
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
                    <strong>{job.methodId}</strong>
                    <small>{job.phase}</small>
                  </span>
                  <Badge tone={statusTone(job.state)}>{job.state}</Badge>
                </Link>
              ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function defaultParameters(method: AnalysisMethodDescriptor | undefined): Record<string, unknown> {
  if (!method) return {};
  const schema = method.parameterSchema as Record<string, unknown>;
  const properties = isObject(schema.properties) ? schema.properties : {};
  return Object.fromEntries(
    Object.entries(properties).flatMap(([name, value]) => {
      const definition = isObject(value) ? value : {};
      return definition.default === undefined ? [] : [[name, definition.default]];
    }),
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

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
