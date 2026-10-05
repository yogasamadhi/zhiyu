import { productCopy } from '../product-copy.js';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runtimeClient } from '@zhiyun/client';
import { useQuery } from '@tanstack/react-query';
import { useWorkspaceAuth } from '../auth.js';
import { Menu } from '../components/experience.js';
import { RunDiagnostics } from '../components/RunDiagnostics.js';
import { ActionCacheSummary } from '../components/RuleCacheNotice.js';
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
  const navigate = useNavigate();
  const auth = useWorkspaceAuth();
  const canRetryOutput = !auth.identityEnabled || auth.permissions.includes('output.bind');
  const [retryingOutput, setRetryingOutput] = useState<string | null>(null);
  const deliveries = useQuery({
    queryKey: ['run-deliveries', id],
    queryFn: () => runtimeClient.listDeliveryAttempts(id),
    enabled: Boolean(id),
    refetchInterval: 5000,
  });
  const destinations = useQuery({
    queryKey: ['outputs', 'destinations'],
    queryFn: () => runtimeClient.listOutputDestinations(),
  });
  const [run, setRun] = useState<Run | null>(null);
  const diagnostics = useQuery({
    queryKey: ['run-diagnostics', id],
    queryFn: () => runtimeClient.getRunDiagnostics(id!),
    enabled: Boolean(id),
    refetchInterval: run && ['queued', 'running'].includes(run.status) ? 1500 : false,
  });
  const diagnosticRules = useQuery({
    queryKey: ['run-diagnostic-rules', run?.taskId],
    queryFn: () => runtimeClient.listRules(run!.taskId),
    enabled: Boolean(run && diagnostics.data?.run.ruleVersionId),
  });
  const diagnosticDefinition = diagnosticRules.data
    ?.flatMap((rule) => rule.versions)
    .find((version) => version.id === diagnostics.data?.run.ruleVersionId)?.definition;
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
  useEffect(() => {
    if (run && !['queued', 'running'].includes(run.status)) void diagnostics.refetch();
  }, [run?.status, diagnostics.refetch]);
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
  const datasetId = typeof run.metadata.datasetId === 'string' ? run.metadata.datasetId : '';
  const snapshotId =
    typeof run.metadata.datasetSnapshotId === 'string' ? run.metadata.datasetSnapshotId : '';
  const workspaceQuery = new URLSearchParams({
    ...(datasetId ? { datasetId } : {}),
    ...(snapshotId ? { snapshotId } : {}),
  }).toString();
  const exportRecords = async (format: 'csv' | 'json' | 'xlsx') => {
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    try {
      await runtimeClient.exportRun(run.id, format, { signal: controller.signal });
    } catch (reason) {
      setError(
        controller.signal.aborted
          ? productCopy('导出已取消')
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
      await navigate(`/runs/${result.runId}`);
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
          <h1>{i18n.language.startsWith('zh') ? '采集运行' : 'Collection run'}</h1>
          <details>
            <summary>{i18n.language.startsWith('zh') ? '运行详情' : 'Run details'}</summary>
            <code>{run.id}</code>
          </details>
        </div>
        <div className="row-actions">
          {['queued', 'running'].includes(run.status) && (
            <Button className="button-danger" onClick={() => void cancel()}>
              {productCopy('取消')}
            </Button>
          )}
          {['failed', 'canceled'].includes(run.status) && (
            <Button className="button-secondary" onClick={() => void retry()}>
              {productCopy('重试')}
            </Button>
          )}
          {run.status === 'failed' && (
            <Button
              className="button-secondary"
              disabled={explaining}
              onClick={() => void explainFailure()}
            >
              {explaining ? productCopy('分析中…') : productCopy('AI 解释失败')}
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
            {t(`ux.state.${run.status}`)}
          </Badge>
        </div>
      </div>
      <ErrorNotice message={error || run.error} />
      <ActionCacheSummary value={run.metadata.actionCache} />
      <RunDiagnostics
        report={diagnostics.data}
        error={diagnostics.error?.message}
        definition={diagnosticDefinition}
        taskId={run.taskId}
        running={['queued', 'running'].includes(run.status)}
        canRetry={!auth.identityEnabled || auth.permissions.includes('run.execute')}
        retryable={['failed', 'canceled'].includes(run.status)}
        canEdit={!auth.identityEnabled || auth.permissions.includes('task.write')}
        refresh={() => void diagnostics.refetch()}
        retry={() => void retry()}
        clear={async () => {
          await runtimeClient.clearRunDiagnostics(run.id);
          await diagnostics.refetch();
        }}
        export={async () => {
          const report = await runtimeClient.getRunDiagnostics(run.id);
          const url = URL.createObjectURL(
            new Blob([JSON.stringify(report)], { type: 'application/json' }),
          );
          try {
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = `zhiyun-run-${run.id}-diagnostics.json`;
            anchor.click();
          } finally {
            URL.revokeObjectURL(url);
          }
        }}
      />
      {failureExplanation && (
        <Card>
          <h2>{productCopy('失败解释')}</h2>
          <p>{failureExplanation}</p>
          <small>{productCopy('仅作为诊断建议，不会修改或激活规则。')}</small>
        </Card>
      )}
      {['queued', 'running'].includes(run.status) && (
        <div
          className="run-progress"
          aria-label={`Run progress ${Math.round(run.progress * 100)}%`}
        >
          <span style={{ width: `${Math.max(2, run.progress * 100)}%` }} />
          <small>
            {t(`analytics.phase.${run.phase}`, { defaultValue: run.phase })} ·{' '}
            {Math.round(run.progress * 100)}%
          </small>
        </div>
      )}
      <Card>
        <h2>{i18n.language.startsWith('zh') ? '采集与输出状态' : 'Collection and delivery'}</h2>
        <p>
          {i18n.language.startsWith('zh') ? '采集：' : 'Collection: '}
          {t(`ux.state.${run.status}`)}
        </p>
        <ErrorNotice
          message={deliveries.error?.message}
          onRetry={() => void deliveries.refetch()}
        />
        {deliveries.isPending ? (
          <p role="status">{t('loading')}</p>
        ) : !deliveries.data?.length ? (
          <p>
            {i18n.language.startsWith('zh')
              ? '本次运行暂无输出投递。'
              : 'No deliveries for this run.'}
          </p>
        ) : (
          deliveries.data.map((attempt) => (
            <div className="section-heading" key={attempt.id}>
              <span>
                {destinations.data?.find((item) => item.id === attempt.destinationId)?.name ??
                  (i18n.language.startsWith('zh') ? '输出目的地' : 'Destination')}{' '}
                · {t(`ux.state.${attempt.status}`)}
              </span>
              {attempt.status === 'failed' && canRetryOutput && (
                <Button
                  className="button-secondary"
                  disabled={Boolean(retryingOutput)}
                  onClick={() => {
                    setRetryingOutput(attempt.id);
                    void runtimeClient
                      .retryDeliveryAttempt(attempt.id)
                      .then(() => deliveries.refetch())
                      .catch((reason: unknown) => setError(String(reason)))
                      .finally(() => setRetryingOutput(null));
                  }}
                >
                  {i18n.language.startsWith('zh') ? '仅重试输出' : 'Retry delivery only'}
                </Button>
              )}
            </div>
          ))
        )}
      </Card>
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
              {run.recordCount} {t('records')} · {run.requestCount}{' '}
              {i18n.language.startsWith('zh') ? '次请求' : 'requests'}
            </p>
          </div>
          {run.status === 'succeeded' && (
            <div className="row-actions">
              <Link className="button button-secondary" to={`/tasks/${run.taskId}/dataset`}>
                {productCopy('查看数据与差异')}
              </Link>
              <Link
                className="button button-secondary"
                to={
                  workspaceQuery ? `/analytics?${workspaceQuery}` : `/tasks/${run.taskId}/dataset`
                }
              >
                {productCopy('创建分析')}
              </Link>
              <Link
                className="button button-secondary"
                to={workspaceQuery ? `/corpora?${workspaceQuery}` : `/tasks/${run.taskId}/dataset`}
              >
                {productCopy('创建语料')}
              </Link>
              <Menu label={i18n.language.startsWith('zh') ? '导出' : 'Export'}>
                {(['csv', 'json', 'xlsx'] as const).map((format) => (
                  <button
                    type="button"
                    role="menuitem"
                    key={format}
                    disabled={exporting}
                    onClick={() => void exportRecords(format)}
                  >
                    {format.toUpperCase()}
                  </button>
                ))}
              </Menu>
              {exporting && (
                <Button className="button-danger" onClick={() => exportController.current?.abort()}>
                  {productCopy('取消导出')}
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
                  <th>{i18n.language.startsWith('zh') ? '来源' : 'Source'}</th>
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
          <h2>{productCopy('运行日志')}</h2>
          <div className="log-list">
            {logs.map((log) => (
              <div className={`log-line log-${log.level}`} key={log.id}>
                <time>{new Date(log.createdAt).toLocaleTimeString()}</time>
                <code>{log.phase}</code>
                <span>{log.message}</span>
              </div>
            ))}
            {logs.length === 0 && <div className="empty-small">{productCopy('暂无日志')}</div>}
          </div>
        </Card>
        <Card>
          <h2>{productCopy('请求历史')}</h2>
          <div className="log-list">
            {requests.map((item) => (
              <div className="request-line" key={item.id}>
                <Badge tone={item.status === 'failed' ? 'danger' : 'success'}>{item.status}</Badge>
                <span className="url-cell">{item.url}</span>
                <small>{item.durationMs}ms</small>
              </div>
            ))}
            {requests.length === 0 && <div className="empty-small">{productCopy('暂无请求')}</div>}
          </div>
        </Card>
      </div>
    </>
  );
}
