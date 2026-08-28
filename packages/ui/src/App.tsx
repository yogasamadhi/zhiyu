import { Suspense, useEffect } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Link, Route, Routes } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runtimeClient } from '@zhiyun/client';
import './styles.css';
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
      <ApplicationShell />
    </QueryClientProvider>
  );
}

function ApplicationShell() {
  const { t } = useTranslation();
  const graph = useQuery({
    queryKey: ['runtime', 'graph'],
    queryFn: () => runtimeClient.getRuntimeGraph(),
  });
  const activeContributions = resolveUiContributions(
    graph.data?.uiContributions.map(({ id }) => id) ?? [],
  );
  const navigation = activeContributions.navigation;
  const routes = activeContributions.routes;
  const toggleLanguage = async () => {
    const next = i18n.language === 'en' ? 'zh-CN' : 'en';
    localStorage.setItem('zhiyun-language', next);
    await i18n.changeLanguage(next);
  };
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/">
          <span className="brand-mark">织</span>
          <span>
            ZhiYun <small>织云</small>
          </span>
        </Link>
        <nav>
          {navigation.map((item) => (
            <Link key={item.id} to={item.to}>
              {t(item.labelKey)}
            </Link>
          ))}
          <Button className="button-ghost" onClick={() => void toggleLanguage()}>
            {t('language')}
          </Button>
        </nav>
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
      <footer>{t('footer')}</footer>
    </div>
  );
}
