import { StrictMode, useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, Layers3, RefreshCw, LogOut, ShieldCheck } from 'lucide-react';
import {
  Button,
  Input,
  Field,
  Card,
  Table,
  Notice,
  Badge,
  CloudListControls,
  useCloudList,
} from '@zhiyun/cloud-ui';
import { request, isCloudListPath, type ApiPath } from '@zhiyun/cloud-client';
import './styles.css';
type Row = Record<string, unknown>;
type FieldSpec = { key: string; label: string; type?: string; value?: string; options?: string[] };
type Operation = { title: string; path: ApiPath; fields: FieldSpec[] };
const p = '/api/cloud/v1/admin';
const sections = [
  ['overview', '运营概览'],
  ['users', '用户账户'],
  ['prices', '商品与价格'],
  ['models', '托管模型与费率'],
  ['subscriptions', '订阅服务期'],
  ['orders', '订单与支付'],
  ['refunds', '退款管理'],
  ['credits', '积分账本'],
  ['periods', '积分周期'],
  ['requests', 'AI 请求核查'],
  ['devices', '设备管理'],
  ['agreements', '自动续费协议'],
  ['staff', '管理员'],
  ['simulation', '模拟支付工具'],
  ['inbox', '测试收件箱'],
  ['jobs', '后台任务'],
  ['audit', '操作审计'],
];
const idField = (key = 'id', label = '记录编号'): FieldSpec => ({ key, label });
const reason: FieldSpec = { key: 'reason', label: '操作原因（保留审计）' };
const scenarios = ['success', 'failure', 'cancel', 'delay', 'duplicate', 'out-of-order', 'unknown'];
const operations: Record<string, Operation[]> = {
  users: [
    {
      title: '调整云账户状态',
      path: `${p}/users/status`,
      fields: [idField(), { key: 'status', label: '状态', options: ['active', 'disabled'] }],
    },
  ],
  models: [
    {
      title: '新增模型与费率版本',
      path: `${p}/models`,
      fields: [
        { key: 'name', label: '展示名称' },
        { key: 'adapter', label: '适配器', options: ['mock', 'openai-compatible'] },
        { key: 'upstreamModel', label: '上游模型标识', value: 'mock-zhiyun' },
        { key: 'baseUrl', label: '测试上游地址（模拟模型可留空）' },
        { key: 'keyRef', label: '测试密钥环境变量名（模拟模型可留空）' },
        { key: 'inputRate', label: '每千输入 Token 积分', type: 'number', value: '1' },
        { key: 'outputRate', label: '每千输出 Token 积分', type: 'number', value: '2' },
        { key: 'maxOutput', label: '最大输出 Token', type: 'number', value: '1024' },
        { key: 'maxContext', label: '上下文上限', type: 'number', value: '32768' },
      ],
    },
    { title: '测试并启用模型版本', path: `${p}/models/test`, fields: [idField()] },
    { title: '停用模型版本', path: `${p}/models/disable`, fields: [idField()] },
  ],
  prices: [
    {
      title: '新增不可变价格版本',
      path: `${p}/prices`,
      fields: [
        { key: 'name', label: '商品名称' },
        { key: 'amountFen', label: '模拟售价（分）', type: 'number' },
        { key: 'cycle', label: '订阅周期', options: ['month', 'year'] },
        { key: 'credits', label: '每月积分额度', type: 'number' },
        { key: 'modelIds', label: '已测试模型编号（逗号分隔）' },
      ],
    },
    {
      title: '发布 / 下架测试商品',
      path: `${p}/prices/publish`,
      fields: [idField(), { key: 'published', label: '是否发布', options: ['true', 'false'] }],
    },
  ],
  orders: [
    {
      title: '申请模拟全额退款',
      path: `${p}/refunds`,
      fields: [idField('orderId', '订单编号'), reason],
    },
  ],
  refunds: [
    {
      title: '模拟渠道确认退款',
      path: `${p}/simulation/refund`,
      fields: [
        idField('orderId', '订单编号'),
        { key: 'scenario', label: '通知场景', options: ['success', 'unknown'] },
      ],
    },
  ],
  credits: [
    {
      title: '积分补偿 / 调整',
      path: `${p}/credits/adjust`,
      fields: [
        idField('periodId', '当前有效积分周期编号'),
        { key: 'amount', label: '积分变化（可为负数）', type: 'number' },
        { key: 'key', label: '业务唯一键' },
        reason,
      ],
    },
  ],
  requests: [
    {
      title: '补偿释放待核查预占',
      path: `${p}/requests/release`,
      fields: [idField(), { key: 'reason', label: '核查证据与补偿原因（至少 10 字）' }],
    },
  ],
  devices: [{ title: '解绑设备并撤销云端访问', path: `${p}/devices/revoke`, fields: [idField()] }],
  staff: [
    {
      title: '创建管理员（首次登录必须使用 TOTP）',
      path: `${p}/staff`,
      fields: [
        { key: 'email', label: '邮箱', type: 'email' },
        { key: 'password', label: '初始密码（至少 12 位）', type: 'password' },
        { key: 'role', label: '角色', options: ['support', 'finance', 'operator'] },
      ],
    },
    { title: '禁用管理员', path: `${p}/staff/disable`, fields: [idField()] },
  ],
  jobs: [{ title: '重新排队失败任务', path: `${p}/jobs/retry`, fields: [idField()] }],
  simulation: [
    {
      title: '模拟主动支付通知',
      path: `${p}/simulation/payment`,
      fields: [
        idField('orderId', '订单编号'),
        { key: 'scenario', label: '故障场景', options: scenarios },
      ],
    },
    {
      title: '设置下一次模拟自动扣款场景',
      path: `${p}/simulation/agreement`,
      fields: [idField(), { key: 'scenario', label: '故障场景', options: scenarios }],
    },
    {
      title: '模拟退款确认',
      path: `${p}/simulation/refund`,
      fields: [
        idField('orderId', '订单编号'),
        { key: 'scenario', label: '场景', options: ['success', 'unknown'] },
      ],
    },
  ],
};
const roleSections: Record<string, string[]> = {
  owner: sections.map(([s]) => s!),
  support: [
    'overview',
    'users',
    'subscriptions',
    'orders',
    'credits',
    'devices',
    'agreements',
    'inbox',
    'audit',
  ],
  finance: [
    'overview',
    'prices',
    'subscriptions',
    'orders',
    'refunds',
    'credits',
    'periods',
    'requests',
    'agreements',
    'simulation',
    'audit',
  ],
  operator: ['overview', 'models', 'jobs', 'requests', 'audit'],
};
function Admin() {
  const [section, setSection] = useState(location.hash.slice(1) || 'overview'),
    [staff, setStaff] = useState<{ id: string; csrf: string; role: string } | null>(null),
    [rows, setRows] = useState<Row[]>([]),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const candidate = `/admin/${section}`;
  const list = useCloudList(isCloudListPath(candidate) ? candidate : null, staff?.id);
  const listRows = list.items;
  const [login, setLogin] = useState({ email: '', password: '', totp: '' });
  async function load() {
    try {
      const s = await request<{ id: string; csrf: string; role: string }>(`${p}/me`);
      setStaff(s);
      if (section === 'overview') {
        const health = await request<Row>('/api/cloud/v1/health');
        setRows([health]);
      }
    } catch (e) {
      if (e instanceof Error && e.message === 'UNAUTHENTICATED') setStaff(null);
      else setError(e instanceof Error ? e.message : '加载失败');
    }
  }
  useEffect(() => {
    void load();
    const handler = () => {
      setSection(location.hash.slice(1) || 'overview');
      setError('');
      setMessage('');
    };
    addEventListener('hashchange', handler);
    return () => removeEventListener('hashchange', handler);
  }, [section]);
  async function submit(path: ApiPath, body: unknown) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const r = await request<Row>(path, body, staff?.csrf);
      setMessage(
        r?.enrollmentUri
          ? `请安全传递一次性 TOTP 注册地址：${String(r.enrollmentUri)}`
          : '操作成功，记录已更新。',
      );
      await load();
      list.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  if (!staff)
    return (
      <main className="mx-auto max-w-md px-5 py-20">
        <div className="mb-8 flex items-center gap-3">
          <ShieldCheck className="text-primary" size={32} />
          <h1 className="text-2xl font-semibold">织云运营后台</h1>
        </div>
        <Card>
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(`${p}/login`, login);
            }}
          >
            <p className="text-sm text-muted-foreground">管理员使用独立账户和动态验证码登录。</p>
            {(['email', 'password', 'totp'] as const).map((name, i) => (
              <Field key={name} label={['管理员邮箱', '密码', 'TOTP 动态验证码'][i]!}>
                <Input
                  type={name === 'password' ? 'password' : 'text'}
                  value={login[name]}
                  onChange={(e) => setLogin({ ...login, [name]: e.target.value })}
                  autoComplete={
                    name === 'totp'
                      ? 'one-time-code'
                      : name === 'password'
                        ? 'current-password'
                        : 'username'
                  }
                  required
                />
              </Field>
            ))}
            {error && <Notice error>{error}</Notice>}
            <Button disabled={busy} className="w-full">
              安全登录
            </Button>
          </form>
        </Card>
        <p className="mt-5 text-xs text-muted-foreground">
          首位管理员由部署命令创建。普通用户账户无法进入后台。
        </p>
      </main>
    );
  const columns = Object.keys(listRows[0] ?? {}).slice(0, 9);
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      <aside className="border-r border-border bg-white p-5 lg:sticky lg:top-0 lg:h-screen lg:overflow-y-auto">
        <a href="#overview" className="mb-7 flex items-center gap-3 px-3 text-lg font-semibold">
          <Layers3 className="text-primary" />
          织云 <span className="text-xs font-normal text-muted-foreground">ADMIN</span>
        </a>
        <Badge className="mx-3 mb-5 text-primary">模拟测试环境</Badge>
        <nav className="grid grid-cols-2 gap-1 lg:grid-cols-1">
          {sections
            .filter(([s]) => roleSections[staff.role]?.includes(s!))
            .map(([s, label]) => (
              <a
                href={`#${s}`}
                key={s}
                className={`rounded-md px-3 py-2.5 text-sm ${section === s ? 'bg-primary text-white' : 'text-muted-foreground hover:bg-muted'}`}
              >
                {label}
              </a>
            ))}
        </nav>
      </aside>
      <div className="min-w-0">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-white px-8 py-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Activity size={16} />
            <span>商业服务控制台</span>
          </div>
          <div className="flex items-center gap-3">
            <Badge>{staff.role}</Badge>
            <Button variant="ghost" onClick={() => void submit(`${p}/logout`, {})}>
              <LogOut size={16} />
              退出
            </Button>
          </div>
        </header>
        <main className="space-y-7 p-6 lg:p-8">
          <div className="flex flex-wrap justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold">
                {sections.find(([s]) => s === section)?.[1]}
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                {section === 'models'
                  ? '模型配置与积分费率采用不可变版本，测试后才允许商品使用。'
                  : section === 'prices'
                    ? '价格、每月积分与可用模型配置完整后，才能发布测试商品。'
                    : section === 'requests'
                      ? '不明调用保留预占。核查并补偿释放后，不会重新发起上游调用。'
                      : '查询服务端事实，所有管理操作按角色校验并记录审计。'}
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => {
                void load();
                list.refresh();
              }}
            >
              <RefreshCw size={16} />
              刷新
            </Button>
          </div>
          {error && <Notice error>{error}</Notice>}
          {message && <Notice>{message}</Notice>}
          {section === 'overview' && (
            <>
              <Notice>模拟支付，不会实际扣款。测试订阅和积分不能访问生产模型池。</Notice>
              <div className="grid gap-5 md:grid-cols-3">
                {[
                  ['PostgreSQL', rows[0]?.database ?? '检查中'],
                  ['Redis', rows[0]?.cache ?? '检查中'],
                  ['支付模式', rows[0]?.payments ?? '检查中'],
                ].map(([name, value]) => (
                  <Card key={String(name)}>
                    <p className="text-sm text-muted-foreground">{String(name)}</p>
                    <p className="mt-3 text-2xl font-semibold">{String(value)}</p>
                  </Card>
                ))}
              </div>
              <Card>
                <h2 className="text-lg font-semibold">测试商品发布顺序</h2>
                <ol className="mt-5 grid gap-4 text-sm md:grid-cols-4">
                  {[
                    ['models', '1. 创建并测试模型'],
                    ['prices', '2. 配置价格与月积分'],
                    ['prices', '3. 发布测试商品'],
                    ['simulation', '4. 验证模拟支付'],
                  ].map(([s, label]) => (
                    <li key={label}>
                      <a className="text-primary" href={`#${s}`}>
                        {label} →
                      </a>
                    </li>
                  ))}
                </ol>
              </Card>
            </>
          )}
          {section !== 'overview' && section !== 'simulation' && (
            <Card>
              <div className="mb-5 space-y-4">
                <h2 className="font-semibold">记录历史</h2>
                <CloudListControls list={list} />
              </div>
              {listRows.length ? (
                <Table>
                  <thead>
                    <tr>
                      {columns.map((col) => (
                        <th key={col}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {listRows.map((row) => (
                      <tr key={String(row.id)}>
                        {columns.map((col) => (
                          <td key={col} className="max-w-72 break-all text-xs">
                            {typeof row[col] === 'object'
                              ? JSON.stringify(row[col])
                              : String(row[col] ?? '—')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ) : !list.loading && !list.error ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  暂无记录。操作完成后可刷新查看。
                </p>
              ) : null}
            </Card>
          )}
          {section === 'simulation' && (
            <Notice>
              模拟支付，不会实际扣款。延迟与超时未知场景由持久任务查询恢复，两个渠道使用相同领域处理入口。
            </Notice>
          )}
          <div className="grid gap-6 xl:grid-cols-2">
            {(operations[section] ?? []).map((op) => (
              <OperationForm
                key={op.title}
                operation={op}
                busy={busy}
                onSubmit={(body) => submit(op.path, body)}
              />
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
function OperationForm({
  operation,
  busy,
  onSubmit,
}: {
  operation: Operation;
  busy: boolean;
  onSubmit: (body: unknown) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(operation.fields.map((f) => [f.key, f.value ?? f.options?.[0] ?? ''])),
  );
  function send(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    for (const field of operation.fields) {
      const value = values[field.key] ?? '';
      if ((field.key === 'baseUrl' || field.key === 'keyRef') && !value) continue;
      body[field.key] =
        field.type === 'number'
          ? Number(value)
          : field.key === 'modelIds'
            ? value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
            : field.key === 'published'
              ? value === 'true'
              : value;
    }
    void onSubmit(body);
  }
  return (
    <Card>
      <h2 className="mb-5 text-lg font-semibold">{operation.title}</h2>
      <form className="space-y-4" onSubmit={send}>
        {operation.fields.map((field) => (
          <Field key={field.key} label={field.label}>
            {field.options ? (
              <select
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                value={values[field.key]}
                onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
              >
                {field.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            ) : (
              <Input
                type={field.type ?? 'text'}
                value={values[field.key]}
                onChange={(e) => setValues({ ...values, [field.key]: e.target.value })}
                required={!['baseUrl', 'keyRef'].includes(field.key)}
              />
            )}
          </Field>
        ))}
        <Button disabled={busy}>{busy ? '处理中…' : '提交操作'}</Button>
      </form>
    </Card>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Admin />
  </StrictMode>,
);
