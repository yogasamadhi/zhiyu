import React, {
  useEffect,
  useMemo,
  useState,
  lazy,
  Suspense,
  Component,
  type ReactNode,
} from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, NavLink, Link } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { runtimeClient } from '@zhiyun/client';
import { UiContributionsProvider, type UiSnapshot } from '@zhiyun/ui-sdk';
import { AuthGate } from '@zhiyun/ui-sdk/auth';
import i18n from '@zhiyun/ui-sdk/i18n';
import { productTransport, type RemoteApi } from '../client/transport.js';
import type { Json } from '../shared/protocol.js';

const pages = [
  {
    path: '/tasks',
    name: 'TaskListPage',
    load: () =>
      import('../../../desktop/packages/plugins/collection/src/client/pages/TaskListPage.js'),
  },
  {
    path: '/tasks/new',
    name: 'TaskEditorPage',
    load: () =>
      import('../../../desktop/packages/plugins/collection/src/client/pages/TaskEditorPage.js'),
  },
  {
    path: '/tasks/:id/edit',
    name: 'TaskEditorPage',
    load: () =>
      import('../../../desktop/packages/plugins/collection/src/client/pages/TaskEditorPage.js'),
  },
  ...[
    '/tasks/:id',
    '/tasks/:id/quality',
    '/tasks/:id/analysis',
    '/tasks/:id/output',
    '/tasks/:id/runs',
  ].map((path) => ({
    path,
    name: 'TaskDetailPage',
    load: () =>
      import('../../../desktop/packages/plugins/collection/src/client/pages/TaskDetailPage.js'),
  })),
  {
    path: '/runs/:id',
    name: 'RunDetailPage',
    load: () =>
      import('../../../desktop/packages/plugins/collection/src/client/pages/RunDetailPage.js'),
  },
  {
    path: '/datasets',
    name: 'DatasetsPage',
    load: () =>
      import('../../../desktop/packages/plugins/datasets/src/client/pages/DatasetsPage.js'),
  },
  ...['/datasets/:datasetId', '/tasks/:taskId/dataset'].map((path) => ({
    path,
    name: 'DatasetPage',
    load: () =>
      import('../../../desktop/packages/plugins/datasets/src/client/pages/DatasetPage.js'),
  })),
  {
    path: '/analytics',
    name: 'AnalyticsPage',
    load: () =>
      import('../../../desktop/packages/plugins/analytics/src/client/pages/AnalyticsPage.js'),
  },
  {
    path: '/analytics/recipes/:recipeId',
    name: 'AnalyticsRecipePage',
    load: () =>
      import('../../../desktop/packages/plugins/analytics/src/client/pages/AnalyticsRecipePage.js'),
  },
  ...['/analytics/jobs/:jobId', '/analytics/results/:resultId'].map((path) => ({
    path,
    name: 'AnalysisJobPage',
    load: () =>
      import('../../../desktop/packages/plugins/analytics/src/client/pages/AnalysisJobPage.js'),
  })),
  {
    path: '/corpora',
    name: 'CorporaPage',
    load: () => import('../../../desktop/packages/plugins/corpus/src/client/pages/CorporaPage.js'),
  },
  {
    path: '/corpora/:corpusId',
    name: 'CorpusDetailPage',
    load: () =>
      import('../../../desktop/packages/plugins/corpus/src/client/pages/CorpusDetailPage.js'),
  },
  {
    path: '/corpora/:corpusId/versions/:versionId',
    name: 'CorpusVersionPage',
    load: () =>
      import('../../../desktop/packages/plugins/corpus/src/client/pages/CorpusVersionPage.js'),
  },
  {
    path: '/outputs',
    name: 'OutputsPage',
    load: () => import('../../../desktop/packages/plugins/outputs/src/client/pages/OutputsPage.js'),
  },
];
const routes = pages.map((page) => ({
  ...page,
  Component: lazy(async () => ({
    default: ((await page.load()) as unknown as Record<string, React.ComponentType>)[page.name]!,
  })),
}));
const contributions: UiSnapshot = {
  routes: [
    {
      id: 'analytics.route',
      order: 0,
      routes: routes.map((row) => ({ path: row.path, component: row.Component })),
    },
  ],
  navigation: [],
  panels: [],
  wrappers: [],
};
interface WorkbenchRemote extends RemoteApi {
  credentialPrompts(workspaceId: string): Promise<Array<{ id: string; kind: string }>>;
  answerCredentialPrompt(
    workspaceId: string,
    id: string,
    value: Json,
    canceled: boolean,
  ): Promise<void>;
  workspaces(): Promise<Array<{ id: string; name: string }>>;
  setCredential(workspaceId: string, kind: string, value: Json): Promise<{ reference: string }>;
  selectExportDirectory(workspaceId: string): Promise<{ selected: boolean }>;
}
interface Locale {
  getSnapshot(): { active: string };
  subscribe(listener: () => void): () => void;
}
export function Workbench({ remote, locale }: { remote: WorkbenchRemote; locale: Locale }) {
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [workspaceId, setWorkspace] = useState('');
  const [error, setError] = useState('');
  const [theme, setTheme] = useState(
    document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light',
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme(document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'),
    );
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
    return () => observer.disconnect();
  }, []);
  const [language, setLanguage] = useState(locale.getSnapshot().active);
  useEffect(() => locale.subscribe(() => setLanguage(locale.getSnapshot().active)), [locale]);
  useEffect(() => {
    void i18n.changeLanguage(language.startsWith('zh') ? 'zh-CN' : 'en');
  }, [language]);
  useEffect(() => {
    void remote
      .workspaces()
      .then((value) => {
        setWorkspaces(value);
        setWorkspace(value[0]?.id ?? '');
      })
      .catch((error) => setError(String(error)));
  }, [remote]);
  const zh = language.startsWith('zh');
  return (
    <section className="zhiyun-workbench" data-theme={theme} data-testid="zhiyun-workbench">
      <header className="zhiyun-header">
        <strong>织云 · ZhiYun</strong>
        <label>
          {zh ? '工作区' : 'Workspace'}{' '}
          <select
            aria-label="ZhiYun workspace"
            value={workspaceId}
            onChange={(event) => setWorkspace(event.target.value)}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        </label>
      </header>
      {error && <p role="alert">{error}</p>}
      {!workspaces.length && !error && (
        <p>{zh ? '请先在 DSH 中创建工作区。' : 'Create a DSH workspace first.'}</p>
      )}
      {workspaceId && (
        <Boundary key={workspaceId}>
          <Workspace key={workspaceId} remote={remote} workspaceId={workspaceId} zh={zh} />
        </Boundary>
      )}
    </section>
  );
}
function Workspace({
  remote,
  workspaceId,
  zh,
}: {
  remote: WorkbenchRemote;
  workspaceId: string;
  zh: boolean;
}) {
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState('');
  const query = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, staleTime: 15_000 },
          mutations: { retry: false },
        },
      }),
    [],
  );
  useEffect(() => {
    let active = true;
    const transport = productTransport(remote, workspaceId, 'dshDesktop' in window);
    runtimeClient.setTransport(transport);
    void remote
      .status(workspaceId)
      .then(() => {
        if (active) setReady(true);
      })
      .catch((error) => {
        if (active) setFailure(String(error));
      });
    return () => {
      active = false;
      void query.cancelQueries();
      query.clear();
      runtimeClient.setTransport(undefined);
    };
  }, [remote, workspaceId, query]);
  if (failure) return <p role="alert">{failure}</p>;
  if (!ready)
    return <p role="status">{zh ? '正在启动本地工作台…' : 'Starting the local workbench…'}</p>;
  const links = [
    ['/tasks', '采集任务', 'Collection'],
    ['/datasets', '数据集', 'Datasets'],
    ['/analytics', '分析与报告', 'Analysis'],
    ['/corpora', '语料工作台', 'Corpora'],
    ['/outputs', '输出连接', 'Outputs'],
    ['/connections', '凭据与导出', 'Credentials & exports'],
  ];
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={query}>
        <MemoryRouter>
          <AuthGate>
            <UiContributionsProvider value={contributions}>
              <CredentialPrompts remote={remote} workspaceId={workspaceId} zh={zh} />
              <nav className="zhiyun-nav">
                {links.map(([path, cn, en]) => (
                  <NavLink key={path} to={path!}>
                    {zh ? cn : en}
                  </NavLink>
                ))}
              </nav>
              <div className="zhiyun-page">
                <Suspense fallback={<p role="status">{zh ? '正在加载…' : 'Loading…'}</p>}>
                  <Routes>
                    <Route
                      path="/"
                      element={
                        <div>
                          <h1>{zh ? '本地数据与语料工作台' : 'Local data and corpus workbench'}</h1>
                          <p>
                            {zh
                              ? '采集网页，保存可追溯的数据版本，再清洗、分析与导出语料。'
                              : 'Collect, version, clean, analyze and export web data locally.'}
                          </p>
                          <Link className="button" to="/tasks/new">
                            {zh ? '新建采集任务' : 'New collection'}
                          </Link>
                        </div>
                      }
                    />
                    {routes.map((row) => (
                      <Route key={row.path} path={row.path} element={<row.Component />} />
                    ))}
                    <Route
                      path="/connections"
                      element={<Connections remote={remote} workspaceId={workspaceId} zh={zh} />}
                    />
                    <Route
                      path="/assistant"
                      element={
                        <p>
                          {zh
                            ? '请使用 DSH 对话中的织云工具。'
                            : 'Use the ZhiYun tools in your DSH conversation.'}
                        </p>
                      }
                    />
                    <Route
                      path="*"
                      element={<Link to="/">{zh ? '返回工作台首页' : 'Workbench home'}</Link>}
                    />
                  </Routes>
                </Suspense>
              </div>
            </UiContributionsProvider>
          </AuthGate>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>
  );
}
function Connections({
  remote,
  workspaceId,
  zh,
}: {
  remote: WorkbenchRemote;
  workspaceId: string;
  zh: boolean;
}) {
  const [kind, setKind] = useState('task-secret-headers');
  const [value, setValue] = useState('');
  const [message, setMessage] = useState('');
  return (
    <section>
      <h1>{zh ? '凭据与导出' : 'Credentials and exports'}</h1>
      <p>
        {zh
          ? '凭据由 DSH 本机凭据服务保存，仅引用进入任务配置；不发送到模型。'
          : 'Credentials are stored by DSH; task configurations use references. Secret values are never sent to the model.'}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setMessage('');
          let parsed: Json;
          try {
            parsed = JSON.parse(value) as Json;
          } catch {
            setMessage(zh ? '请输入合法 JSON。' : 'Enter valid JSON.');
            return;
          }
          void remote
            .setCredential(workspaceId, kind, parsed)
            .then((result) => {
              setValue('');
              setMessage(`${zh ? '凭据引用' : 'Credential reference'}: ${result.reference}`);
            })
            .catch((error) => setMessage(String(error)));
        }}
      >
        <label>
          {zh ? '用途' : 'Purpose'}
          <select value={kind} onChange={(event) => setKind(event.target.value)}>
            {[
              'task-secret-headers',
              'task-cookies',
              'task-proxy',
              'output-webhook',
              'output-google-sheets',
              'output-s3',
            ].map((kind) => (
              <option key={kind}>{kind}</option>
            ))}
          </select>
        </label>
        <label>
          {zh ? '凭据 JSON' : 'Credential JSON'}
          <textarea
            aria-label="Credential JSON"
            autoComplete="off"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <button className="button" type="submit">
          {zh ? '保存凭据' : 'Save credential'}
        </button>
      </form>
      <p role="status">{message}</p>
      <button
        className="button"
        onClick={() => {
          void remote
            .selectExportDirectory(workspaceId)
            .then((result) =>
              setMessage(
                result.selected
                  ? zh
                    ? '已选择导出目录。'
                    : 'Export directory selected.'
                  : zh
                    ? '使用工作区 exports/zhiyun 默认目录。'
                    : 'Using workspace exports/zhiyun.',
              ),
            );
        }}
      >
        {zh ? '选择导出目录' : 'Choose export directory'}
      </button>
    </section>
  );
}
class Boundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' };
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  render() {
    return this.state.error ? <p role="alert">{this.state.error}</p> : this.props.children;
  }
}

