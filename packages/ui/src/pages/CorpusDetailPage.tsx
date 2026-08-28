import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runtimeClient, type CorpusRecipeInput } from '@zhiyun/client';
import { Badge, Button, Card, ErrorNotice, Input } from '../components/ui.js';

const defaultRecipe: CorpusRecipeInput = {
  name: 'Default bilingual corpus',
  snapshotPolicy: { mode: 'latest' },
  selectedTextFields: [],
  metadataFields: [],
  stripHtml: true,
  unicodeNormalization: 'NFKC',
  deduplication: 'exact-and-near',
  nearDuplicateThreshold: 0.9,
  chunkSize: 2000,
  chunkOverlap: 200,
  languagePolicy: 'zh-en-first',
  outputFormats: ['parquet', 'jsonl'],
};

export function CorpusDetailPage() {
  const { corpusId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const corpus = useQuery({
    queryKey: ['corpus', corpusId],
    queryFn: () => runtimeClient.getCorpus(corpusId),
  });
  const recipes = useQuery({
    queryKey: ['corpus', corpusId, 'recipes'],
    queryFn: () => runtimeClient.listCorpusRecipes(corpusId),
  });
  const builds = useQuery({
    queryKey: ['corpus', corpusId, 'builds'],
    queryFn: () => runtimeClient.listCorpusBuilds(corpusId),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((build) => isActive(build.state)) ? 1_000 : 5_000,
  });
  const versions = useQuery({
    queryKey: ['corpus', corpusId, 'versions'],
    queryFn: () => runtimeClient.listCorpusVersions(corpusId),
  });
  const [recipe, setRecipe] = useState<CorpusRecipeInput>(defaultRecipe);
  const [selectedRecipeId, setSelectedRecipeId] = useState('');
  const [snapshotId, setSnapshotId] = useState(searchParams.get('snapshotId') ?? '');
  useEffect(() => {
    if (!selectedRecipeId && recipes.data?.[0]) setSelectedRecipeId(recipes.data[0].id);
  }, [recipes.data, selectedRecipeId]);
  const createRecipe = useMutation({
    mutationFn: () => runtimeClient.createCorpusRecipe(corpusId, recipe),
    onSuccess: async (created) => {
      setSelectedRecipeId(created.id);
      await queryClient.invalidateQueries({ queryKey: ['corpus', corpusId, 'recipes'] });
    },
  });
  const createBuild = useMutation({
    mutationFn: () =>
      runtimeClient.createCorpusBuild(corpusId, { recipeId: selectedRecipeId, snapshotId }),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['corpus', corpusId] }),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => runtimeClient.cancelCorpusBuild(id),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['corpus', corpusId] }),
  });
  const retry = useMutation({
    mutationFn: (id: string) => runtimeClient.retryCorpusBuild(id),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['corpus', corpusId] }),
  });
  const error =
    corpus.error ??
    recipes.error ??
    builds.error ??
    versions.error ??
    createRecipe.error ??
    createBuild.error;
  if (corpus.isPending) return <p role="status">{t('loading')}</p>;
  return (
    <>
      <Link className="back-link" to="/corpora">
        ← {t('back')}
      </Link>
      <div className="page-heading">
        <div>
          <span className="eyebrow">{corpus.data?.datasetId}</span>
          <h1>{corpus.data?.name ?? t('corpus.title')}</h1>
          <p>{t('corpus.detailIntro')}</p>
        </div>
      </div>
      <ErrorNotice message={error instanceof Error ? error.message : error ? String(error) : ''} />
      <div className="two-column">
        <Card className="editor-card">
          <h2>{t('corpus.recipe')}</h2>
          <div className="form-grid two">
            <label>
              <span>{t('name')}</span>
              <Input
                value={recipe.name}
                onChange={(event) => setRecipe({ ...recipe, name: event.target.value })}
              />
            </label>
            <label>
              <span>{t('corpus.textFields')}</span>
              <Input
                value={recipe.selectedTextFields.join(', ')}
                onChange={(event) =>
                  setRecipe({ ...recipe, selectedTextFields: parseList(event.target.value) })
                }
              />
            </label>
            <label>
              <span>{t('corpus.metadataFields')}</span>
              <Input
                value={recipe.metadataFields.join(', ')}
                onChange={(event) =>
                  setRecipe({ ...recipe, metadataFields: parseList(event.target.value) })
                }
              />
            </label>
            <label>
              <span>{t('corpus.nearDuplicateThreshold')}</span>
              <Input
                type="number"
                min={0.5}
                max={1}
                step={0.01}
                value={recipe.nearDuplicateThreshold}
                onChange={(event) =>
                  setRecipe({ ...recipe, nearDuplicateThreshold: Number(event.target.value) })
                }
              />
            </label>
            <label>
              <span>{t('corpus.chunkSize')}</span>
              <Input
                type="number"
                min={100}
                max={10000}
                value={recipe.chunkSize}
                onChange={(event) =>
                  setRecipe({ ...recipe, chunkSize: Number(event.target.value) })
                }
              />
            </label>
            <label>
              <span>{t('corpus.chunkOverlap')}</span>
              <Input
                type="number"
                min={0}
                max={2000}
                value={recipe.chunkOverlap}
                onChange={(event) =>
                  setRecipe({ ...recipe, chunkOverlap: Number(event.target.value) })
                }
              />
            </label>
          </div>
          <div className="form-grid two">
            <label className="check">
              <input
                type="checkbox"
                checked={recipe.stripHtml}
                onChange={(event) => setRecipe({ ...recipe, stripHtml: event.target.checked })}
              />
              {t('corpus.stripHtml')}
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={recipe.outputFormats.includes('markdown')}
                onChange={(event) =>
                  setRecipe({
                    ...recipe,
                    outputFormats: event.target.checked
                      ? [...recipe.outputFormats, 'markdown']
                      : recipe.outputFormats.filter((item) => item !== 'markdown'),
                  })
                }
              />
              {t('corpus.markdown')}
            </label>
          </div>
          <Button
            disabled={createRecipe.isPending || !recipe.name || !recipe.selectedTextFields.length}
            onClick={() => createRecipe.mutate()}
          >
            {t('corpus.saveRecipe')}
          </Button>
        </Card>
        <Card>
          <h2>{t('corpus.build')}</h2>
          <label>
            <span>{t('corpus.recipe')}</span>
            <select
              value={selectedRecipeId}
              onChange={(event) => setSelectedRecipeId(event.target.value)}
            >
              <option value="">—</option>
              {(recipes.data ?? []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · v{item.revision}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('analytics.snapshotId')}</span>
            <Input value={snapshotId} onChange={(event) => setSnapshotId(event.target.value)} />
          </label>
          <Button
            disabled={!selectedRecipeId || !snapshotId || createBuild.isPending}
            onClick={() => createBuild.mutate()}
          >
            {createBuild.isPending ? t('corpus.starting') : t('corpus.startBuild')}
          </Button>
        </Card>
      </div>
      <Card>
        <h2>{t('corpus.builds')}</h2>
        <div className="compact-list">
          {(builds.data ?? []).map((build) => (
            <div key={build.id}>
              <span>
                <strong>{build.id}</strong>
                <small>
                  {build.phase} · {Math.round(build.progress * 100)}%
                </small>
              </span>
              <div className="row-actions">
                <Badge
                  tone={
                    build.state === 'succeeded'
                      ? 'success'
                      : build.state === 'failed'
                        ? 'danger'
                        : 'neutral'
                  }
                >
                  {build.state}
                </Badge>
                {isActive(build.state) && (
                  <Button className="button-danger" onClick={() => cancel.mutate(build.id)}>
                    {t('analytics.cancel')}
                  </Button>
                )}
                {['failed', 'canceled', 'interrupted'].includes(build.state) && (
                  <Button className="button-secondary" onClick={() => retry.mutate(build.id)}>
                    {t('analytics.retry')}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <h2>{t('corpus.versions')}</h2>
        <div className="compact-list">
          {(versions.data ?? []).map((version) => (
            <Link key={version.id} to={`/corpora/${corpusId}/versions/${version.id}`}>
              <span>
                <strong>{version.fingerprint.slice(0, 16)}</strong>
                <small>{new Date(version.createdAt).toLocaleString()}</small>
              </span>
              <Badge tone="success">{String(version.stats.documentCount ?? 0)} docs</Badge>
            </Link>
          ))}
        </div>
      </Card>
    </>
  );
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isActive(state: string): boolean {
  return ['queued', 'claimed', 'running', 'persisting', 'canceling', 'interrupted'].includes(state);
}
