import { Link } from 'react-router-dom';

export type TaskTab = 'overview' | 'data' | 'quality' | 'analysis' | 'output' | 'runs';

export function TaskTabs(props: { taskId: string; active: TaskTab }) {
  const tabs: Array<{ id: TaskTab; label: string; to: string }> = [
    { id: 'overview', label: '概览', to: `/tasks/${props.taskId}` },
    { id: 'data', label: '数据', to: `/tasks/${props.taskId}/dataset` },
    { id: 'quality', label: '质量', to: `/tasks/${props.taskId}/quality` },
    { id: 'analysis', label: '分析', to: `/tasks/${props.taskId}/analysis` },
    { id: 'output', label: '输出', to: `/tasks/${props.taskId}/output` },
    { id: 'runs', label: '运行', to: `/tasks/${props.taskId}/runs` },
  ];
  return (
    <nav className="task-tabs" aria-label="Task sections">
      {tabs.map((tab) => (
        <Link
          aria-current={props.active === tab.id ? 'page' : undefined}
          className={props.active === tab.id ? 'active' : ''}
          key={tab.id}
          to={tab.to}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
