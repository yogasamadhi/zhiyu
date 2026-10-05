import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { runtimeClient } from '@zhiyun/client';
import { Badge, Button, Card, ErrorNotice } from '../ui.js';
import { productCopy } from '../../product-copy.js';
import { qualityRuleLabel } from '../../monitoring.js';

export function MonitoringAlerts({ taskId, canWrite }: { taskId: string; canWrite: boolean }) {
  const cache = useQueryClient();
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]),
    [position, setPosition] = useState(0),
    [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    setCursors([undefined]);
    setPosition(0);
    setSelected(null);
  }, [taskId]);
  const cursor = cursors[position];
  const query = useQuery({
    queryKey: ['monitoring-alerts', taskId, cursor ?? null],
    queryFn: () =>
      runtimeClient.listTaskMonitoringAlerts(taskId, { limit: 10, ...(cursor ? { cursor } : {}) }),
    refetchInterval: 3000,
  });
  const dismiss = useMutation({
    mutationFn: (id: string) => runtimeClient.dismissTaskMonitoringAlert(taskId, id),
    onSuccess: () => cache.invalidateQueries({ queryKey: ['monitoring-alerts', taskId] }),
  });
  return (
    <Card aria-label={productCopy('监控事件')}>
      <div className="section-heading">
        <h2>{productCopy('监控事件')}</h2>
        <Button
          className="button-secondary"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {productCopy('刷新')}
        </Button>
      </div>
      <p className="subtle">
        {productCopy(
          '通知未显示时，仍可在这里查看事件。计划通知次数不代表系统已送达；关闭事件保留历史，后续异常仍会重新记录。',
        )}
      </p>
      <ErrorNotice message={query.error instanceof Error ? query.error.message : ''} />
      <ErrorNotice message={dismiss.error instanceof Error ? dismiss.error.message : ''} />
      {query.isPending && <p>{productCopy('正在读取事件')}</p>}
      {query.data?.items.map((alert) => (
        <article className="monitoring-alert" key={alert.id}>
          <div className="section-heading">
            <h3>
              {qualityRuleLabel(alert.kind)}
              {alert.field ? ` · ${alert.field}` : ''}
            </h3>
            <Badge tone={alert.status === 'resolved' ? 'success' : 'neutral'}>
              {productCopy(
                alert.status === 'open'
                  ? '异常中'
                  : alert.status === 'resolved'
                    ? '已恢复'
                    : '已关闭',
              )}
            </Badge>
          </div>
          <p>
            {productCopy('异常次数')} {alert.occurrenceCount} · {productCopy('计划通知次数')}{' '}
            {alert.notificationCount} · {productCopy('未通知次数')} {alert.suppressedCount}
          </p>
          <p>
            {productCopy('首次')}{' '}
            <Link to={`/runs/${alert.firstRunId}`}>{new Date(alert.firstAt).toLocaleString()}</Link>{' '}
            · {productCopy('最近异常')}{' '}
            <Link to={`/runs/${alert.lastRunId}`}>{new Date(alert.lastAt).toLocaleString()}</Link>
          </p>
          <div className="row-actions">
            <Button
              className="button-secondary"
              onClick={() => setSelected(selected === alert.id ? null : alert.id)}
            >
              {productCopy(selected === alert.id ? '收起运行记录' : '查看运行记录')}
            </Button>
            {canWrite && alert.status !== 'dismissed' && (
              <Button
                className="button-secondary"
                disabled={dismiss.isPending}
                onClick={() => dismiss.mutate(alert.id)}
              >
                {productCopy('关闭此事件')}
              </Button>
            )}
          </div>
          {selected === alert.id && (
            <AlertRuns
              key={alert.id}
              taskId={taskId}
              alertId={alert.id}
              total={alert.occurrenceCount}
            />
          )}
        </article>
      ))}
      {query.data && !query.data.items.length && (
        <p className="empty-small">{productCopy('当前页没有监控事件')}</p>
      )}
      <div className="row-actions">
        <Button
          className="button-secondary"
          disabled={position === 0 || query.isFetching}
          onClick={() => setPosition(position - 1)}
        >
          {productCopy('上一页')}
        </Button>
        <span>
          {productCopy('事件页')} {position + 1}
        </span>
        <Button
          className="button-secondary"
          disabled={!query.data?.nextCursor || query.isFetching}
          onClick={() => {
            const next = query.data?.nextCursor;
            if (next) {
              setCursors([...cursors.slice(0, position + 1), next]);
              setPosition(position + 1);
              setSelected(null);
            }
          }}
        >
          {productCopy('下一页')}
        </Button>
      </div>
    </Card>
  );
}

function AlertRuns({ taskId, alertId, total }: { taskId: string; alertId: string; total: number }) {
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]),
    [position, setPosition] = useState(0);
  const cursor = cursors[position];
  const query = useQuery({
    queryKey: ['monitoring-alert-runs', taskId, alertId, cursor ?? null],
    queryFn: () =>
      runtimeClient.listTaskMonitoringAlertRuns(taskId, alertId, {
        limit: 20,
        ...(cursor ? { cursor } : {}),
      }),
    refetchInterval: 3000,
  });
  const reasons = {
    ready: '已计划通知',
    cooldown: '冷却期间',
    consecutive: '等待连续异常',
    'no-notification': '仅记录事件',
  };
  return (
    <div className="monitoring-runs" aria-label={productCopy('事件运行记录')}>
      <h4>
        {productCopy('事件运行记录')} · {total}
      </h4>
      <ErrorNotice message={query.error instanceof Error ? query.error.message : ''} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{productCopy('运行')}</th>
              <th>{productCopy('时间')}</th>
              <th>{productCopy('通知决策')}</th>
            </tr>
          </thead>
          <tbody>
            {query.data?.items.map((run) => (
              <tr key={run.runId}>
                <td>
                  <Link to={`/runs/${run.runId}`}>{run.runId}</Link>
                </td>
                <td>{new Date(run.occurredAt).toLocaleString()}</td>
                <td>{productCopy(reasons[run.reason])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row-actions">
        <Button
          className="button-secondary"
          disabled={position === 0 || query.isFetching}
          onClick={() => setPosition(position - 1)}
        >
          {productCopy('上一页')}
        </Button>
        <span>
          {productCopy('运行记录页')} {position + 1}
        </span>
        <Button
          className="button-secondary"
          disabled={!query.data?.nextCursor || query.isFetching}
          onClick={() => {
            const next = query.data?.nextCursor;
            if (next) {
              setCursors([...cursors.slice(0, position + 1), next]);
              setPosition(position + 1);
            }
          }}
        >
          {productCopy('下一页')}
        </Button>
      </div>
    </div>
  );
}
