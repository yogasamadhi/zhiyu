import { productCopy } from '../product-copy.js';
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { qualityRuleLabel } from '../monitoring.js';
import { QualityPolicyEditor } from '../components/monitoring/QualityPolicyEditor.js';
import { MonitoringAlerts } from '../components/monitoring/MonitoringAlerts.js';
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
import i18nCopy from '../i18n.js';
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
  const location = useLocation();
  const returnState = location.state as { taskList?: { search?: string; scroll?: number } } | null;
  const section = resolveTaskDetailSection(location.pathname);
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

  useEffect(() => {
    if (
      !id ||
      (task?.status !== 'running' &&
        !runs.some((run) => ['queued', 'running'].includes(run.status)))
    )
      return;
    let active = true;
    const timer = setTimeout(() => {
      void Promise.all([runtimeClient.getTask(id), loadTaskDetailOptionalData(runtimeClient, id)])
        .then(([latest, loaded]) => {
          if (!active) return;
          setTask(latest);
          setRuns(loaded.runs);
          setHealth(loaded.health);
          setAttempts(loaded.attempts);
          setEvaluations(loaded.evaluations);
          setResourceErrors(loaded.errors);
        })
        .catch((reason) => active && setError(String(reason)));
    }, 1500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [id, runs, task?.status]);
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
      setMessage(productCopy('质量策略已保存；告警不会把成功采集改判为失败，也不会暂停输出。'));
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
      setMessage(productCopy('任务输出绑定已更新。'));
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
      setMessage(productCopy('投递已重新进入队列。'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (!id) return <ErrorNotice message={productCopy('任务 ID 缺失')} />;
  if (!task) {
    return (
      <>
        <ErrorNotice message={error} />
        <p role={taskLoading ? 'status' : 'alert'}>
          {taskLoading ? t('loading') : productCopy('任务详情不可用，请返回任务列表后重试。')}
        </p>
      </>
    );
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <Link
            className="back-link"
            to={`/tasks${returnState?.taskList?.search ?? ''}`}
            state={returnState}
          >
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
          fields={fields.map((field) => field.name)}
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
          <small>{productCopy('状态')}</small>
          <strong>{i18nCopy.t(`ux.state.${props.task.status}`)}</strong>
        </Card>
        <Card>
          <small>{productCopy('计划')}</small>
          <strong>{describeSchedule(props.task.schedule)}</strong>
        </Card>
        <Card>
          <small>{productCopy('健康度')}</small>
          <strong>{i18nCopy.t(`ux.state.${props.health?.status ?? 'unknown'}`)}</strong>
        </Card>
        <Card>
          <small>{productCopy('最近记录数')}</small>
          <strong>{props.runs[0]?.recordCount ?? '—'}</strong>
        </Card>
      </div>
      <div className="two-column task-workflow-cards">
        <Card>
          <h2>{productCopy('最近状态')}</h2>
          <div className="task-health-line">
            <HealthBadge health={props.health} />
            <span>
              {props.health?.issues[0]?.message ??
                (props.health?.baselineReady
                  ? productCopy('最近运行没有发现质量问题。')
                  : productCopy('至少三次成功运行后启用统计型质量判断。'))}
            </span>
          </div>
          <div className="row-actions">
            <Link className="button" to={`/tasks/${props.task.id}/dataset`}>
              {productCopy('查看数据')}
            </Link>
            <Link className="button button-secondary" to={`/tasks/${props.task.id}/quality`}>
              {productCopy('质量详情')}
            </Link>
          </div>
        </Card>
        <Card>
          <h2>{productCopy('任务配置')}</h2>
          <p>
            {productCopy('来源：')}
            {props.task.origin.kind} {productCopy('· 活动规则')}{' '}
            {props.task.activeRule
              ? `v${props.task.activeRule.version.version}`
              : productCopy('未建立')}{' '}
            {productCopy('· 输出绑定')}
            {props.task.outputBindings.length}
          </p>
          <div className="row-actions">
            {props.canWrite && (
              <Link className="button button-secondary" to={`/tasks/${props.task.id}/edit`}>
                {productCopy('规则与设置')}
              </Link>
            )}
            {props.canManageOutput && (
              <Link className="button button-secondary" to="/outputs">
                {productCopy('管理目的地')}
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
  fields: string[];
  policy: QualityPolicy | null;
  health: TaskHealth | null;
  evaluations: QualityEvaluation[];
  canWrite: boolean;
  busy: boolean;
  onChange(next: QualityPolicy): void;
}) {
  const policy = props.policy;
  const healthQuery = useQuery({
    queryKey: ['task-monitoring-health', props.taskId],
    queryFn: () => runtimeClient.getTaskHealth(props.taskId),
    refetchInterval: 3000,
  });
  const evaluationsQuery = useQuery({
    queryKey: ['task-monitoring-evaluations', props.taskId],
    queryFn: () => runtimeClient.listTaskQualityEvaluations(props.taskId, 50),
    refetchInterval: 3000,
  });
  const health = healthQuery.data ?? props.health;
  const evaluations = evaluationsQuery.data ?? props.evaluations;
  return (
    <>
      <div className="two-column">
        <Card>
          <h2>{productCopy('质量策略')}</h2>
          {policy ? (
            <QualityPolicyEditor
              policy={policy}
              fields={props.fields}
              canWrite={props.canWrite}
              busy={props.busy}
              onSave={props.onChange}
            />
          ) : (
            <div className="empty-small">
              {productCopy('质量策略暂不可用，健康度与历史仍可查看。')}
            </div>
          )}
        </Card>
        <Card>
          <h2>{productCopy('当前健康度')}</h2>
          <ErrorNotice
            message={healthQuery.error instanceof Error ? healthQuery.error.message : ''}
          />
          <p>
            <HealthBadge health={health} /> {productCopy('· 基线')}
            {health?.baselineReady ? productCopy('已就绪') : productCopy('建立中')}
          </p>
          {(health?.issues ?? []).map((issue, index) => (
            <div className="notice notice-error" key={`${issue.kind}-${issue.field}-${index}`}>
              <strong>{qualityRuleLabel(issue.kind)}</strong>
              <p>{issue.message}</p>
            </div>
          ))}
          {!health?.issues.length && (
            <div className="empty-small">{productCopy('尚未发现质量问题；请结合评估状态查看')}</div>
          )}
          {props.canWrite && health?.issues.length ? (
            <Link className="button button-secondary" to={`/tasks/${props.taskId}/edit`}>
              {productCopy('解释原因 / 生成修复建议')}
            </Link>
          ) : null}
        </Card>
      </div>
      <MonitoringAlerts taskId={props.taskId} canWrite={props.canWrite} />
      <Card>
        <h2>{productCopy('评估与恢复历史')}</h2>
        <ErrorNotice
          message={evaluationsQuery.error instanceof Error ? evaluationsQuery.error.message : ''}
        />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{productCopy('时间')}</th>
                <th>{productCopy('状态')}</th>
                <th>{productCopy('记录数')}</th>
                <th>{productCopy('字段画像')}</th>
                <th>{productCopy('问题')}</th>
              </tr>
            </thead>
            <tbody>
              {evaluations.map((evaluation) => (
                <tr key={evaluation.id}>
                  <td>
                    <Link to={`/runs/${evaluation.runId}`}>
                      {new Date(evaluation.createdAt).toLocaleString()}
                    </Link>
                  </td>
                  <td>
                    <Badge tone={evaluation.status === 'healthy' ? 'success' : 'neutral'}>
                      {i18nCopy.t(`ux.state.${evaluation.status}`)}
                    </Badge>
                  </td>
                  <td>{evaluation.profile.recordCount}</td>
                  <td>{Object.keys(evaluation.profile.fields).join(', ') || '—'}</td>
                  <td>
                    {evaluation.issues.map((issue) => issue.message).join('；') ||
                      productCopy('已恢复/正常')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!evaluations.length && <div className="empty-small">{productCopy('尚无质量评估')}</div>}
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
        <h2>{productCopy('推荐分析')}</h2>
        <p>
          {numeric.length
            ? `数值字段 ${numeric.map((field) => field.name).join('、')}：推荐趋势、分布和异常值。`
            : productCopy('当前规则没有数值字段，可先运行一次并在数据画像中确认类型。')}
        </p>
        <p>
          {text.length
            ? `文本字段 ${text.map((field) => field.name).join('、')}：推荐重复项、频次和文本长度。`
            : productCopy('当前规则没有文本字段。')}
        </p>
        {props.canAnalyze && (
          <Link
            className="button"
            to={props.hasDataset ? `/analytics${query}` : `/tasks/${props.task.id}/dataset`}
          >
            {props.hasDataset ? productCopy('打开分析工作台') : productCopy('先查看并准备数据')}
          </Link>
        )}
      </Card>
      <Card>
        <h2>{productCopy('从文本创建语料库')}</h2>
        <p>{productCopy('选择文本字段，清洗与分块后构建可导出的语料。')}</p>
        {props.canAnalyze && (
          <Link
            className="button button-secondary"
            to={props.hasDataset ? `/corpora${query}` : `/tasks/${props.task.id}/dataset`}
          >
            {props.hasDataset ? productCopy('创建语料库') : productCopy('先准备数据版本')}
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
            <h2>{productCopy('任务输出绑定')}</h2>
            <p>{productCopy('编辑者可绑定管理员已经创建的目的地，但不能新建目的地或查看秘密。')}</p>
          </div>
          {props.canManage && (
            <Link className="button button-secondary" to="/outputs">
              {productCopy('管理目的地')}
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
              {!destination.enabled && productCopy('· 已禁用')}
            </label>
          ))}
        </div>
        {!props.destinations.length && (
          <div className="empty-small">{productCopy('尚无输出目的地')}</div>
        )}
      </Card>
      <Card>
        <h2>{productCopy('最近运行投递')}</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{productCopy('目的地')}</th>
                <th>{productCopy('状态')}</th>
                <th>{productCopy('格式 / 记录')}</th>
                <th>{productCopy('最终位置')}</th>
                <th>{productCopy('操作')}</th>
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
                      {i18nCopy.t(`ux.state.${attempt.status}`)}
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
                        {productCopy('重试')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!props.attempts.length && (
          <div className="empty-small">{productCopy('最近运行没有数据投递记录')}</div>
        )}
      </Card>
    </>
  );
}

function RunsSection(props: { runs: Run[]; locale: string }) {
  return (
    <Card>
      <h2>{productCopy('运行历史')}</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{productCopy('状态')}</th>
              <th>{productCopy('开始时间')}</th>
              <th>{productCopy('记录数')}</th>
              <th>{productCopy('变化')}</th>
              <th>{productCopy('引擎')}</th>
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
                      {i18nCopy.t(`ux.state.${run.status}`)}
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
      {!props.runs.length && <div className="empty-small">{productCopy('尚无运行记录')}</div>}
    </Card>
  );
}

function HealthBadge(props: { health: TaskHealth | null }) {
  const status = props.health?.status ?? 'unknown';
  return (
    <Badge tone={status === 'failing' ? 'danger' : status === 'healthy' ? 'success' : 'neutral'}>
      {i18nCopy.t(`ux.state.${status}`)}
    </Badge>
  );
}

function SupplementaryDataNotice(props: { loading: boolean; errors: string[] }) {
  if (props.loading) {
    return (
      <div className="notice" role="status">
        {productCopy('正在加载本页补充数据…')}
      </div>
    );
  }
  if (!props.errors.length) return null;
  return (
    <div className="notice notice-warning" role="status">
      {productCopy('部分数据暂不可用，但任务详情仍可继续使用：')}
      {props.errors.join('；')}
    </div>
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
