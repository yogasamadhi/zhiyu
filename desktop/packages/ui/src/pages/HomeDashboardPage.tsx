import { AssistantHomeEntry } from '../components/assistant/AssistantWorkspace.js';
import { productCopy } from '../product-copy.js';
import { Skeleton } from '../components/experience.js';
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runtimeClient } from '@zhiyun/client';
import type { TaskHealth } from '@zhiyun/contracts';
import { useWorkspaceAuth } from '../auth.js';
import { Badge, Card, ErrorNotice } from '../components/ui.js';

export function HomeDashboardPage() {
  const auth = useWorkspaceAuth();
  const { t, i18n } = useTranslation();
  const canCreate = !auth.identityEnabled || auth.permissions.includes('task.write');
  const queryClient = useQueryClient();
  const drafts = useQuery({
    queryKey: ['collection-drafts'],
    queryFn: () => runtimeClient.listCollectionDrafts(),
    enabled: canCreate,
  });
  const tasks = useQuery({
    queryKey: ['dashboard', 'tasks'],
    queryFn: async () => {
      let page = await runtimeClient.listTasks(500);
      const items = [...page.items];
      while (page.nextCursor) {
        page = await runtimeClient.listTasks(500, page.nextCursor);
        items.push(...page.items);
      }
      return { ...page, items };
    },
  });

  useEffect(
    () =>
      runtimeClient.onDomainEvent((event) => {
        if (event.aggregateType === 'task' || event.aggregateType === 'run') {
          void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
        }
      }),
    [queryClient],
  );

  const items = tasks.data?.items ?? [];
  const health = useQuery({
    queryKey: ['dashboard', 'health', items.map(({ id }) => id)],
    queryFn: async () => {
      const values: TaskHealth[] = [];
      for (let offset = 0; offset < items.length; offset += 100)
        values.push(
          ...(await runtimeClient.listTaskHealth(
            items.slice(offset, offset + 100).map(({ id }) => id),
          )),
        );
      return values;
    },
    enabled: items.length > 0,
    retry: 1,
  });
  const healthByTask = new Map<string, TaskHealth>(
    (health.data ?? []).map((item) => [item.taskId, item]),
  );
  const running = items.filter((task) => task.latestRun?.status === 'running').length;
  const needsAttention = items.filter((task) => {
    const status = healthByTask.get(task.id)?.status;
    return (
      status === 'warning' ||
      status === 'failing' ||
      task.status === 'failed' ||
      task.latestRun?.status === 'failed'
    );
  });
  const healthy = items.filter(
    (task) =>
      healthByTask.get(task.id)?.status === 'healthy' ||
      (!health.data && task.latestRun?.status === 'succeeded' && task.status !== 'failed'),
  ).length;
  const recent = [...items]
    .filter((task) => task.latestRun)
    .sort(
      (left, right) =>
        new Date(right.latestRun!.createdAt).getTime() -
        new Date(left.latestRun!.createdAt).getTime(),
    )
    .slice(0, 8);

  if (tasks.isPending || (canCreate && drafts.isPending))
    return (
      <>
        <h1>{t('home')}</h1>
        <Skeleton lines={5} />
      </>
    );
  if (tasks.isError)
    return (
      <>
        <h1>{t('home')}</h1>
        <ErrorNotice message={tasks.error.message} onRetry={() => void tasks.refetch()} />
      </>
    );
  return (
    <>
      <AssistantHomeEntry />
      <div className="page-heading dashboard-heading">
        <div>
          <p className="eyebrow">{t('workspace')}</p>
          <h1>{t('home')}</h1>
          <p>{t('homeIntro')}</p>
        </div>
        {canCreate && (
          <div className="heading-actions">
            <Link className="button" to="/tasks/new">
              ＋ {t('newTask')}
            </Link>
          </div>
        )}
      </div>

      {(drafts.data?.items.length ?? 0) > 0 && (
        <Card>
          <div className="section-heading">
            <div>
              <h2>{i18n.language.startsWith('zh') ? '继续未完成的采集' : 'Continue your draft'}</h2>
              <p>
                {i18n.language.startsWith('zh')
                  ? '配置已自动保存，可以从上次的步骤继续。'
                  : 'Your configuration was saved. Continue where you left off.'}
              </p>
            </div>
          </div>
          <div className="compact-list">
            {drafts.data!.items.slice(0, 3).map((draft) => (
              <Link key={draft.id} to={`/tasks/new?draft=${draft.id}`}>
                <strong>{draft.task.name || draft.task.instruction || t('newTask')}</strong>
                <span>
                  {i18n.language.startsWith('zh') ? productCopy('第') : 'Step'} {draft.step} / 3 →
                </span>
              </Link>
            ))}
          </div>
        </Card>
      )}
      {items.length > 0 && (
        <div className="dashboard-stats">
          <Link to="/tasks">
            <Card>
              <small>{t('tasks')}</small>
              <strong>{items.length}</strong>
              <span>{t('viewAll')}</span>
            </Card>
          </Link>
          <Card>
            <small>{t('runningNow')}</small>
            <strong>{running}</strong>
            <span>{t('runningNowHint')}</span>
          </Card>
          <Card className={needsAttention.length ? 'dashboard-attention' : ''}>
            <small>{t('needsAttention')}</small>
            <strong>{health.isPending ? '—' : needsAttention.length}</strong>
            <span>
              {health.isPending
                ? t('loading')
                : health.isError
                  ? t('ux.state.unassessed')
                  : needsAttention.length
                    ? t('needsAttentionHint')
                    : health.data?.length === items.length
                      ? t('allClear')
                      : t('ux.state.unassessed')}
            </span>
          </Card>
          <Card>
            <small>{t('recentHealthy')}</small>
            <strong>{health.isPending || health.isError ? '—' : healthy}</strong>
            <span>{t('recentHealthyHint')}</span>
          </Card>
        </div>
      )}
      {items.length === 0 ? (
        <Card className="empty dashboard-empty">
          <div className="empty-icon">⌁</div>
          <h2>{t('welcomeTitle')}</h2>
          <p>{t('welcomeHint')}</p>
          {canCreate && (
            <div className="empty-actions">
              <Link className="button" to="/tasks/new">
                {t('newTask')}
              </Link>
            </div>
          )}
        </Card>
      ) : (
        <div className="dashboard-columns">
          <Card>
            <div className="section-heading compact">
              <div>
                <h2>{t('needsAttention')}</h2>
                <p>{t('needsAttentionDescription')}</p>
              </div>
            </div>
            <div className="compact-list">
              {needsAttention.slice(0, 6).map((task) => (
                <Link key={task.id} to={`/tasks/${task.id}`}>
                  <span>
                    <strong>{task.name}</strong>
                    <small>
                      {healthByTask.get(task.id)?.issues[0]?.message ??
                        task.latestRun?.error ??
                        task.startUrl}
                    </small>
                  </span>
                  <Badge
                    tone={
                      healthByTask.get(task.id)?.status === 'failing' ||
                      task.latestRun?.status === 'failed'
                        ? 'danger'
                        : 'neutral'
                    }
                  >
                    {t(`ux.state.${healthByTask.get(task.id)?.status ?? 'failed'}`)}
                  </Badge>
                </Link>
              ))}
              {needsAttention.length === 0 && (
                <div className="empty-small">
                  {health.isPending
                    ? t('loading')
                    : health.isError
                      ? t('ux.state.unassessed')
                      : health.data?.length === items.length
                        ? t('allClear')
                        : t('ux.state.unassessed')}
                </div>
              )}
            </div>
          </Card>
          <Card>
            <div className="section-heading compact">
              <div>
                <h2>{t('recentRuns')}</h2>
                <p>{t('recentRunsDescription')}</p>
              </div>
              <Link to="/tasks">{t('viewAll')}</Link>
            </div>
            <div className="compact-list">
              {recent.map((task) => (
                <Link key={task.id} to={`/runs/${task.latestRun!.id}`}>
                  <span>
                    <strong>{task.name}</strong>
                    <small>
                      {new Intl.DateTimeFormat(i18n.language, {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      }).format(new Date(task.latestRun!.createdAt))}
                      {' · '}
                      {task.latestRun!.recordCount} {t('records').toLocaleLowerCase()}
                    </small>
                  </span>
                  <Badge
                    tone={
                      task.latestRun!.status === 'failed'
                        ? 'danger'
                        : task.latestRun!.status === 'succeeded'
                          ? 'success'
                          : 'neutral'
                    }
                  >
                    {t(`ux.state.${task.latestRun!.status}`)}
                  </Badge>
                </Link>
              ))}
              {recent.length === 0 && <div className="empty-small">{t('noRecentRuns')}</div>}
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
