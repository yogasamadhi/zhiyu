import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { runtimeClient, type AnalyticsResult } from '@zhiyun/client';
import { Button, Card, ErrorNotice } from '../ui.js';

type Row = Record<string, unknown>;
export function ResultCollection({
  resultId,
  section,
  id,
  initial,
  total,
  nextCursor,
  children,
}: {
  resultId: string;
  section: 'table' | 'series';
  id: string;
  initial: Row[];
  total: number;
  nextCursor: string | null;
  children: (rows: Row[]) => ReactNode;
}) {
  const { t } = useTranslation();
  const [pages, setPages] = useState<Array<{ cursor: string | null; offset: number }>>([
    { cursor: null, offset: 0 },
  ]);
  const selected = pages.at(-1)!;
  const page = useQuery({
    queryKey: ['analytics', 'collection', resultId, section, id, selected.cursor],
    queryFn: () => runtimeClient.getAnalysisResultPage(resultId, section, id, 50, selected.cursor!),
    enabled: selected.cursor !== null,
    gcTime: 0,
    retry: false,
  });
  const rows = selected.cursor === null ? initial : page.data?.items;
  const next = selected.cursor === null ? nextCursor : page.data?.nextCursor;
  return (
    <>
      <ErrorNotice message={page.error?.message} onRetry={() => void page.refetch()} />
      {rows ? children(rows) : page.isPending ? <p role="status">{t('loading')}</p> : null}
      <div className="analysis-pagination" aria-label={t('analytics.paging')}>
        <span role="status">
          {t('analytics.pageRange', {
            start: total ? selected.offset + 1 : 0,
            end: selected.offset + (rows?.length ?? 0),
            total,
          })}
        </span>
        <Button
          className="button-secondary"
          disabled={pages.length < 2 || page.isFetching}
          onClick={() => setPages(pages.slice(0, -1))}
        >
          {t('analytics.previousPage')}
        </Button>
        <Button
          className="button-secondary"
          disabled={!next || !rows || page.isFetching}
          onClick={() =>
            next &&
            rows &&
            setPages([...pages, { cursor: next, offset: selected.offset + rows.length }])
          }
        >
          {t('analytics.nextPage')}
        </Button>
      </div>
    </>
  );
}

export function ResultTable({
  resultId,
  table,
}: {
  resultId: string;
  table: AnalyticsResult['tables'][number];
}) {
  const { t } = useTranslation();
  const declared =
    table.columns?.flatMap((column) => (typeof column.name === 'string' ? [column.name] : [])) ??
    [];
  return (
    <Card className="analysis-result-table" data-testid={`analysis-table-${table.id}`}>
      <h2>{t(`analytics.outputs.${table.id}`, { defaultValue: table.id })}</h2>
      <ResultCollection
        key={`${resultId}:table:${table.id}`}
        resultId={resultId}
        section="table"
        id={table.id}
        initial={table.rows}
        total={table.totalRows ?? table.rows.length}
        nextCursor={table.nextCursor ?? null}
      >
        {(rows) => {
          const columns = declared.length
            ? declared
            : [...new Set(rows.flatMap((row) => Object.keys(row)))];
          return (
            <>
              {!rows.length && <p>{t('analytics.emptyTable')}</p>}
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {columns.map((column) => (
                        <th key={column}>
                          {t(`analytics.outputs.${column}`, { defaultValue: column })}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => (
                      <tr key={index}>
                        {columns.map((column) => (
                          <td key={column}>{formatAnalysisValue(row[column])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          );
        }}
      </ResultCollection>
    </Card>
  );
}
export function formatAnalysisValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number')
    return Number.isInteger(value) ? String(value) : value.toPrecision(6);
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
