import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runtimeClient } from '@zhiyun/client';
import type { TaskListItem } from '@zhiyun/contracts';
import { Badge, Button, Card, ErrorNotice } from '../components/ui.js';
import { installBuiltInExampleTask, isBuiltInExampleTask } from '../example-task.js';

export function TaskListPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [error, setError] = useState('');
  const [addingExample, setAddingExample] = useState(false);
  const load = () =>
    Promise.all([runtimeClient.listTasks(), runtimeClient.listTrendSources().catch(() => [])])
      .then(([page, sources]) => {
        const managed = new Set(
          sources.flatMap((source) => (source.taskId ? [source.taskId] : [])),
        );
        setTasks(page.items.filter((task) => !managed.has(task.id)));
      })
      .catch((reason: Error) => setError(reason.message));
  useEffect(() => {
    void load();
  }, []);
  const run = async (id: string) => {
    try {
      const result = await runtimeClient.runTask(id);
      void navigate(`/runs/${result.runId}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const remove = async (id: string) => {
    if (!window.confirm(t('delete'))) return;
    await runtimeClient.deleteTask(id);
    await load();
  };
  const openExample = async () => {
    const existing = tasks.find(isBuiltInExampleTask);
    if (existing) {
      void navigate(`/tasks/${existing.id}`);
      return;
    }
    setAddingExample(true);
    setError('');
    try {
      const id = await installBuiltInExampleTask(runtimeClient, i18n.language);
      void navigate(`/tasks/${id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAddingExample(false);
    }
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t('workspace')}</p>
          <h1>{t('tasks')}</h1>
        </div>
        <div className="heading-actions">
          <Link className="button button-secondary" to="/preferences">
            {t('preferencesAndTrends')}
          </Link>
          <Button
            className="button-secondary"
            disabled={addingExample}
            onClick={() => void openExample()}
          >
            {addingExample ? t('addingExampleTask') : t('exampleTask')}
          </Button>
          <Link className="button" to="/tasks/new">
            ＋ {t('newTask')}
          </Link>
        </div>
      </div>
      <ErrorNotice message={error} />
      {tasks.length === 0 ? (
        <Card className="empty">
          <div className="empty-icon">⌁</div>
          <p>{t('emptyTasks')}</p>
          <p>{t('exampleTaskHint')}</p>
          <div className="empty-actions">
            <Link className="button" to="/preferences">
              {t('preferencesAndTrends')}
            </Link>
            <Button
              className="button-secondary"
              disabled={addingExample}
              onClick={() => void openExample()}
            >
              {addingExample ? t('addingExampleTask') : t('exampleTask')}
            </Button>
            <Link className="button button-secondary" to="/tasks/new">
              {t('newTask')}
            </Link>
          </div>
        </Card>
      ) : (
        <Card>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{t('name')}</th>
                  <th>{t('status')}</th>
                  <th>{t('lastRun')}</th>
                  <th>{t('records')}</th>
                  <th>{t('schedule')}</th>
                  <th>{t('actions')}</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <Link className="task-name" to={`/tasks/${task.id}`}>
                        {task.name}
                      </Link>
                      <small className="url-cell">{task.startUrl}</small>
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
                        {task.status}
                      </Badge>
                    </td>
                    <td>
                      {task.latestRun
                        ? new Intl.DateTimeFormat(i18n.language, {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          }).format(new Date(task.latestRun.createdAt))
                        : '—'}
                    </td>
                    <td>{task.latestRun?.recordCount ?? 0}</td>
                    <td>{task.schedule.mode === 'cron' ? task.schedule.cron : 'Manual'}</td>
                    <td>
                      <div className="row-actions">
                        <Button onClick={() => void run(task.id)}>{t('run')}</Button>
                        <Link className="button button-secondary" to={`/tasks/${task.id}/edit`}>
                          {t('edit')}
                        </Link>
                        <Button className="button-danger" onClick={() => void remove(task.id)}>
                          {t('delete')}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
