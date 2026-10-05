import { productCopy } from '../product-copy.js';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { FrozenInput } from '../components/analysis/FrozenInput.js';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Download, Columns3 } from 'lucide-react';
import { runtimeClient } from '@zhiyun/client';
import type { RecordPredicate, RecordQuery } from '@zhiyun/shared';
import { Badge, Button, Card, ErrorNotice, Input } from '../components/ui.js';
import { Field, Menu, Select, Skeleton, StatusNotice } from '../components/experience.js';
import { TaskTabs } from '../components/TaskTabs.js';
import { DatasetCleaningPanel } from '../components/dataset-cleaning/DatasetCleaningPanel.js';
import { useWorkspacePreference } from '../workspace-preferences.js';
export function DatasetPage() {
  const { datasetId: routeDatasetId, taskId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const dataset = useQuery({
    queryKey: ['dataset', routeDatasetId, taskId],
    queryFn: () =>
      routeDatasetId
        ? runtimeClient.getDatasetResource(routeDatasetId)
        : runtimeClient.findDatasetForTask(taskId!),
  });
  const id = dataset.data?.id,
    sourceTaskId = dataset.data?.sourceTaskId;
  const task = useQuery({
    queryKey: ['task', sourceTaskId],
    queryFn: () => runtimeClient.getTask(sourceTaskId!),
    enabled: Boolean(sourceTaskId),
  });
  const schema = useQuery({
    queryKey: ['dataset-fields', id],
    queryFn: () => runtimeClient.getDatasetFields(id!),
    enabled: Boolean(id),
  });
  const [query, setQuery] = useState(''),
    [search, setSearch] = useState('');
  const [filters, setFilters] = useState<RecordPredicate[]>([]);
  const [applied, setApplied] = useState<RecordPredicate[]>([]);
  const [sort, setSort] = useState<RecordQuery['sort']>();
  const [includeRemoved, setIncludeRemoved] = useState(false);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [target, setTarget] = useState<'analytics' | 'corpora' | null>(null);
  const [analysisSnapshotId, setAnalysisSnapshotId] = useState<string | null>(null);
  const [hidden, setHidden] = useWorkspacePreference<string[]>(`dataset-columns:${id ?? ''}`, []);
  const page = useQuery({
    queryKey: ['records', id, query, applied, sort, includeRemoved, cursors.at(-1)],
    queryFn: () =>
      runtimeClient.getDataset(id!, {
        query,
        filters: applied,
        ...(sort ? { sort } : {}),
        includeRemoved,
        limit: 50,
        ...(cursors.at(-1) ? { cursor: cursors.at(-1)! } : {}),
      }),
    enabled: Boolean(id),
  });
  const runs = useQuery({
    queryKey: ['dataset-runs', sourceTaskId],
    queryFn: () => runtimeClient.listTaskRuns(sourceTaskId!, 500),
    enabled: Boolean(sourceTaskId),
  });
  const changes = useQuery({
    queryKey: ['dataset-changes', id],
    queryFn: () => runtimeClient.getDatasetChanges(id!),
    enabled: Boolean(id),
  });
  const [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [comparison, setComparison] = useState<{ from: string; to: string } | null>(null),
    [diffCursor, setDiffCursor] = useState<string | undefined>();
  const diff = useQuery({
    queryKey: ['dataset-diff', id, comparison, diffCursor],
    queryFn: () =>
      runtimeClient.diffDatasetRuns(id!, comparison!.from, comparison!.to, 50, diffCursor),
    enabled: Boolean(id && comparison),
  });
  useEffect(() => {
    setCursors([undefined]);
  }, [query, JSON.stringify(applied), JSON.stringify(sort), includeRemoved, id]);
  const names = [
    ...new Set([
      ...(schema.data?.fields.map((field) => field.name) ?? []),
      ...(page.data?.items.flatMap((r) => Object.keys(r.data)) ?? []),
    ]),
  ];
  const visible = names.filter((name) => !hidden.includes(name));
  const exportData = async (format: 'csv' | 'json' | 'xlsx') => {
    if (!id || exporting) return;
    setExporting(true);
    setError('');
    try {
      await runtimeClient.exportDataset(id, format, {
        query,
        filters: applied,
        ...(sort ? { sort } : {}),
        includeRemoved,
        fields: visible,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExporting(false);
    }
  };
  const open = (kind: 'analytics' | 'corpora') => {
    if (!id) return;
    setTarget(kind);
    void navigate(
      `/${kind}?${new URLSearchParams({ datasetId: id, ...(kind === 'analytics' && analysisSnapshotId ? { snapshotId: analysisSnapshotId } : {}) })}`,
    );
  };
  const updateFilter = (index: number, patch: Partial<RecordPredicate>) =>
    setFilters((items) => items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  if (dataset.isPending) return <Skeleton lines={5} />;
  if (!dataset.data)
    return (
      <>
        <h1>{t('ux.datasets')}</h1>
        <ErrorNotice
          message={
            dataset.error?.message ??
            (zh ? '暂无采集结果。请先运行任务。' : 'No collection results yet. Run the task first.')
          }
          onRetry={() => void dataset.refetch()}
        />
        <Link to={taskId ? `/tasks/${taskId}` : '/tasks'} state={location.state}>
          {t('back')}
        </Link>
      </>
    );
  const total =
      (page.data as { totalCount?: number } | undefined)?.totalCount ?? dataset.data.currentCount,
    matched = (page.data as { matchedCount?: number } | undefined)?.matchedCount;
  return (
    <>
      <div className="page-heading">
        <div>
          <Link
            className="back-link"
            to={sourceTaskId ? `/tasks/${sourceTaskId}` : '/datasets'}
            state={location.state}
          >
            ← {zh ? '返回来源任务' : 'Back to source task'}
          </Link>
          <h1>{task.data?.name ?? dataset.data.name ?? t('ux.datasets')}</h1>
          <p>
            {zh
              ? '确认数据，筛选并导出你需要的内容。'
              : 'Review, filter and export the data you need.'}
          </p>
        </div>
        <div className="heading-actions">
          <Button
            className="button-secondary"
            disabled={Boolean(target)}
            onClick={() => open('analytics')}
          >
            {zh ? '开始分析' : 'Analyze'}
          </Button>
          <Menu label={exporting ? (zh ? '正在导出…' : 'Exporting…') : zh ? '导出' : 'Export'}>
            {(['csv', 'xlsx', 'json'] as const).map((format) => (
              <button
                key={format}
                type="button"
                disabled={exporting || visible.length === 0}
                onClick={() => void exportData(format)}
              >
                <Download size={16} />
                {format.toUpperCase()} ·{' '}
                {zh ? '当前筛选与可见字段' : 'Current filters and visible fields'}
              </button>
            ))}
            <button type="button" onClick={() => open('corpora')}>
              {zh ? '构建语料' : 'Build corpus'}
            </button>
          </Menu>
        </div>
      </div>
      {sourceTaskId && <TaskTabs taskId={sourceTaskId} active="data" />}
      {id && searchParams.get('snapshotId') && (
        <FrozenInput
          key={`${id}:${searchParams.get('snapshotId')}`}
          datasetId={id}
          snapshotId={searchParams.get('snapshotId')!}
          cleaningVersionId={searchParams.get('cleaningVersionId')}
        />
      )}
      {id && (
        <DatasetCleaningPanel key={id} datasetId={id} onSnapshotChange={setAnalysisSnapshotId} />
      )}
      <ErrorNotice
        message={error || page.error?.message || schema.error?.message}
        onRetry={() => void page.refetch()}
      />
      <Card>
        <h2>{zh ? '原始采集记录' : 'Original collected records'}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setCursors([undefined]);
            setQuery(search);
            setApplied(filters);
          }}
        >
          <div className="query-toolbar">
            <Input
              type="search"
              aria-label={t('ux.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                zh ? '搜索完整数据集中的字段值' : 'Search values across the complete dataset'
              }
            />
            <Button type="submit" className="button-secondary">
              {zh ? '应用查询' : 'Apply query'}
            </Button>
            <Menu label={zh ? '显示字段' : 'Columns'}>
              {names.map((name) => (
                <label className="column-option" key={name}>
                  <input
                    type="checkbox"
                    checked={!hidden.includes(name)}
                    onChange={(e) =>
                      setHidden(
                        e.target.checked ? hidden.filter((v) => v !== name) : [...hidden, name],
                      )
                    }
                  />
                  {name}
                </label>
              ))}
            </Menu>
          </div>
          {filters.map((filter, index) => (
            <div className="filter-row" key={index}>
              <Select
                aria-label={zh ? '筛选字段' : 'Filter field'}
                value={filter.field}
                onChange={(e) => {
                  const field = schema.data?.fields.find((f) => f.name === e.target.value);
                  updateFilter(index, {
                    field: e.target.value,
                    type:
                      field?.type === 'number'
                        ? 'number'
                        : field?.type === 'date'
                          ? 'date'
                          : 'text',
                    value: field?.type === 'number' ? 0 : '',
                  });
                }}
              >
                {names.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </Select>
              <Select
                aria-label={zh ? '筛选条件' : 'Filter operator'}
                value={filter.operator}
                onChange={(e) =>
                  updateFilter(index, { operator: e.target.value as RecordPredicate['operator'] })
                }
              >
                {[
                  ['eq', '等于', 'Equals'],
                  ['ne', '不等于', 'Not equal'],
                  ['contains', '包含', 'Contains'],
                  ['gt', '大于 / 晚于', 'Greater / after'],
                  ['gte', '大于等于', 'Greater or equal'],
                  ['lt', '小于 / 早于', 'Less / before'],
                  ['lte', '小于等于', 'Less or equal'],
                  ['empty', '为空', 'Is empty'],
                  ['not_empty', '非空', 'Is not empty'],
                ].map(([value, cn, en]) => (
                  <option key={value} value={value}>
                    {zh ? cn : en}
                  </option>
                ))}
              </Select>
              {!['empty', 'not_empty'].includes(filter.operator) && (
                <Input
                  aria-label={zh ? '比较值' : 'Comparison value'}
                  type={
                    filter.type === 'number' ? 'number' : filter.type === 'date' ? 'date' : 'text'
                  }
                  value={String(filter.value ?? '')}
                  onChange={(e) =>
                    updateFilter(index, {
                      value: filter.type === 'number' ? Number(e.target.value) : e.target.value,
                    })
                  }
                />
              )}
              <Button
                className="button-ghost"
                aria-label={zh ? '删除条件' : 'Remove condition'}
                onClick={() => setFilters(filters.filter((_, i) => i !== index))}
              >
                <Trash2 size={16} />
              </Button>
            </div>
          ))}
          <div className="query-toolbar">
            <Button
              className="button-ghost"
              disabled={!names[0] || filters.length >= 20}
              onClick={() =>
                setFilters([
                  ...filters,
                  { field: names[0]!, operator: 'contains', type: 'text', value: '' },
                ])
              }
            >
              <Plus size={16} />
              {zh ? '添加筛选条件（同时满足）' : 'Add filter (match all)'}
            </Button>
            <label className="check">
              <input
                type="checkbox"
                checked={includeRemoved}
                onChange={(e) => setIncludeRemoved(e.target.checked)}
              />
              {zh ? '显示已删除记录' : 'Include removed records'}
            </label>
            {(query || applied.length || sort) && (
              <Button
                className="button-ghost"
                onClick={() => {
                  setSearch('');
                  setQuery('');
                  setFilters([]);
                  setApplied([]);
                  setSort(undefined);
                  setCursors([undefined]);
                }}
              >
                {zh ? '清除查询' : 'Clear query'}
              </Button>
            )}
          </div>
        </form>
        <div className="table-summary">
          <strong>
            {zh ? '数据集总量' : 'Dataset total'} {total.toLocaleString()}
          </strong>
          <span>
            {zh ? '筛选结果' : 'Matching records'}{' '}
            {page.isPending ? '…' : (matched ?? 0).toLocaleString()}
          </span>
          <small>
            <Columns3 size={14} /> {visible.length}/{names.length}
          </small>
        </div>
        {page.isPending ? (
          <Skeleton />
        ) : (
          <div className="data-table-scroll">
            <table>
              <thead>
                <tr>
                  {includeRemoved && <th>{t('status')}</th>}
                  {visible.map((name) => (
                    <th key={name}>
                      <button
                        type="button"
                        className="table-sort"
                        aria-label={`${name} ${t('ux.sort')}`}
                        onClick={() => {
                          const type = schema.data?.fields.find((f) => f.name === name)?.type;
                          setCursors([undefined]);
                          setSort({
                            field: name,
                            type: type === 'number' ? 'number' : type === 'date' ? 'date' : 'text',
                            direction:
                              sort?.field === name && sort.direction === 'asc' ? 'desc' : 'asc',
                          });
                        }}
                      >
                        {name}
                        {sort?.field === name ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ' ↕'}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.data?.items.map((record) => (
                  <tr key={record.id}>
                    {includeRemoved && (
                      <td>
                        <Badge>
                          {record.removed ? (zh ? '已删除' : 'Removed') : zh ? '当前' : 'Current'}
                        </Badge>
                      </td>
                    )}
                    {visible.map((name) => (
                      <td key={name}>{format(record.data[name])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {!page.data?.items.length && (
              <p className="empty-state">{zh ? '没有符合条件的记录' : 'No matching records'}</p>
            )}
          </div>
        )}
        <div className="pagination">
          <span>
            {zh ? productCopy('第') : 'Page'} {cursors.length}{' '}
            {zh ? '页 · 每页 50 条' : '· 50 records per page'}
          </span>
          <Button
            className="button-secondary"
            disabled={cursors.length === 1}
            onClick={() => setCursors(cursors.slice(0, -1))}
          >
            {zh ? productCopy('上一页') : 'Previous'}
          </Button>
          <Button
            className="button-secondary"
            disabled={!page.data?.nextCursor}
            onClick={() => setCursors([...cursors, page.data!.nextCursor!])}
          >
            {zh ? '下一页' : 'Next'}
          </Button>
        </div>
      </Card>
      <details className="advanced-section">
        <summary>{zh ? '数据变更与版本比较' : 'Data changes and version comparison'}</summary>
        <div className="query-toolbar">
          <Field label={zh ? '起始运行' : 'From run'}>
            <Select value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">—</option>
              {(runs.data?.items ?? [])
                .filter((r) => r.status === 'succeeded')
                .map((run) => (
                  <option key={run.id} value={run.id}>
                    {new Date(run.createdAt).toLocaleString(i18n.language)}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label={zh ? '结束运行' : 'To run'}>
            <Select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">—</option>
              {(runs.data?.items ?? [])
                .filter((r) => r.status === 'succeeded')
                .map((run) => (
                  <option key={run.id} value={run.id}>
                    {new Date(run.createdAt).toLocaleString(i18n.language)}
                  </option>
                ))}
            </Select>
          </Field>
          <Button
            className="button-secondary"
            disabled={!from || !to}
            onClick={() => {
              setComparison({ from, to });
              setDiffCursor(undefined);
            }}
          >
            {zh ? '比较版本' : 'Compare'}
          </Button>
        </div>
        <ErrorNotice message={diff.error?.message} />
        {diff.data && (
          <>
            <StatusNotice>
              {zh ? '全部差异' : 'All changes'} · {zh ? productCopy('新增') : 'Added'}{' '}
              {diff.data.stats.added} · {zh ? productCopy('更新') : 'Updated'}{' '}
              {diff.data.stats.updated} · {zh ? productCopy('删除') : 'Removed'}{' '}
              {diff.data.stats.removed}
            </StatusNotice>
            <div className="data-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t('status')}</th>
                    <th>{zh ? '变更前' : 'Before'}</th>
                    <th>{zh ? '变更后' : 'After'}</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.data.items.map((item) => (
                    <tr key={item.recordKey}>
                      <td>{t(`ux.change.${item.type}`)}</td>
                      <td>{format(item.before)}</td>
                      <td>{format(item.after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button
              className="button-secondary"
              disabled={!diff.data.nextCursor}
              onClick={() => setDiffCursor(diff.data!.nextCursor!)}
            >
              {zh ? '下一页差异' : 'Next changes'}
            </Button>
          </>
        )}
        <h3>{zh ? '最近变更' : 'Recent changes'}</h3>
        <ul>
          {changes.data?.items.map((change) => (
            <li key={change.id}>
              {new Date(change.createdAt).toLocaleString(i18n.language)} ·{' '}
              {t(`ux.change.${change.type}`)}
              <details>
                <summary>{zh ? '查看详情' : 'Details'}</summary>
                <pre>{JSON.stringify({ before: change.before, after: change.after }, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}
function format(value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
