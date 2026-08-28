import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runtimeClient } from '@zhiyun/client';
import { Badge, Button, Card, ErrorNotice } from '../components/ui.js';

export function CorpusVersionPage() {
  const { corpusId = '', versionId = '' } = useParams();
  const { t } = useTranslation();
  const version = useQuery({
    queryKey: ['corpus', corpusId, 'version', versionId],
    queryFn: () => runtimeClient.getCorpusVersion(corpusId, versionId),
  });
  const exportVersion = useMutation({
    mutationFn: () => runtimeClient.exportCorpusVersion(corpusId, versionId),
  });
  const error = version.error ?? exportVersion.error;
  if (version.isPending) return <p role="status">{t('loading')}</p>;
  return (
    <>
      <Link className="back-link" to={`/corpora/${corpusId}`}>
        ← {t('back')}
      </Link>
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t('corpus.version')}</span>
          <h1>{version.data?.fingerprint.slice(0, 16)}</h1>
          <p>{version.data?.createdAt ? new Date(version.data.createdAt).toLocaleString() : ''}</p>
        </div>
        <Button className="button-secondary" onClick={() => exportVersion.mutate()}>
          {t('corpus.exportArtifacts')}
        </Button>
      </div>
      <ErrorNotice message={error instanceof Error ? error.message : error ? String(error) : ''} />
      {version.data && (
        <>
          <div className="stats">
            {Object.entries(version.data.stats)
              .filter(([, value]) => typeof value === 'number')
              .map(([key, value]) => (
                <Card key={key}>
                  <small>{key}</small>
                  <strong>{String(value)}</strong>
                </Card>
              ))}
          </div>
          <Card>
            <h2>{t('analytics.provenanceTitle')}</h2>
            <dl className="diagnostics-grid">
              <dt>{t('analytics.datasetId')}</dt>
              <dd>{version.data.datasetId}</dd>
              <dt>{t('analytics.snapshotId')}</dt>
              <dd>{version.data.snapshotId}</dd>
              <dt>Snapshot fingerprint</dt>
              <dd>{version.data.snapshotFingerprint}</dd>
              <dt>{t('corpus.recipe')}</dt>
              <dd>
                {version.data.recipeId} · v{version.data.recipeRevision}
              </dd>
              <dt>Worker</dt>
              <dd>{version.data.workerVersion}</dd>
              <dt>Languages</dt>
              <dd>{JSON.stringify(version.data.stats.languages)}</dd>
            </dl>
          </Card>
          <Card>
            <h2>{t('analytics.artifacts')}</h2>
            <div className="compact-list">
              {version.data.artifacts.map((artifact) => (
                <div key={artifact.id}>
                  <span>
                    <strong>{artifact.filename}</strong>
                    <small>
                      {artifact.contentType} · {formatBytes(artifact.size)}
                    </small>
                  </span>
                  <Badge>{artifact.checksum.slice(0, 12)}</Badge>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
