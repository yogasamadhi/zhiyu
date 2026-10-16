import { useTranslation } from 'react-i18next';
import { productCopy } from './product-copy.js';
import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ApiError,
  runtimeClient,
  type IdentityPermission,
  type IdentityUser,
} from '@zhiyun/client';
import { Button, Card, ErrorNotice, Input } from './components/ui.js';
import { revokeWorkspaceSession } from './auth-session.js';
import { withoutWorkspaceTokenAction, workspaceTokenAction } from './identity-links.js';

interface WorkspaceAuthContextValue {
  identityEnabled: boolean;
  user: IdentityUser | null;
  permissions: readonly IdentityPermission[];
  logoutError: string;
  requireLogin(): void;
  logout(): Promise<void>;
}

const WorkspaceAuthContext = createContext<WorkspaceAuthContextValue>({
  identityEnabled: false,
  user: null,
  permissions: [],
  logoutError: '',
  requireLogin() {},
  async logout() {},
});

export function useWorkspaceAuth(): WorkspaceAuthContextValue {
  return useContext(WorkspaceAuthContext);
}

export function AuthGate({ children }: { children: ReactNode }) {
  useTranslation();
  const queryClient = useQueryClient();
  const [forceLogin, setForceLogin] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [action, setAction] = useState<PublicAuthAction | null>(() => publicAuthAction());
  useLayoutEffect(() => {
    if (action) clearPublicAuthAction();
  }, [action]);
  const graph = useQuery({
    queryKey: ['runtime', 'graph'],
    queryFn: () => runtimeClient.getRuntimeGraph(),
    retry: 2,
  });
  const identityEnabled = Boolean(
    graph.data?.routes.some(({ operationId }) => operationId === 'getAuthStatus'),
  );
  const authStatus = useQuery({
    queryKey: ['auth', 'status'],
    queryFn: () => runtimeClient.getAuthStatus(),
    enabled: identityEnabled,
    retry: false,
  });
  const currentUser = useQuery({
    queryKey: ['auth', 'me'],
    queryFn: () => runtimeClient.getCurrentUser(),
    enabled: identityEnabled && authStatus.data?.initialized === true && !forceLogin,
    retry: false,
  });

  if (graph.isPending)
    return <AuthenticationLoading message={productCopy('正在连接织云工作区…')} />;
  if (graph.isError) {
    return <AuthenticationFailure error={graph.error} retry={() => void graph.refetch()} />;
  }
  if (!identityEnabled) {
    return (
      <WorkspaceAuthContext.Provider value={anonymousAuthContext}>
        {children}
      </WorkspaceAuthContext.Provider>
    );
  }
  if (authStatus.isPending)
    return <AuthenticationLoading message={productCopy('正在检查工作区身份…')} />;
  if (authStatus.isError) {
    return (
      <AuthenticationFailure error={authStatus.error} retry={() => void authStatus.refetch()} />
    );
  }

  if (!authStatus.data.initialized) {
    return (
      <SetupForm
        onComplete={async (email, password) => {
          await runtimeClient.login({ email, password });
          await queryClient.invalidateQueries({ queryKey: ['auth'] });
        }}
      />
    );
  }
  if (action?.kind === 'invitation') {
    return (
      <InvitationAcceptance
        token={action.token}
        onComplete={() => {
          setAction(null);
          setForceLogin(true);
        }}
      />
    );
  }
  if (action?.kind === 'password-reset') {
    return (
      <PasswordReset
        token={action.token}
        onComplete={() => {
          setAction(null);
          setForceLogin(true);
        }}
      />
    );
  }
  if (forceLogin || (currentUser.isError && isAuthenticationRequired(currentUser.error))) {
    return (
      <LoginForm
        onComplete={async () => {
          setForceLogin(false);
          await queryClient.invalidateQueries({ queryKey: ['auth', 'me'] });
        }}
      />
    );
  }
  if (currentUser.isPending)
    return <AuthenticationLoading message={productCopy('正在恢复登录会话…')} />;
  if (currentUser.isError) {
    return (
      <AuthenticationFailure error={currentUser.error} retry={() => void currentUser.refetch()} />
    );
  }

  const context: WorkspaceAuthContextValue = {
    identityEnabled: true,
    user: currentUser.data.user,
    permissions: currentUser.data.permissions,
    logoutError,
    requireLogin: () => setForceLogin(true),
    logout: () =>
      revokeWorkspaceSession(
        () => runtimeClient.logout(),
        () => {
          setLogoutError('');
          setForceLogin(true);
          queryClient.removeQueries({ queryKey: ['auth', 'me'] });
        },
        (reason) => {
          setLogoutError(productCopy('退出失败：{{message}}', { message: errorMessage(reason) }));
        },
      ),
  };
  return <WorkspaceAuthContext.Provider value={context}>{children}</WorkspaceAuthContext.Provider>;
}

const anonymousAuthContext: WorkspaceAuthContextValue = {
  identityEnabled: false,
  user: null,
  permissions: [],
  logoutError: '',
  requireLogin() {},
  async logout() {},
};

function AuthenticationLoading({ message }: { message: string }) {
  useTranslation();
  return (
    <main className="auth-screen">
      <div className="auth-loading" role="status">
        <span className="brand-mark">织</span>
        <p>{message}</p>
      </div>
    </main>
  );
}

function AuthenticationFailure({ error, retry }: { error: unknown; retry(): void }) {
  useTranslation();
  return (
    <main className="auth-screen">
      <Card className="auth-card">
        <span className="eyebrow">Workspace access</span>
        <h1>{productCopy('无法连接工作区')}</h1>
        <ErrorNotice message={errorMessage(error)} />
        <Button onClick={retry}>{productCopy('重试')}</Button>
      </Card>
    </main>
  );
}

