import { Component, Suspense, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Link, NavLink, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runtimeClient } from '@zhiyun/client';
import './styles.css';
import { AuthGate, useWorkspaceAuth } from './auth.js';
import i18n from './i18n.js';
import { Button } from './components/ui.js';
import { resolveUiContributions } from './shell/contributions.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 2, staleTime: 30_000, refetchOnWindowFocus: false },
    mutations: { retry: false },
  },
});

export function App() {
  useEffect(() => runtimeClient.onRuntimeReset(() => queryClient.clear()), []);
  return (
    <QueryClientProvider client={queryClient}>
      <ApplicationErrorBoundary>
        <AuthGate>
          <ApplicationShell />
        </AuthGate>
      </ApplicationErrorBoundary>
    </QueryClientProvider>
  );
}

interface ApplicationErrorBoundaryProps {
  children: ReactNode;
}

interface ApplicationErrorBoundaryState {
  error?: Error;
}

class ApplicationErrorBoundary extends Component<
  ApplicationErrorBoundaryProps,
  ApplicationErrorBoundaryState
> {
  state: ApplicationErrorBoundaryState = {};

  static getDerivedStateFromError(error: Error): ApplicationErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] Unhandled Renderer error', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-error" role="alert">
        <section className="card">
          <span className="badge badge-danger">界面异常</span>
          <h1>织云界面加载失败</h1>
          <p>
            任务与会话数据仍保存在 Runtime 中。请重新加载界面；若问题持续，请查看启动终端中的
            Renderer 错误。
          </p>
          <pre>{this.state.error.message}</pre>
          <Button onClick={() => window.location.reload()}>重新加载</Button>
        </section>
      </main>
    );
  }
}

function ApplicationShell() {
  const { t } = useTranslation();
  const auth = useWorkspaceAuth();
  const graph = useQuery({
    queryKey: ['runtime', 'graph'],
    queryFn: () => runtimeClient.getRuntimeGraph(),
  });
  const activeContributions = resolveUiContributions(
    graph.data?.uiContributions.map(({ id }) => id) ?? [],
  );
  const navigation = activeContributions.navigation.filter((item) => {
    if (
      auth.identityEnabled &&
      ['outputs.navigation', 'platform.settings-navigation'].includes(item.id)
    ) {
      return auth.permissions.includes('output.manage');
    }
    if (item.id === 'identity.members-navigation') {
      return auth.permissions.includes('member.manage');
    }
    if (item.id === 'identity.audit-navigation') return auth.permissions.includes('audit.read');
    return true;
  });
  const routes = activeContributions.routes;
  const hasCollection = routes.some(({ id }) => id === 'collection.route');
  const canCreateTasks =
    hasCollection && (!auth.identityEnabled || auth.permissions.includes('task.write'));
  const toggleLanguage = async () => {
    const next = i18n.language === 'en' ? 'zh-CN' : 'en';
    localStorage.setItem('zhiyun-language', next);
    await i18n.changeLanguage(next);
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" to="/">
          <span className="brand-mark">织</span>
          <span>
            ZhiYun <small>织云</small>
          </span>
        </Link>
        {canCreateTasks && (
          <Link className="sidebar-create" to="/tasks/new">
            ＋ {t('newTask')}
          </Link>
        )}
        <nav className="sidebar-navigation" aria-label={t('workspace')}>
          {hasCollection && (
            <SidebarGroup label={t('navOverview')}>
              <NavLink to="/" end>
                <span aria-hidden="true">⌂</span>
                {t('home')}
              </NavLink>
            </SidebarGroup>
          )}
          {(['collection', 'data', 'automation', 'system'] as const).map((group) => {
            const items = navigation.filter((item) => item.group === group);
            if (!items.length) return null;
            return (
              <SidebarGroup key={group} label={t(`navGroup.${group}`)}>
                {items.map((item) => (
                  <NavLink key={item.id} to={item.to}>
                    <span aria-hidden="true">{item.icon}</span>
                    {t(item.labelKey)}
                  </NavLink>
                ))}
              </SidebarGroup>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          {auth.user && (
            <div className="sidebar-user">
              <span>
                <strong>{auth.user.displayName}</strong>
                <small>{auth.user.email}</small>
              </span>
              <Button
                className="button-ghost"
                onClick={() => void auth.logout().catch(() => undefined)}
              >
                {t('logout')}
              </Button>
              {auth.logoutError ? <small role="alert">{auth.logoutError}</small> : null}
            </div>
          )}
          <Button className="button-ghost" onClick={() => void toggleLanguage()}>
            {t('language')}
          </Button>
          <small>{t('footer')}</small>
        </div>
      </aside>
      <div className="workspace-shell">
        <header className="mobile-topbar">
          <Link className="brand" to="/">
            <span className="brand-mark">织</span>
            <strong>ZhiYun</strong>
          </Link>
          {canCreateTasks && (
            <Link className="button" to="/tasks/new">
              ＋ {t('newTask')}
            </Link>
          )}
        </header>
        <main className="content">
          {graph.isPending ? (
            <p role="status">Loading Runtime…</p>
          ) : graph.isError ? (
            <section role="alert">
              <h1>Runtime degraded</h1>
              <p>{graph.error instanceof Error ? graph.error.message : String(graph.error)}</p>
            </section>
          ) : (
            <Suspense fallback={<p role="status">Loading…</p>}>
              <Routes>
                {routes.flatMap((contribution) =>
                  contribution.routes.map((route) => {
                    const Component = route.component;
                    return (
                      <Route
                        key={`${contribution.id}:${route.path}`}
                        path={route.path}
                        element={<Component />}
                      />
                    );
                  }),
                )}
              </Routes>
            </Suspense>
          )}
        </main>
      </div>
    </div>
  );
}

function SidebarGroup(props: { label: string; children: ReactNode }) {
  return (
    <section className="sidebar-group">
      <small>{props.label}</small>
      {props.children}
    </section>
  );
}
