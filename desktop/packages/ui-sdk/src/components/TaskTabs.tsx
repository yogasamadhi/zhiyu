import { productCopy } from '../product-copy.js';
import { Link, useLocation } from 'react-router-dom';

export type TaskTab = 'overview' | 'data' | 'quality' | 'analysis' | 'output' | 'runs';

export function TaskTabs(props: { taskId: string; active: TaskTab }) {
  const location = useLocation();
  const tabs: Array<{ id: TaskTab; label: string; to: string }> = [
    { id: 'overview', label: productCopy('概览'), to: `/tasks/${props.taskId}` },
    { id: 'data', label: productCopy('数据'), to: `/tasks/${props.taskId}/dataset` },
    { id: 'quality', label: productCopy('质量'), to: `/tasks/${props.taskId}/quality` },
    { id: 'analysis', label: productCopy('分析'), to: `/tasks/${props.taskId}/analysis` },
    { id: 'output', label: productCopy('输出'), to: `/tasks/${props.taskId}/output` },
    { id: 'runs', label: productCopy('运行'), to: `/tasks/${props.taskId}/runs` },
  ];
  return (
    <nav className="task-tabs" aria-label="Task sections">
      {tabs.map((tab) => (
        <Link
          aria-current={props.active === tab.id ? 'page' : undefined}
          className={props.active === tab.id ? 'active' : ''}
          key={tab.id}
          to={tab.to}
          state={location.state}
        >
          {productCopy(tab.label)}
        </Link>
      ))}
    </nav>
  );
}
