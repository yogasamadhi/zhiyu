import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  runtimeClient,
  type CrawlerAssistantConversation,
  type CrawlerAssistantDraft,
} from '@zhiyun/client';
import { Badge, Button, Card, ErrorNotice } from '../components/ui.js';

export function CrawlerAssistantPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [streaming, setStreaming] = useState('');
  const [toolStatus, setToolStatus] = useState<string[]>([]);
  const [error, setError] = useState('');
  const messageEnd = useRef<HTMLDivElement>(null);
  const conversations = useQuery({
    queryKey: ['crawler-assistant', 'conversations'],
    queryFn: () => runtimeClient.listCrawlerAssistantConversations(),
  });
  const detail = useQuery({
    queryKey: ['crawler-assistant', 'conversation', selectedId],
    queryFn: () => runtimeClient.getCrawlerAssistantConversation(selectedId!),
    enabled: Boolean(selectedId),
    refetchInterval: selectedId ? 2_000 : false,
  });
  const provider = useQuery({
    queryKey: ['ai-provider'],
    queryFn: () => runtimeClient.getAiProviderSettings(),
  });

  useEffect(() => {
    if (!selectedId && conversations.data?.items[0]) setSelectedId(conversations.data.items[0].id);
  }, [conversations.data, selectedId]);

  useEffect(
    () =>
      runtimeClient.onRealtimeEvent((event) => {
        const conversationId = event.payload.conversationId;
        if (conversationId !== selectedId) return;
        if (event.type === 'ai.turn.delta' && typeof event.payload.delta === 'string') {
          setStreaming((current) => current + event.payload.delta);
        }
        if (event.type === 'ai.tool.status') {
          const name = String(event.payload.name ?? 'tool');
          const status = String(event.payload.status ?? 'running');
          setToolStatus((items) => [...items.slice(-7), `${toolLabel(name)} · ${status}`]);
        }
        if (event.type === 'ai.draft.updated' || event.type === 'ai.turn.status') {
          void queryClient.invalidateQueries({
            queryKey: ['crawler-assistant', 'conversation', selectedId],
          });
          if (event.type === 'ai.turn.status' && event.payload.status !== 'running') {
            setStreaming('');
          }
        }
      }),
    [queryClient, selectedId],
  );

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [detail.data, streaming]);

  const refresh = async (id = selectedId) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['crawler-assistant', 'conversations'] }),
      id
        ? queryClient.invalidateQueries({ queryKey: ['crawler-assistant', 'conversation', id] })
        : Promise.resolve(),
    ]);
  };
  const create = useMutation({
    mutationFn: () => runtimeClient.createCrawlerAssistantConversation(),
    onSuccess: async ({ conversation }) => {
      setSelectedId(conversation.id);
      setToolStatus([]);
      setStreaming('');
      await refresh(conversation.id);
    },
    onError: mutationError(setError),
  });
  const send = useMutation({
    mutationFn: () => runtimeClient.postCrawlerAssistantMessage(selectedId!, content.trim()),
    onSuccess: async () => {
      setContent('');
      setStreaming('');
      setToolStatus([]);
      await refresh();
    },
    onError: mutationError(setError),
  });
  const selectSite = useMutation({
    mutationFn: (url: string) =>
      runtimeClient.selectCrawlerAssistantSite(selectedId!, url, detail.data!.draft!.revision),
    onSuccess: () => refresh(),
    onError: mutationError(setError),
  });
  const testDraft = useMutation({
    mutationFn: (draft: CrawlerAssistantDraft) =>
      runtimeClient.testCrawlerAssistantDraft(selectedId!, draft.revision),
    onSuccess: () => refresh(),
    onError: mutationError(setError),
  });
  const commit = useMutation({
    mutationFn: (draft: CrawlerAssistantDraft) =>
      runtimeClient.commitCrawlerAssistantDraft(selectedId!, draft.revision),
    onSuccess: ({ taskId }) => navigate(`/tasks/${taskId}`),
    onError: mutationError(setError),
  });
  const cancel = useMutation({
    mutationFn: (turnId: string) => runtimeClient.cancelCrawlerAssistantTurn(turnId),
    onSuccess: () => refresh(),
    onError: mutationError(setError),
  });
  const retry = useMutation({
    mutationFn: (turnId: string) => runtimeClient.retryCrawlerAssistantTurn(turnId),
    onSuccess: () => refresh(),
    onError: mutationError(setError),
  });
  const archive = useMutation({
    mutationFn: (id: string) => runtimeClient.archiveCrawlerAssistantConversation(id),
    onSuccess: async () => {
      setSelectedId(null);
      await refresh(null);
    },
    onError: mutationError(setError),
  });
  const remove = useMutation({
    mutationFn: (id: string) => runtimeClient.deleteCrawlerAssistantConversation(id),
    onSuccess: async () => {
      setSelectedId(null);
      await refresh(null);
    },
    onError: mutationError(setError),
  });

  const draft = detail.data?.draft ?? null;
  const status = detail.data?.conversation.status;
  const lastMessage = detail.data?.messages.at(-1);
  const activeTurnId = lastMessage?.role === 'user' ? lastMessage.turnId : null;
  const busy =
    lastMessage?.role === 'user' && !['failed', 'committed', 'archived'].includes(status ?? '');
  const previewColumns = useMemo(
    () =>
      [...new Set(draft?.draft.preview.flatMap((record) => Object.keys(record.data)) ?? [])].slice(
        0,
        8,
      ),
    [draft],
  );

  return (
    <div className="assistant-page">
      <div className="page-heading assistant-heading">
        <div>
          <span className="eyebrow">Crawler Assistant</span>
          <h1>对话创建爬虫</h1>
          <p>说清楚目标，逐步确认站点、规则和预览；任务只会在你点击确认卡后创建。</p>
        </div>
        <Button onClick={() => create.mutate()} disabled={create.isPending}>
          {create.isPending ? '创建中…' : '新会话'}
        </Button>
      </div>
      <ErrorNotice message={error || (conversations.error as Error | undefined)?.message || ''} />
      {provider.data && !provider.data.configured ? (
        <div className="notice assistant-provider-notice">
          <div>
            <strong>演示模式</strong>
            <p>尚未配置真实模型，历史与草稿仍可查看，但发送消息已禁用。</p>
          </div>
          <Button className="button-secondary" onClick={() => void navigate('/settings')}>
            前往设置
          </Button>
        </div>
      ) : null}

      <div className="assistant-layout">
        <aside className="assistant-history card">
          <div className="assistant-panel-title">
            <h2>会话</h2>
            <Badge>{conversations.data?.items.length ?? 0}</Badge>
          </div>
          <div className="assistant-history-list">
            {conversations.data?.items.map((conversation) => (
              <button
                key={conversation.id}
                className={`assistant-history-item ${selectedId === conversation.id ? 'active' : ''}`}
                onClick={() => {
                  setSelectedId(conversation.id);
                  setStreaming('');
                  setToolStatus([]);
                }}
              >
                <strong>{conversation.title}</strong>
                <span>{statusLabel(conversation.status)}</span>
              </button>
            ))}
            {!conversations.isPending && conversations.data?.items.length === 0 ? (
              <p className="empty-small">还没有会话，先新建一个。</p>
            ) : null}
          </div>
          {detail.data ? (
            <div className="assistant-history-actions">
              <Button
                className="button-ghost"
                onClick={() => archive.mutate(detail.data!.conversation.id)}
              >
                归档
              </Button>
              <Button
                className="button-danger"
                onClick={() => remove.mutate(detail.data!.conversation.id)}
              >
                删除
              </Button>
            </div>
          ) : null}
        </aside>

        <section className="assistant-chat card">
          <div className="assistant-panel-title">
            <h2>{detail.data?.conversation.title ?? '选择一个会话'}</h2>
            {status ? (
              <Badge tone={status === 'failed' ? 'danger' : 'neutral'}>{statusLabel(status)}</Badge>
            ) : null}
          </div>
          <div className="assistant-messages" aria-live="polite">
            {detail.data?.messages.map((message) => (
              <article key={message.id} className={`assistant-message ${message.role}`}>
                <small>{message.role === 'user' ? '你' : 'AI 助手'}</small>
                <p>{message.content}</p>
              </article>
            ))}
            {streaming ? (
              <article className="assistant-message assistant streaming">
                <small>AI 助手 · 生成中</small>
                <p>{streaming}</p>
              </article>
            ) : null}
            {toolStatus.length > 0 ? (
              <div className="assistant-tool-log">
                {toolStatus.map((item, index) => (
                  <span key={`${item}-${index}`}>{item}</span>
                ))}
              </div>
            ) : null}
            <div ref={messageEnd} />
          </div>
          <form
            className="assistant-composer"
            onSubmit={(event) => {
              event.preventDefault();
              if (content.trim() && selectedId) send.mutate();
            }}
          >
            <textarea
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="例如：采集这个商品列表的名称、价格和详情链接，每天早上 9 点运行…"
              rows={3}
              disabled={!selectedId || !provider.data?.configured || busy || send.isPending}
            />
            <div className="assistant-composer-actions">
              <small>不在聊天中输入账号、密码、Cookie 或 Token。</small>
              <div className="assistant-composer-buttons">
                {busy && activeTurnId ? (
                  <Button
                    type="button"
                    className="button-secondary"
                    onClick={() => cancel.mutate(activeTurnId)}
                    disabled={cancel.isPending}
                  >
                    取消
                  </Button>
                ) : null}
                {status === 'failed' && activeTurnId ? (
                  <Button
                    type="button"
                    className="button-secondary"
                    onClick={() => retry.mutate(activeTurnId)}
                    disabled={retry.isPending}
                  >
                    {retry.isPending ? '重试中…' : '重试 Turn'}
                  </Button>
                ) : null}
                <Button
                  type="submit"
                  disabled={
                    !content.trim() ||
                    !selectedId ||
                    !provider.data?.configured ||
                    busy ||
                    status === 'failed'
                  }
                >
                  {busy ? 'AI 正在处理…' : '发送'}
                </Button>
              </div>
            </div>
          </form>
        </section>

        <aside className="assistant-draft">
          <DraftPanel
            draft={draft}
            conversation={detail.data?.conversation ?? null}
            previewColumns={previewColumns}
            onSelectSite={(url) => selectSite.mutate(url)}
            onTest={() => draft && testDraft.mutate(draft)}
            onCommit={() => draft && commit.mutate(draft)}
            testing={testDraft.isPending}
            committing={commit.isPending || Boolean(busy)}
          />
        </aside>
      </div>
    </div>
  );
}

