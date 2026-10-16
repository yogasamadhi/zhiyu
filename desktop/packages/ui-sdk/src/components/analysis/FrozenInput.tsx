import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { runtimeClient } from '@zhiyun/client';
import { Card, ErrorNotice } from '../ui.js';
import './analysis.css';

export function FrozenInput({
  datasetId,
  snapshotId,
  cleaningVersionId,
}: {
  datasetId: string;
  snapshotId: string;
  cleaningVersionId: string | null;
}) {
  const { t } = useTranslation();
  const snapshot = useQuery({
    queryKey: ['frozen-input', datasetId, snapshotId],
    queryFn: () => runtimeClient.getDatasetSnapshot(datasetId, snapshotId),
  });
  const fields = useQuery({
    queryKey: ['analysis-fields', datasetId, snapshotId],
    queryFn: () => runtimeClient.getDatasetFields(datasetId, snapshotId),
  });
  const version = useQuery({
    queryKey: ['frozen-cleaning-version', datasetId, snapshotId, cleaningVersionId],
    queryFn: async () => {
      const sessions = await runtimeClient.listDatasetCleaningSessions(datasetId);
      const session = sessions.find(
        (item) =>
          item.recipeVersionId === cleaningVersionId &&
          (item.inputSnapshotId === snapshotId || item.outputSnapshotIds.includes(snapshotId)),
      );
      if (!session) throw new Error(t('analytics.cleaningVersionUnavailable'));
      const detail = await runtimeClient.getDatasetCleaningSession(datasetId, session.id);
      if (detail.recipeVersion.id !== cleaningVersionId)
        throw new Error(t('analytics.cleaningVersionUnavailable'));
      return detail.recipeVersion;
    },
    enabled: Boolean(cleaningVersionId),
    retry: false,
  });
  return (
    <Card className="analysis-provenance" data-testid="frozen-analysis-input">
      <h2>{t('analytics.frozenInput')}</h2>
      <p>{t('analytics.frozenDatasetHint')}</p>
      <ErrorNotice message={(snapshot.error ?? fields.error ?? version.error)?.message} />
      {(snapshot.isPending || fields.isPending) && <p role="status">{t('loading')}</p>}
      {snapshot.data && (
        <dl className="diagnostics-grid">
          <dt>{t('analytics.snapshotId')}</dt>
          <dd>{snapshot.data.id}</dd>
          <dt>{t('analytics.inputRows')}</dt>
          <dd>{snapshot.data.rowCount}</dd>
          <dt>{t('analytics.fingerprint')}</dt>
          <dd>{snapshot.data.fingerprint}</dd>
        </dl>
      )}
      {fields.data && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('analytics.inputField')}</th>
                <th>{t('analytics.inputType')}</th>
              </tr>
            </thead>
            <tbody>
              {fields.data.fields.map((field) => (
                <tr key={field.name}>
                  <td>{field.name}</td>
                  <td>{t(`ux.fieldType.${field.type === 'text' ? 'string' : field.type}`)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cleaningVersionId && (
        <p>
          {t('analytics.cleaningVersion')}: {cleaningVersionId}
        </p>
      )}
      {version.isFetching && <p role="status">{t('loading')}</p>}
      {version.data && (
        <details open>
          <summary>
            {version.data.name} · v{version.data.revision}
          </summary>
          <pre>{JSON.stringify(version.data.steps, null, 2)}</pre>
        </details>
      )}
    </Card>
  );
}
