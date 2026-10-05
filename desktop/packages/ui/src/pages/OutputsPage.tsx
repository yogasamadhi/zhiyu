import { ConfirmAction } from '../components/ConfirmAction.js';
import { productCopy } from '../product-copy.js';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../components/experience.js';
import { useEffect, useState } from 'react';
import type {
  ApiToken,
  DeliveryAttempt,
  OutputDestination,
  TaskListItem,
  WebhookEventType,
} from '@zhiyun/contracts';
import { runtimeClient } from '@zhiyun/client';
import { useWorkspaceAuth } from '../auth.js';
import { Badge, Button, Card, ErrorNotice, Input } from '../components/ui.js';
import { resolveDevelopmentFixture } from '../development-demo.js';
import {
  buildOutputDestinationInput,
  defaultOutputDestinationDraft,
  outputDestinationSummary,
  type OutputDestinationDraft,
} from '../output-destination-form.js';

const webhookEventOptions: Array<{ value: WebhookEventType; label: string }> = [
  { value: 'run.succeeded', label: 'Run succeeded' },
  { value: 'run.failed', label: 'Run failed' },
  { value: 'dataset.changed', label: 'Dataset changed' },
  { value: 'quality.issue.detected', label: 'Quality issue detected' },
  { value: 'quality.recovered', label: 'Quality recovered' },
  { value: 'recruitment.match.detected', label: 'Recruitment match detected' },
  { value: 'recruitment.posting.changed', label: 'Recruitment posting changed' },
  { value: 'recruitment.digest.ready', label: 'Recruitment digest ready' },
];