function DraftPanel(props: {
  draft: CrawlerAssistantDraft | null;
  conversation: CrawlerAssistantConversation | null;
  previewColumns: string[];
  onSelectSite(url: string): void;
  onTest(): void;
  onCommit(): void;
  testing: boolean;
  committing: boolean;
}) {
  const value = props.draft?.draft;
  if (!value)
    return (
      <Card>
        <p>草稿会实时显示在这里。</p>
      </Card>
    );
  return (
    <>
      {value.siteCandidates.length > 0 && !value.selectedSiteUrl ? (
        <Card>
          <span className="eyebrow">实验性站点发现</span>
          <h2>选择公开站点</h2>
          <p>搜索摘要可能不准确；只有你确认后才会访问页面。</p>
          <div className="site-candidates">
            {value.siteCandidates.map((candidate) => (
              <button key={candidate.url} onClick={() => props.onSelectSite(candidate.url)}>
                <strong>{candidate.title}</strong>
                <span>{candidate.url}</span>
                <small>{candidate.summary}</small>
              </button>
            ))}
          </div>
        </Card>
      ) : null}
      <Card>
        <div className="assistant-panel-title">
          <h2>任务草稿</h2>
          <Badge>r{props.draft!.revision}</Badge>
        </div>
        <dl className="draft-summary">
          <dt>名称</dt>
          <dd>{value.name || '待补充'}</dd>
          <dt>URL</dt>
          <dd className="break-all">{value.startUrl || '待确认'}</dd>
          <dt>采集目标</dt>
          <dd>{value.instruction || '待补充'}</dd>
          <dt>调度</dt>
          <dd>{scheduleLabel(value.schedule)}</dd>
          <dt>分页</dt>
          <dd>{String(value.pagination.type ?? 'none')}</dd>
          <dt>模式</dt>
          <dd>{value.browserEnabled ? '浏览器' : 'HTTP 优先'}</dd>
        </dl>
        {value.loginRequired ? (
          <div className="notice notice-warning">
            检测到登录墙。请先创建任务，再到任务编辑页配置 Login Session；聊天不会读取登录凭据。
          </div>
        ) : null}
      </Card>
      <Card>
        <div className="assistant-panel-title">
          <h2>规则与测试</h2>
          <Badge tone={value.rule ? 'success' : 'neutral'}>
            {value.rule ? '已生成' : '待生成'}
          </Badge>
        </div>
        {value.rule ? (
          <details>
            <summary>查看 CrawlPlan</summary>
            <pre className="assistant-rule-json">{JSON.stringify(value.rule, null, 2)}</pre>
          </details>
        ) : (
          <p>AI 分析页面后会生成强类型规则。</p>
        )}
        {value.rule ? (
          <Button className="button-secondary" onClick={props.onTest} disabled={props.testing}>
            {props.testing ? '测试中…' : '重新测试'}
          </Button>
        ) : null}
      </Card>
      <Card>
        <div className="assistant-panel-title">
          <h2>数据预览</h2>
          <Badge>{value.preview.length}/10</Badge>
        </div>
        {value.preview.length > 0 ? (
          <div className="assistant-preview-scroll">
            <table>
              <thead>
                <tr>
                  {props.previewColumns.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {value.preview.map((record, index) => (
                  <tr key={`${record.sourceUrl}-${index}`}>
                    {props.previewColumns.map((column) => (
                      <td key={column}>{cell(record.data[column])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p>规则测试后最多展示 10 条公开数据。</p>
        )}
      </Card>
      {props.conversation &&
      ['awaiting_confirmation', 'committing', 'failed'].includes(props.conversation.status) &&
      value.confirmationPresentedAt ? (
        <Card className="assistant-confirm-card">
          <span className="eyebrow">最终确认</span>
          <h2>创建任务与初始规则？</h2>
          <p>将按当前 r{props.draft!.revision} 草稿原子创建，重复点击不会产生重复任务。</p>
          <Button onClick={props.onCommit} disabled={props.committing}>
            {props.committing
              ? '创建中…'
              : props.conversation.status === 'awaiting_confirmation'
                ? '确认创建'
                : '恢复创建'}
          </Button>
        </Card>
      ) : null}
    </>
  );
}

function mutationError(setError: (message: string) => void) {
  return (reason: Error) => setError(reason.message);
}
function statusLabel(status: CrawlerAssistantConversation['status']): string {
  return (
    {
      active: '对话中',
      awaiting_site_confirmation: '等待选站',
      draft_ready: '草稿就绪',
      testing: '测试中',
      awaiting_confirmation: '等待确认',
      committing: '创建中',
      committed: '已创建',
      failed: '失败',
      archived: '已归档',
    } as const
  )[status];
}
function toolLabel(name: string): string {
  return (
    (
      {
        search_sites: '搜索站点',
        inspect_page: '分析页面',
        update_task_draft: '更新草稿',
        generate_rule: '生成规则',
        test_rule: '测试规则',
        present_draft: '准备确认卡',
      } as Record<string, string>
    )[name] ?? name
  );
}
function scheduleLabel(value: Record<string, unknown>): string {
  return value.mode === 'cron' ? `${String(value.cron)} · ${String(value.timezone)}` : '手动';
}
function cell(value: unknown): string {
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}
