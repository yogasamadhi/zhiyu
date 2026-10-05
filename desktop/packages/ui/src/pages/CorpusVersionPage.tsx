import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runtimeClient } from '@zhiyun/client';
import { Menu } from '../components/experience.js';
import { Badge, Card, ErrorNotice } from '../components/ui.js';

export function CorpusVersionPage() {
  const { corpusId = '', versionId = '' } = useParams();
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const version = useQuery({
    queryKey: ['corpus', corpusId, 'version', versionId],
    queryFn: () => runtimeClient.getCorpusVersion(corpusId, versionId),
  });
  const exportVersion = useMutation({
    mutationFn: async (artifactId: string) => {
      const exported = await runtimeClient.exportCorpusVersion(corpusId, versionId);
      const artifact = exported.artifacts.find((item) => item.id === artifactId);
      if (artifact) await runtimeClient.saveArtifact(artifact);
    },
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
          <h1>{zh ? '语料结果' : 'Corpus result'}</h1>
          <p>{version.data?.createdAt ? new Date(version.data.createdAt).toLocaleString() : ''}</p>
        </div>
        <Menu label={t('corpus.exportArtifacts')}>
          {(version.data?.artifacts ?? []).map((artifact) => (
            <button
              type="button"
              key={artifact.id}
              disabled={exportVersion.isPending}
              onClick={() => exportVersion.mutate(artifact.id)}
            >
              {artifact.filename}
            </button>
          ))}
        </Menu>
      </div>
      <ErrorNotice message={error instanceof Error ? error.message : error ? String(error) : ''} />
      {version.data && (
        <>
          <div className="stats">
            {Object.entries(version.data.stats)
              .filter(([, value]) => typeof value === 'number')
              .map(([key, value]) => (
                <Card key={key}>
                  <small>
                    {t(`analytics.outputs.${key}`, {
                      defaultValue:
                        (
                          {
                            documentCount: zh ? '文档数' : 'Documents',
                            chunkCount: zh ? '文本块数' : 'Chunks',
                            failureCount: zh ? '失败行数' : 'Failed rows',
                            inputRows: zh ? '输入记录数' : 'Input rows',
                          } as Record<string, string>
                        )[key] ?? key,
                    })}
                  </small>
                  <strong>{String(value)}</strong>
                </Card>
              ))}
          </div>
          <Card>
            <details>
              <summary>{t('analytics.provenanceTitle')}</summary>
              <dl className="diagnostics-grid">
                <dt>{t('analytics.datasetId')}</dt>
                <dd>{version.data.datasetId}</dd>
                <dt>{t('analytics.snapshotId')}</dt>
                <dd>{version.data.snapshotId}</dd>
                <dt>{zh ? '数据版本指纹' : 'Data version fingerprint'}</dt>
                <dd>{version.data.snapshotFingerprint}</dd>
                <dt>{t('corpus.recipe')}</dt>
                <dd>
                  {version.data.recipeId} · v{version.data.recipeRevision}
                </dd>
                <dt>Worker</dt>
                <dd>{version.data.workerVersion}</dd>
                <dt>{zh ? '语言分布' : 'Languages'}</dt>
                <dd>{JSON.stringify(version.data.stats.languages)}</dd>
              </dl>
            </details>
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
