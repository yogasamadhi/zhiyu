import { useEffect, useState } from 'react';
import { Button, Card, ErrorNotice } from './ui.js';
interface Summary {
  mode: 'byok' | 'hosted';
  model: string;
  signedIn: boolean;
  offline: boolean;
  error?: string;
  account: {
    identities?: { target: string }[];
    balance?: { available: number; reserved: number };
  } | null;
  models: { id: string; name: string }[];
}
interface Bridge {
  summary(): Promise<Summary>;
  login(): Promise<Summary>;
  logout(): Promise<Summary>;
  select(mode: 'byok' | 'hosted', model: string): Promise<Summary>;
  portal(): Promise<void>;
}
function bridge() {
  return (window as unknown as { zhiyunCloud?: Bridge }).zhiyunCloud;
}
export function CloudAccountSettings() {
  const [summary, setSummary] = useState<Summary | null>(null),
    [model, setModel] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    void bridge()
      ?.summary()
      .then((value) => {
        setSummary(value);
        setModel(value.model);
      })
      .catch(() => undefined);
  }, []);
  if (!bridge()) return null;
  async function act(fn: () => Promise<Summary>) {
    setBusy(true);
    setError('');
    try {
      const value = await fn();
      setSummary(value);
      setModel(value.model);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <h2>云账户与 AI 服务方式</h2>
      <p>采集、分析、语料、定时任务与导出始终免费。自带 API Key 保存在本机，无需登录或订阅。</p>
      <ErrorNotice message={error} />
      <p>
        当前方式：
        <strong>{summary?.mode === 'hosted' ? '平台托管 AI' : '自带 API Key（免费）'}</strong>
      </p>
      {summary?.signedIn ? (
        <>
          <p>{summary.account?.identities?.map((i) => i.target).join(' / ')}</p>
          <p>
            测试积分：{summary.account?.balance?.available ?? '—'} 可用 /{' '}
            {summary.account?.balance?.reserved ?? '—'} 待结算
          </p>
          {summary.offline && (
            <p role="status">
              云服务不可用：{summary.error}。缓存仅用于展示，无法离线使用托管额度。
            </p>
          )}
          <div className="button-row">
            <Button
              className="button-secondary"
              disabled={busy}
              onClick={() => void act(() => bridge()!.summary())}
            >
              刷新账户
            </Button>
            <Button className="button-secondary" onClick={() => void bridge()!.portal()}>
              订阅、订单与设备
            </Button>
            <Button
              className="button-secondary"
              disabled={busy}
              onClick={() => void act(() => bridge()!.logout())}
            >
              退出云账户
            </Button>
          </div>
        </>
      ) : (
        <Button disabled={busy} onClick={() => void act(() => bridge()!.login())}>
          {busy ? '等待系统浏览器授权…' : '登录云账户'}
        </Button>
      )}
      <div className="form-grid">
        <label>
          托管模型
          <select
            disabled={busy}
            aria-label="托管模型"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">选择订阅中的模型</option>
            {summary?.models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="button-row">
        <Button
          disabled={busy || !summary?.signedIn || !model || summary.offline}
          onClick={() => void act(() => bridge()!.select('hosted', model))}
        >
          使用托管 AI
        </Button>
        <Button
          className="button-secondary"
          disabled={busy}
          onClick={() => void act(() => bridge()!.select('byok', model))}
        >
          手动切换为自带 Key
        </Button>
      </div>
      <p className="muted">
        托管模式会转发当前调用必要的对话与工具结果，默认不保存正文。工具仍在本机执行。额度不足或订阅到期时不会自动使用你的
        Key。以下 Provider 配置仅用于自带 Key 模式。
      </p>
    </Card>
  );
}
