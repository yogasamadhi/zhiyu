import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  diagnosticRecovery,
  type RunDiagnostics as Report,
  type CrawlPlanDefinition,
} from '@zhiyun/contracts';
import { Badge, Button, Card, ErrorNotice } from './ui.js';

export function RunDiagnostics(props: {
  report?: Report | undefined;
  error?: string | undefined;
  taskId: string;
  running: boolean;
  canEdit: boolean;
  canRetry: boolean;
  retryable: boolean;
  definition?: CrawlPlanDefinition | undefined;
  refresh(): void;
  retry(): void;
  clear(): Promise<void>;
  export(): Promise<void>;
}) {
  const zh = useTranslation().i18n.language.startsWith('zh');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const kind = {
    navigation: zh ? '导航' : 'Navigation',
    action: zh ? '页面动作' : 'Action',
    selector: zh ? '字段匹配' : 'Selector',
    extraction: zh ? '提取' : 'Extraction',
    write: zh ? '写入' : 'Write',
  };
  const target = {
    list: zh ? '列表' : 'List',
    detail: zh ? '详情' : 'Detail',
    pagination: zh ? '分页' : 'Pagination',
    dataset: 'Dataset',
  };
  const status = {
    succeeded: zh ? '成功' : 'Succeeded',
    failed: zh ? '失败' : 'Failed',
    canceled: zh ? '已取消' : 'Canceled',
    skipped: zh ? '已跳过' : 'Skipped',
  };
  const code = {
    NAVIGATION_ERROR: zh ? '页面访问失败' : 'Navigation failed',
    ACTION_STATE_INVALID: zh ? '动作未达到预期页面状态' : 'Action did not reach its expected state',
    SELECTOR_UNMATCHED: zh ? '字段未匹配' : 'Field unmatched',
    EMPTY_PREVIEW: zh ? '提取结果为空' : 'No extracted rows',
    TIMEOUT: zh ? '步骤超时' : 'Step timed out',
    RESOURCE_LIMIT: zh ? '达到资源上限' : 'Resource limit reached',
    CANCELED: zh ? '已取消' : 'Canceled',
    NETWORK_POLICY_ERROR: zh ? '访问策略阻止请求' : 'Access policy blocked the request',
    EXTRACTION_ERROR: zh ? '字段转换或提取失败' : 'Extraction failed',
    WRITE_ERROR: zh ? '数据写入失败' : 'Write failed',
    UNEXPECTED_ERROR: zh ? '步骤执行失败' : 'Step failed',
  };
  return (
    <Card>
      <div className="section-heading">
        <h2>{zh ? '采集步骤诊断' : 'Collection step diagnostics'}</h2>
        <div className="row-actions">
          <Button
            className="button-secondary"
            disabled={busy || !props.report?.available}
            onClick={() => void act(props.export)}
          >
            {zh ? '导出诊断包' : 'Export diagnostics'}
          </Button>
          {props.canEdit && (
            <Button
              className="button-secondary"
              disabled={busy || props.running || !props.report?.available}
              onClick={() => void act(props.clear)}
            >
              {zh ? '清理本次诊断' : 'Clear this run’s diagnostics'}
            </Button>
          )}
        </div>
      </div>
      <ErrorNotice message={error || props.error} onRetry={props.refresh} />
      {!props.report?.available ? (
        <p>
          {zh
            ? '暂无步骤诊断；历史运行或诊断暂不可用时，采集结果仍可查看。'
            : 'No step diagnostics are available. Collection results remain accessible.'}
        </p>
      ) : (
        <>
          <p>
            {zh
              ? '诊断包仅包含步骤类型、计数、时间和固定错误码。页面内容、URL、凭据和填表值不包含在内。'
              : 'The report contains step types, counts, timing and error codes. Page contents, URLs, credentials and form values are excluded.'}
          </p>
          {props.report.truncated && (
            <p role="status">
              {zh
                ? `已保留最近步骤，共执行 ${props.report.stepCount} 步；导出上限为 256 步 / 64 KiB。`
                : `${props.report.stepCount} steps were observed. The report retains recent steps within 256 steps / 64 KiB.`}
            </p>
          )}
          <details>
            <summary>{zh ? '规则版本与执行标识' : 'Rule version and trace'}</summary>
            <p>
              Trace ID: <code>{props.report.run.traceId}</code>
            </p>
            <p>
              {zh ? '规则版本：' : 'Rule version: '}
              <code>{props.report.run.ruleVersionId ?? '—'}</code>
            </p>
          </details>
          <div className="data-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{zh ? '步骤' : 'Step'}</th>
                  <th>{zh ? '状态' : 'Status'}</th>
                  <th>{zh ? '结果' : 'Result'}</th>
                  <th>{zh ? '耗时' : 'Duration'}</th>
                  <th>{zh ? '下一步' : 'Next step'}</th>
                </tr>
              </thead>
              <tbody>
                {props.report.steps.map((step, index) => {
                  const recovery = step.errorCode ? diagnosticRecovery(step.errorCode) : null;
                  const fields =
                    step.target === 'detail'
                      ? props.definition?.detail?.rule.fields
                      : props.definition?.list.rule.fields;
                  const field =
                    step.fieldIndex === undefined
                      ? ''
                      : (Object.keys(fields ?? {})[step.fieldIndex] ??
                        `${zh ? '字段' : 'field'} ${step.fieldIndex + 1}`);
                  return (
                    <tr key={`${step.startedAt}-${index}`}>
                      <td>
                        {target[step.target]} ·{' '}
                        {step.kind === 'write' && step.writePhase
                          ? step.writePhase === 'staging'
                            ? '采集暂存'
                            : '结果更新'
                          : kind[step.kind]}
                        {step.actionType ? ` · ${step.actionType}` : ''}
                        {field ? ` · ${field}` : ''}
                      </td>
                      <td>
                        <Badge
                          tone={
                            step.status === 'failed'
                              ? 'danger'
                              : step.status === 'succeeded'
                                ? 'success'
                                : 'neutral'
                          }
                        >
                          {status[step.status]}
                        </Badge>
                      </td>
                      <td>
                        {step.errorCode
                          ? code[step.errorCode]
                          : step.writtenCount !== undefined
                            ? `${step.writtenCount} ${zh ? '条已写入' : 'rows written'}`
                            : step.recordCount !== undefined
                              ? `${step.recordCount} ${zh ? '条记录' : 'rows'}`
                              : step.matchedCount !== undefined
                                ? `${step.matchedCount} ${zh ? '次匹配' : 'matches'}`
                                : '—'}
                      </td>
                      <td>{step.durationMs} ms</td>
                      <td>
                        {props.canEdit &&
                          recovery &&
                          (['retry', 'new_run'].includes(recovery) ? (
                            <Button
                              className="button-secondary"
                              disabled={props.running || !props.canRetry || !props.retryable}
                              onClick={props.retry}
                            >
                              {zh ? '新建重试运行' : 'Start a retry run'}
                            </Button>
                          ) : (
                            <Link to={`/tasks/${props.taskId}/edit`}>
                              {recovery === 'edit_fields'
                                ? zh
                                  ? '修改字段规则'
                                  : 'Edit fields'
                                : recovery === 'edit_access'
                                  ? zh
                                    ? '修改访问策略'
                                    : 'Edit access policy'
                                  : zh
                                    ? '调整超时与资源上限'
                                    : 'Edit timeout and limits'}
                            </Link>
                          ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