function CredentialPrompts({
  remote,
  workspaceId,
  zh,
}: {
  remote: WorkbenchRemote;
  workspaceId: string;
  zh: boolean;
}) {
  const [prompts, setPrompts] = useState<Array<{ id: string; kind: string }>>([]);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const update = () => {
      void remote
        .credentialPrompts(workspaceId)
        .then((rows) => {
          if (active) setPrompts(rows);
        })
        .catch(() => {});
    };
    update();
    const timer = setInterval(update, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [remote, workspaceId]);
  const prompt = prompts[0];
  if (!prompt) return null;
  const answer = async (canceled: boolean) => {
    try {
      await remote.answerCredentialPrompt(
        workspaceId,
        prompt.id,
        canceled ? null : (JSON.parse(value) as Json),
        canceled,
      );
      setValue('');
      setError('');
      setPrompts((rows) => rows.filter((row) => row.id !== prompt.id));
    } catch {
      setError(zh ? '请输入合法的凭据 JSON。' : 'Enter valid credential JSON.');
    }
  };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={zh ? '输入凭据' : 'Enter credentials'}
      className="zhiyun-credential-prompt"
    >
      <h2>{zh ? '输入凭据' : 'Enter credentials'}</h2>
      <p>{prompt.kind}</p>
      <textarea
        autoComplete="off"
        aria-label="Secret JSON"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <p role="alert">{error}</p>
      <button
        onClick={() => {
          void answer(false);
        }}
      >
        {zh ? '保存到 DSH' : 'Save in DSH'}
      </button>
      <button
        onClick={() => {
          void answer(true);
        }}
      >
        {zh ? '取消' : 'Cancel'}
      </button>
    </div>
  );
}
