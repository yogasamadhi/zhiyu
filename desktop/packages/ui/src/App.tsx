import { AssistantProvider } from './components/assistant/AssistantProvider.js';
import { AssistantHost } from './components/assistant/AssistantWorkspace.js';
import { Home, Menu, X } from 'lucide-react';
import { useWorkspacePreference } from './workspace-preferences.js';
import { Skeleton } from './components/experience.js';
import {
  Component,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
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
          <AssistantProvider>
            <ApplicationShell />
            <AssistantHost />
          </AssistantProvider>
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
    const zh = i18n.language.startsWith('zh');
    return (
      <main className="fatal-error" role="alert">
        <section className="card">
          <span className="badge badge-danger">{zh ? '界面异常' : 'Interface error'}</span>
          <h1>{zh ? '织云界面加载失败' : 'ZhiYun could not load this page'}</h1>
          <p>
            {zh
              ? '已保存的任务与会话仍然可用。请重新加载界面；若问题持续，请在诊断中查看错误信息。'
              : 'Your saved tasks and conversations are available. Reload the page; if the issue persists, check Diagnostics for error details.'}
          </p>
          <pre>{this.state.error.message}</pre>
          <Button onClick={() => window.location.reload()}>{zh ? '重新加载' : 'Reload'}</Button>
        </section>
      </main>
    );
  }
}

function ApplicationShell() {
  const { t } = useTranslation();
  const auth = useWorkspaceAuth();
  const [navOpen, setNavOpen] = useState(false);
  const navToggle = useRef<HTMLButtonElement>(null);
  const sidebar = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!navOpen) return;
    const first = sidebar.current?.querySelector<HTMLElement>('a,button');
    first?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setNavOpen(false);
        navToggle.current?.focus();
      }
      if (event.key !== 'Tab') return;
      const controls = [
        ...(sidebar.current?.querySelectorAll<HTMLElement>('a,button:not(:disabled)') ?? []),
        ...(navToggle.current ? [navToggle.current] : []),
      ];
      const index = controls.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      controls[(index + (event.shiftKey ? controls.length - 1 : 1)) % controls.length]?.focus();
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [navOpen]);
  const [pins] = useWorkspacePreference<string[]>('pinned-navigation', []);
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
      <a className="skip-link" href="#main-content">
        {t('ux.skipToContent')}
      </a>
      <aside
        ref={sidebar}
        className={`sidebar ${navOpen ? 'sidebar-open' : ''}`}
        id="workspace-navigation"
      >
        <Link className="brand" to="/">
          <span className="brand-mark">织</span>
          <span>
            ZhiYun <small>织云</small>
          </span>
        </Link>
        <nav className="sidebar-navigation" aria-label={t('workspace')}>
          {hasCollection && (
            <SidebarGroup label={t('navOverview')}>
              <NavLink to="/" end onClick={() => setNavOpen(false)}>
                <Home size={19} aria-hidden="true" />
                {t('home')}
              </NavLink>
            </SidebarGroup>
          )}
          <SidebarGroup label={t('workspace')}>
            {[...navigation]
              .filter(
                (item) =>
                  !['system'].includes(item.group) &&
                  (!['/recruitment', '/preferences', '/corpora'].includes(item.to) ||
                    pins.includes(item.to)),
              )
              .sort((a, b) => navigationOrder(a.to) - navigationOrder(b.to))
              .map((item) => (
                <NavLink key={item.id} to={item.to} onClick={() => setNavOpen(false)}>
                  <item.icon size={19} aria-hidden="true" />
                  {t(item.labelKey)}
                </NavLink>
              ))}
          </SidebarGroup>
        </nav>
        <div className="sidebar-footer">
          {navigation
            .filter((item) => item.group === 'system')
            .map((item) => (
              <NavLink
                className="footer-link"
                key={item.id}
                to={item.to}
                onClick={() => setNavOpen(false)}
              >
                <item.icon size={18} />
                {t(item.labelKey)}
              </NavLink>
            ))}
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
          <Button className="button-ghost language-button" onClick={() => void toggleLanguage()}>
            {t('language')}
          </Button>
          <small>{t('footer')}</small>
        </div>
      </aside>
      <div className="workspace-shell">
        <header className="mobile-topbar">
          <button
            ref={navToggle}
            type="button"
            className="button button-secondary"
            aria-label={t('ux.navigation')}
            aria-controls="workspace-navigation"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(!navOpen)}
          >
            {navOpen ? <X size={20} /> : <Menu size={20} />}
          </button>
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
        <main className="content" id="main-content">
          {graph.isPending ? (
            <Skeleton />
          ) : graph.isError ? (
            <section role="alert">
              <h1>Runtime degraded</h1>
              <p>{graph.error instanceof Error ? graph.error.message : String(graph.error)}</p>
            </section>
          ) : (
            <Suspense fallback={<Skeleton />}>
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

function navigationOrder(path: string) {
  const index = ['/tasks', '/datasets', '/analytics', '/outputs', '/scenarios'].indexOf(path);
  return index < 0 ? 10 : index;
}
