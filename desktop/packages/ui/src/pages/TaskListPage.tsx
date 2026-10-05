import { productCopy } from '../product-copy.js';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Plus, Play, Check, AlertTriangle } from 'lucide-react';
import { runtimeClient } from '@zhiyun/client';
import { useWorkspaceAuth } from '../auth.js';
import { Badge, Button, Card, ErrorNotice, Input } from '../components/ui.js';
import { Dialog, EmptyState, Menu, Select, Skeleton } from '../components/experience.js';
import { describeSchedule } from '../schedule-builder.js';
type BulkAction = 'run' | 'pause' | 'resume' | 'delete';
export function TaskListPage() {
  const auth = useWorkspaceAuth(),
    { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const navigate = useNavigate();
  const location = useLocation();
  const cache = useQueryClient();
  const canWrite = !auth.identityEnabled || auth.permissions.includes('task.write'),
    canRun = !auth.identityEnabled || auth.permissions.includes('run.execute');
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const query = params.get('q') ?? '',
    status = params.get('status') ?? '',
    sort = params.get('sort') === 'name' ? 'name' : 'updatedAt',
    cursor = params.get('cursor') ?? undefined;
  const [selected, setSelected] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [outcomes, setOutcomes] = useState<
    Array<{ id: string; name: string; ok: boolean; message: string }>
  >([]);
  const tasks = useQuery({
    queryKey: ['tasks', query, status, sort, cursor],
    queryFn: () =>
      runtimeClient.listTasks(25, cursor, {
        query,
        ...(status ? { status } : {}),
        sort,
        includeManaged: false,
      }),
    refetchInterval: 5000,
  });
  const items = tasks.data?.items ?? [];
  useEffect(() => {
    if (tasks.data)
      window.scrollTo(
        0,
        (location.state as { taskList?: { scroll?: number } } | null)?.taskList?.scroll ?? 0,
      );
  }, [tasks.isPending, location.key]);
  const changeQuery = (patch: Record<string, string>) => {
    setSelected([]);
    setParams({ q: query, status, sort, ...patch });
  };
  const perform = async (action: BulkAction, ids = selected) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setOutcomes([]);
    setDeleting(null);
    for (const id of ids) {
      const name = items.find((item) => item.id === id)?.name ?? id;
      try {
        if (action === 'run') await runtimeClient.runTask(id);
        else {
          const task = await runtimeClient.getTask(id);
          if (action === 'delete') await runtimeClient.deleteTask(id);
          else {
            if (task.schedule.mode !== 'cron')
              throw new Error(zh ? '此任务尚未设置定时计划' : 'This task has no schedule');
            await runtimeClient.updateTask(id, {
              schedule: { ...task.schedule, paused: action === 'pause' },
            });
          }
        }
        setOutcomes((rows) => [...rows, { id, name, ok: true, message: zh ? '已完成' : 'Done' }]);
      } catch (reason) {
        setOutcomes((rows) => [
          ...rows,
          {
            id,
            name,
            ok: false,
            message: reason instanceof Error ? reason.message : String(reason),
          },
        ]);
      }
    }
    setSelected([]);
    setBusy(false);
    await cache.invalidateQueries({ queryKey: ['tasks'] });
  };
  const runOne = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const run = await runtimeClient.runTask(id);
      await navigate(`/runs/${run.runId}`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  const startExample = async () => {
    setBusy(true);
    try {
      const draft = await runtimeClient.createExampleDraft();
      await navigate(`/tasks/new?draft=${draft.id}`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{t('tasks')}</h1>
          <p>
            {zh
              ? '管理采集进度、运行计划和最近结果。'
              : 'Manage collection progress, schedules and recent results.'}
          </p>
        </div>
        {canWrite && (
          <Link className="button" to="/tasks/new">
            <Plus size={18} />
            {t('newTask')}
          </Link>
        )}
      </div>
      <form
        className="query-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          changeQuery({ q: search });
        }}
      >
        <Input
          aria-label={t('ux.search')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={zh ? '搜索任务名称或网址' : 'Search task name or URL'}
        />
        <Select
          aria-label={t('status')}
          value={status}
          onChange={(e) => changeQuery({ status: e.target.value })}
        >
          <option value="">{zh ? '全部状态' : 'All states'}</option>
          {['draft', 'ready', 'running', 'succeeded', 'failed'].map((s) => (
            <option key={s} value={s}>
              {t(`ux.state.${s}`)}
            </option>
          ))}
        </Select>
        <Select
          aria-label={t('ux.sort')}
          value={sort}
          onChange={(e) => changeQuery({ sort: e.target.value })}
        >
          <option value="updatedAt">{zh ? '最近更新' : 'Recently updated'}</option>
          <option value="name">{zh ? '任务名称' : 'Task name'}</option>
        </Select>
        <Button type="submit" className="button-secondary">
          {t('ux.search')}
        </Button>
      </form>
      <ErrorNotice message={error || tasks.error?.message} onRetry={() => void tasks.refetch()} />
      {selected.length > 0 && (
        <div className="bulk-toolbar" role="region" aria-label={zh ? '批量操作' : 'Bulk actions'}>
          <strong>
            {zh ? '已选择' : 'Selected'} {selected.length}
          </strong>
          {canRun && (
            <Button
              className="button-secondary"
              disabled={busy}
              onClick={() => void perform('run')}
            >
              {t('run')}
            </Button>
          )}
          {canWrite && (
            <>
              <Button
                className="button-secondary"
                disabled={busy}
                onClick={() => void perform('pause')}
              >
                {zh ? '暂停计划' : 'Pause schedules'}
              </Button>
              <Button
                className="button-secondary"
                disabled={busy}
                onClick={() => void perform('resume')}
              >
                {zh ? '恢复计划' : 'Resume schedules'}
              </Button>
              <Menu label={zh ? '更多' : 'More'}>
                <button type="button" disabled={busy} onClick={() => setDeleting(selected)}>
                  {t('delete')}
                </button>
              </Menu>
            </>
          )}
        </div>
      )}
      {outcomes.length > 0 && (
        <Card>
          <h2>{zh ? '批量操作结果' : 'Bulk action results'}</h2>
          <ul className="outcome-list" aria-live="polite">
            {outcomes.map((o) => (
              <li key={o.id}>
                {o.ok ? <Check size={16} /> : <AlertTriangle size={16} />}
                <strong>{o.name}</strong>
                <span>{o.message}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {tasks.isPending ? (
        <Skeleton />
      ) : items.length ? (
        <Card>
          <p>
            {tasks.data?.totalCount} {zh ? '个任务' : 'tasks'}
          </p>
          <div className="data-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label={zh ? '选择本页所有任务' : 'Select all tasks on this page'}
                      checked={
                        items.length > 0 && items.every((item) => selected.includes(item.id))
                      }
                      onChange={(e) =>
                        setSelected(e.target.checked ? items.map((item) => item.id) : [])
                      }
                    />
                  </th>
                  <th>{t('name')}</th>
                  <th>{t('status')}</th>
                  <th>{t('records')}</th>
                  <th>{t('schedule')}</th>
                  <th>{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`${zh ? '选择' : 'Select'} ${task.name}`}
                        checked={selected.includes(task.id)}
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, task.id]
                              : selected.filter((id) => id !== task.id),
                          )
                        }
                      />
                    </td>
                    <td>
                      <Link
                        className="task-name"
                        to={`/tasks/${task.id}`}
                        state={{ taskList: { search: location.search, scroll: window.scrollY } }}
                        onClick={(event) => {
                          if (
                            event.button ||
                            event.metaKey ||
                            event.ctrlKey ||
                            event.shiftKey ||
                            event.altKey
                          )
                            return;
                          event.preventDefault();
                          void navigate(`/tasks/${task.id}`, {
                            state: {
                              taskList: { search: location.search, scroll: window.scrollY },
                            },
                          });
                        }}
                      >
                        {task.name}
                      </Link>
                      <small className="url-cell">{task.startUrl}</small>
                      {task.origin.kind === 'example' && (
                        <Badge>{zh ? '内置样例' : 'Example'}</Badge>
                      )}
                    </td>
                    <td>
                      <Badge
                        tone={
                          task.status === 'failed'
                            ? 'danger'
                            : task.status === 'succeeded'
                              ? 'success'
                              : 'neutral'
                        }
                      >
                        {t(`ux.state.${task.status}`)}
                      </Badge>
                    </td>
                    <td>{task.latestRun?.recordCount ?? '—'}</td>
                    <td>
                      {task.schedule.paused
                        ? zh
                          ? '计划已暂停'
                          : 'Schedule paused'
                        : describeSchedule(task.schedule)}
                    </td>
                    <td>
                      <div className="row-actions">
                        {canRun && (
                          <Button
                            className="button-secondary"
                            disabled={busy || task.status === 'running'}
                            onClick={() => void runOne(task.id)}
                          >
                            <Play size={15} />
                            {t('run')}
                          </Button>
                        )}
                        {canWrite && (
                          <Menu label={zh ? '更多' : 'More'}>
                            <Link to={`/tasks/${task.id}/edit`}>{t('edit')}</Link>
                            <button
                              type="button"
                              disabled={busy || task.schedule.mode !== 'cron'}
                              onClick={() =>
                                void perform(task.schedule.paused ? 'resume' : 'pause', [task.id])
                              }
                            >
                              {task.schedule.paused
                                ? zh
                                  ? '恢复计划'
                                  : 'Resume schedule'
                                : zh
                                  ? '暂停计划'
                                  : 'Pause schedule'}
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setDeleting([task.id])}
                            >
                              {t('delete')}
                            </button>
                          </Menu>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <Button className="button-secondary" disabled={!cursor} onClick={() => changeQuery({})}>
              {zh ? '首页' : 'First page'}
            </Button>
            <Button
              className="button-secondary"
              disabled={!tasks.data?.nextCursor}
              onClick={() => changeQuery({ cursor: tasks.data!.nextCursor! })}
            >
              {zh ? '下一页' : 'Next page'}
            </Button>
          </div>
        </Card>
      ) : (
        !tasks.isError && (
          <EmptyState
            title={
              query || status
                ? zh
                  ? '没有匹配的任务'
                  : 'No matching tasks'
                : zh
                  ? '从第一次采集开始'
                  : 'Start your first collection'
            }
            description={
              zh
                ? '输入网址和数据目标，或用内置样例体验完整流程。'
                : 'Enter a URL and a data goal, or try the built-in example.'
            }
            action={
              canWrite ? (
                <div className="heading-actions">
                  <Link className="button" to="/tasks/new">
                    {t('newTask')}
                  </Link>
                  <Button
                    className="button-secondary"
                    disabled={busy}
                    onClick={() => void startExample()}
                  >
                    {zh ? '使用商品样例' : 'Use product example'}
                  </Button>
                </div>
              ) : undefined
            }
          />
        )
      )}
      <Dialog
        open={Boolean(deleting)}
        title={zh ? '删除选中的任务？' : 'Delete selected tasks?'}
        onClose={() => setDeleting(null)}
      >
        <p>
          {zh
            ? '将删除任务配置、规则版本、运行历史和关联的输出绑定。此操作无法撤销。'
            : 'This removes task configuration, rule versions, run history and output bindings. This cannot be undone.'}
        </p>
        <ul>
          {deleting?.map((id) => (
            <li key={id}>{items.find((item) => item.id === id)?.name ?? id}</li>
          ))}
        </ul>
        <div className="heading-actions">
          <Button className="button-secondary" onClick={() => setDeleting(null)}>
            {zh ? productCopy('取消') : 'Cancel'}
          </Button>
          <Button className="button-danger" onClick={() => void perform('delete', deleting ?? [])}>
            {t('delete')}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
