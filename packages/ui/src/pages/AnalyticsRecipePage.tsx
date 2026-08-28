import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runtimeClient } from '@zhiyun/client';
import { SchemaForm } from '../components/SchemaForm.js';
import { Button, Card, ErrorNotice, Input } from '../components/ui.js';

export function AnalyticsRecipePage() {
  const { recipeId = '' } = useParams();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const recipe = useQuery({
    queryKey: ['analytics', 'recipe', recipeId],
    queryFn: () => runtimeClient.getAnalysisRecipe(recipeId),
  });
  const methods = useQuery({
    queryKey: ['analytics', 'methods'],
    queryFn: () => runtimeClient.listAnalysisMethods(),
  });
  const [name, setName] = useState('');
  const [parameters, setParameters] = useState<Record<string, unknown>>({});
  const [snapshotId, setSnapshotId] = useState('');
  useEffect(() => {
    if (recipe.data) {
      setName(recipe.data.name);
      setParameters(recipe.data.parameters as Record<string, unknown>);
    }
  }, [recipe.data]);
  const method = methods.data?.find(({ id }) => id === recipe.data?.methodId);
  const save = useMutation({
    mutationFn: () =>
      runtimeClient.updateAnalysisRecipe(recipeId, {
        name,
        datasetId: recipe.data!.datasetId,
        methodId: recipe.data!.methodId,
        methodVersion: recipe.data!.methodVersion,
        parameters,
      }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['analytics'] }),
  });
  const run = useMutation({
    mutationFn: () =>
      runtimeClient.createAnalysisJob({
        recipeId,
        datasetId: recipe.data!.datasetId,
        snapshotId,
        methodId: recipe.data!.methodId,
        methodVersion: recipe.data!.methodVersion,
        parameters,
      }),
    onSuccess: (job) => navigate(`/analytics/jobs/${job.id}`),
  });
  const remove = useMutation({
    mutationFn: () => runtimeClient.deleteAnalysisRecipe(recipeId),
    onSuccess: () => navigate('/analytics'),
  });
  const error = recipe.error ?? methods.error ?? save.error ?? run.error ?? remove.error;
  if (recipe.isPending) return <p role="status">{t('loading')}</p>;
  return (
    <>
      <Link className="back-link" to="/analytics">
        ← {t('back')}
      </Link>
      <div className="page-heading">
        <div>
          <span className="eyebrow">{recipe.data?.methodId}</span>
          <h1>{recipe.data?.name ?? t('analytics.recipe')}</h1>
          <p>{t('analytics.recipeRevision', { revision: recipe.data?.revision ?? 0 })}</p>
        </div>
      </div>
      <ErrorNotice message={error instanceof Error ? error.message : error ? String(error) : ''} />
      {recipe.data && (
        <Card className="editor-card">
          <div className="form-grid two">
            <label>
              <span>{t('name')}</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              <span>{t('analytics.datasetId')}</span>
              <Input value={recipe.data.datasetId} disabled />
            </label>
          </div>
          {method && (
            <SchemaForm
              schema={method.parameterSchema as Record<string, unknown>}
              value={parameters}
              onChange={setParameters}
            />
          )}
          <div className="launcher-actions">
            <Button disabled={save.isPending || !name.trim()} onClick={() => save.mutate()}>
              {t('save')}
            </Button>
            <Input
              value={snapshotId}
              placeholder={t('analytics.snapshotId')}
              aria-label={t('analytics.snapshotId')}
              onChange={(event) => setSnapshotId(event.target.value)}
            />
            <Button
              className="button-secondary"
              disabled={!snapshotId || run.isPending}
              onClick={() => run.mutate()}
            >
              {t('analytics.runRecipe')}
            </Button>
            <Button
              className="button-danger"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {t('delete')}
            </Button>
          </div>
        </Card>
      )}
    </>
  );
}
