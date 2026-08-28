import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runtimeClient } from '@zhiyun/client';
import { Badge, Button, Card, ErrorNotice, Input } from '../components/ui.js';

export function CorporaPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [datasetId, setDatasetId] = useState(searchParams.get('datasetId') ?? '');
  const snapshotId = searchParams.get('snapshotId') ?? '';
  const corpora = useQuery({
    queryKey: ['corpus', 'list'],
    queryFn: () => runtimeClient.listCorpora(),
  });
  const builds = useQuery({
    queryKey: ['corpus', 'builds'],
    queryFn: () => runtimeClient.listCorpusBuilds(),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((build) => isActive(build.state)) ? 1_000 : 5_000,
  });
  const create = useMutation({
    mutationFn: () => runtimeClient.createCorpus({ name: name.trim(), datasetId }),
    onSuccess: async (created) => {
      setName('');
      await queryClient.invalidateQueries({ queryKey: ['corpus'] });
      const query = snapshotId ? `?${new URLSearchParams({ snapshotId }).toString()}` : '';
      await navigate(`/corpora/${created.id}${query}`);
    },
  });
  const error = corpora.error ?? builds.error ?? create.error;
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t('corpus.eyebrow')}</span>
          <h1>{t('corpus.title')}</h1>
          <p>{t('corpus.intro')}</p>
        </div>
      </div>
      <ErrorNotice message={error instanceof Error ? error.message : error ? String(error) : ''} />
      <Card className="editor-card">
        <h2>{t('corpus.create')}</h2>
        <div className="form-grid two">
          <label>
            <span>{t('name')}</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            <span>{t('analytics.datasetId')}</span>
            <Input value={datasetId} onChange={(event) => setDatasetId(event.target.value)} />
          </label>
        </div>
        <Button
          disabled={!name.trim() || !datasetId || create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? t('corpus.creating') : t('corpus.create')}
        </Button>
      </Card>
      <div className="two-column">
        <Card>
          <h2>{t('corpus.corpora')}</h2>
          {!corpora.data?.items.length ? (
            <div className="empty-small">{t('corpus.empty')}</div>
          ) : (
            <div className="compact-list">
              {corpora.data.items.map((corpus) => (
                <Link key={corpus.id} to={`/corpora/${corpus.id}`}>
                  <span>
                    <strong>{corpus.name}</strong>
                    <small>{corpus.datasetId}</small>
                  </span>
                  <Badge>v{corpus.revision}</Badge>
                </Link>
              ))}
            </div>
          )}
        </Card>
        <Card>
          <h2>{t('corpus.recentBuilds')}</h2>
          {!builds.data?.length ? (
            <div className="empty-small">{t('corpus.emptyBuilds')}</div>
          ) : (
            <div className="compact-list">
              {builds.data.slice(0, 20).map((build) => (
                <Link key={build.id} to={`/corpora/${build.corpusId}`}>
                  <span>
                    <strong>{build.id.slice(0, 8)}</strong>
                    <small>{build.phase}</small>
                  </span>
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
