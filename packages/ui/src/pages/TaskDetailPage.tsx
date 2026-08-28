import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runtimeClient } from '@zhiyun/client';
import { Badge, Button, Card, ErrorNotice } from '../components/ui.js';
import type { Run, Task } from '../types.js';

export function TaskDetailPage() {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const [task, setTask] = useState<Task | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!id) return;
    void Promise.all([runtimeClient.getTask(id), runtimeClient.listTaskRuns(id)])
      .then(([loadedTask, loadedRuns]) => {
        setTask(loadedTask);
        setRuns(loadedRuns.items);
      })
      .catch((reason: Error) => setError(reason.message));
  }, [id]);
  const run = async () => {
    if (!id) return;
    try {
      const result = await runtimeClient.runTask(id);
      void navigate(`/runs/${result.runId}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  if (!task)
    return (
      <>
        <ErrorNotice message={error} />
        <p>{t('loading')}</p>
      </>
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <Link className="back-link" to="/">
            ← {t('back')}
          </Link>
          <h1>{task.name}</h1>
          <p className="url-cell">{task.startUrl}</p>
        </div>
        <div className="row-actions">
          <Button onClick={() => void run()}>{t('run')}</Button>
          <Link className="button button-secondary" to={`/tasks/${task.id}/edit`}>
            {t('edit')}
          </Link>
        </div>
      </div>
      <ErrorNotice message={error} />
      <nav className="task-tabs" aria-label="Task sections">
        <Link className="active" to={`/tasks/${task.id}`}>
          Overview
        </Link>
        <a href="#runs">Runs</a>
        <Link to={`/tasks/${task.id}/dataset`}>Dataset</Link>
        <Link to={`/tasks/${task.id}/edit`}>Rules & Settings</Link>
      </nav>
      <div className="stats">
        <Card>
          <small>{t('status')}</small>
          <strong>{task.status}</strong>
        </Card>
        <Card>
          <small>{t('schedule')}</small>
          <strong>{task.schedule.mode === 'cron' ? task.schedule.cron : 'Manual'}</strong>
        </Card>
        <Card>
          <small>Active rule</small>
          <strong>{task.activeRule ? `v${task.activeRule.version.version}` : '—'}</strong>
        </Card>
      </div>
      <Card className="task-section">
        <div id="runs" />
        <h2>{t('history')}</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('status')}</th>
                <th>{t('startedAt')}</th>
                <th>{t('records')}</th>
                <th>{t('engine')}</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
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
                    {new Intl.DateTimeFormat(i18n.language, {
                      dateStyle: 'medium',
                      timeStyle: 'medium',
                    }).format(new Date(run.createdAt))}
                  </td>
                  <td>{run.recordCount}</td>
                  <td>{run.browserUsed ? 'Browser' : 'HTTP'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
