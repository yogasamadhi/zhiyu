'use client';
import { useEffect, useState } from 'react';
import {
  cloudListOptions,
  cloudListQuerySchema,
  requestList,
  type CloudListPath,
  type CloudListQuery,
  type CloudListPage,
} from '@zhiyun/cloud-client';
import { Button, Field, Input, Notice } from './components';

type Row = Record<string, unknown>;
type Draft = { q: string; status: string; from: string; to: string; userId: string };
const emptyDraft = (): Draft => ({ q: '', status: '', from: '', to: '', userId: '' });
const initial = (identity: string, revision = 0) => ({
  identity,
  draft: emptyDraft(),
  query: { limit: 50, q: '' } as CloudListQuery,
  cursors: [''],
  index: 0,
  revision,
  validation: '',
});

/** Filters and cursors belong to one resource and signed-in account. */
export function useCloudList(path: CloudListPath | null, actorId?: string) {
  const identity = path && actorId ? `${actorId}:${path}` : '';
  const [state, setState] = useState(() => initial(identity));
  const [response, setResponse] = useState<{
    key: string;
    page: CloudListPage<Row>;
    loading: boolean;
    error: string;
  }>({ key: '', page: { items: [], nextCursor: null }, loading: false, error: '' });
  useEffect(() => {
    if (state.identity !== identity) setState(initial(identity));
  }, [identity, state.identity]);
  const cursor = state.cursors[state.index] ?? '';
  const key = JSON.stringify([identity, state.query, cursor, state.revision]);
  const enabled = Boolean(identity) && state.identity === identity;
  useEffect(() => {
    if (!enabled || !path) return;
    const controller = new AbortController();
    let active = true;
    setResponse({ key, page: { items: [], nextCursor: null }, loading: true, error: '' });
    void requestList<Row>(
      path,
      { ...state.query, ...(cursor ? { cursor } : {}) },
      controller.signal,
    )
      .then((page) => {
        if (active) setResponse({ key, page, loading: false, error: '' });
      })
      .catch((error: unknown) => {
        if (!active) return;
        const code = error instanceof Error ? error.message : '';
        const message =
          code === 'UNAUTHENTICATED'
            ? '会话已失效，请重新登录。'
            : code === 'FORBIDDEN'
              ? '当前账户无权查看此列表。'
              : code === 'INVALID_CURSOR'
                ? '翻页位置已失效，请清除筛选后重新查询。'
                : '列表加载失败，请重试。';
        setResponse({ key, page: { items: [], nextCursor: null }, loading: false, error: message });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, path, key, state.query, cursor]);
  const current = enabled && response.key === key;
  const loading = Boolean(identity) && (!current || response.loading);
  const page = current ? response.page : { items: [], nextCursor: null };
  function apply() {
    if (!path || !enabled) return;
    try {
      const input: Record<string, string> = { limit: '50', q: state.draft.q };
      for (const field of ['status', 'userId'] as const)
        if (state.draft[field]) input[field] = state.draft[field];
      for (const field of ['from', 'to'] as const)
        if (state.draft[field]) input[field] = new Date(state.draft[field]).toISOString();
      const query = cloudListQuerySchema(path).parse(input) as CloudListQuery;
      setState((previous) => ({
        ...previous,
        query,
        cursors: [''],
        index: 0,
        validation: '',
        revision: previous.revision + 1,
      }));
    } catch {
      setState((previous) => ({
        ...previous,
        validation:
          '请检查筛选条件：文字最多 160 字，用户编号须为 UUID，结束时间不能早于开始时间。',
      }));
    }
  }
  return {
    path,
    draft: state.identity === identity ? state.draft : emptyDraft(),
    items: page.items,
    loading,
    error: current ? response.error : '',
    validation: state.identity === identity ? state.validation : '',
    pageNumber: state.identity === identity ? state.index + 1 : 1,
    canPrevious: enabled && state.index > 0 && !loading,
    canNext: Boolean(page.nextCursor) && !loading,
    edit: (field: keyof Draft, value: string) =>
      setState((previous) => ({
        ...previous,
        draft: { ...previous.draft, [field]: value },
        validation: '',
      })),
    apply,
    clear: () => setState((previous) => initial(identity, previous.revision + 1)),
    refresh: () => setState((previous) => ({ ...previous, revision: previous.revision + 1 })),
    previous: () => {
      if (!loading && state.index > 0)
        setState((previous) => ({ ...previous, index: previous.index - 1 }));
    },
    next: () => {
      if (!loading && page.nextCursor)
        setState((previous) => ({
          ...previous,
          cursors: [...previous.cursors.slice(0, previous.index + 1), page.nextCursor!],
          index: previous.index + 1,
        }));
    },
  };
}

const statusLabels: Record<string, string> = {
  pending: '待处理',
  paid: '已支付',
  failed: '失败',
  canceled: '已取消',
  closed: '已关闭',
  refunded: '已退款',
  grant: '发放',
  reserve: '预占',
  settle: '结算',
  release: '释放',
  expire: '过期',
  adjust: '调整',
  refund: '退款',
  scheduled: '待生效',
  active: '有效',
  expired: '已过期',
  revoked: '已撤销',
  unrevoked: '未撤销',
  reserved: '已预占',
  calling: '调用中',
  settled: '已结算',
  released: '已释放',
  review: '待核查',
  disabled: '已停用',
  enabled: '已启用',
  published: '已发布',
  draft: '草稿',
  confirmed: '已确认',
  owner: '所有者',
  support: '客服',
  finance: '财务',
  operator: '运营',
  running: '执行中',
  done: '已完成',
  canceling: '取消中',
};
export function CloudListControls({ list }: { list: ReturnType<typeof useCloudList> }) {
  if (!list.path) return null;
  const options = cloudListOptions[list.path];
  return (
    <div className="space-y-4">
      <form
        aria-label="记录筛选"
        className="grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          list.apply();
        }}
      >
        <Field label="搜索记录">
          <Input
            placeholder="按编号或内容查询完整历史"
            maxLength={160}
            value={list.draft.q}
            onChange={(event) => list.edit('q', event.target.value)}
          />
        </Field>
        {options.statuses.length > 0 && (
          <Field label={options.statusLabel ?? '状态'}>
            <select
              aria-label={options.statusLabel ?? '状态'}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              value={list.draft.status}
              onChange={(event) => list.edit('status', event.target.value)}
            >
              <option value="">全部</option>
              {options.statuses.map((status) => (
                <option key={status} value={status}>
                  {statusLabels[status] ?? status}
                </option>
              ))}
            </select>
          </Field>
        )}
        {options.userFilter && (
          <Field label="用户编号">
            <Input
              value={list.draft.userId}
              onChange={(event) => list.edit('userId', event.target.value)}
            />
          </Field>
        )}
        {options.timeLabel &&
          (['from', 'to'] as const).map((field) => (
            <Field
              key={field}
              label={`${options.timeLabel} · ${field === 'from' ? '从' : '至'}（本地时间）`}
            >
              <Input
                type="datetime-local"
                step="1"
                value={list.draft[field]}
                onChange={(event) => list.edit(field, event.target.value)}
              />
            </Field>
          ))}
        <div className="flex flex-wrap gap-2">
          <Button type="submit">查询</Button>
          <Button type="button" variant="outline" onClick={list.clear}>
            清除筛选
          </Button>
        </div>
      </form>
      {list.validation && <Notice error>{list.validation}</Notice>}
      {list.error && (
        <Notice error>
          {list.error}{' '}
          <Button type="button" variant="ghost" onClick={list.refresh}>
            重试
          </Button>
        </Notice>
      )}
      <div className="flex flex-wrap items-center gap-3" aria-live="polite">
        <Button
          type="button"
          variant="outline"
          disabled={!list.canPrevious}
          onClick={list.previous}
        >
          上一页
        </Button>
        <span className="text-sm text-muted-foreground">
          {list.loading ? '正在加载记录…' : `第 ${list.pageNumber} 页 · ${list.items.length} 条`}
        </span>
        <Button type="button" variant="outline" disabled={!list.canNext} onClick={list.next}>
          下一页
        </Button>
      </div>
    </div>
  );
}
