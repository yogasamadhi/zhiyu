import { Navigate, useLocation } from 'react-router-dom';
export function LegacyCrawlerAssistantRedirect() {
  const location = useLocation();
  return <Navigate replace to={`/assistant${location.search}`} />;
}
