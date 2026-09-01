import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runtimeClient } from '@zhiyun/client';
import type {
  DeliveryAttempt,
  OutputDestination,
  QualityEvaluation,
  QualityPolicy,
  TaskHealth,
} from '@zhiyun/contracts';
import { useWorkspaceAuth } from '../auth.js';
import { TaskTabs } from '../components/TaskTabs.js';
import { Badge, Button, Card, ErrorNotice } from '../components/ui.js';
import type { Run, Task } from '../types.js';
import { describeSchedule } from '../schedule-builder.js';
import {
  loadTaskDetailOptionalData,
  resolveTaskDetailCapabilities,
  resolveTaskDetailSection,
  taskSectionResourceErrors,
  taskWorkspaceQuery,
  type TaskDetailResourceErrors,
} from '../task-detail.js';

export function TaskDetailPage() {
  const auth = useWorkspaceAuth();
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const section = resolveTaskDetailSection(useLocation().pathname);
  const { canWrite, canRun, canBindOutput, canManageOutput, canAnalyze } =
    resolveTaskDetailCapabilities(auth.identityEnabled, auth.permissions);
  const navigate = useNavigate();
  const [task, setTask] = useState<Task | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [health, setHealth] = useState<TaskHealth | null>(null);
  const [policy, setPolicy] = useState<QualityPolicy | null>(null);
  const [evaluations, setEvaluations] = useState<QualityEvaluation[]>([]);
  const [destinations, setDestinations] = useState<OutputDestination[]>([]);
  const [attempts, setAttempts] = useState<DeliveryAttempt[]>([]);
  const [taskLoading, setTaskLoading] = useState(true);
  const [optionalLoading, setOptionalLoading] = useState(true);
  const [resourceErrors, setResourceErrors] = useState<TaskDetailResourceErrors>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    let active = true;
    setTask(null);
    setRuns([]);
    setHealth(null);
    setPolicy(null);
    setEvaluations([]);
    setDestinations([]);
    setAttempts([]);
    setResourceErrors({});
    setError('');
    setMessage('');
    setTaskLoading(true);
    setOptionalLoading(true);
    void runtimeClient
      .getTask(id)
      .then((loadedTask) => active && setTask(loadedTask))
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => active && setTaskLoading(false));
    void loadTaskDetailOptionalData(runtimeClient, id).then((loaded) => {
      if (!active) return;
      setRuns(loaded.runs);
      setHealth(loaded.health);
      setPolicy(loaded.policy);
      setEvaluations(loaded.evaluations);
      setDestinations(loaded.destinations);
      setAttempts(loaded.attempts);
      setResourceErrors(loaded.errors);
      setOptionalLoading(false);
    });
    return () => {
      active = false;
    };
  }, [id]);

  const workspaceQuery = taskWorkspaceQuery(runs);
  const hasDataset = new URLSearchParams(workspaceQuery).has('datasetId');
  const fields = useMemo(() => taskFields(task), [task]);

  const run = async () => {
    if (!id) return;
    try {
      const result = await runtimeClient.runTask(id);
      void navigate(`/runs/${result.runId}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const updatePolicy = async (next: QualityPolicy) => {
    if (!id) return;
    setBusy(true);
    setError('');
    try {
      setPolicy(await runtimeClient.updateTaskQualityPolicy(id, next));
      setMessage('质量策略已保存；告警不会把成功采集改判为失败，也不会暂停输出。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleBinding = async (destinationId: string) => {
    if (!task) return;
    const next = task.outputBindings.includes(destinationId)
      ? task.outputBindings.filter((candidate) => candidate !== destinationId)
      : [...task.outputBindings, destinationId];
    setBusy(true);
    setError('');
    try {
      const updated = await runtimeClient.updateTask(task.id, { outputBindings: next });
      setTask(updated);
      setMessage('任务输出绑定已更新。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const retryAttempt = async (attemptId: string) => {
    setBusy(true);
    setError('');
    try {
      const updated = await runtimeClient.retryDeliveryAttempt(attemptId);
      setAttempts((current) =>
        current.map((attempt) => (attempt.id === updated.id ? updated : attempt)),
      );
      setMessage('投递已重新进入队列。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (!id) return <ErrorNotice message="任务 ID 缺失" />;
  if (!task) {
    return (
      <>
        <ErrorNotice message={error} />
        <p role={taskLoading ? 'status' : 'alert'}>
          {taskLoading ? t('loading') : '任务详情不可用，请返回任务列表后重试。'}
        </p>
      </>
    );
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <Link className="back-link" to="/tasks">
            ← {t('back')}
          </Link>
          <h1>{task.name}</h1>
          <p className="url-cell">{task.startUrl}</p>
        </div>
        <div className="row-actions">
          {canRun && <Button onClick={() => void run()}>{t('run')}</Button>}
          {canWrite && (
            <Link className="button button-secondary" to={`/tasks/${task.id}/edit`}>
              {t('edit')}
            </Link>
          )}
        </div>
      </div>
      <ErrorNotice message={error} />
      {message && <div className="notice notice-success">{message}</div>}
      <TaskTabs taskId={task.id} active={section} />
      <SupplementaryDataNotice
        loading={optionalLoading}
        errors={taskSectionResourceErrors(section, resourceErrors)}
      />

      {section === 'overview' && (
        <OverviewSection
          task={task}
          runs={runs}
          health={health}
          canWrite={canWrite}
          canManageOutput={canManageOutput}
        />
      )}

      {section === 'quality' && (
        <QualitySection
          taskId={task.id}
          policy={policy}
          health={health}
          evaluations={evaluations}
          canWrite={canWrite}
          busy={busy}
          onChange={(next) => void updatePolicy(next)}
        />
      )}

      {section === 'analysis' && (
        <AnalysisSection
          task={task}
          fields={fields}
          workspaceQuery={workspaceQuery}
          hasDataset={hasDataset}
          canAnalyze={canAnalyze}
        />
      )}

      {section === 'output' && (
        <OutputSection
          task={task}
          destinations={destinations}
          attempts={attempts}
          canBind={canBindOutput}
          canManage={canManageOutput}
          busy={busy}
          onToggle={(destinationId) => void toggleBinding(destinationId)}
          onRetry={(attemptId) => void retryAttempt(attemptId)}
        />
      )}

      {section === 'runs' && <RunsSection runs={runs} locale={i18n.language} />}
    </>
  );
}

function OverviewSection(props: {
  task: Task;
  runs: Run[];
  health: TaskHealth | null;
  canWrite: boolean;
  canManageOutput: boolean;
}) {
  return (
    <>
      <div className="stats">
        <Card>
          <small>状态</small>
          <strong>{props.task.status}</strong>
        </Card>
        <Card>
          <small>计划</small>
          <strong>{describeSchedule(props.task.schedule)}</strong>
        </Card>
        <Card>
          <small>健康度</small>
          <strong>{props.health?.status ?? 'unknown'}</strong>
        </Card>
        <Card>
          <small>最近记录数</small>
          <strong>{props.runs[0]?.recordCount ?? 0}</strong>
        </Card>
      </div>
      <div className="two-column task-workflow-cards">
        <Card>
          <h2>最近状态</h2>
          <div className="task-health-line">
            <HealthBadge health={props.health} />
            <span>
              {props.health?.issues[0]?.message ??
                (props.health?.baselineReady
                  ? '最近运行没有发现质量问题。'
                  : '至少三次成功运行后启用统计型质量判断。')}
            </span>
          </div>
          <div className="row-actions">
            <Link className="button" to={`/tasks/${props.task.id}/dataset`}>
              查看数据
            </Link>
            <Link className="button button-secondary" to={`/tasks/${props.task.id}/quality`}>
              质量详情
            </Link>
          </div>
        </Card>
        <Card>
          <h2>任务配置</h2>
          <p>
            来源：{props.task.origin.kind} · 活动规则{' '}
            {props.task.activeRule ? `v${props.task.activeRule.version.version}` : '未建立'} ·
            输出绑定 {props.task.outputBindings.length}
          </p>
          <div className="row-actions">
            {props.canWrite && (
              <Link className="button button-secondary" to={`/tasks/${props.task.id}/edit`}>
                规则与设置
              </Link>
            )}
            {props.canManageOutput && (
              <Link className="button button-secondary" to="/outputs">
                管理目的地
              </Link>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}

function QualitySection(props: {
  taskId: string;
  policy: QualityPolicy | null;
  health: TaskHealth | null;
  evaluations: QualityEvaluation[];
  canWrite: boolean;
  busy: boolean;
  onChange(next: QualityPolicy): void;
}) {
  const policy = props.policy;
  return (
    <>
      <div className="two-column">
        <Card>
          <h2>质量策略</h2>
          {policy ? (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={policy.enabled}
                  disabled={!props.canWrite || props.busy}
                  onChange={(event) => props.onChange({ ...policy, enabled: event.target.checked })}
                />
                启用任务质量告警
              </label>
              <div className="compact-list">
                {policy.rules.map((rule, index) => (
                  <label className="check" key={rule.kind}>
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      disabled={!props.canWrite || props.busy}
                      onChange={(event) =>
                        props.onChange({
                          ...policy,
                          rules: policy.rules.map((candidate, position) =>
                            position === index
                              ? { ...candidate, enabled: event.target.checked }
                              : candidate,
                          ),
                        })
                      }
                    />
                    {qualityRuleLabel(rule.kind)}
                    {rule.threshold === undefined ? '' : ` · ${Math.round(rule.threshold * 100)}%`}
                  </label>
                ))}
              </div>
            </>
          ) : (
            <div className="empty-small">质量策略暂不可用，健康度与历史仍可查看。</div>
          )}
        </Card>
        <Card>
          <h2>当前健康度</h2>
          <p>
            <HealthBadge health={props.health} /> · 基线
            {props.health?.baselineReady ? '已就绪' : '建立中'}
          </p>
          {(props.health?.issues ?? []).map((issue, index) => (
            <div className="notice notice-error" key={`${issue.kind}-${issue.field}-${index}`}>
              <strong>{qualityRuleLabel(issue.kind)}</strong>
              <p>{issue.message}</p>
            </div>
          ))}
          {!props.health?.issues.length && <div className="empty-small">当前没有质量问题</div>}
          {props.canWrite && props.health?.issues.length ? (
            <Link className="button button-secondary" to={`/tasks/${props.taskId}/edit`}>
              解释原因 / 生成修复建议
            </Link>
          ) : null}
        </Card>
      </div>
      <Card>
        <h2>评估与恢复历史</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>状态</th>
                <th>记录数</th>
                <th>字段画像</th>
                <th>问题</th>
              </tr>
            </thead>
            <tbody>
              {props.evaluations.map((evaluation) => (
                <tr key={evaluation.id}>
                  <td>{new Date(evaluation.createdAt).toLocaleString()}</td>
                  <td>
                    <Badge tone={evaluation.status === 'healthy' ? 'success' : 'neutral'}>
                      {evaluation.status}
                    </Badge>
                  </td>
                  <td>{evaluation.profile.recordCount}</td>
                  <td>{Object.keys(evaluation.profile.fields).join(', ') || '—'}</td>
                  <td>
                    {evaluation.issues.map((issue) => issue.message).join('；') || '已恢复/正常'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!props.evaluations.length && <div className="empty-small">尚无质量评估</div>}
      </Card>
    </>
  );
}

function AnalysisSection(props: {
  task: Task;
  fields: Array<{ name: string; dataType: string }>;
  workspaceQuery: string;
  hasDataset: boolean;
  canAnalyze: boolean;
}) {
  const query = props.workspaceQuery ? `?${props.workspaceQuery}` : '';
  const numeric = props.fields.filter((field) => field.dataType === 'number');
  const text = props.fields.filter((field) => field.dataType === 'string');
  return (
    <div className="two-column">
      <Card>
        <h2>推荐分析</h2>
        <p>
          {numeric.length
            ? `数值字段 ${numeric.map((field) => field.name).join('、')}：推荐趋势、分布和异常值。`
            : '当前规则没有数值字段，可先运行一次并在数据画像中确认类型。'}
        </p>
        <p>
          {text.length
            ? `文本字段 ${text.map((field) => field.name).join('、')}：推荐重复项、频次和文本长度。`
            : '当前规则没有文本字段。'}
        </p>
        {props.canAnalyze && (
          <Link
            className="button"
            to={props.hasDataset ? `/analytics${query}` : `/tasks/${props.task.id}/dataset`}
          >
            {props.hasDataset ? '打开分析工作台' : '先查看并准备数据'}
          </Link>
        )}
      </Card>
      <Card>
        <h2>从文本创建语料库</h2>
        <p>将当前任务、最新快照和候选文本字段预填到现有语料工作流，不复制数据模型。</p>
        {props.canAnalyze && (
          <Link
            className="button button-secondary"
            to={props.hasDataset ? `/corpora${query}` : `/tasks/${props.task.id}/dataset`}
          >
            {props.hasDataset ? '创建语料库' : '先准备 Dataset Snapshot'}
          </Link>
        )}
      </Card>
    </div>
  );
}

function OutputSection(props: {
  task: Task;
  destinations: OutputDestination[];
  attempts: DeliveryAttempt[];
  canBind: boolean;
  canManage: boolean;
  busy: boolean;
  onToggle(destinationId: string): void;
  onRetry(attemptId: string): void;
}) {
  const destinationById = new Map(
    props.destinations.map((destination) => [destination.id, destination]),
  );
  return (
    <>
      <Card>
        <div className="section-heading">
          <div>
            <h2>任务输出绑定</h2>
            <p>编辑者可绑定管理员已经创建的目的地，但不能新建目的地或查看秘密。</p>
          </div>
          {props.canManage && (
            <Link className="button button-secondary" to="/outputs">
              管理目的地
            </Link>
          )}
        </div>
        <div className="compact-list">
          {props.destinations.map((destination) => (
            <label className="check" key={destination.id}>
              <input
                type="checkbox"
                checked={props.task.outputBindings.includes(destination.id)}
                disabled={!props.canBind || props.busy || !destination.enabled}
                onChange={() => props.onToggle(destination.id)}
              />
              <strong>{destination.name}</strong> · {destination.type}
              {!destination.enabled && ' · 已禁用'}
            </label>
          ))}
        </div>
        {!props.destinations.length && <div className="empty-small">尚无输出目的地</div>}
      </Card>
      <Card>
        <h2>最近运行投递</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>目的地</th>
                <th>状态</th>
                <th>格式 / 记录</th>
                <th>最终位置</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {props.attempts.map((attempt) => (
                <tr key={attempt.id}>
                  <td>
                    {destinationById.get(attempt.destinationId)?.name ?? attempt.destinationId}
                  </td>
                  <td>
                    <Badge
                      tone={
                        attempt.status === 'succeeded'
                          ? 'success'
                          : attempt.status === 'failed'
                            ? 'danger'
                            : 'neutral'
                      }
                    >
                      {attempt.status}
                    </Badge>
                  </td>
                  <td>
                    {attempt.format ?? '—'} · {attempt.deliveredRecordCount ?? '—'}
                  </td>
                  <td>
                    <code>{attempt.finalLocation ?? '—'}</code>
                  </td>
                  <td>
                    {attempt.status === 'failed' && props.canBind && (
                      <Button
                        className="button-secondary"
                        disabled={props.busy}
                        onClick={() => props.onRetry(attempt.id)}
                      >
                        重试
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!props.attempts.length && <div className="empty-small">最近运行没有数据投递记录</div>}
      </Card>
    </>
  );
}

function RunsSection(props: { runs: Run[]; locale: string }) {
  return (
    <Card>
      <h2>运行历史</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>状态</th>
              <th>开始时间</th>
              <th>记录数</th>
              <th>变化</th>
              <th>引擎</th>
            </tr>
          </thead>
          <tbody>
            {props.runs.map((run) => (
              <tr key={run.id}>
                <td>
                  <Link to={`/runs/${run.id}`}>
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
                  </Link>
                </td>
                <td>
                  {new Intl.DateTimeFormat(props.locale, {
                    dateStyle: 'medium',
                    timeStyle: 'medium',
                  }).format(new Date(run.createdAt))}
                </td>
                <td>{run.recordCount}</td>
                <td>
                  +{run.datasetStats.added} / ~{run.datasetStats.updated} / −
                  {run.datasetStats.removed}
                </td>
                <td>{run.browserUsed ? 'Browser' : 'HTTP'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!props.runs.length && <div className="empty-small">尚无运行记录</div>}
    </Card>
  );
}

function HealthBadge(props: { health: TaskHealth | null }) {
  const status = props.health?.status ?? 'unknown';
  return (
    <Badge tone={status === 'failing' ? 'danger' : status === 'healthy' ? 'success' : 'neutral'}>
      {status}
    </Badge>
  );
}

function SupplementaryDataNotice(props: { loading: boolean; errors: string[] }) {
  if (props.loading) {
    return (
      <div className="notice" role="status">
        正在加载本页补充数据…
      </div>
    );
  }
  if (!props.errors.length) return null;
  return (
    <div className="notice notice-warning" role="status">
      部分数据暂不可用，但任务详情仍可继续使用：{props.errors.join('；')}
    </div>
  );
}

function qualityRuleLabel(kind: string): string {
  return (
    {
      'run-failed': '运行失败',
      'empty-result': '空结果',
      'record-count-drop': '记录数骤降',
      'field-missing': '字段消失',
      'null-rate-spike': '空值率骤升',
      'type-change': '字段类型改变',
      'content-change': '内容变化阈值',
    }[kind] ?? kind
  );
}

function taskFields(task: Task | null): Array<{ name: string; dataType: string }> {
  const definition = task?.activeRule?.version.definition;
  if (!definition) return [];
  const fields = new Map<string, string>();
  for (const [name, rule] of Object.entries(definition.list.rule.fields))
    fields.set(name, rule.dataType);
  for (const [name, rule] of Object.entries(definition.detail?.rule.fields ?? {}))
    if (!fields.has(name)) fields.set(name, rule.dataType);
  return [...fields].map(([name, dataType]) => ({ name, dataType }));
}
