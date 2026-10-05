'use client';
import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import {
  ArrowUpRight,
  Check,
  Database,
  Fingerprint,
  Layers3,
  Monitor,
  Sparkles,
  Zap,
  ArrowRight,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  Notice,
  Table,
  CloudListControls,
  useCloudList,
} from '@zhiyun/cloud-ui';
import { request, type ApiPath } from '@zhiyun/cloud-client';
type Row = Record<string, unknown>;
type Price = {
  id: string;
  config: {
    name: string;
    cycle: 'month' | 'year';
    amountFen: number;
    credits: number;
    modelIds: string[];
  };
};
type Account = {
  id: string;
  csrf: string;
  balance: { available: number; reserved: number; expiresAt: string | null };
  identities: { target: string }[];
  terms: Row[];
  agreements: Row[];
};
const base = '/api/cloud/v1';
const nav = [
  ['', '概览'],
  ['pricing', '订阅价格'],
  ['download', '下载桌面端'],
  ['docs', '使用指南'],
];
const accountNav = [
  ['account', '账户概览'],
  ['account/subscription', '我的订阅'],
  ['account/orders', '订单记录'],
  ['account/credits', '积分用量'],
  ['account/devices', '设备管理'],
  ['account/security', '安全设置'],
];
const errors: Record<string, string> = {
  UNAUTHENTICATED: '请先登录织云账户。',
  INVALID_CREDENTIALS: '邮箱或密码不正确。',
  INVALID_CHALLENGE: '验证码无效、已使用或已过期。',
  IDENTITY_ALREADY_BOUND: '该身份已绑定其他账户，不会自动合并。',
  INSUFFICIENT_CREDITS: '本月托管积分不足。可以手动切换为自带 Key。',
  DEVICE_LIMIT: '已达到 2 台托管设备上限，请先解绑旧设备。',
  END_OLD_AGREEMENT_FIRST: '请先取消现有自动续费协议，再切换渠道。',
};
const fmt = (v: unknown) =>
  v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
