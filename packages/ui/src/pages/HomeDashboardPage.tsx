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
  const tasks = useQuery({
    queryKey: ['dashboard', 'tasks'],
    queryFn: () => runtimeClient.listTasks(500),
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
    queryFn: () => runtimeClient.listTaskHealth(items.map(({ id }) => id)),
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

  return (
    <>
      <div className="page-heading dashboard-heading">
        <div>
          <p className="eyebrow">{t('workspace')}</p>
          <h1>{t('home')}</h1>
          <p>{t('homeIntro')}</p>
        </div>
        {canCreate && (
          <div className="heading-actions">
            <Link className="button button-secondary" to="/tasks/new?mode=ai">
              ✦ {t('aiCreate')}
            </Link>
            <Link className="button" to="/tasks/new">
              ＋ {t('newTask')}
            </Link>
          </div>
        )}
      </div>
      <ErrorNotice
        message={
          tasks.error instanceof Error
            ? tasks.error.message
            : tasks.error
              ? String(tasks.error)
              : ''
        }
      />
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
          <strong>{needsAttention.length}</strong>
          <span>{needsAttention.length ? t('needsAttentionHint') : t('allClear')}</span>
        </Card>
        <Card>
          <small>{t('recentHealthy')}</small>
          <strong>{healthy}</strong>
          <span>{t('recentHealthyHint')}</span>
        </Card>
      </div>
      {items.length === 0 ? (
        <Card className="empty dashboard-empty">
          <div className="empty-icon">⌁</div>
          <h2>{t('welcomeTitle')}</h2>
          <p>{t('welcomeHint')}</p>
          {canCreate && (
            <div className="empty-actions">
              <Link className="button" to="/tasks/new?mode=ai">
                ✦ {t('aiCreate')}
              </Link>
              <Link className="button button-secondary" to="/tasks/new">
                {t('manualCreate')}
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
                    {healthByTask.get(task.id)?.status ?? 'failed'}
                  </Badge>
                </Link>
              ))}
              {needsAttention.length === 0 && <div className="empty-small">{t('allClear')}</div>}
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
                    {task.latestRun!.status}
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
