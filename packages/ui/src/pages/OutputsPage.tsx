import { useEffect, useState } from 'react';
import type { ApiToken, DeliveryAttempt, OutputDestination, TaskListItem } from '@zhiyun/contracts';
import { runtimeClient } from '@zhiyun/client';
import { Badge, Button, Card, ErrorNotice, Input } from '../components/ui.js';

export function OutputsPage() {
  const desktop = typeof window !== 'undefined' && Boolean(window.zhiyunRuntime);
  const [destinations, setDestinations] = useState<OutputDestination[]>([]);
  const [attempts, setAttempts] = useState<DeliveryAttempt[]>([]);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [name, setName] = useState('Webhook');
  const [type, setType] = useState<'webhook' | 'postgres'>('webhook');
  const [target, setTarget] = useState('http://127.0.0.1:45100/webhook');
  const [secret, setSecret] = useState('');
  const [webhookEvent, setWebhookEvent] = useState<'run.succeeded' | 'dataset.changed'>(
    'run.succeeded',
  );
  const [issuedToken, setIssuedToken] = useState('');
  const [tokenTaskIds, setTokenTaskIds] = useState<string[]>([]);
  const [tokenRateLimit, setTokenRateLimit] = useState(60);
  const [tokenExpiryDays, setTokenExpiryDays] = useState(30);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    try {
      const [loadedDestinations, loadedAttempts, loadedTokens, loadedTasks] = await Promise.all([
        runtimeClient.listOutputDestinations(),
        runtimeClient.listDeliveryAttempts(),
        runtimeClient.listApiTokens(),
        runtimeClient.listTasks(500),
      ]);
      setDestinations(loadedDestinations);
      setAttempts(loadedAttempts);
      setTokens(loadedTokens);
      setTasks(loadedTasks.items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  useEffect(() => void load(), []);

  const createDestination = async () => {
    try {
      const created = await runtimeClient.createOutputDestination({
        name,
        type,
        config:
          type === 'webhook'
            ? { url: target, event: webhookEvent }
            : { schema: 'public', table: 'zhiyun_records' },
        ...(!desktop
          ? {
              credential: type === 'webhook' ? { secret } : { connectionString: target },
            }
          : {}),
        enabled: true,
      });
      setSecret('');
      if (type === 'postgres') setTarget('');
      if (desktop) {
        const prompted = await runtimeClient.promptOutputCredential(created.id);
        setNotice(prompted.canceled ? '输出已创建，凭据尚未设置' : '输出与凭据已安全保存');
      }
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const promptOutputCredential = async (destination: OutputDestination) => {
    try {
      const result = await runtimeClient.promptOutputCredential(destination.id);
      if (!result.canceled) setNotice(`${destination.name} 的凭据已安全替换`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const testDestination = async (destination: OutputDestination) => {
    setError('');
    setNotice('');
    try {
      await runtimeClient.testOutputDestination(destination.id);
      setNotice(`${destination.name} 连接测试成功`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const toggleDestination = async (destination: OutputDestination) => {
    try {
      await runtimeClient.updateOutputDestination(destination.id, {
        enabled: !destination.enabled,
      });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const removeDestination = async (destination: OutputDestination) => {
    if (!window.confirm(`删除输出“${destination.name}”？`)) return;
    try {
      await runtimeClient.deleteOutputDestination(destination.id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const retryDelivery = async (attempt: DeliveryAttempt) => {
    try {
      await runtimeClient.retryDeliveryAttempt(attempt.id);
      setNotice('已加入输出重试队列');
      window.setTimeout(() => void load(), 500);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const revokeToken = async (token: ApiToken) => {
    try {
      await runtimeClient.revokeApiToken(token.id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const createToken = async () => {
    try {
      const result = await runtimeClient.createApiToken({
        name: `Data API ${new Date().toLocaleDateString()}`,
        taskIds: tokenTaskIds,
        rateLimitPerMinute: tokenRateLimit,
        expiresAt:
          tokenExpiryDays > 0
            ? new Date(Date.now() + tokenExpiryDays * 86_400_000).toISOString()
            : null,
      });
      setIssuedToken(result.token);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Outputs & Data API</h1>
          <p>配置外部推送与只读访问 Token</p>
        </div>
      </div>
      <ErrorNotice message={error} />
      {notice && <div className="notice notice-success">{notice}</div>}
      <Card>
        <h2>新增输出</h2>
        <div className="form-grid">
          <label>
            <span>名称</span>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            <span>类型</span>
            <select value={type} onChange={(event) => setType(event.target.value as typeof type)}>
              <option value="webhook">Webhook</option>
              <option value="postgres">PostgreSQL</option>
            </select>
          </label>
          {(type === 'webhook' || !desktop) && (
            <label className="full">
              <span>{type === 'webhook' ? 'Webhook URL' : 'Connection string'}</span>
              <Input
                type={type === 'postgres' ? 'password' : 'url'}
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              />
            </label>
          )}
          {type === 'postgres' && desktop && (
            <div className="full notice">保存后将在 Host 安全窗口输入 Connection string。</div>
          )}
          {type === 'webhook' && !desktop && (
            <label className="full">
              <span>HMAC Secret</span>
              <Input
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
              />
            </label>
          )}
          {type === 'webhook' && (
            <label>
              <span>事件</span>
              <select
                value={webhookEvent}
                onChange={(event) =>
                  setWebhookEvent(event.target.value as 'run.succeeded' | 'dataset.changed')
                }
              >
                <option value="run.succeeded">Run succeeded</option>
                <option value="dataset.changed">Dataset changed</option>
              </select>
            </label>
          )}
        </div>
        <Button onClick={() => void createDestination()}>保存输出</Button>
      </Card>
      <Card>
        <h2>输出目的地</h2>
        <div className="change-list">
          {destinations.map((destination) => (
            <div className="change-item" key={destination.id}>
              <Badge tone={destination.enabled ? 'success' : 'neutral'}>{destination.type}</Badge>
              <strong>{destination.name}</strong>
              <span>
                {String(destination.config.url ?? destination.config.table ?? '')}
                {destination.type === 'webhook'
                  ? ` · ${String(destination.config.event ?? 'run.succeeded')}`
                  : ''}
              </span>
              <div className="row-actions">
                <Button
                  className="button-secondary"
                  onClick={() => void testDestination(destination)}
                >
                  测试连接
                </Button>
                {desktop && (
                  <Button
                    className="button-secondary"
                    onClick={() => void promptOutputCredential(destination)}
                  >
                    {destination.credentialRef ? '替换凭据' : '安全输入凭据'}
                  </Button>
                )}
                <Button
                  className="button-secondary"
                  onClick={() => void toggleDestination(destination)}
                >
                  {destination.enabled ? '停用' : '启用'}
                </Button>
                <Button
                  className="button-danger"
                  onClick={() => void removeDestination(destination)}
                >
                  删除
                </Button>
              </div>
            </div>
          ))}
          {!destinations.length && <div className="empty-small">尚未配置输出</div>}
        </div>
      </Card>
      <Card>
        <div className="section-heading">
          <div>
            <h2>只读 Data API Token</h2>
            <p>Token 只在创建时显示一次</p>
          </div>
          <Button onClick={() => void createToken()}>创建 Token</Button>
        </div>
        <div className="form-grid">
          <label>
            <span>每分钟请求上限</span>
            <Input
              type="number"
              min={1}
              max={10_000}
              value={tokenRateLimit}
              onChange={(event) => setTokenRateLimit(Number(event.target.value))}
            />
          </label>
          <label>
            <span>有效天数（0 为永久）</span>
            <Input
              type="number"
              min={0}
              value={tokenExpiryDays}
              onChange={(event) => setTokenExpiryDays(Number(event.target.value))}
            />
          </label>
          <div className="full">
            <span className="field-label">任务 Scope（不选择表示全部任务）</span>
            <div className="binding-list">
              {tasks.map((task) => (
                <label className="check" key={task.id}>
                  <input
                    type="checkbox"
                    checked={tokenTaskIds.includes(task.id)}
                    onChange={(event) =>
                      setTokenTaskIds((current) =>
                        event.target.checked
                          ? [...current, task.id]
                          : current.filter((id) => id !== task.id),
                      )
                    }
                  />
                  {task.name}
                </label>
              ))}
            </div>
          </div>
        </div>
        {issuedToken && (
          <div className="notice notice-success">
            <code>{issuedToken}</code>
          </div>
        )}
        <div className="change-list">
          {tokens.map((token) => (
            <div className="change-item" key={token.id}>
              <Badge tone={token.revokedAt ? 'danger' : 'success'}>
                {token.revokedAt ? 'revoked' : 'active'}
              </Badge>
              <strong>{token.name}</strong>
              <span>
                {token.taskIds.length || '全部'} task scope · {token.rateLimitPerMinute}/min ·{' '}
                {token.expiresAt ? new Date(token.expiresAt).toLocaleDateString() : '永久'}
              </span>
              {!token.revokedAt && (
                <Button className="button-danger" onClick={() => void revokeToken(token)}>
                  撤销
                </Button>
              )}
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <h2>最近发送</h2>
        <div className="change-list">
          {attempts.slice(0, 20).map((attempt) => (
            <div className="change-item" key={attempt.id}>
              <Badge
                tone={
                  attempt.status === 'failed'
                    ? 'danger'
                    : attempt.status === 'succeeded'
                      ? 'success'
                      : 'neutral'
                }
              >
                {attempt.status}
              </Badge>
              <code>{attempt.runId.slice(0, 8)}</code>
              <span>attempt {attempt.attempt}</span>
              {attempt.error && <span title={attempt.error}>{attempt.error}</span>}
              {attempt.status === 'failed' && (
                <Button className="button-secondary" onClick={() => void retryDelivery(attempt)}>
                  重试
                </Button>
              )}
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}
