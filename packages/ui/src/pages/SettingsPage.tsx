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
      if (!selected) throw new Error('AI Provider 目录为空');
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
          <h1>Runtime 设置</h1>
          <p>运行状态与架构诊断</p>
        </div>
      </div>
      <ErrorNotice message={error} />
      {auth.identityEnabled && auth.user ? <PasswordSettingsCard /> : null}
      {provider ? (
        <Card>
          <div className="assistant-panel-title">
            <div>
              <h2>AI Provider</h2>
              <p>选择模型厂商和模型 ID；调用地址由系统维护，仅需手动配置 API Key。</p>
            </div>
            <span className={`badge badge-${provider.configured ? 'success' : 'neutral'}`}>
              {provider.configured ? '已配置' : '演示模式'}
            </span>
          </div>
          {provider.writable ? (
            <div className="provider-settings-grid">
              <label>
                <span>模型厂商</span>
                <select
                  aria-label="模型厂商"
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
                <span>模型 ID</span>
                <select
                  aria-label="模型 ID"
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
                      {candidate.status === 'preview' ? '（预览）' : ''}
                    </option>
                  ))}
                </select>
              </label>
              {selectedProvider ? (
                <div className="provider-endpoint" aria-label="Provider 调用地址">
                  <div>
                    <strong>系统调用地址</strong>
                    <code>{selectedProvider.baseUrl}</code>
                  </div>
                  <a href={selectedProvider.documentationUrl} target="_blank" rel="noreferrer">
                    官方模型文档
                  </a>
                </div>
              ) : null}
              {provider.providerId === null && provider.baseUrl ? (
                <div className="notice">
                  当前为旧版自定义地址配置。请重新选择厂商、替换对应 API Key 并测试后保存。
                </div>
              ) : null}
              <div className="provider-key-row">
                <div>
                  <strong>{selectedProvider?.name ?? 'AI Provider'} API Key</strong>
                  <p>{provider.apiKeyConfigured ? '已通过 safeStorage 加密保存' : '尚未配置'}</p>
                  <small>切换模型厂商后，请替换为该厂商签发的 API Key。</small>
                </div>
                <Button
                  className="button-secondary"
                  disabled={providerBusy}
                  onClick={() =>
                    void providerAction(
                      () => runtimeClient.promptAiProviderCredential(provider.revision),
                      'API Key 已安全保存，请执行连接测试。',
                      { preserveSelection: true },
                    )
                  }
                >
                  {provider.apiKeyConfigured ? '替换 Key' : '配置 Key'}
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
                      '连接测试通过，可保存并热切换。',
                      { reload: false, tested: true },
                    )
                  }
                >
                  测试连接
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
                      'Provider 已保存并热切换，无需重启 Runtime。',
                    )
                  }
                >
                  保存 Provider
                </Button>
                {provider.apiKeyConfigured ? (
                  <Button
                    className="button-danger"
                    disabled={providerBusy}
                    onClick={() =>
                      void providerAction(
                        () => runtimeClient.deleteAiProviderCredential(provider.revision),
                        'API Key 已删除，聊天切换到演示模式。',
                      )
                    }
                  >
                    删除 Key
                  </Button>
                ) : null}
              </div>
              {providerStatus ? (
                <div className="notice notice-success">{providerStatus}</div>
              ) : null}
              <p className="provider-meta">
                来源：{provider.source} · Revision {provider.revision}
                {provider.testedAt
                  ? ` · 最近测试 ${new Date(provider.testedAt).toLocaleString()}`
                  : ''}
                {` · 模型目录更新于 ${provider.catalogUpdatedAt}`}
              </p>
            </div>
          ) : (
            <div className="notice">
              Headless 配置为只读。请使用 AI_BASE_URL、AI_MODEL 和 AI_API_KEY 环境变量后重启服务。
            </div>
          )}
        </Card>
      ) : null}
      <Card>
        <h2>Runtime</h2>
        {diagnostics ? (
          <dl className="diagnostics-grid">
            <dt>版本</dt>
            <dd>{diagnostics.runtime.version}</dd>
            <dt>Generation</dt>
            <dd>{diagnostics.runtime.generation}</dd>
            <dt>Runtime ID</dt>
            <dd>
              <code>{diagnostics.runtime.runtimeId}</code>
            </dd>
            <dt>Chromium 资源</dt>
            <dd>{diagnostics.browserResources ?? '未检测到'}</dd>
            {Object.entries(diagnostics.database).map(([key, value]) => (
              <Fragment key={key}>
                <dt>{key}</dt>
                <dd>{String(typeof value === 'object' ? JSON.stringify(value) : value)}</dd>
              </Fragment>
            ))}
          </dl>
        ) : (
          <div className="empty-small">Desktop Runtime 诊断不可用</div>
        )}
      </Card>
      <Card>
        <div className="assistant-panel-title">
          <div>
            <h2>服务就绪状态</h2>
            <p>数据库与队列异常会阻止接入流量；分析 Worker 降级不影响采集。</p>
          </div>
          <span className={`badge badge-${readiness?.status === 'ready' ? 'success' : 'warning'}`}>
            {readiness?.status === 'ready' ? '已就绪' : '未就绪'}
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
            <dt>运行时间</dt>
            <dd>{formatDuration(runtimeSummary?.uptimeSeconds ?? 0)}</dd>
            <dt>队列积压</dt>
            <dd>{runtimeSummary?.queueBacklog ?? '—'}</dd>
            <dt>调度器</dt>
            <dd>{runtimeSummary?.schedulingPaused ? '已暂停' : '运行中'}</dd>
            <dt>作业状态</dt>
            <dd>
              {runtimeSummary
                ? Object.entries(runtimeSummary.jobsByState)
                    .filter(([, count]) => count > 0)
                    .map(([state, count]) => `${state}: ${count}`)
                    .join(' · ') || '暂无作业'
                : '—'}
            </dd>
          </dl>
        ) : (
          <div className="empty-small">正在读取服务状态</div>
        )}
      </Card>
      <Card>
        <h2>1.0 数据策略</h2>
        <p>
          ZhiYun 1.0 使用全新 Schema。首次检测到明确的 0.x
          数据时会自动清空；本版本不提供旧数据备份、恢复或导入工具。
        </p>
      </Card>
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
          <p>修改 {auth.user?.email} 的登录密码。成功后所有会话都会撤销，需要重新登录。</p>
        </div>
      </div>
      <form className="provider-settings-grid" onSubmit={(event) => void submit(event)}>
        <ErrorNotice message={error} />
        <label>
          <span>当前密码</span>
          <Input
            autoComplete="current-password"
            required
            type="password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </label>
        <label>
          <span>新密码</span>
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
          <span>确认新密码</span>
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
            {busy ? '正在修改…' : '修改密码'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

function runtimeCheckLabel(value: string): string {
  return (
    {
      database: 'PostgreSQL / 迁移',
      redis: 'Redis',
      queue: '作业队列',
      browser: 'Chromium',
      analyticsWorker: '分析 Worker',
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
