import { productCopy } from '../product-copy.js';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { runtimeClient, type IdentityAuditEvent } from '@zhiyun/client';
import { useWorkspaceAuth } from '../auth.js';
import { Badge, Button, Card, ErrorNotice } from '../components/ui.js';

export function AuditPage() {
  const auth = useWorkspaceAuth();
  const [cursor, setCursor] = useState<string | undefined>();
  const [history, setHistory] = useState<Array<string | undefined>>([]);
  const canRead = auth.permissions.includes('audit.read');
  const audit = useQuery({
    queryKey: ['identity', 'audit-events', cursor ?? 'first'],
    queryFn: () => runtimeClient.listAuditEvents(100, cursor),
    enabled: canRead,
  });

  if (!canRead) {
    return (
      <Card>
        <span className="badge badge-danger">{productCopy('权限不足')}</span>
        <h1>{productCopy('审计记录仅限管理员')}</h1>
        <p>{productCopy('审计事件不可通过普通 API 修改或删除。')}</p>
      </Card>
    );
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">{productCopy('工作区操作记录')}</span>
          <h1>{productCopy('工作区审计')}</h1>
          <p>{productCopy('查看身份、任务、运行、质量、输出与系统操作的最小必要记录。')}</p>
        </div>
        <Button className="button-secondary" onClick={() => void audit.refetch()}>
          {productCopy('刷新')}
        </Button>
      </div>
      <ErrorNotice message={audit.error ? errorMessage(audit.error) : ''} />
      <Card>
        <div className="section-heading">
          <div>
            <h2>{productCopy('审计事件')}</h2>
            <p>{productCopy('不记录密码、Cookie、服务账号 JSON、访问密钥或采集页面正文。')}</p>
          </div>
          <Badge tone="neutral">
            {productCopy('本页')}
            {audit.data?.items.length ?? 0} {productCopy('条')}
          </Badge>
        </div>
        <div className="table-wrap">
          <table className="audit-table">
            <thead>
              <tr>
                <th>{productCopy('时间 / 结果')}</th>
                <th>{productCopy('操作')}</th>
                <th>{productCopy('资源')}</th>
                <th>{productCopy('操作者')}</th>
                <th>{productCopy('追踪')}</th>
              </tr>
            </thead>
            <tbody>
              {audit.data?.items.map((event) => (
                <AuditRow event={event} key={event.id} />
              ))}
            </tbody>
          </table>
        </div>
        {audit.isPending && <p role="status">{productCopy('正在加载审计记录…')}</p>}
        {!audit.isPending && !audit.data?.items.length && (
          <div className="empty-small">{productCopy('尚无审计事件')}</div>
        )}
        <div className="audit-pagination">
          <Button
            className="button-secondary"
            disabled={!history.length}
            onClick={() => {
              const previous = history.at(-1);
              setHistory((items) => items.slice(0, -1));
              setCursor(previous);
            }}
          >
            {productCopy('上一页')}
          </Button>
          <Button
            className="button-secondary"
            disabled={!audit.data?.nextCursor}
            onClick={() => {
              if (!audit.data?.nextCursor) return;
              setHistory((items) => [...items, cursor]);
              setCursor(audit.data.nextCursor ?? undefined);
            }}
          >
            下一页
          </Button>
        </div>
      </Card>
    </>
  );
}

function AuditRow({ event }: { event: IdentityAuditEvent }) {
  return (
    <tr>
      <td>
        <strong className="task-name">{formatDate(event.occurredAt)}</strong>
        <Badge tone={auditTone(event.result)}>{auditResultLabel(event.result)}</Badge>
      </td>
      <td>
        <strong>{event.operationId}</strong>
        {hasDetails(event.details) && (
          <details className="audit-details">
            <summary>{productCopy('安全详情')}</summary>
            <pre>{JSON.stringify(event.details, null, 2)}</pre>
          </details>
        )}
      </td>
      <td>
        {event.resourceType}
        {event.resourceId && <small className="url-cell">{event.resourceId}</small>}
      </td>
      <td>{event.actorUserId ?? productCopy('系统 / 未认证')}</td>
      <td>
        {event.traceId ? <code>{event.traceId}</code> : '—'}
        {event.networkHash && (
          <small className="url-cell">
            {productCopy('网络')}
            {event.networkHash.slice(0, 12)}…
          </small>
        )}
      </td>
    </tr>
  );
}

function hasDetails(details: unknown): boolean {
  return Boolean(
    details &&
    typeof details === 'object' &&
    !Array.isArray(details) &&
    Object.keys(details).length,
  );
}

function auditTone(result: IdentityAuditEvent['result']): string {
  if (result === 'succeeded') return 'success';
  if (result === 'denied') return 'danger';
  return 'neutral';
}

function auditResultLabel(result: IdentityAuditEvent['result']): string {
  return {
    succeeded: productCopy('成功'),
    failed: productCopy('失败'),
    denied: productCopy('拒绝'),
  }[result];
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(
    new Date(value),
  );
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