export function Portal({ page }: { page: string }) {
  const [ready, setReady] = useState(false);
  const [account, setAccount] = useState<Account | null>(null),
    [prices, setPrices] = useState<Price[]>([]),
    [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [channel, setChannel] = useState<'mock-wechat' | 'mock-alipay'>('mock-wechat');
  const [challenge, setChallenge] = useState(''),
    [target, setTarget] = useState(''),
    [code, setCode] = useState(''),
    [pass, setPass] = useState(''),
    [purpose, setPurpose] = useState('verify');
  const [creditView, setCreditView] = useState<'credits' | 'usage'>('credits');
  const listPath =
    page === 'account/orders'
      ? '/me/orders'
      : page === 'account/credits'
        ? (`/me/${creditView}` as const)
        : page === 'account/devices'
          ? '/me/devices'
          : page === 'account/security'
            ? '/me/sessions'
            : null;
  const list = useCloudList(listPath, account?.id);
  const rows = list.items;
  async function load() {
    try {
      setPrices((await request<{ prices: Price[] }>(`${base}/catalog`)).prices);
    } catch {
      setError('云端暂时不可用，本地工作台与自带 Key 功能不受影响。');
    }
    try {
      setAccount(await request<Account>(`${base}/me`));
    } catch {
      setAccount(null);
    }
    setReady(true);
  }
  useEffect(() => {
    setCreditView('credits');
    void load();
  }, [page]);
  async function action(fn: () => Promise<unknown>, message = '已完成') {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      await fn();
      setNotice(message);
      await load();
      list.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : '操作失败';
      setError(errors[message] ?? message);
    } finally {
      setBusy(false);
    }
  }
  const post = async (path: ApiPath, body: unknown) => {
    let csrf = account?.csrf;
    if (!csrf)
      try {
        csrf = (await request<Account>(`${base}/me`)).csrf;
      } catch {
        /* anonymous auth */
      }
    return request(path, body, csrf);
  };
  async function buy(price: Price) {
    await action(async () => {
      const order = (await post(`${base}/billing/orders`, {
        priceId: price.id,
        channel,
        key: crypto.randomUUID(),
      })) as { id: string };
      location.href = `/checkout?order=${order.id}`;
    }, '已创建模拟订单');
  }
  function authForm(security = false) {
    return (
      <Card className="space-y-5">
        <h2 className="text-xl font-semibold">
          {security ? '验证并绑定手机号或邮箱' : '登录你的织云账户'}
        </h2>
        <p className="text-sm text-muted-foreground">
          账户用于托管 AI、订阅与设备管理。桌面本地功能无需登录。
        </p>
        <form
          className="space-y-4"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void action(async () => {
              await post(`${base}/auth/login`, { email: target, password: pass });
            }, '登录成功');
          }}
        >
          <Field label="邮箱或中国大陆手机号">
            <Input
              disabled={!ready}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              autoComplete="username"
              required
              placeholder="you@example.com / 13800138000"
            />
          </Field>
          <Field label="密码（邮箱注册、找回密码至少 12 位）">
            <Input
              disabled={!ready}
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              type="password"
              autoComplete="current-password"
            />
          </Field>
          {!security && (
            <Button disabled={!ready || busy} type="submit">
              邮箱密码登录
            </Button>
          )}
        </form>
        <div className="border-t border-border pt-4 space-y-4">
          {!security && (
            <Field label="验证码用途">
              <select
                className="h-10 rounded-md border border-input px-3"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
              >
                <option value="verify">邮箱注册 / 验证</option>
                <option value="login">手机号验证码登录</option>
                <option value="reset">找回邮箱密码</option>
              </select>
            </Field>
          )}
          <Button
            variant="outline"
            disabled={!ready || busy || !target}
            onClick={() =>
              void action(async () => {
                const c = (await post(`${base}/auth/challenges`, {
                  target,
                  purpose: security ? 'bind' : purpose,
                })) as { challengeId: string };
                setChallenge(c.challengeId);
              }, '验证码请求已提交；开发环境请在测试收件箱查看。')
            }
          >
            获取验证码
          </Button>
          {challenge && (
            <>
              <Field label="6 位验证码">
                <Input
                  disabled={!ready}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                />
              </Field>
              <Button
                disabled={!ready || busy}
                onClick={() =>
                  void action(
                    async () => {
                      await post(`${base}/auth/verify`, {
                        challengeId: challenge,
                        code,
                        ...(pass ? { password: pass } : {}),
                      });
                      setChallenge('');
                    },
                    security ? '身份已安全绑定' : '验证成功',
                  )
                }
              >
                验证{security ? '并绑定' : '并登录'}
              </Button>
            </>
          )}
        </div>
      </Card>
    );
  }
  const pricing = (
    <>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div>
          <Badge>托管 AI 订阅</Badge>
          <h1 className="mt-4 text-3xl font-semibold">把精力留给数据与发现</h1>
          <p className="mt-3 text-muted-foreground">
            月付或年付，每月获得独立积分额度。未用积分不结转。
          </p>
        </div>
        <select
          aria-label="模拟支付渠道"
          value={channel}
          onChange={(e) => setChannel(e.target.value as typeof channel)}
          className="h-10 rounded-md border border-input px-3"
        >
          <option value="mock-wechat">模拟微信</option>
          <option value="mock-alipay">模拟支付宝</option>
        </select>
      </div>
      <Notice>模拟支付，不会实际扣款。测试积分仅可用于测试模型池。</Notice>
      <div className="mt-6 grid gap-6 md:grid-cols-3">
        <Card className="space-y-5">
          <Badge>始终免费</Badge>
          <h2 className="text-2xl font-semibold">本地工作台</h2>
          <p className="text-4xl font-semibold">¥ 0</p>
          <ul className="space-y-3 text-sm">
            {[
              '网页采集、清洗与导出',
              '统计分析与语料处理',
              '定时任务与本地数据管理',
              '自带 API Key 使用 AI 助手',
            ].map((s) => (
              <li key={s} className="flex gap-2">
                <Check size={16} />
                {s}
              </li>
            ))}
          </ul>
          <Button asChild variant="outline">
            <Link href="/download">下载桌面端</Link>
          </Button>
        </Card>
        {prices.map((p) => (
          <Card key={p.id} className="space-y-5 border-primary/40">
            <Badge>{p.config.cycle === 'year' ? '年付 · 逐月积分' : '月付订阅'}</Badge>
            <h2 className="text-2xl font-semibold">{p.config.name}</h2>
            <p>
              <strong className="text-4xl">¥ {(p.config.amountFen / 100).toFixed(2)}</strong>
              <span className="text-muted-foreground">
                {' '}
                / {p.config.cycle === 'year' ? '年' : '月'}
              </span>
            </p>
            <p>每月 {p.config.credits.toLocaleString()} 积分</p>
            <p className="text-sm text-muted-foreground">
              平台托管模型 · 最多 2 台在线校验设备
              <br />
              本月积分用尽后，续费增加下一服务期。
            </p>
            <Button
              disabled={!ready || busy}
              onClick={() => (account ? void buy(p) : location.assign('/login'))}
            >
              模拟购买 <ArrowUpRight size={16} />
            </Button>
            {account && (
              <Button
                variant="outline"
                disabled={!ready || busy}
                onClick={() =>
                  void action(async () => {
                    const a = (await post(`${base}/billing/agreements`, {
                      priceId: p.id,
                      channel,
                    })) as { id: string };
                    await post(`${base}/simulation/agreement`, { id: a.id });
                  }, '已模拟签约，可在订阅页取消未来扣款')
                }
              >
                模拟签约自动续费
              </Button>
            )}
          </Card>
        ))}
      </div>
      {!prices.length && (
        <p className="mt-6 text-sm text-muted-foreground">
          托管订阅尚未开放。管理员配置价格、月积分和可用模型后发布测试商品。
        </p>
      )}
    </>
  );
  return (
    <>
      <header className="border-b border-border bg-white/95">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 px-6 py-5">
          <Link href="/" className="flex items-center gap-3 font-semibold text-xl">
            <span className="rounded-lg bg-primary p-2 text-white">
              <Layers3 size={23} />
            </span>
            织云 <span className="text-xs font-normal text-muted-foreground">ZHIYUN</span>
          </Link>
          <nav className="flex flex-wrap gap-6 text-sm">
            {nav.map(([href, label]) => (
              <Link
                key={href}
                href={`/${href}`}
                className={page === href ? 'text-primary font-semibold' : 'text-muted-foreground'}
              >
                {label}
              </Link>
            ))}
          </nav>
          <Button asChild variant="outline">
            <Link href={account ? '/account' : '/login'}>
              {account ? '我的账户' : '登录 / 注册'}
            </Link>
          </Button>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-6 py-10">
        {error && (
          <div className="mb-6">
            <Notice error>{error}</Notice>
          </div>
        )}
        {notice && (
          <div className="mb-6">
            <Notice>{notice}</Notice>
          </div>
        )}
        {page === '' && (
          <>
            <section className="grid items-center gap-14 py-12 lg:grid-cols-[1.1fr_1fr]">
              <div>
                <Badge>你的数据工作，始于本地</Badge>
                <h1 className="mt-7 text-5xl font-semibold leading-[1.2] tracking-tight lg:text-6xl">
                  从网页到洞察，
                  <br />
                  <span className="text-primary">每一步都在掌握。</span>
                </h1>
                <p className="mt-6 max-w-xl text-lg leading-8 text-muted-foreground">
                  用织云采集、整理和分析数据。在自己的电脑上完成工作，按需接入 AI 助手。
                </p>
                <div className="mt-8 flex flex-wrap gap-3">
                  <Button asChild>
                    <Link href="/download">
                      下载免费桌面端 <ArrowRight size={16} />
                    </Link>
                  </Button>
                  <Button asChild variant="outline">
                    <Link href="/pricing">了解托管 AI</Link>
                  </Button>
                </div>
                <p className="mt-5 text-xs text-muted-foreground">
                  本地工具免费 · 自带 Key 免费 · 托管 AI 按需订阅
                </p>
              </div>
              <div className="rounded-2xl border border-border bg-white p-7 shadow-lg shadow-indigo-100/50">
                <div className="flex items-center justify-between border-b border-border pb-5">
                  <div className="flex gap-2">
                    <span className="h-2.5 w-2.5 rounded-full bg-red-300" />
                    <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
                    <span className="h-2.5 w-2.5 rounded-full bg-green-300" />
                  </div>
                  <span className="text-xs text-muted-foreground">织云 · 数据工作流示意</span>
                  <Monitor size={16} />
                </div>
                <div className="grid grid-cols-[30px_1fr] gap-5 pt-7">
                  {[
                    ['01', '采集网页', '浏览器会话与任务，在本机运行。'],
                    ['02', '处理与分析', '清洗数据，构建语料，发现规律。'],
                    ['03', '与 AI 协作', '描述需求，检查建议，在桌面执行。'],
                  ].map(([n, title, text]) => (
                    <div key={n} className="contents">
                      <span className="text-xs text-primary pt-1">{n}</span>
                      <div className="border-b border-border pb-6">
                        <h3 className="font-medium">{title}</h3>
                        <p className="mt-2 text-sm text-muted-foreground">{text}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-6 flex items-center gap-2 text-xs text-primary">
                  <Fingerprint size={15} />
                  数据保存在你的设备上
                </div>
              </div>
            </section>
            <div className="mt-12 grid gap-7 border-t border-border pt-10 md:grid-cols-3">
              {[
                [Database, '本地优先', '采集、定时任务、导出与数据管理始终免费。'],
                [Sparkles, '两种 AI 方式', '使用自己的 Key，或订阅平台托管模型。'],
                [Zap, '透明的月度额度', '每月积分独立发放，按实际模型用量结算。'],
              ].map(([Icon, title, text]) => {
                const I = Icon as typeof Database;
                return (
                  <section key={String(title)}>
                    <I className="text-primary" size={24} />
                    <h2 className="mt-4 font-semibold">{String(title)}</h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{String(text)}</p>
                  </section>
                );
              })}
            </div>
          </>
        )}
        {page === 'pricing' && pricing}
        {page === 'login' && (
          <div className="mx-auto max-w-lg">
            {account ? (
              <Card>
                <h1 className="text-xl font-semibold">已登录</h1>
                <p className="my-4">{account.identities.map((i) => i.target).join(' / ')}</p>
                <Button asChild>
                  <Link href="/account">进入用户中心</Link>
                </Button>
                {typeof window !== 'undefined' &&
                  new URLSearchParams(window.location.search)
                    .get('returnTo')
                    ?.startsWith('/desktop/authorize') && (
                    <Button asChild variant="outline">
                      <a href={new URLSearchParams(window.location.search).get('returnTo')!}>
                        继续授权桌面端
                      </a>
                    </Button>
                  )}
              </Card>
            ) : (
              authForm()
            )}
          </div>
        )}
        {page === 'checkout' && (
          <div className="mx-auto max-w-xl space-y-6">
            <h1 className="text-3xl font-semibold">模拟收银台</h1>
            <Notice>模拟支付，不会实际扣款。不需要扫描二维码或输入支付账户。</Notice>
            <Card className="space-y-4">
              <p className="text-sm text-muted-foreground">
                选择模拟结果。重复或乱序通知将经过服务端相同的履约流程。
              </p>
              {(
                [
                  'success',
                  'failure',
                  'cancel',
                  'delay',
                  'duplicate',
                  'out-of-order',
                  'unknown',
                ] as const
              ).map((scenario, i) => (
                <Button
                  key={scenario}
                  variant={i === 0 ? 'default' : 'outline'}
                  disabled={!ready || busy}
                  onClick={() =>
                    void action(
                      () =>
                        post(`${base}/simulation/payment`, {
                          orderId: new URLSearchParams(location.search).get('order'),
                          scenario,
                        }),
                      [
                        '支付成功',
                        '支付失败',
                        '已取消',
                        '通知延迟 60 秒',
                        '重复通知已提交',
                        '乱序通知已提交',
                        '结果未知，将查询原支付标识',
                      ][i],
                    )
                  }
                >
                  {
                    [
                      '模拟成功',
                      '模拟失败',
                      '模拟取消',
                      '延迟通知',
                      '重复通知',
                      '乱序通知',
                      '超时未知',
                    ][i]
                  }
                </Button>
              ))}
              <p>
                <Link className="text-primary" href="/account/orders">
                  查看订单与履约结果 →
                </Link>
              </p>
            </Card>
          </div>
        )}
        {page.startsWith('account') && (
          <div className="grid gap-8 md:grid-cols-[180px_1fr]">
            <aside className="space-y-2">
              {accountNav.map(([href, label]) => (
                <Link
                  key={href}
                  href={`/${href}`}
                  className={`block rounded-md px-4 py-3 text-sm ${page === href ? 'bg-primary text-white' : 'hover:bg-muted text-muted-foreground'}`}
                >
                  {label}
                </Link>
              ))}
            </aside>
            <div className="min-w-0 space-y-6">
              <h1 className="text-3xl font-semibold">
                {accountNav.find(([href]) => href === page)?.[1] ?? '用户中心'}
              </h1>
              {!account ? (
                <>
                  <Notice>请先登录，查看托管账户与订阅。</Notice>
                  {authForm()}
                </>
              ) : (
                <>
                  {list.path && <CloudListControls list={list} />}
                  {page === 'account' && (
                    <>
                      <p className="text-muted-foreground">
                        {account.identities.map((i) => i.target).join(' / ')}
                      </p>
                      <div className="grid gap-5 md:grid-cols-3">
                        {[
                          ['本月可用积分', account.balance.available.toLocaleString()],
                          ['待结算积分', account.balance.reserved.toLocaleString()],
                          ['托管设备上限', '2 台'],
                        ].map(([title, value]) => (
                          <Card key={title}>
                            <p className="text-sm text-muted-foreground">{title}</p>
                            <p className="mt-3 text-3xl font-semibold">{value}</p>
                          </Card>
                        ))}
                      </div>
                      <Notice>
                        这里显示测试账户权益。离线缓存仅用于展示；托管 AI 每次联网校验。非 AI
                        本地功能与自带 Key 不受订阅限制。
                      </Notice>
                      <Button asChild>
                        <Link href="/pricing">管理托管订阅</Link>
                      </Button>
                    </>
                  )}
                  {page === 'account/subscription' && (
                    <>
                      <Notice>取消自动续费只停止未来收费，已付服务期及合法积分继续有效。</Notice>
                      <h2 className="text-lg font-semibold">已付服务期</h2>
                      <Data rows={account.terms} columns={['starts_at', 'ends_at', 'revoked_at']} />
                      <h2 className="text-lg font-semibold">自动续费协议</h2>
                      {account.agreements.map((a) => (
                        <Card
                          key={String(a.id)}
                          className="flex flex-wrap items-center justify-between gap-3"
                        >
                          <div>
                            <p>
                              {fmt(a.channel)} · {fmt(a.status)}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              下次扣款：{fmt(a.next_at)}
                            </p>
                          </div>
                          {a.status === 'active' && (
                            <Button
                              variant="outline"
                              disabled={!ready || busy}
                              onClick={() =>
                                void action(
                                  () => post(`${base}/billing/agreements/cancel`, { id: a.id }),
                                  '已停止未来自动续费',
                                )
                              }
                            >
                              取消自动续费
                            </Button>
                          )}
                        </Card>
                      ))}
                      <Button asChild variant="outline">
                        <Link href="/pricing">购买 / 提前续费 / 切换月年套餐</Link>
                      </Button>
                    </>
                  )}
                  {page === 'account/orders' && (
                    <>
                      <Notice>模拟支付，不会实际扣款。退款请联系测试运营管理员。</Notice>
                      {!list.loading && !list.error && (
                        <Data rows={rows} columns={['id', 'channel', 'status', 'created_at']} />
                      )}
                    </>
                  )}
                  {page === 'account/credits' && (
                    <>
                      <Notice>
                        流水金额表示可用积分变化。预占会暂时减少可用余额，结算后退回未使用部分；过期积分不结转。
                      </Notice>
                      {!list.loading && !list.error && (
                        <Data
                          rows={rows}
                          columns={
                            creditView === 'credits'
                              ? ['kind', 'amount', 'request_id', 'created_at']
                              : [
                                  'turn_id',
                                  'status',
                                  'input_tokens',
                                  'output_tokens',
                                  'cost',
                                  'created_at',
                                ]
                          }
                        />
                      )}
                      <Button
                        variant="outline"
                        onClick={() =>
                          setCreditView(creditView === 'credits' ? 'usage' : 'credits')
                        }
                      >
                        {creditView === 'credits' ? '查看 AI 请求用量' : '查看积分流水'}
                      </Button>
                    </>
                  )}
                  {page === 'account/devices' && (
                    <>
                      <p className="text-muted-foreground">
                        最多 2 台设备使用托管 AI。解绑立即撤销云端会话，本地功能继续可用。
                      </p>
                      {rows.length ? (
                        rows.map((d) => (
                          <Card key={String(d.id)} className="flex flex-wrap justify-between gap-3">
                            <div>
                              <h2 className="font-medium">{fmt(d.name)}</h2>
                              <p className="mt-1 text-sm text-muted-foreground">
                                {d.revoked_at ? '已解绑' : '已激活'} · {fmt(d.created_at)}
                              </p>
                            </div>
                            {!d.revoked_at && (
                              <Button
                                variant="outline"
                                onClick={() =>
                                  void action(
                                    () => post(`${base}/me/devices/revoke`, { id: d.id }),
                                    '设备已解绑',
                                  )
                                }
                              >
                                解绑设备
                              </Button>
                            )}
                          </Card>
                        ))
                      ) : !list.loading && !list.error ? (
                        <Notice>尚无托管设备。请在 Electron 设置中登录云账户。</Notice>
                      ) : null}
                    </>
                  )}
                  {page === 'account/security' && (
                    <>
                      {authForm(true)}
                      <Card>
                        <h2 className="mb-4 text-lg font-semibold">账户会话</h2>
                        {rows.map((s) => (
                          <div
                            key={String(s.id)}
                            className="flex flex-wrap items-center justify-between gap-3 border-b border-border py-3 text-sm"
                          >
                            <span>
                              {fmt(s.created_at)} · {s.revoked_at ? '已撤销' : '有效'}
                            </span>
                            {!s.revoked_at && (
                              <Button
                                variant="outline"
                                onClick={() =>
                                  void action(
                                    () => post(`${base}/me/sessions/revoke`, { id: s.id }),
                                    '会话已撤销',
                                  )
                                }
                              >
                                撤销会话
                              </Button>
                            )}
                          </div>
                        ))}
                        <Button
                          className="mt-5"
                          variant="outline"
                          onClick={() =>
                            void action(() => post(`${base}/auth/logout`, {}), '已退出云账户')
                          }
                        >
                          退出登录
                        </Button>
                      </Card>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}
        {page === 'desktop/authorize' && (
          <Card className="mx-auto max-w-xl space-y-5">
            <Monitor className="text-primary" size={32} />
            <h1 className="text-2xl font-semibold">连接织云桌面端</h1>
            <p className="text-muted-foreground">
              授权后，桌面主进程将安全保存登录凭证。你的本地文件和自带 API Key 不会上传。
            </p>
            {account ? (
              <Button
                disabled={!ready || busy}
                onClick={() =>
                  void action(async () => {
                    const q = new URLSearchParams(location.search),
                      redirectUri = q.get('redirect_uri') ?? '';
                    const data = (await post(`${base}/desktop/authorize`, {
                      challenge: q.get('code_challenge'),
                      redirectUri,
                      deviceId: q.get('device_id'),
                      deviceName: q.get('device_name') ?? '织云桌面端',
                    })) as { code: string };
                    const u = new URL(redirectUri);
                    u.searchParams.set('code', data.code);
                    u.searchParams.set('state', q.get('state') ?? '');
                    location.assign(u.toString());
                  })
                }
              >
                授权此设备
              </Button>
            ) : (
              <Button
                onClick={() =>
                  location.assign(
                    `/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`,
                  )
                }
              >
                先登录账户
              </Button>
            )}
          </Card>
        )}
        {page === 'download' && (
          <section className="space-y-8">
            <Badge>桌面优先 · 免费开始</Badge>
            <h1 className="text-4xl font-semibold">让数据工作回到你的电脑</h1>
            <p className="text-muted-foreground">
              下载 Electron 桌面端。本地任务、分析和自带 Key 助手不需要云账户。
            </p>
            <div className="grid gap-5 md:grid-cols-3">
              {[
                ['macOS', process.env.NEXT_PUBLIC_DOWNLOAD_MAC],
                ['Windows', process.env.NEXT_PUBLIC_DOWNLOAD_WINDOWS],
                ['Linux', process.env.NEXT_PUBLIC_DOWNLOAD_LINUX],
              ].map(([name, url]) => (
                <Card key={name} className="space-y-4">
                  <Monitor size={30} className="text-primary" />
                  <h2 className="text-xl font-semibold">{name}</h2>
                  {url ? (
                    <Button asChild>
                      <a href={url}>下载安装包</a>
                    </Button>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      安装包尚未发布。开发构建请参阅仓库的桌面打包说明。
                    </p>
                  )}
                </Card>
              ))}
            </div>
          </section>
        )}
        {(page === 'docs' || page === 'changelog') && (
          <article className="mx-auto max-w-3xl space-y-8">
            <h1 className="text-3xl font-semibold">
              {page === 'docs' ? '开始使用织云' : '版本与测试说明'}
            </h1>
            {[
              [
                '1. 在本机完成数据工作',
                '安装桌面端即可采集网页、处理语料、分析数据和导出结果。无需购买订阅。',
              ],
              [
                '2. 选择 AI 服务方式',
                '设置中可选择自带 API Key 或平台托管。自带 Key 保存在本机，直接连接模型服务；托管模式会发送本次调用必要的对话与工具结果。',
              ],
              [
                '3. 测试托管订阅',
                '登录账户并激活设备，在价格页购买已发布的测试套餐。年付逐月发放积分，未用积分到期作废。',
              ],
              [
                '4. 模拟支付阶段',
                '所有支付、签约、自动扣款与退款均为模拟。真实支付、短信、邮件和模型外部联调需要单独记录验收。',
              ],
            ].map(([title, text]) => (
              <section key={title}>
                <h2 className="text-xl font-semibold">{title}</h2>
                <p className="mt-3 leading-7 text-muted-foreground">{text}</p>
              </section>
            ))}
          </article>
        )}
      </main>
      <footer className="mx-auto mt-16 flex max-w-7xl flex-wrap justify-between gap-4 border-t border-border px-6 py-8 text-xs text-muted-foreground">
        <span>织云 ZhiYun · 本地数据，按需 AI</span>
        <div className="flex gap-5">
          <Link href="/changelog">版本说明</Link>
          <span>当前商业服务为模拟测试环境</span>
        </div>
      </footer>
    </>
  );
}
const labels: Record<string, string> = {
  id: '编号',
  channel: '渠道',
  status: '状态',
  created_at: '创建时间',
  starts_at: '开始时间',
  ends_at: '结束时间',
  revoked_at: '撤销时间',
  kind: '类型',
  amount: '积分变化',
  request_id: '请求编号',
  turn_id: '助手回合',
  input_tokens: '输入 Token',
  output_tokens: '输出 Token',
  cost: '实际积分',
};
function Data({ rows, columns }: { rows: Row[]; columns: string[] }) {
  return (
    <Card>
      {rows.length ? (
        <Table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c}>{labels[c] ?? c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                {columns.map((c) => (
                  <td key={c} className="max-w-64 break-all font-mono text-xs">
                    {fmt(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">
          暂无记录。完成相应操作后，记录会显示在这里。
        </p>
      )}
    </Card>
  );
}