function SetupForm(props: { onComplete(email: string, password: string): Promise<void> }) {
  const [bootstrapToken, setBootstrapToken] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      await runtimeClient.setupAuth({ bootstrapToken, email, displayName, password });
      await props.onComplete(email, password);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthLayout
      eyebrow={productCopy('首次部署')}
      title={productCopy('初始化织云工作区')}
      description={productCopy(
        '使用部署时配置的 Bootstrap Token 创建首位管理员。完成后该 Token 将永久失效。',
      )}
    >
      <form className="auth-form" onSubmit={(event) => void submit(event)}>
        <ErrorNotice message={error} />
        <label>
          <span>Bootstrap Token</span>
          <Input
            autoComplete="off"
            minLength={32}
            required
            type="password"
            value={bootstrapToken}
            onChange={(event) => setBootstrapToken(event.target.value)}
          />
        </label>
        <label>
          <span>{productCopy('管理员邮箱')}</span>
          <Input
            autoComplete="username"
            required
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          <span>{productCopy('显示名称')}</span>
          <Input
            autoComplete="name"
            maxLength={120}
            required
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <PasswordField value={password} onChange={setPassword} label={productCopy('管理员密码')} />
        <Button disabled={pending} type="submit">
          {pending ? productCopy('正在初始化…') : productCopy('创建管理员并进入工作区')}
        </Button>
      </form>
    </AuthLayout>
  );
}

function LoginForm(props: { onComplete(): Promise<void> }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      await runtimeClient.login({ email, password });
      await props.onComplete();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthLayout
      eyebrow="Self-hosted workspace"
      title={productCopy('登录织云')}
      description={productCopy('使用工作区管理员邀请你加入时登记的邮箱与密码。')}
    >
      <form className="auth-form" onSubmit={(event) => void submit(event)}>
        <ErrorNotice message={error} />
        <label>
          <span>{productCopy('邮箱')}</span>
          <Input
            autoComplete="username"
            required
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          <span>{productCopy('密码')}</span>
          <Input
            autoComplete="current-password"
            required
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <Button disabled={pending} type="submit">
          {pending ? productCopy('正在登录…') : productCopy('登录')}
        </Button>
      </form>
    </AuthLayout>
  );
}

function InvitationAcceptance(props: { token: string; onComplete(): void }) {
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      await runtimeClient.acceptInvitation({ token: props.token, displayName, password });
      props.onComplete();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthLayout
      eyebrow="Workspace invitation"
      title={productCopy('接受工作区邀请')}
      description={productCopy(
        '设置你的显示名称与密码。邀请链接只能使用一次，密码至少 12 个字符。',
      )}
    >
      <form className="auth-form" onSubmit={(event) => void submit(event)}>
        <ErrorNotice message={error} />
        <label>
          <span>{productCopy('显示名称')}</span>
          <Input
            autoComplete="name"
            maxLength={120}
            required
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>
        <PasswordField value={password} onChange={setPassword} label={productCopy('设置密码')} />
        <Button disabled={pending} type="submit">
          {pending ? productCopy('正在加入…') : productCopy('接受邀请')}
        </Button>
      </form>
    </AuthLayout>
  );
}

function PasswordReset(props: { token: string; onComplete(): void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError('');
    try {
      await runtimeClient.resetPassword({ resetToken: props.token, newPassword: password });
      props.onComplete();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthLayout
      eyebrow="Password reset"
      title={productCopy('设置新密码')}
      description={productCopy('重置链接只能使用一次。成功后，其他已登录会话会立即失效。')}
    >
      <form className="auth-form" onSubmit={(event) => void submit(event)}>
        <ErrorNotice message={error} />
        <PasswordField value={password} onChange={setPassword} label={productCopy('新密码')} />
        <Button disabled={pending} type="submit">
          {pending ? productCopy('正在保存…') : productCopy('保存并返回登录')}
        </Button>
      </form>
    </AuthLayout>
  );
}

function PasswordField(props: { label: string; value: string; onChange(value: string): void }) {
  return (
    <label>
      <span>{props.label}</span>
      <Input
        autoComplete="new-password"
        minLength={12}
        required
        type="password"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <small className="field-help">{productCopy('至少 12 个字符')}</small>
    </label>
  );
}

function AuthLayout(props: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  const { i18n } = useTranslation();
  return (
    <main className="auth-screen">
      <Card className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark">织</span>
          <strong>织云 · ZhiYun</strong>
        </div>
        <Button
          className="button-ghost language-button"
          onClick={() => {
            const language = i18n.language.startsWith('zh') ? 'en' : 'zh-CN';
            localStorage.setItem('zhiyun-language', language);
            void i18n.changeLanguage(language);
          }}
        >
          {i18n.language.startsWith('zh') ? 'English' : '中文'}
        </Button>
        <span className="eyebrow">{props.eyebrow}</span>
        <h1>{props.title}</h1>
        <p>{props.description}</p>
        {props.children}
      </Card>
    </main>
  );
}

function isAuthenticationRequired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type PublicAuthAction =
  { kind: 'invitation'; token: string } | { kind: 'password-reset'; token: string };

function publicAuthAction(): PublicAuthAction | null {
  if (typeof window === 'undefined') return null;
  return workspaceTokenAction(window.location.hash);
}

function clearPublicAuthAction(): void {
  const url = new URL(window.location.href);
  window.history.replaceState(
    {},
    '',
    `${url.pathname}${url.search}${withoutWorkspaceTokenAction(url.hash)}`,
  );
}
