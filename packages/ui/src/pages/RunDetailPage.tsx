import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runtimeClient } from '@zhiyun/client';
import { Badge, Button, Card, ErrorNotice } from '../components/ui.js';
import type { Run } from '../types.js';
import type { RunLogEntry, RunRequestEntry } from '@zhiyun/contracts';

interface RecordPage {
  items: Array<{ id: string; data: Record<string, unknown>; sourceUrl: string }>;
  nextCursor: string | null;
}

export function RunDetailPage() {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const [run, setRun] = useState<Run | null>(null);
  const [records, setRecords] = useState<RecordPage>({ items: [], nextCursor: null });
  const [logs, setLogs] = useState<RunLogEntry[]>([]);
  const [requests, setRequests] = useState<RunRequestEntry[]>([]);
  const [failureExplanation, setFailureExplanation] = useState('');
  const [explaining, setExplaining] = useState(false);
  const [exporting, setExporting] = useState(false);
  const exportController = useRef<AbortController | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!id) return;
    let active = true;
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRecoveryProbe = () => {
      if (recoveryTimer) clearTimeout(recoveryTimer);
      recoveryTimer = setTimeout(() => void load(), 1_500);
    };
    const load = async () => {
      try {
        const loaded = await runtimeClient.getRun(id);
        if (!active) return;
        setRun(loaded);
        if (['queued', 'running'].includes(loaded.status)) {
          scheduleRecoveryProbe();
        } else if (recoveryTimer) {
          clearTimeout(recoveryTimer);
        }
        const [loadedLogs, loadedRequests] = await Promise.all([
          runtimeClient.getRunLogs(id, 100),
          runtimeClient.getRunRequests(id, 100),
        ]);
        if (!active) return;
        setLogs(loadedLogs.items);
        setRequests(loadedRequests.items);
        if (!['queued', 'running'].includes(loaded.status)) {
          setRecords(await runtimeClient.getRunRecords(id));
        }
      } catch (reason) {
        if (active) {
          setError(reason instanceof Error ? reason.message : String(reason));
          scheduleRecoveryProbe();
        }
      }
    };
    void load();
    const unsubscribe = runtimeClient.onDomainEvent((event) => {
      if (event.aggregateType === 'run' && event.aggregateId === id) void load();
    });
    return () => {
      active = false;
      if (recoveryTimer) clearTimeout(recoveryTimer);
      unsubscribe();
    };
  }, [id]);
  if (!run)
    return (
      <>
        <ErrorNotice message={error} />
        <p>{t('loading')}</p>
      </>
    );
  const date = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'medium' }).format(
          new Date(value),
        )
      : '—';
  const columns = [...new Set(records.items.flatMap((record) => Object.keys(record.data)))];
  const exportRecords = async (format: 'csv' | 'json' | 'xlsx') => {
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    try {
      await runtimeClient.exportRun(run.id, format, { signal: controller.signal });
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
  const cancel = async () => {
    try {
      setRun(await runtimeClient.cancelRun(run.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const retry = async () => {
    try {
      const result = await runtimeClient.retryRun(run.id);
      window.location.assign(`/runs/${result.runId}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const explainFailure = async () => {
    setExplaining(true);
    try {
      const result = await runtimeClient.explainRunFailure(run.id);
      setFailureExplanation(result.explanation);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setExplaining(false);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <Link className="back-link" to={`/tasks/${run.taskId}`}>
            ← {t('back')}
          </Link>
          <h1>
            Run <code>{run.id.slice(0, 8)}</code>
          </h1>
        </div>
        <div className="row-actions">
          {['queued', 'running'].includes(run.status) && (
            <Button className="button-danger" onClick={() => void cancel()}>
              取消
            </Button>
          )}
          {['failed', 'canceled'].includes(run.status) && (
            <Button className="button-secondary" onClick={() => void retry()}>
              重试
            </Button>
          )}
          {run.status === 'failed' && (
            <Button
              className="button-secondary"
              disabled={explaining}
              onClick={() => void explainFailure()}
            >
              {explaining ? '分析中…' : 'AI 解释失败'}
            </Button>
          )}
          <Badge
            tone={
              run.status === 'failed'
                ? 'danger'
                : run.status === 'succeeded'
                  ? 'success'
                  : 'neutral'
            }
          >
            {run.status}
          </Badge>
        </div>
      </div>
      <ErrorNotice message={error || run.error} />
      {failureExplanation && (
        <Card>
          <h2>失败解释</h2>
          <p>{failureExplanation}</p>
          <small>仅作为诊断建议，不会修改或激活规则。</small>
        </Card>
      )}
      {['queued', 'running'].includes(run.status) && (
        <div
          className="run-progress"
          aria-label={`Run progress ${Math.round(run.progress * 100)}%`}
        >
          <span style={{ width: `${Math.max(2, run.progress * 100)}%` }} />
          <small>
            {run.phase} · {Math.round(run.progress * 100)}%
          </small>
        </div>
      )}
      <div className="stats">
        <Card>
          <small>{t('startedAt')}</small>
          <strong>{date(run.startedAt)}</strong>
        </Card>
        <Card>
          <small>{t('records')}</small>
          <strong>{run.recordCount}</strong>
        </Card>
        <Card>
          <small>{t('engine')}</small>
          <strong>{run.browserUsed ? 'Browser' : 'HTTP'}</strong>
        </Card>
      </div>
      <Card>
        <div className="section-heading">
          <div>
            <h2>{t('records')}</h2>
            <p>
              {run.recordCount} records · {run.requestCount} requests
            </p>
          </div>
          {run.status === 'succeeded' && (
            <div className="row-actions">
              <Button
                className="button-secondary"
                disabled={exporting}
                onClick={() => void exportRecords('csv')}
              >
                {t('exportCsv')}
              </Button>
              <Button
                className="button-secondary"
                disabled={exporting}
                onClick={() => void exportRecords('json')}
              >
                {t('exportJson')}
              </Button>
              <Button disabled={exporting} onClick={() => void exportRecords('xlsx')}>
                {t('exportXlsx')}
              </Button>
              {exporting && (
                <Button className="button-danger" onClick={() => exportController.current?.abort()}>
                  取消导出
                </Button>
              )}
            </div>
          )}
        </div>
        {records.items.length === 0 ? (
          <div className="empty-small">
            {run.status === 'succeeded' ? t('noPreview') : t('loading')}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {records.items.map((record) => (
                  <tr key={record.id}>
                    {columns.map((column) => (
                      <td key={column}>{String(record.data[column] ?? '—')}</td>
                    ))}
                    <td>
                      <a href={record.sourceUrl} target="_blank" rel="noreferrer">
                        ↗
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="two-column">
        <Card>
          <h2>运行日志</h2>
          <div className="log-list">
            {logs.map((log) => (
              <div className={`log-line log-${log.level}`} key={log.id}>
                <time>{new Date(log.createdAt).toLocaleTimeString()}</time>
                <code>{log.phase}</code>
                <span>{log.message}</span>
              </div>
            ))}
            {logs.length === 0 && <div className="empty-small">暂无日志</div>}
          </div>
        </Card>
        <Card>
          <h2>请求历史</h2>
          <div className="log-list">
            {requests.map((item) => (
              <div className="request-line" key={item.id}>
                <Badge tone={item.status === 'failed' ? 'danger' : 'success'}>{item.status}</Badge>
                <span className="url-cell">{item.url}</span>
                <small>{item.durationMs}ms</small>
              </div>
            ))}
            {requests.length === 0 && <div className="empty-small">暂无请求</div>}
          </div>
        </Card>
      </div>
    </>
  );
}
