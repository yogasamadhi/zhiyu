import { CloudAccountSettings } from '../components/CloudAccountSettings.js';
import { ConfirmAction } from '../components/ConfirmAction.js';
import { productCopy } from '../product-copy.js';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ExperienceSettings } from '../components/ExperienceSettings.js';
import { Fragment, useEffect, useState, type FormEvent } from 'react';
import {
  runtimeClient,
  type AiProviderCatalogEntry,
  type AiProviderSettingsView,
  type DesktopDiagnostics,
  type RuntimeReadiness,
  type RuntimeSummary,
} from '@zhiyun/client';
import { useWorkspaceAuth } from '../auth.js';
import { Button, Card, ErrorNotice, Input } from '../components/ui.js';
import { validatePasswordChange } from '../password-settings.js';

export function SettingsPage() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [params, setParams] = useSearchParams();
  const section = params.get('section') ?? 'general';
  const returnTo = params.get('returnTo');

  const auth = useWorkspaceAuth();
  const [diagnostics, setDiagnostics] = useState<DesktopDiagnostics | null>(null);
  const [readiness, setReadiness] = useState<RuntimeReadiness | null>(null);
  const [runtimeSummary, setRuntimeSummary] = useState<RuntimeSummary | null>(null);
  const [error, setError] = useState('');
  const [provider, setProvider] = useState<AiProviderSettingsView | null>(null);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [providerStatus, setProviderStatus] = useState('');
  const [providerBusy, setProviderBusy] = useState(false);
  const [selectionTested, setSelectionTested] = useState(false);
  useEffect(() => {
    void runtimeClient
      .getDesktopDiagnostics()
      .then(setDiagnostics)
      .catch((reason: Error) => setError(reason.message));
    void runtimeClient
      .getReadiness()
      .then(setReadiness)
      .catch((reason: Error) => setError(reason.message));
    void runtimeClient
      .getRuntimeSummary()
      .then(setRuntimeSummary)
      .catch((reason: Error) => setError(reason.message));
    void loadProvider();
  }, []);
  const loadProvider = async (preferred?: { providerId: string; model: string }) => {
    try {
      const value = await runtimeClient.getAiProviderSettings();
      setProvider(value);
      const selected =
        value.catalog.find((candidate) => candidate.id === preferred?.providerId) ??
        value.catalog.find((candidate) => candidate.id === value.providerId) ??
        value.catalog[0];
      if (!selected) throw new Error(productCopy('AI Provider 目录为空'));
      setProviderId(selected.id);
      setModel(
        selected.models.some((candidate) => candidate.id === preferred?.model)
          ? (preferred?.model as string)
          : selected.models.some((candidate) => candidate.id === value.model)
            ? (value.model as string)
            : selected.defaultModel,
      );
      setSelectionTested(false);
    } catch (reason) {
      setProvider(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const providerAction = async (
    operation: () => Promise<unknown>,
    success: string,
    options: { reload?: boolean; tested?: boolean; preserveSelection?: boolean } = {},
  ) => {
    setProviderBusy(true);
    setError('');
    setProviderStatus('');
    try {
      await operation();
      setProviderStatus(success);
      if (options.tested) setSelectionTested(true);
      if (options.reload !== false) {
        await loadProvider(options.preserveSelection ? { providerId, model } : undefined);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setProviderBusy(false);
    }
  };
  const selectedProvider: AiProviderCatalogEntry | undefined = provider?.catalog.find(
    (candidate) => candidate.id === providerId,
  );
  const selectionChanged = Boolean(
    provider && (provider.providerId !== providerId || provider.model !== model),
  );
  const configurationNeedsSave = Boolean(
    provider && (selectionChanged || !provider.testedAt || !provider.configured),
  );
  const selectProvider = (nextProviderId: string) => {
    const next = provider?.catalog.find((candidate) => candidate.id === nextProviderId);
    if (!next) return;
    setProviderId(next.id);
    setModel(next.defaultModel);
    setSelectionTested(false);
    setProviderStatus('');
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{zh ? '设置' : 'Settings'}</h1>
          <p>
            {zh
              ? '管理偏好、连接与数据，检查服务状态。'
              : 'Manage preferences, connections and data, and check service status.'}
          </p>
        </div>
      </div>
      {returnTo?.startsWith('/') && !returnTo.startsWith('//') && (
        <Link className="button button-secondary" to={returnTo}>
          {zh ? '返回采集草稿' : 'Return to collection draft'}
        </Link>
      )}
      <nav className="section-tabs" aria-label={zh ? '设置分组' : 'Settings sections'}>
        {[
          ['general', '通用', 'General'],
          ['ai', 'AI 模型', 'AI models'],
          ['connections', '连接与凭据', 'Connections & credentials'],
          ['data', '数据与存储', 'Data & storage'],
          ['account', '账号安全', 'Account security'],
          ['diagnostics', '诊断', 'Diagnostics'],
        ].map(([id, cn, en]) => (
          <Button
            key={id}
            className={section === id ? 'button-secondary' : 'button-ghost'}
            aria-current={section === id ? 'page' : undefined}
            onClick={() => setParams({ ...Object.fromEntries(params), section: id! })}
          >
            {zh ? cn : en}
          </Button>
        ))}
      </nav>
      <ErrorNotice message={error} />
      {(section === 'ai' || section === 'account') && <CloudAccountSettings />}
      {section === 'general' && (
        <Card>
          <h2>{zh ? '语言与工作区' : 'Language and workspace'}</h2>
          <p>
            {zh
              ? '导航固定项与表格偏好按工作区、用户分别保存。'
              : 'Pinned navigation and table preferences are saved per workspace and user.'}
          </p>
          <Button
            className="button-secondary"
            onClick={() => {
              const next = zh ? 'en' : 'zh-CN';
              localStorage.setItem('zhiyun-language', next);
              void i18n.changeLanguage(next);
            }}
          >
            {zh ? 'Switch to English' : '切换为中文'}
          </Button>
        </Card>
      )}
      {section === 'connections' && (
        <Card>
          <h2>{zh ? '连接与凭据' : 'Connections and credentials'}</h2>
          <p>
            {zh
              ? '采集登录状态与密钥由现有主机凭据机制保护。可以在任务高级设置和自动化连接中管理。'
              : 'Collection login states and keys use the existing host credential protection. Manage them in task settings and automation connections.'}
          </p>
          <Link className="button button-secondary" to="/outputs">
            {zh ? '管理自动化连接' : 'Manage automation connections'}
          </Link>
        </Card>
      )}
      {section === 'data' && <ExperienceSettings />}
      {section === 'account' &&
        (auth.identityEnabled && auth.user ? (
          <PasswordSettingsCard />
        ) : (
          <Card>
            <h2>{zh ? '本地账号' : 'Local account'}</h2>
            <p>{zh ? '当前实例使用本机访问权限。' : 'This instance uses local machine access.'}</p>
          </Card>
        ))}
      {section === 'ai' && provider ? (
        <Card>
          <div className="assistant-panel-title">
            <div>
              <h2>{productCopy('AI 模型连接')}</h2>
              <p>
                {productCopy('选择模型厂商和模型 ID；调用地址由系统维护，仅需手动配置 API Key。')}
              </p>
            </div>
            <span className={`badge badge-${provider.configured ? 'success' : 'neutral'}`}>
              {provider.configured ? productCopy('已连接') : productCopy('尚未连接 AI 模型')}
            </span>
          </div>
          {provider.writable ? (
            <div className="provider-settings-grid">
              <label>
                <span>{productCopy('模型厂商')}</span>
                <select
                  aria-label={productCopy('模型厂商')}
                  value={providerId}
                  onChange={(event) => selectProvider(event.target.value)}
                >
                  {provider.catalog.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{productCopy('模型 ID')}</span>
                <select
                  aria-label={productCopy('模型 ID')}
                  value={model}
                  onChange={(event) => {
                    setModel(event.target.value);
                    setSelectionTested(false);
                    setProviderStatus('');
                  }}
                >
                  {(selectedProvider?.models ?? []).map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name} · {candidate.id}
                      {candidate.status === 'preview' ? productCopy('（预览）') : ''}
                    </option>
                  ))}
                </select>
              </label>
              {selectedProvider ? (
                <div className="provider-endpoint" aria-label={productCopy('Provider 调用地址')}>
                  <div>
                    <strong>{productCopy('系统调用地址')}</strong>
                    <code>{selectedProvider.baseUrl}</code>
                  </div>
                  <a href={selectedProvider.documentationUrl} target="_blank" rel="noreferrer">
                    {productCopy('官方模型文档')}
                  </a>
                </div>
              ) : null}
              {provider.providerId === null && provider.baseUrl ? (
                <div className="notice">
                  {productCopy(
                    '当前为旧版自定义地址配置。请重新选择厂商、替换对应 API Key 并测试后保存。',
                  )}
                </div>
              ) : null}
              <div className="provider-key-row">
                <div>
                  <strong>{selectedProvider?.name ?? 'AI Provider'} API Key</strong>
                  <p>
                    {provider.apiKeyConfigured
                      ? productCopy('已通过 safeStorage 加密保存')
                      : productCopy('尚未配置')}
                  </p>
                  <small>{productCopy('切换模型厂商后，请替换为该厂商签发的 API Key。')}</small>
                </div>
                <Button
                  className="button-secondary"
                  disabled={providerBusy}
                  onClick={() =>
                    void providerAction(
                      () => runtimeClient.promptAiProviderCredential(provider.revision),
                      productCopy('API Key 已安全保存，请执行连接测试。'),
                      { preserveSelection: true },
                    )
                  }
                >
                  {provider.apiKeyConfigured ? productCopy('替换 Key') : productCopy('配置 Key')}
                </Button>
              </div>
              <div className="heading-actions provider-actions">
                <Button
                  className="button-secondary"
                  disabled={
                    providerBusy || !provider.apiKeyConfigured || !selectedProvider || !model
                  }
                  onClick={() =>
                    void providerAction(
                      () => runtimeClient.testAiProvider({ providerId, model }),
                      productCopy('连接测试通过，可保存并热切换。'),
                      { reload: false, tested: true },
                    )
                  }
                >
                  {productCopy('测试连接')}
                </Button>
                <Button
                  disabled={
                    providerBusy ||
                    !provider.apiKeyConfigured ||
                    !selectedProvider ||
                    !model ||
                    !configurationNeedsSave ||
                    !selectionTested
                  }
                  onClick={() =>
                    void providerAction(
                      () =>
                        runtimeClient.updateAiProvider({ providerId, model }, provider.revision),
                      productCopy('Provider 已保存并热切换，无需重启 Runtime。'),
                    )
                  }
                >
                  {productCopy('保存 Provider')}
                </Button>
                {provider.apiKeyConfigured ? (
                  <ConfirmAction
                    label={productCopy('删除 Key')}
                    disabled={providerBusy}
                    description={
                      zh
                        ? '删除后将断开 AI 模型连接，需要重新配置密钥才能使用 AI。已保存任务、规则和手动采集可继续使用。'
                        : 'Removes the AI credential. Reconnect a key to use AI again. Saved tasks, rules and manual collection remain available.'
                    }
                    onConfirm={async () => {
                      await runtimeClient.deleteAiProviderCredential(provider.revision);
                      await loadProvider();
                      setProviderStatus(zh ? '尚未连接 AI 模型' : 'No AI model connected');
                    }}
                  />
                ) : null}
              </div>
              {providerStatus ? (
                <div className="notice notice-success">{providerStatus}</div>
              ) : null}
              <p className="provider-meta">
                {productCopy('来源：')}
                {provider.source} {productCopy('· 配置版本')} {provider.revision}
                {provider.testedAt
                  ? ` · 最近测试 ${new Date(provider.testedAt).toLocaleString()}`
                  : ''}
                {` · 模型目录更新于 ${provider.catalogUpdatedAt}`}
              </p>
            </div>
          ) : (
            <div className="notice">
              {productCopy(
                'Headless 配置为只读。请使用 AI_BASE_URL、AI_MODEL 和 AI_API_KEY 环境变量后重启服务。',
              )}
            </div>
          )}
        </Card>
      ) : null}
      {section === 'diagnostics' && (
        <>
          <Card>
            <h2>Runtime</h2>
            {diagnostics ? (
              <dl className="diagnostics-grid">
                <dt>{productCopy('版本')}</dt>
                <dd>{diagnostics.runtime.version}</dd>
                <dt>Generation</dt>
                <dd>{diagnostics.runtime.generation}</dd>
                <dt>Runtime ID</dt>
                <dd>
                  <code>{diagnostics.runtime.runtimeId}</code>
                </dd>
                <dt>{productCopy('Chromium 资源')}</dt>
                <dd>{diagnostics.browserResources ?? productCopy('未检测到')}</dd>
                {Object.entries(diagnostics.database).map(([key, value]) => (
                  <Fragment key={key}>
                    <dt>{key}</dt>
                    <dd>{String(typeof value === 'object' ? JSON.stringify(value) : value)}</dd>
                  </Fragment>
                ))}
              </dl>
            ) : (
              <div className="empty-small">{productCopy('Desktop Runtime 诊断不可用')}</div>
            )}
          </Card>
          <Card>
            <div className="assistant-panel-title">
              <div>
                <h2>{productCopy('服务就绪状态')}</h2>
                <p>{productCopy('数据库与队列异常会阻止接入流量；分析 Worker 降级不影响采集。')}</p>
              </div>
              <span
                className={`badge badge-${readiness?.status === 'ready' ? 'success' : 'warning'}`}
              >
                {readiness?.status === 'ready' ? productCopy('已就绪') : productCopy('未就绪')}
              </span>
            </div>
            {readiness ? (
              <dl className="diagnostics-grid">
                {Object.entries(readiness.checks).map(([name, check]) => (
                  <Fragment key={name}>
                    <dt>{runtimeCheckLabel(name)}</dt>
                    <dd>{String(check.status)}</dd>
                  </Fragment>
                ))}
                <dt>{productCopy('运行时间')}</dt>
                <dd>{formatDuration(runtimeSummary?.uptimeSeconds ?? 0)}</dd>
                <dt>{productCopy('队列积压')}</dt>
                <dd>{runtimeSummary?.queueBacklog ?? '—'}</dd>
                <dt>{productCopy('调度器')}</dt>
                <dd>
                  {runtimeSummary?.schedulingPaused ? productCopy('已暂停') : productCopy('运行中')}
                </dd>
                <dt>{productCopy('作业状态')}</dt>
                <dd>
                  {runtimeSummary
                    ? Object.entries(runtimeSummary.jobsByState)
                        .filter(([, count]) => count > 0)
                        .map(([state, count]) => `${state}: ${count}`)
                        .join(' · ') || productCopy('暂无作业')
                    : '—'}
                </dd>
              </dl>
            ) : (
              <div className="empty-small">{productCopy('正在读取服务状态')}</div>
            )}
          </Card>
        </>
      )}
      {section === 'data' && (
        <Card>
          <h2>{zh ? '数据与存储' : 'Data and storage'}</h2>
          <p>
            {zh
              ? '任务、规则历史、数据版本与草稿保存在当前实例。此次升级使用增量迁移，保留已有 1.0 数据。可通过数据集导出菜单导出选定字段与筛选结果。'
              : 'Tasks, rule history, data versions and drafts are stored in this instance. This upgrade uses incremental migrations and retains existing 1.0 data. Export selected fields and filtered results from a dataset.'}
          </p>
        </Card>
      )}
    </>
  );
}

function PasswordSettingsCard() {
  const auth = useWorkspaceAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validatePasswordChange({ currentPassword, newPassword, confirmation });
    if (validation) {
      setError(validation);
      return;
    }
    setBusy(true);
    setError('');
    try {
      await runtimeClient.changePassword({ currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      auth.requireLogin();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="assistant-panel-title">
        <div>
          <h2>账号安全</h2>
          <p>
            {productCopy('修改')}
            {auth.user?.email} {productCopy('的登录密码。成功后所有会话都会撤销，需要重新登录。')}
          </p>
        </div>
      </div>
      <form className="provider-settings-grid" onSubmit={(event) => void submit(event)}>
        <ErrorNotice message={error} />
        <label>
          <span>{productCopy('当前密码')}</span>
          <Input
            autoComplete="current-password"
            required
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </label>
        <label>
          <span>{productCopy('新密码')}</span>
          <Input
            autoComplete="new-password"
            minLength={12}
            required
            type="password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
        </label>
        <label>
          <span>{productCopy('确认新密码')}</span>
          <Input
            autoComplete="new-password"
            minLength={12}
            required
            type="password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
        <div className="heading-actions">
          <Button disabled={busy} type="submit">
            {busy ? productCopy('正在修改…') : productCopy('修改密码')}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function runtimeCheckLabel(value: string): string {
  return (
    {
      database: productCopy('SQLite / 迁移'),
      queue: productCopy('作业队列'),
      browser: 'Chromium',
      analyticsWorker: productCopy('分析 Worker'),
    }[value] ?? value
  );
}

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return [days ? `${days} 天` : '', hours ? `${hours} 小时` : '', `${minutes} 分钟`]
    .filter(Boolean)
    .join(' ');
}