export function OutputsPage() {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [params, setParams] = useSearchParams();
  const section = params.get('section') ?? 'schedules';
  const [showCreate, setShowCreate] = useState(false);
  const auth = useWorkspaceAuth();
  const desktop = typeof window !== 'undefined' && Boolean(window.zhiyunRuntime);
  const canManage = !auth.identityEnabled || auth.permissions.includes('output.manage');
  const [destinations, setDestinations] = useState<OutputDestination[]>([]);
  const [attempts, setAttempts] = useState<DeliveryAttempt[]>([]);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [tasks, setTasks] = useState<TaskListItem[]>([]);
  const [draft, setDraft] = useState<OutputDestinationDraft>(defaultOutputDestinationDraft);
  const [issuedToken, setIssuedToken] = useState('');
  const [tokenTaskIds, setTokenTaskIds] = useState<string[]>([]);
  const [tokenRateLimit, setTokenRateLimit] = useState(60);
  const [tokenExpiryDays, setTokenExpiryDays] = useState(30);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const developmentFixtureUrl = import.meta.env.DEV
    ? resolveDevelopmentFixture(true, import.meta.env.VITE_FIXTURE_URL)
    : undefined;
  const patchDraft = (patch: Partial<OutputDestinationDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));

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

  useEffect(() => {
    if (canManage) void load();
  }, [canManage]);

  if (!canManage) {
    return (
      <Card>
        <span className="badge badge-danger">{productCopy('权限不足')}</span>
        <h1>{productCopy('输出目的地管理仅限管理员')}</h1>
        <p>
          {productCopy(
            '编辑者可以在任务中绑定管理员已创建的目的地，但不能创建外部投递通道或 Data API Token。',
          )}
        </p>
      </Card>
    );
  }

  const createDestination = async () => {
    try {
      const created = await runtimeClient.createOutputDestination(
        buildOutputDestinationInput(draft, desktop),
      );
      patchDraft({
        secret: '',
        serviceAccountJson: '',
        secretAccessKey: '',
        sessionToken: '',
        ...(draft.type === 'local-directory' ? { target: '' } : {}),
      });
      if (desktop) {
        const prompted = await runtimeClient.promptOutputCredential(created.id);
        setShowCreate(false);
        setNotice(
          prompted.canceled
            ? created.type === 'local-directory'
              ? productCopy('输出已创建，尚未选择目录')
              : productCopy('输出已创建，凭据尚未设置')
            : created.type === 'local-directory'
              ? productCopy('输出与目录授权已安全保存')
              : productCopy('输出与凭据已安全保存'),
        );
      }
      setShowCreate(false);
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
    try {
      await runtimeClient.deleteOutputDestination(destination.id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
  };

  const retryDelivery = async (attempt: DeliveryAttempt) => {
    try {
      await runtimeClient.retryDeliveryAttempt(attempt.id);
      setNotice(productCopy('已加入输出重试队列'));
      window.setTimeout(() => void load(), 500);
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
          <h1>{zh ? productCopy('自动化') : 'Automation'}</h1>
          <p>
            {zh
              ? productCopy('设置定时采集、数据同步、通知和 API 访问。')
              : 'Configure schedules, data sync, notifications and API access.'}
          </p>
        </div>
      </div>
      <nav
        className="section-tabs"
        aria-label={zh ? productCopy('自动化分组') : 'Automation sections'}
      >
        {[
          ['schedules', productCopy('计划任务'), 'Schedules'],
          ['sync', productCopy('数据同步'), 'Data sync'],
          ['notifications', productCopy('消息通知'), 'Notifications'],
          ['api', productCopy('API 访问'), 'API access'],
        ].map(([id, cn, en]) => (
          <Button
            key={id}
            className={section === id ? 'button-secondary' : 'button-ghost'}
            aria-current={section === id ? 'page' : undefined}
            onClick={() => setParams({ section: id! })}
          >
            {zh ? cn : en}
          </Button>
        ))}
      </nav>
      {section === 'schedules' && (
        <Card>
          <h2>{zh ? productCopy('计划任务') : 'Scheduled tasks'}</h2>
          <p>
            {zh
              ? productCopy('在采集任务中设置运行频率，支持单独暂停或恢复计划。')
              : 'Set a frequency in a collection task, and pause or resume schedules individually.'}
          </p>
          <div className="compact-list">
            {tasks
              .filter((task) => task.schedule.mode === 'cron')
              .map((task) => (
                <Link key={task.id} to={`/tasks/${task.id}/edit`}>
                  <strong>{task.name}</strong>
                  <span>
                    {task.schedule.paused
                      ? zh
                        ? productCopy('已暂停')
                        : 'Paused'
                      : task.schedule.cron}
                  </span>
                </Link>
              ))}
          </div>
          <Link className="button button-secondary" to="/tasks">
            {zh ? productCopy('管理采集计划') : 'Manage schedules'}
          </Link>
        </Card>
      )}
      <ErrorNotice message={error} />
      {notice && <div className="notice notice-success">{notice}</div>}
      {['sync', 'notifications'].includes(section) && (
        <Button
          className="button"
          onClick={() => {
            if (section === 'notifications') patchDraft({ type: 'webhook' });
            setShowCreate(true);
          }}
        >
          {zh ? productCopy('新增连接') : 'Add connection'}
        </Button>
      )}
      <Dialog
        open={showCreate}
        title={zh ? productCopy('新增连接') : 'Add connection'}
        onClose={() => setShowCreate(false)}
      >
        <h2>{zh ? productCopy('连接信息') : 'Connection details'}</h2>
        <div className="form-grid">
          <label>
            <span>{productCopy('名称')}</span>
            <Input
              value={draft.name}
              onChange={(event) => patchDraft({ name: event.target.value })}
            />
          </label>
          <label>
            <span>{productCopy('类型')}</span>
            <select
              value={draft.type}
              onChange={(event) =>
                patchDraft({ type: event.target.value as OutputDestinationDraft['type'] })
              }
            >
              <option value="webhook">Webhook</option>
              <option value="local-directory">{productCopy('本地目录')}</option>
              <option value="google-sheets">Google Sheets</option>
              <option value="s3">{productCopy('S3 / 兼容对象存储')}</option>
            </select>
          </label>
          <DestinationFormFields
            draft={draft}
            desktop={desktop}
            developmentFixtureUrl={developmentFixtureUrl}
            onChange={patchDraft}
          />
        </div>
        <Button onClick={() => void createDestination()}>{productCopy('保存输出')}</Button>
      </Dialog>
      {['sync', 'notifications'].includes(section) && (
        <Card>
          <h2>{zh ? productCopy('已连接的目的地') : 'Connected destinations'}</h2>
          <div className="change-list">
            {destinations
              .filter((destination) =>
                section === 'notifications'
                  ? destination.type === 'webhook'
                  : destination.type !== 'webhook',
              )
              .map((destination) => (
                <div className="change-item" key={destination.id}>
                  <Badge tone={destination.enabled ? 'success' : 'neutral'}>
                    {destination.type}
                  </Badge>
                  <strong>{destination.name}</strong>
                  <span>{productCopy(outputDestinationSummary(destination))}</span>
                  <div className="row-actions">
                    <Button
                      className="button-secondary"
                      disabled={destination.type === 'postgres'}
                      onClick={() => void testDestination(destination)}
                    >
                      {productCopy('测试连接')}
                    </Button>
                    {desktop && destination.type !== 'postgres' && (
                      <Button
                        className="button-secondary"
                        onClick={() => void promptOutputCredential(destination)}
                      >
                        {destination.type === 'local-directory'
                          ? destination.credentialRef
                            ? productCopy('更换目录')
                            : productCopy('选择目录')
                          : destination.credentialRef
                            ? productCopy('替换凭据')
                            : productCopy('安全输入凭据')}
                      </Button>
                    )}
                    <Button
                      className="button-secondary"
                      disabled={destination.type === 'postgres'}
                      onClick={() => void toggleDestination(destination)}
                    >
                      {destination.enabled ? productCopy('停用') : productCopy('启用')}
                    </Button>
                    <ConfirmAction
                      label={productCopy('删除')}
                      description={
                        zh
                          ? `删除“${destination.name}”后，关联任务无法再向它输出数据。已采集的数据会保留。此操作无法撤销。`
                          : `Delete “${destination.name}”? Connected tasks will no longer deliver to it. Collected data is retained. This cannot be undone.`
                      }
                      onConfirm={() => removeDestination(destination)}
                    />
                  </div>
                </div>
              ))}
            {!destinations.length && (
              <div className="empty-small">{productCopy('尚未配置输出')}</div>
            )}
          </div>
        </Card>
      )}
      {section === 'api' && (
        <Card>
          <div className="section-heading">
            <div>
              <h2>{productCopy('只读 Data API Token')}</h2>
              <p>{productCopy('Token 只在创建时显示一次')}</p>
            </div>
            <Button onClick={() => void createToken()}>{productCopy('创建 Token')}</Button>
          </div>
          <div className="form-grid">
            <label>
              <span>{productCopy('每分钟请求上限')}</span>
              <Input
                type="number"
                min={1}
                max={10_000}
                value={tokenRateLimit}
                onChange={(event) => setTokenRateLimit(Number(event.target.value))}
              />
            </label>
            <label>
              <span>{productCopy('有效天数（0 为永久）')}</span>
              <Input
                type="number"
                min={0}
                value={tokenExpiryDays}
                onChange={(event) => setTokenExpiryDays(Number(event.target.value))}
              />
            </label>
            <div className="full">
              <span className="field-label">{productCopy('任务 Scope（不选择表示全部任务）')}</span>
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
                  {token.revokedAt ? productCopy('已撤销') : productCopy('启用')}
                </Badge>
                <strong>{token.name}</strong>
                <span>
                  {token.taskIds.length || productCopy('全部')} {productCopy('任务范围 ·')}{' '}
                  {token.rateLimitPerMinute}/min ·{' '}
                  {token.expiresAt
                    ? new Date(token.expiresAt).toLocaleDateString()
                    : productCopy('永久')}
                </span>
                {!token.revokedAt && (
                  <ConfirmAction
                    label={productCopy('撤销')}
                    description={
                      i18n.language.startsWith('zh')
                        ? '此访问令牌将立即失效，使用它的外部程序将无法再访问数据。需要重新创建令牌后才能恢复访问。'
                        : 'This token stops working immediately. Connected programs will need a new token to access data again.'
                    }
                    onConfirm={async () => {
                      await runtimeClient.revokeApiToken(token.id);
                      await load();
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
      {['sync', 'notifications'].includes(section) && (
        <Card>
          <h2>{productCopy('最近发送')}</h2>
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
                  {t(`ux.state.${attempt.status}`, { defaultValue: attempt.status })}
                </Badge>
                <code>{attempt.runId.slice(0, 8)}</code>
                <span>
                  {productCopy('尝试次数')} {attempt.attempt}
                </span>
                {attempt.error && <span title={attempt.error}>{attempt.error}</span>}
                {attempt.status === 'failed' && (
                  <Button className="button-secondary" onClick={() => void retryDelivery(attempt)}>
                    {productCopy('重试')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

function DestinationFormFields(props: {
  draft: OutputDestinationDraft;
  desktop: boolean;
  developmentFixtureUrl: string | undefined;
  onChange(patch: Partial<OutputDestinationDraft>): void;
}) {
  const { t } = useTranslation();
  const { draft } = props;
  if (draft.type === 'webhook') {
    return (
      <>
        <label className="full">
          <span>{productCopy('Webhook 地址')}</span>
          <Input
            type="url"
            value={draft.target}
            onChange={(event) => props.onChange({ target: event.target.value })}
          />
          {props.developmentFixtureUrl && (
            <button
              className="inline-demo-link"
              type="button"
              onClick={() => props.onChange({ target: `${props.developmentFixtureUrl}/webhook` })}
            >
              {productCopy('加载开发演示 Webhook')}
            </button>
          )}
        </label>
        <div className="full">
          <span className="field-label">{productCopy('订阅事件')}</span>
          <div className="binding-list">
            {webhookEventOptions.map((option) => (
              <label className="check" key={option.value}>
                <input
                  type="checkbox"
                  checked={draft.webhookEvents.includes(option.value)}
                  onChange={(event) =>
                    props.onChange({
                      webhookEvents: event.target.checked
                        ? [...draft.webhookEvents, option.value]
                        : draft.webhookEvents.filter((value) => value !== option.value),
                    })
                  }
                />
                {t(`outputEvents.${option.value}`, { defaultValue: option.label })}
              </label>
            ))}
          </div>
        </div>
        {!props.desktop && (
          <label className="full">
            <span>{productCopy('HMAC 密钥')}</span>
            <Input
              type="password"
              value={draft.secret}
              onChange={(event) => props.onChange({ secret: event.target.value })}
            />
          </label>
        )}
      </>
    );
  }
  if (draft.type === 'local-directory') {
    return (
      <>
        {props.desktop ? (
          <div className="full notice">
            {productCopy('保存后将打开原生目录选择器；目录授权会加密保存。')}
          </div>
        ) : (
          <label className="full">
            <span>{productCopy('根目录内子目录（可选）')}</span>
            <Input
              value={draft.target}
              onChange={(event) => props.onChange({ target: event.target.value })}
            />
            <small className="form-help">
              {productCopy('使用相对路径；实际根目录由 Headless 的 ZHIYUN_OUTPUT_ROOT 锁定。')}
            </small>
          </label>
        )}
        <FileOutputFields draft={draft} onChange={props.onChange} />
      </>
    );
  }
  if (draft.type === 'google-sheets') {
    return (
      <>
        <label>
          <span>{productCopy('电子表格标识')}</span>
          <Input
            value={draft.spreadsheetId}
            onChange={(event) => props.onChange({ spreadsheetId: event.target.value })}
          />
        </label>
        <label>
          <span>{productCopy('工作表名称')}</span>
          <Input
            value={draft.sheetName}
            onChange={(event) => props.onChange({ sheetName: event.target.value })}
          />
        </label>
        <label>
          <span>{productCopy('写入模式')}</span>
          <select
            value={draft.sheetMode}
            onChange={(event) =>
              props.onChange({
                sheetMode: event.target.value as OutputDestinationDraft['sheetMode'],
              })
            }
          >
            <option value="auto">{productCopy('自动（Snapshot/Upsert 替换，Append 追加）')}</option>
            <option value="replace">{productCopy('Replace（快照默认）')}</option>
            <option value="append">{productCopy('Append（带 Run ID 去重）')}</option>
          </select>
        </label>
        <label>
          <span>{productCopy('字段顺序（逗号分隔）')}</span>
          <Input
            value={draft.columns}
            onChange={(event) => props.onChange({ columns: event.target.value })}
          />
        </label>
        {props.desktop ? (
          <div className="full notice">
            {productCopy('保存后安全输入服务账号 JSON，并将表格共享给其中的 client_email。')}
          </div>
        ) : (
          <label className="full">
            <span>{productCopy('服务账号 JSON')}</span>
            <textarea
              rows={6}
              value={draft.serviceAccountJson}
              onChange={(event) => props.onChange({ serviceAccountJson: event.target.value })}
            />
          </label>
        )}
      </>
    );
  }
  return (
    <>
      <label>
        <span>{productCopy('存储桶')}</span>
        <Input
          value={draft.bucket}
          onChange={(event) => props.onChange({ bucket: event.target.value })}
        />
      </label>
      <label>
        <span>{productCopy('区域')}</span>
        <Input
          value={draft.region}
          onChange={(event) => props.onChange({ region: event.target.value })}
        />
      </label>
      <label>
        <span>{productCopy('文件前缀')}</span>
        <Input
          value={draft.prefix}
          onChange={(event) => props.onChange({ prefix: event.target.value })}
        />
      </label>
      <label>
        <span>{productCopy('兼容端点（可选）')}</span>
        <Input
          type="url"
          value={draft.endpoint}
          onChange={(event) => props.onChange({ endpoint: event.target.value })}
        />
      </label>
      <FileOutputFields draft={draft} onChange={props.onChange} />
      <label className="check">
        <input
          type="checkbox"
          checked={draft.forcePathStyle}
          onChange={(event) => props.onChange({ forcePathStyle: event.target.checked })}
        />
        {productCopy('使用 Path-style URL（MinIO 等）')}
      </label>
      <label>
        <span>{productCopy('服务端加密')}</span>
        <select
          value={draft.serverSideEncryption}
          onChange={(event) =>
            props.onChange({
              serverSideEncryption: event.target
                .value as OutputDestinationDraft['serverSideEncryption'],
            })
          }
        >
          <option value="">{productCopy('不指定')}</option>
          <option value="AES256">SSE-S3 (AES256)</option>
          <option value="aws:kms">SSE-KMS</option>
        </select>
      </label>
      {draft.serverSideEncryption === 'aws:kms' && (
        <label className="full">
          <span>{productCopy('KMS 密钥标识')}</span>
          <Input
            value={draft.kmsKeyId}
            onChange={(event) => props.onChange({ kmsKeyId: event.target.value })}
          />
        </label>
      )}
      {props.desktop ? (
        <div className="full notice">
          {productCopy('保存后在 Host 安全窗口输入 S3 凭据；也可使用运行环境 IAM。')}
        </div>
      ) : (
        <div className="full form-grid two output-credential-fields">
          <label>
            <span>{productCopy('Access Key ID（留空使用环境 IAM）')}</span>
            <Input
              value={draft.accessKeyId}
              onChange={(event) => props.onChange({ accessKeyId: event.target.value })}
            />
          </label>
          <label>
            <span>{productCopy('访问密钥')}</span>
            <Input
              type="password"
              value={draft.secretAccessKey}
              onChange={(event) => props.onChange({ secretAccessKey: event.target.value })}
            />
          </label>
          <label className="full">
            <span>{productCopy('Session Token（可选）')}</span>
            <Input
              type="password"
              value={draft.sessionToken}
              onChange={(event) => props.onChange({ sessionToken: event.target.value })}
            />
          </label>
        </div>
      )}
    </>
  );
}

function FileOutputFields(props: {
  draft: OutputDestinationDraft;
  onChange(patch: Partial<OutputDestinationDraft>): void;
}) {
  return (
    <>
      <label>
        <span>{productCopy('文件格式')}</span>
        <select
          value={props.draft.format}
          onChange={(event) =>
            props.onChange({ format: event.target.value as OutputDestinationDraft['format'] })
          }
        >
          <option value="csv">CSV</option>
          <option value="jsonl">JSONL</option>
          <option value="parquet">{productCopy('Parquet（需要分析 Worker）')}</option>
        </select>
      </label>
      <label className="full">
        <span>{productCopy('归档路径模板')}</span>
        <Input
          value={props.draft.pathTemplate}
          onChange={(event) => props.onChange({ pathTemplate: event.target.value })}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={props.draft.updateLatest}
          onChange={(event) => props.onChange({ updateLatest: event.target.checked })}
        />
        {productCopy('同时原子更新 latest 文件 / 对象')}
      </label>
    </>
  );
}
