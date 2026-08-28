import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  CrawlRun,
  DatasetDiffEntry,
  DatasetDiffStats,
  DatasetRecord,
  DatasetStats,
  RecordChange,
} from '@zhiyun/contracts';
import { runtimeClient } from '@zhiyun/client';
import { Badge, Button, Card, ErrorNotice, Input } from '../components/ui.js';
import type { Task } from '../types.js';

interface DatasetPageResult {
  items: DatasetRecord[];
  nextCursor: string | null;
  stats: DatasetStats;
}

export function DatasetPage() {
  const { id } = useParams();
  const [task, setTask] = useState<Task | null>(null);
  const [page, setPage] = useState<DatasetPageResult | null>(null);
  const [changes, setChanges] = useState<RecordChange[]>([]);
  const [runs, setRuns] = useState<CrawlRun[]>([]);
  const [fromRunId, setFromRunId] = useState('');
  const [toRunId, setToRunId] = useState('');
  const [diff, setDiff] = useState<{
    items: DatasetDiffEntry[];
    nextCursor: string | null;
    stats: DatasetDiffStats;
  } | null>(null);
  const [query, setQuery] = useState('');
  const [includeRemoved, setIncludeRemoved] = useState(false);
  const [fieldFilter, setFieldFilter] = useState('');
  const [exportFields, setExportFields] = useState('');
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const exportController = useRef<AbortController | null>(null);

  const exportDataset = async (format: 'csv' | 'json' | 'xlsx') => {
    if (!id || exporting) return;
    setExporting(true);
    setError('');
    const controller = new AbortController();
    exportController.current = controller;
    try {
      const parsedFilter = fieldFilter
        ? (JSON.parse(fieldFilter) as Record<string, string | number | boolean | null>)
        : undefined;
      await runtimeClient.exportDataset(id, format, {
        signal: controller.signal,
        includeRemoved,
        ...(query ? { query } : {}),
        ...(parsedFilter ? { filter: parsedFilter } : {}),
        ...(exportFields.trim()
          ? {
              fields: exportFields
                .split(',')
                .map((field) => field.trim())
                .filter(Boolean),
            }
          : {}),
      });
    } catch (reason) {
      setError(
        controller.signal.aborted
          ? '导出已取消'
          : reason instanceof Error
            ? reason.message
            : String(reason),
      );
    } finally {
      if (exportController.current === controller) exportController.current = null;
      setExporting(false);
    }
  };

  const load = async (cursor?: string, append = false) => {
    if (!id) return;
    try {
      const [loadedTask, loadedPage, loadedChanges, loadedRuns] = await Promise.all([
        task ? Promise.resolve(task) : runtimeClient.getTask(id),
        runtimeClient.getDataset(id, {
          limit: 100,
          includeRemoved,
          ...(query ? { query } : {}),
          ...(fieldFilter ? { filter: fieldFilter } : {}),
          ...(cursor ? { cursor } : {}),
        }),
        runtimeClient.getDatasetChanges(id, 20),
        runtimeClient.listTaskRuns(id, 100),
      ]);
      setTask(loadedTask);
      setPage((current) =>
        append && current
          ? { ...loadedPage, items: [...current.items, ...loadedPage.items] }
          : loadedPage,
      );
      setChanges(loadedChanges.items);
      const successfulRuns = loadedRuns.items.filter((run) => run.status === 'succeeded');
      setRuns(successfulRuns);
      setToRunId((current) => current || successfulRuns[0]?.id || '');
      setFromRunId((current) => current || successfulRuns[1]?.id || successfulRuns[0]?.id || '');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const compareRuns = async (cursor?: string, append = false) => {
    if (!id || !fromRunId || !toRunId) return;
    try {
      const loaded = await runtimeClient.diffDatasetRuns(id, fromRunId, toRunId, 100, cursor);
      setDiff((current) =>
        append && current ? { ...loaded, items: [...current.items, ...loaded.items] } : loaded,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => {
    void load();
  }, [id, includeRemoved]);

  const columns = useMemo(
    () => [...new Set((page?.items ?? []).flatMap((record) => Object.keys(record.data)))],
    [page],
  );

  return (
    <>
      <div className="page-heading">
        <div>
          <Link className="back-link" to={`/tasks/${id}`}>
            ← 返回任务
          </Link>
          <h1>{task?.name ?? 'Dataset'}</h1>
          <p>当前数据、删除标记与最近变更历史</p>
        </div>
      </div>
      <ErrorNotice message={error} />
      <div className="stats">
        {(['current', 'added', 'updated', 'removed'] as const).map((key) => (
          <Card key={key}>
            <small>{key}</small>
            <strong>{page?.stats[key] ?? 0}</strong>
          </Card>
        ))}
      </div>
      <Card>
        <div className="section-heading">
          <div>
            <h2>Dataset</h2>
            <p>{task?.datasetSettings.mode ?? 'snapshot'} 模式</p>
          </div>
          <div className="row-actions dataset-filters">
            <Input
              value={query}
              placeholder="搜索记录"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void load()}
            />
            <Input
              value={fieldFilter}
              placeholder='字段过滤，如 {"status":"active"}'
              onChange={(event) => setFieldFilter(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && void load()}
            />
            <label className="check">
              <input
                type="checkbox"
                checked={includeRemoved}
                onChange={(event) => setIncludeRemoved(event.target.checked)}
              />
              显示已删除
            </label>
            <Button onClick={() => void load()}>搜索</Button>
            <Button
              className="button-secondary"
              disabled={exporting}
              onClick={() => void exportDataset('csv')}
            >
              CSV
            </Button>
            <Button
              className="button-secondary"
              disabled={exporting}
              onClick={() => void exportDataset('json')}
            >
              JSON
            </Button>
            <Button disabled={exporting} onClick={() => void exportDataset('xlsx')}>
              {exporting ? '导出中…' : 'XLSX'}
            </Button>
            {exporting && (
              <Button className="button-danger" onClick={() => exportController.current?.abort()}>
                取消导出
              </Button>
            )}
          </div>
        </div>
        <label className="dataset-export-fields">
          <span>导出字段与顺序（逗号分隔，留空为当前全部字段）</span>
          <Input
            value={exportFields}
            placeholder={columns.join(', ')}
            onChange={(event) => setExportFields(event.target.value)}
          />
        </label>
        {!page?.items.length ? (
          <div className="empty-small">暂无 Dataset 数据</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>状态</th>
                  {columns.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                  <th>最后出现</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((record) => (
                  <tr key={record.id}>
                    <td>
                      <Badge tone={record.removed ? 'danger' : 'success'}>
                        {record.removed ? 'removed' : 'current'}
                      </Badge>
                    </td>
                    {columns.map((column) => (
                      <td key={column}>{String(record.data[column] ?? '—')}</td>
                    ))}
                    <td>{new Date(record.lastSeenAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {page?.nextCursor && (
          <Button className="button-secondary" onClick={() => void load(page.nextCursor!, true)}>
            加载更多
          </Button>
        )}
      </Card>
      <Card>
        <h2>最近变更</h2>
        <div className="change-list">
          {changes.map((change) => (
            <div className="change-item" key={change.id}>
              <Badge
                tone={
                  change.type === 'removed'
                    ? 'danger'
                    : change.type === 'added'
                      ? 'success'
                      : 'neutral'
                }
              >
                {change.type}
              </Badge>
              <code>{change.datasetRecordId.slice(0, 8)}</code>
              <span>{new Date(change.createdAt).toLocaleString()}</span>
            </div>
          ))}
          {changes.length === 0 && <div className="empty-small">暂无变更</div>}
        </div>
      </Card>
      <Card>
        <div className="section-heading">
          <div>
            <h2>Run Diff</h2>
            <p>按 Dataset 唯一键比较两次成功运行的实际快照</p>
          </div>
          <div className="row-actions">
            <select value={fromRunId} onChange={(event) => setFromRunId(event.target.value)}>
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  From · {new Date(run.createdAt).toLocaleString()} · {run.recordCount}
                </option>
              ))}
            </select>
            <select value={toRunId} onChange={(event) => setToRunId(event.target.value)}>
              {runs.map((run) => (
                <option key={run.id} value={run.id}>
                  To · {new Date(run.createdAt).toLocaleString()} · {run.recordCount}
                </option>
              ))}
            </select>
            <Button disabled={runs.length < 2} onClick={() => void compareRuns()}>
              比较
            </Button>
          </div>
        </div>
        {diff && (
          <>
            <div className="stats compact-stats">
              {(['added', 'updated', 'removed'] as const).map((key) => (
                <div key={key}>
                  <small>{key}</small>
                  <strong>{diff.stats[key]}</strong>
                </div>
              ))}
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>变更</th>
                    <th>记录键</th>
                    <th>之前</th>
                    <th>之后</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.items.map((entry) => (
                    <tr key={entry.recordKey}>
                      <td>
                        <Badge tone={entry.type === 'removed' ? 'danger' : 'neutral'}>
                          {entry.type}
                        </Badge>
                      </td>
                      <td>
                        <code>{entry.recordKey.slice(0, 16)}</code>
                      </td>
                      <td>
                        <code>{entry.before ? JSON.stringify(entry.before) : '—'}</code>
                      </td>
                      <td>
                        <code>{entry.after ? JSON.stringify(entry.after) : '—'}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {diff.items.length === 0 && <div className="empty-small">两次 Run 没有数据变化</div>}
            {diff.nextCursor && (
              <Button
                className="button-secondary"
                onClick={() => void compareRuns(diff.nextCursor!, true)}
              >
                加载更多 Diff
              </Button>
            )}
          </>
        )}
        {!diff && runs.length < 2 && <div className="empty-small">至少需要两次成功 Run</div>}
      </Card>
    </>
  );
}
