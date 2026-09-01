import { Navigate } from 'react-router-dom';

export function LegacyCrawlerAssistantRedirect() {
  return <Navigate to="/tasks/new?mode=ai" replace />;
}
