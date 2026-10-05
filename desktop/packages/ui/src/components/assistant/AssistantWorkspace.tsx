import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  MessageCircle,
  X,
  ArrowUpRight,
  Send,
  BookOpen,
  Sparkles,
  Globe,
  Lightbulb,
} from 'lucide-react';
import {
  runtimeClient,
  type AssistantAction,
  type AssistantDetail,
  type AssistantLesson,
  type AssistantMessageBlock,
} from '@zhiyun/client';
import { aiCostBudgetSchema, assistantExamplePage, type AssistantContext } from '@zhiyun/shared';
import { useWorkspaceAuth } from '../../auth.js';
import { Button, ErrorNotice } from '../ui.js';
import { AssistantCacheNotice } from '../RuleCacheNotice.js';
import { useAssistant, pageResource } from './AssistantProvider.js';
import { AssistantCostPanel } from './AssistantCostPanel.js';

function useCopy() {
  const { i18n } = useTranslation();
  return (zh: string, en: string) => (i18n.language.startsWith('zh') ? zh : en);
}
export function AssistantHomeEntry() {
  const assistant = useAssistant();
  const text = useCopy();
  const navigate = useNavigate();
  const [goal, setGoal] = useState('');
  if (!assistant.capabilities?.enabled) return null;
  const start = (intent: AssistantContext['intent'], lesson = false) =>
    void assistant.perform(async () => {
      const result = await assistant.start(intent);
      if (lesson)
        await runtimeClient.updateAssistantLesson(
          result.conversation.id,
          result.conversation.revision,
          { lessonId: 'first-table', event: 'start' },
        );
      else if (goal.trim())
        await runtimeClient.postAssistantMessage(result.conversation.id, goal.trim());
      void navigate(`/assistant?conversation=${result.conversation.id}`);
    });
  return (
    <section
      className="assistant-home card"
      aria-labelledby="assistant-home-title"
      data-assistant-anchor="home.assistant"
    >
      <div className="assistant-home-copy">
        <span className="eyebrow">
          <Sparkles size={15} /> {text('织云助手', 'ZhiYun assistant')}
        </span>
        <h2 id="assistant-home-title">
          {text('你想收集什么信息？', 'What would you like to collect?')}
        </h2>
        <p>
          {text(
            '从一个想法开始，我带你找到数据、整理成表格，也可以教你自己操作。',
            'Start with an idea. I can help you find data, build a table, and learn each step.',
          )}
        </p>
      </div>
      <form
        className="assistant-home-form"
        onSubmit={(event) => {
          event.preventDefault();
          start('explore');
        }}
      >
        <label className="sr-only" htmlFor="assistant-home-goal">
          {text('告诉助手你的目标', 'Tell the assistant your goal')}
        </label>
        <input
          id="assistant-home-goal"
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder={text(
            '例如：每天看看几家店的商品价格有没有变化',
            'For example: track product prices across several stores',
          )}
        />
        <Button type="submit" disabled={assistant.pending}>
          <Send size={16} />
          {text('开始聊聊', 'Start chatting')}
        </Button>
      </form>
      <div className="assistant-entry-options">
        <Button
          className="button-secondary"
          disabled={assistant.pending}
          onClick={() => start('collect')}
        >
          <Globe size={17} />
          {text('我有一个网页', 'I have a page')}
        </Button>
        <Button
          className="button-secondary"
          disabled={assistant.pending}
          onClick={() => start('explore')}
        >
          <Lightbulb size={17} />
          {text('我有一个想法', 'I have an idea')}
        </Button>
        <Button
          className="button-secondary"
          disabled={assistant.pending}
          onClick={() => start('learn')}
        >
          <BookOpen size={17} />
          {text('我想先学一下', 'Teach me first')}
        </Button>
        <Button
          className="button-secondary"
          disabled={assistant.pending}
          onClick={() => start('learn', true)}
        >
          <Sparkles size={17} />
          {text('用样例带我体验', 'Try an example')}
        </Button>
      </div>
      <ErrorNotice message={assistant.error} />
    </section>
  );
}
export function AssistantHost() {
  const assistant = useAssistant();
  const text = useCopy();
  const location = useLocation();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!assistant.open) return;
    const previous = document.activeElement;
    panel.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        assistant.setOpen(false);
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.removeEventListener('keydown', keydown);
      requestAnimationFrame(() => {
        if (previous instanceof HTMLElement && previous !== document.body && previous.isConnected)
          previous.focus();
        else document.querySelector<HTMLElement>('[data-assistant-launcher]')?.focus();
      });
    };
  }, [assistant.open]);
  if (!assistant.capabilities?.enabled || location.pathname === '/assistant') return null;
  const resource = pageResource(location.pathname, location.search);
  return (
    <>
      {!assistant.open && (
        <div className="assistant-launcher">
          <Button
            onClick={() => assistant.setOpen(true)}
            aria-label={text('打开织云助手', 'Open ZhiYun assistant')}
            data-assistant-launcher
          >
            <MessageCircle size={18} />
            {text('织云助手', 'Assistant')}
          </Button>
          {resource && (
            <Button className="button-secondary" onClick={() => void assistant.askHere()}>
              {text(
                resource.kind === 'run' ? '帮我检查' : '解释这里',
                resource.kind === 'run' ? 'Check this' : 'Explain this',
              )}
            </Button>
          )}
        </div>
      )}
      {assistant.open && (
        <aside
          className="assistant-drawer"
          ref={panel}
          tabIndex={-1}
          aria-label={text('织云助手侧栏', 'Assistant sidebar')}
        >
          <header className="assistant-drawer-heading">
            <strong>
              <Sparkles size={18} />
              {text('织云助手', 'ZhiYun assistant')}
            </strong>
            <div>
              {resource && (
                <Button
                  className="button-ghost"
                  disabled={assistant.pending || assistant.busy}
                  onClick={() => void assistant.askHere()}
                >
                  {text('帮助当前页面', 'Help with this page')}
                </Button>
              )}
              <Link
                className="button button-ghost"
                to={`/assistant${assistant.selectedId ? `?conversation=${assistant.selectedId}` : ''}`}
                aria-label={text('展开助手', 'Expand assistant')}
              >
                <ArrowUpRight size={18} />
              </Link>
              <Button
                className="button-ghost"
                onClick={() => assistant.setOpen(false)}
                aria-label={text('关闭助手', 'Close assistant')}
              >
                <X size={18} />
              </Button>
            </div>
          </header>
          <AssistantWorkspace compact />
        </aside>
      )}
    </>
  );
}
export function AssistantWorkspace({ compact = false }: { compact?: boolean }) {
  const assistant = useAssistant();
  const text = useCopy();
  const auth = useWorkspaceAuth();
  const navigate = useNavigate();
  const owner = auth.user?.id ?? 'local-workspace';
  const [content, setContent] = useState('');
  const [costMaximum, setCostMaximum] = useState('');
  const [costEstimate, setCostEstimate] = useState('');
  const [costCurrency, setCostCurrency] = useState<'CNY' | 'USD'>('CNY');
  const [older, setOlder] = useState<AssistantDetail['messages']>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [moreHistory, setMoreHistory] = useState<AssistantDetail['conversation'][]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const history = useQuery({
    queryKey: ['assistant', owner, 'history'],
    queryFn: () => runtimeClient.listAssistantConversations(),
    enabled: Boolean(assistant.capabilities?.enabled),
  });
  const lessons = useQuery({
    queryKey: ['assistant', owner, 'lessons', text('zh', 'en')],
    queryFn: () => runtimeClient.listAssistantLessons(text('zh', 'en') as 'zh' | 'en'),
    enabled: Boolean(assistant.capabilities?.enabled),
  });
  const data = assistant.detail;
  const conversation = data?.conversation;
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setOlder([]);
    setBefore(null);
    setContent('');
  }, [assistant.selectedId]);
  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [data?.messages.at(-1)?.id, assistant.streaming]);
  const choose = (id: string) => {
    assistant.select(id);
    if (!compact) void navigate(`/assistant?conversation=${id}`, { replace: true });
  };
  const send = () =>
    void assistant.perform(async () => {
      const message = content.trim();
      if (!message) return;
      const costBudget = costMaximum.trim()
        ? aiCostBudgetSchema.parse({
            maximum: Number(costMaximum),
            perCallEstimate: costEstimate.trim() ? Number(costEstimate) : null,
            currency: costCurrency,
          })
        : undefined;
      const current = conversation ?? (await assistant.start()).conversation;
      await runtimeClient.postAssistantMessage(current.id, message, undefined, costBudget);
      setContent('');
      if (!compact) void navigate(`/assistant?conversation=${current.id}`, { replace: true });
    });
  if (assistant.capabilities && !assistant.capabilities.enabled)
    return (
      <p>
        {text(
          '当前工作区已关闭新助手入口。已有采集任务仍可继续使用。',
          'The new assistant is disabled in this workspace. Existing collection tasks remain available.',
        )}
      </p>
    );
  return (
    <div className={`zhiyun-assistant ${compact ? 'compact' : ''}`}>
      {!compact && (
        <aside className="assistant-history card">
          <div className="section-heading">
            <h2>{text('会话', 'Conversations')}</h2>
            <Button
              className="button-secondary"
              disabled={assistant.pending}
              onClick={() =>
                void assistant.perform(async () => {
                  const created = await assistant.start();
                  choose(created.conversation.id);
                })
              }
            >
              {text('新会话', 'New')}
            </Button>
          </div>
          <div className="assistant-history-list">
            {[...(history.data?.items ?? []), ...moreHistory]
              .filter(
                (item, index, all) => all.findIndex((other) => other.id === item.id) === index,
              )
              .map((item) => (
                <button
                  key={item.id}
                  className={`assistant-history-item ${item.id === assistant.selectedId ? 'active' : ''}`}
                  onClick={() => choose(item.id)}
                >
                  <strong>{item.title}</strong>
                  <span>
                    {item.lifecycle === 'archived'
                      ? text('已归档', 'Archived')
                      : new Date(item.updatedAt).toLocaleDateString()}
                  </span>
                </button>
              ))}
          </div>
          {(historyCursor ?? history.data?.nextCursor) && (
            <Button
              className="button-ghost"
              onClick={() =>
                void assistant.perform(async () => {
                  const next = await runtimeClient.listAssistantConversations(
                    historyCursor ?? history.data?.nextCursor ?? undefined,
                  );
                  setMoreHistory((items) => [...items, ...next.items]);
                  setHistoryCursor(next.nextCursor ?? '');
                })
              }
            >
              {text('更多会话', 'More conversations')}
            </Button>
          )}
          <details className="assistant-course-list">
            <summary>{text('学习与练习', 'Lessons and practice')}</summary>
            {lessons.data?.map((lesson) => (
              <Button
                key={lesson.id}
                className="button-ghost"
                disabled={assistant.pending || assistant.busy}
                onClick={() =>
                  void assistant.perform(async () => {
                    const current = data ?? (await assistant.start('learn'));
                    await runtimeClient.updateAssistantLesson(
                      current.conversation.id,
                      current.conversation.revision,
                      { lessonId: lesson.id, event: 'start' },
                    );
                  })
                }
              >
                {lesson.title}
              </Button>
            ))}
          </details>
        </aside>
      )}
      <section
        className="assistant-conversation card"
        aria-label={text('助手会话', 'Assistant conversation')}
      >
        <header className="assistant-conversation-heading">
          <div>
            <strong>{conversation?.title ?? text('从你的目标开始', 'Start with your goal')}</strong>
            <p className="assistant-target">
              {text('正在帮助：', 'Helping: ')}
              {conversation?.context.resource ? (
                <Link
                  to={href(conversation.context.resource)}
                  onClick={() => assistant.setOpen(false)}
                >
                  {conversation.context.resource.label ??
                    `${conversation.context.resource.kind} · ${conversation.context.resource.id.slice(0, 8)}`}
                </Link>
              ) : (
                text('自由提问与学习', 'Questions and learning')
              )}
            </p>
          </div>
          {conversation && (
            <select
              aria-label={text('助手帮助方式', 'Assistance style')}
              value={conversation.mode}
              disabled={assistant.pending || assistant.busy}
              onChange={(event) =>
                void assistant.perform(() =>
                  runtimeClient.updateAssistantConversation(
                    conversation.id,
                    conversation.revision,
                    { mode: event.target.value as 'guide' | 'do' | 'teach' },
                  ),
                )
              }
            >
              <option value="guide">{text('带我完成', 'Guide me')}</option>
              <option value="do">{text('帮我处理', 'Do it for me')}</option>
              <option value="teach">{text('教我操作', 'Teach me')}</option>
            </select>
          )}
        </header>
        {!assistant.capabilities?.providerConfigured && (
          <div className="notice assistant-fixed-guidance">
            <strong>
              {text('固定引导与离线练习可用', 'Fixed guidance and offline practice available')}
            </strong>
            <span>
              {text(
                '连接模型后可自由聊天，现有进度会保留。',
                'Connect a model for AI chat. Your progress is preserved.',
              )}
            </span>
            <Link
              to={`/settings?section=ai&returnTo=${encodeURIComponent(`/assistant${assistant.selectedId ? `?conversation=${assistant.selectedId}` : ''}`)}`}
              onClick={() => assistant.setOpen(false)}
            >
              {text('连接模型', 'Connect model')}
            </Link>
          </div>
        )}
        <ErrorNotice message={assistant.error} />
        <div className="assistant-message-scroll" aria-label={text('聊天记录', 'Messages')}>
          {!data?.messages.length && (
            <div className="assistant-welcome">
              <Sparkles size={30} />
              <h2>{text('告诉我，你想得到什么数据？', 'What data would you like to get?')}</h2>
              <p>
                {text(
                  '有网址可以直接贴过来。还不知道怎么开始也没关系，我们先聊想法。',
                  'Paste a page if you have one, or describe your idea and we will work through it.',
                )}
              </p>
              <div className="assistant-entry-options">
                <Button
                  className="button-secondary"
                  disabled={assistant.pending}
                  onClick={() =>
                    setContent(
                      text(
                        '我有一个想法，但不知道去哪里找数据。',
                        'I have an idea but do not know where to find data.',
                      ),
                    )
                  }
                >
                  {text('帮我梳理想法', 'Explore my idea')}
                </Button>
                <Button
                  className="button-secondary"
                  disabled={assistant.pending}
                  onClick={() =>
                    void assistant.perform(async () => {
                      const current = data ?? (await assistant.start('learn'));
                      await runtimeClient.updateAssistantLesson(
                        current.conversation.id,
                        current.conversation.revision,
                        { lessonId: 'first-table', event: 'start' },
                      );
                    })
                  }
                >
                  {text('用样例教我', 'Teach me with an example')}
                </Button>
              </div>
            </div>
          )}
          {(before ?? data?.nextCursor) && (
            <Button
              className="button-ghost"
              onClick={() =>
                void assistant.perform(async () => {
                  const result = await runtimeClient.listAssistantMessages(
                    conversation!.id,
                    before ?? data!.nextCursor!,
                  );
                  setOlder((items) => [...result.messages, ...items]);
                  setBefore(result.nextCursor ?? '');
                })
              }
            >
              {text('更早的消息', 'Earlier messages')}
            </Button>
          )}
          {[...older, ...(data?.messages ?? [])]
            .filter(
              (message, index, all) => all.findIndex((item) => item.id === message.id) === index,
            )
            .map((message) => (
              <article key={message.id} className={`assistant-message ${message.role}`}>
                <small>
                  {message.role === 'user'
                    ? text('你', 'You')
                    : text('织云助手', 'ZhiYun assistant')}
                </small>
                {message.content && <p>{message.content}</p>}
                {message.blocks.map((block) => (
                  <MessageBlock key={block.id} block={block} lessons={lessons.data ?? []} />
                ))}
              </article>
            ))}
          {assistant.streaming && (
            <article className="assistant-message assistant streaming">
              <small>{text('正在回复', 'Responding')}</small>
              <p>{assistant.streaming}</p>
            </article>
          )}
          {assistant.busy && (
            <p className="assistant-live-status" role="status">
              {toolLabel(assistant.tool, text)}
            </p>
          )}
          {data?.turn?.status === 'failed' && (
            <div className="notice notice-warning">
              <p>{data.turn.error}</p>
              <Button
                disabled={assistant.pending}
                onClick={() =>
                  void assistant.perform(() => runtimeClient.retryAssistantTurn(data.turn!.id))
                }
              >
                {text('重试这次回复', 'Retry response')}
              </Button>
              <span>
                {text('也可以修改问题继续提问。', 'You can also ask a different question.')}
              </span>
            </div>
          )}
          <AssistantCostPanel
            turn={data?.turn ?? null}
            language={text('zh', 'en') as 'zh' | 'en'}
          />
          <div ref={end} />
        </div>
        {conversation?.lifecycle === 'archived' ? (
          <div className="notice">
            <p>
              {text(
                '这个会话已归档。恢复后可以继续提问。',
                'This conversation is archived. Restore it to continue.',
              )}
            </p>
            <Button
              disabled={assistant.pending}
              onClick={() =>
                void assistant.perform(() =>
                  runtimeClient.updateAssistantConversation(
                    conversation.id,
                    conversation.revision,
                    { lifecycle: 'active' },
                  ),
                )
              }
            >
              {text('恢复会话', 'Restore conversation')}
            </Button>
          </div>
        ) : (
          <form
            className="assistant-composer"
            onSubmit={(event) => {
              event.preventDefault();
              send();
            }}
          >
            <label className="sr-only" htmlFor={`assistant-message-${compact ? 'drawer' : 'page'}`}>
              {text('发送给织云助手', 'Message ZhiYun assistant')}
            </label>
            <textarea
              id={`assistant-message-${compact ? 'drawer' : 'page'}`}
              rows={3}
              maxLength={8000}
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder={text(
                '说说你的目标，或问我这一步怎么操作…',
                'Describe your goal or ask about this step…',
              )}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  if (!assistant.busy) send();
                }
              }}
            />
            <details data-testid="assistant-cost-budget">
              <summary>
                {text('本轮预估上限（可选）', 'Estimated limit for this turn (optional)')}
              </summary>
              <label>
                {text('预估上限', 'Estimated limit')}
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="0.000001"
                  value={costMaximum}
                  onChange={(event) => setCostMaximum(event.target.value)}
                  disabled={assistant.busy}
                />
              </label>
              <label>
                {text('每次 AI 调用估价', 'Estimate per AI call')}
                <input
                  type="number"
                  min="0"
                  max="10000"
                  step="0.000001"
                  value={costEstimate}
                  onChange={(event) => setCostEstimate(event.target.value)}
                  disabled={assistant.busy}
                />
              </label>
              <label>
                {text('币种', 'Currency')}
                <select
                  aria-label={text('币种', 'Currency')}
                  value={costCurrency}
                  onChange={(event) => setCostCurrency(event.target.value as 'CNY' | 'USD')}
                  disabled={assistant.busy}
                >
                  <option value="CNY">CNY</option>
                  <option value="USD">USD</option>
                </select>
              </label>
              <small>
                {text(
                  '估价用于停止追加调用，不代表实际账单。没有估价时，设定上限将停止真实模型请求。',
                  'Estimates stop further calls; they are not bills. A limit without an estimate stops real provider requests.',
                )}
              </small>
            </details>
            <div className="assistant-composer-actions">
              <small>
                {text('不要在聊天中输入密码或凭据。', 'Use protected settings for credentials.')}
              </small>
              {assistant.busy ? (
                <Button
                  type="button"
                  className="button-secondary"
                  disabled={assistant.pending}
                  onClick={() =>
                    void assistant.perform(() =>
                      runtimeClient.cancelAssistantTurn(conversation!.activeTurnId!),
                    )
                  }
                >
                  {text('停止', 'Stop')}
                </Button>
              ) : (
                <Button type="submit" disabled={!content.trim() || assistant.pending}>
                  <Send size={16} />
                  {text('发送', 'Send')}
                </Button>
              )}
            </div>
          </form>
        )}
        {conversation && !assistant.busy && (
          <details className="assistant-conversation-actions">
            <summary>{text('会话管理', 'Manage conversation')}</summary>
            <Button
              className="button-ghost"
              onClick={() =>
                void assistant.perform(() =>
                  runtimeClient.updateAssistantConversation(
                    conversation.id,
                    conversation.revision,
                    { lifecycle: conversation.lifecycle === 'active' ? 'archived' : 'active' },
                  ),
                )
              }
            >
              {conversation.lifecycle === 'active'
                ? text('归档会话', 'Archive conversation')
                : text('恢复会话', 'Restore conversation')}
            </Button>
            <Button
              className="button-danger"
              onClick={() =>
                void assistant.perform(async () => {
                  await runtimeClient.deleteAssistantConversation(
                    conversation.id,
                    conversation.revision,
                  );
                  assistant.select(null);
                  if (!compact) void navigate('/assistant', { replace: true });
                })
              }
            >
              {text('删除此会话', 'Delete conversation')}
            </Button>
          </details>
        )}
      </section>
    </div>
  );
}
function MessageBlock({
  block,
  lessons,
}: {
  block: AssistantMessageBlock;
  lessons: AssistantLesson[];
}) {
  const assistant = useAssistant();
  const text = useCopy();
  if (block.type === 'text') return <p>{block.text}</p>;
  if (block.type === 'navigation')
    return /^\/(?!\/)/.test(block.href) ? (
      <Link
        className="button button-secondary"
        to={block.href}
        onClick={() => assistant.setOpen(false)}
      >
        {block.label}
        <ArrowUpRight size={16} />
      </Link>
    ) : null;
  if (block.type === 'action') {
    const action = assistant.detail?.actions.find((item) => item.id === block.actionId);
    return action ? <ActionCard action={action} /> : null;
  }
  if (block.type === 'source') {
    const action = assistant.detail?.actions.find((item) => item.id === block.actionId);
    return (
      <div className="assistant-result-card">
        <strong>{block.title}</strong>
        <span className="break-all">{block.url}</span>
        <p>{block.summary}</p>
        <small>{text('候选来源 · 尚未验证可采集', 'Candidate source · Not yet verified')}</small>
        {action && <ActionCard action={action} />}
      </div>
    );
  }
  if (block.type === 'fields')
    return (
      <>
        <FieldCard draftId={block.draftId} />
        <AssistantCacheNotice block={block} />
      </>
    );
  if (block.type === 'lesson') {
    const lesson = lessons.find((item) => item.id === block.lessonId);
    return lesson ? <LessonCard lesson={lesson} /> : null;
  }
  return <PreviewCard block={block} />;
}
function PreviewCard({ block }: { block: Extract<AssistantMessageBlock, { type: 'preview' }> }) {
  const assistant = useAssistant();
  const text = useCopy();
  const current = useQuery({
    queryKey: ['collection-drafts', block.draftId],
    queryFn: () => runtimeClient.getCollectionDraft(block.draftId!),
    enabled: Boolean(block.draftId),
  });
  const repair = assistant.detail?.actions.find((action) => action.id === block.repairActionId);
  const stale = block.repairActionId
    ? !repair ||
      repair.status === 'expired' ||
      repair.contextRevision !== assistant.detail?.conversation.context.revision
    : assistant.detail?.conversation.collectionDraftId !== block.draftId ||
      !current.data?.preview ||
      current.data.revision !== block.revision;
  const columns = [...new Set(block.records.flatMap((record) => Object.keys(record.data)))];
  return (
    <div className="assistant-result-card" data-assistant-anchor="assistant.preview">
      <strong>
        {block.repairActionId
          ? text('修复预览', 'Repair preview')
          : text('数据预览', 'Data preview')}{' '}
        · {block.records.length} {text('条样本', 'sample records')}
      </strong>
      {stale && (
        <p role="status">
          {text(
            '这是之前的样本。当前目标或字段已变化，请重新预览。',
            'This is an earlier sample. The target or fields changed; preview again.',
          )}
        </p>
      )}
      <small>
        {new Date(block.createdAt).toLocaleString()} ·{' '}
        {text('少量页面检查，不代表全部数据', 'Limited page inspection, not the entire dataset')}
      </small>
      <div className="assistant-sample-table">
        <table>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.records.map((record, index) => (
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column}>
                    {record.data[column] === null ||
                    record.data[column] === undefined ||
                    record.data[column] === '' ? (
                      <span className="assistant-missing">{text('缺失', 'Missing')}</span>
                    ) : (
                      String(record.data[column])
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details>
        <summary>{text('查看来源与缺失项', 'Sources and missing values')}</summary>
        {[...new Set(block.records.map((record) => record.sourceUrl))].map((url) => (
          <p className="break-all" key={url}>
            {url}
          </p>
        ))}
        {columns.map((column) => (
          <p key={column}>
            {column}:{' '}
            {
              block.records.filter(
                (record) =>
                  record.data[column] === null ||
                  record.data[column] === undefined ||
                  record.data[column] === '',
              ).length
            }{' '}
            / {block.records.length} {text('条缺失', 'missing')}
          </p>
        ))}
      </details>
      <div className="assistant-entry-options">
        {block.draftId &&
          (['save', 'save_and_run'] as const).map((kind) => (
            <Button
              key={kind}
              className="button-secondary"
              disabled={stale || assistant.pending || assistant.busy}
              onClick={() =>
                void assistant.perform(() =>
                  runtimeClient.prepareAssistantAction(assistant.selectedId!, kind),
                )
              }
            >
              {kind === 'save'
                ? text('准备保存', 'Prepare to save')
                : text('准备保存并运行', 'Prepare to save and run')}
            </Button>
          ))}
      </div>
    </div>
  );
}
function ActionCard({ action }: { action: AssistantAction }) {
  const assistant = useAssistant();
  const text = useCopy();
  const stale = action.contextRevision !== assistant.detail?.conversation.context.revision;
  const execute = () =>
    void assistant.perform(() => runtimeClient.executeAssistantAction(action.id, action.revision));
  return (
    <div className="assistant-action-card" data-assistant-anchor="assistant.action">
      <strong>{action.title}</strong>
      <p>{action.summary}</p>
      {action.error && <p className="notice-warning">{action.error}</p>}
      {action.status === 'succeeded' ? (
        <>
          <span className="badge badge-success">{text('操作已完成', 'Action completed')}</span>
          {typeof action.result?.artifactId === 'string' && (
            <Button
              className="button-secondary"
              onClick={() =>
                void assistant.perform(() =>
                  runtimeClient.saveArtifact({
                    id: String(action.result!.artifactId),
                    filename: String(action.result!.filename ?? 'export.csv'),
                  }),
                )
              }
            >
              {text('下载 / 保存文件', 'Download / save file')}
            </Button>
          )}
          {typeof action.result?.href === 'string' && (
            <Link to={action.result.href} onClick={() => assistant.setOpen(false)}>
              {text('查看结果', 'View result')}
            </Link>
          )}
        </>
      ) : action.status === 'running' ? (
        <span role="status">{text('正在执行…', 'Executing…')}</span>
      ) : stale || ['expired', 'canceled'].includes(action.status) ? (
        <span>
          {text(
            '这张卡片已失效，请根据当前目标重新准备。',
            'This card is no longer current. Prepare a new action for the current target.',
          )}
        </span>
      ) : (
        <Button disabled={assistant.pending || assistant.busy} onClick={execute}>
          {action.kind === 'select_source'
            ? text('选择这个来源', 'Choose this source')
            : action.status === 'failed'
              ? text('重试此操作', 'Retry action')
              : text('执行此操作', 'Execute action')}
        </Button>
      )}
    </div>
  );
}
function FieldCard({ draftId }: { draftId: string }) {
  const assistant = useAssistant();
  const text = useCopy();
  const draft = useQuery({
    queryKey: ['collection-drafts', draftId],
    queryFn: () => runtimeClient.getCollectionDraft(draftId),
  });
  const [names, setNames] = useState<Record<string, string>>({});
  const rule = draft.data?.definition?.list.rule;
  if (!rule) return null;
  if (assistant.detail?.conversation.collectionDraftId !== draftId)
    return (
      <p>
        {text(
          '这是之前帮助对象的字段。切换回该草稿后可继续编辑。',
          'These fields belong to an earlier target. Select that draft to edit them.',
        )}
      </p>
    );
  const fields = Object.keys(rule.fields);
  const save = (removed?: string) =>
    void assistant.perform(async () => {
      const current = draft.data!;
      const definition = current.definition!;
      const updated = Object.fromEntries(
        Object.entries(definition.list.rule.fields)
          .filter(([key]) => key !== removed)
          .map(([key, field]) => [names[key]?.trim() || key, field]),
      );
      if (Object.keys(updated).length !== fields.length - (removed ? 1 : 0))
        throw new Error(text('字段名称不能重复。', 'Column names must be unique.'));
      await runtimeClient.updateCollectionDraft(current.id, current.revision, {
        definition: {
          ...definition,
          list: { ...definition.list, rule: { ...definition.list.rule, fields: updated } },
        },
      });
      setNames({});
    });
  return (
    <div className="assistant-result-card">
      <strong>{text('准备采集的列', 'Columns to collect')}</strong>
      {fields.map((field) => (
        <div className="assistant-field-row" key={field}>
          <input
            aria-label={`${text('字段名称', 'Column name')} ${field}`}
            value={names[field] ?? field}
            onChange={(event) => setNames({ ...names, [field]: event.target.value })}
          />
          <Button
            className="button-ghost"
            disabled={assistant.pending || assistant.busy || fields.length < 2}
            onClick={() => save(field)}
          >
            {text('移除', 'Remove')}
          </Button>
        </div>
      ))}
      <div className="assistant-entry-options">
        <Button
          className="button-secondary"
          disabled={assistant.pending || assistant.busy}
          onClick={() => save()}
        >
          {text('保存字段名称', 'Save column names')}
        </Button>
        <Link
          className="button button-ghost"
          to={`/tasks/new?draft=${draftId}`}
          onClick={() => assistant.setOpen(false)}
        >
          {text('添加字段或点选页面', 'Add fields or select on page')}
        </Link>
      </div>
      <small>{text('更改字段后需要重新预览。', 'Preview again after changing fields.')}</small>
    </div>
  );
}
function LessonCard({ lesson }: { lesson: AssistantLesson }) {
  const assistant = useAssistant();
  const text = useCopy();
  const conversation = assistant.detail?.conversation;
  const progress = conversation?.lessons.find((item) => item.lessonId === lesson.id);
  const [selection, setSelection] = useState<'card' | 'price' | 'name'>('card');
  const pages = progress?.evidence.some((item) => item.kind === 'loaded_range') ? 2 : 1;
  const step = lesson.steps[progress?.step ?? 0];
  const event = (
    event: 'start' | 'pause' | 'resume' | 'skip' | 'restart' | 'verify' | 'take_over' | 'load_more',
  ) =>
    void assistant.perform(() =>
      runtimeClient.updateAssistantLesson(conversation!.id, conversation!.revision, {
        lessonId: lesson.id,
        event,
        selection,
        pages,
      }),
    );
  return (
    <div
      className="assistant-result-card assistant-lesson"
      data-assistant-anchor="assistant.lesson"
    >
      <span className="eyebrow">
        {text('固定教学 · 离线练习', 'Fixed lesson · Offline practice')}
      </span>
      <strong>
        <BookOpen size={17} />
        {lesson.title}
      </strong>
      <p>{lesson.summary}</p>
      {!progress ? (
        <Button disabled={assistant.pending || assistant.busy} onClick={() => event('start')}>
          {text('开始学习', 'Start lesson')}
        </Button>
      ) : progress.status === 'completed' ? (
        <>
          <p>
            {progress.evidence.some((entry) => entry.kind === 'skipped')
              ? text('已结束本课，部分步骤由你选择跳过。', 'Lesson ended; some steps were skipped.')
              : text(
                  '本课步骤已完成，可以再独立试一次。',
                  'Lesson steps completed. Try it again on your own.',
                )}
          </p>
          <Button
            className="button-secondary"
            disabled={assistant.pending}
            onClick={() => event('restart')}
          >
            {text('重新练习', 'Practice again')}
          </Button>
        </>
      ) : (
        <>
          <small>
            {text('第', 'Step')} {progress.step + 1} / {lesson.steps.length}
          </small>
          <h3>{step?.title}</h3>
          <p>{step?.explanation}</p>
          <p className="assistant-demonstration">{step?.demonstration}</p>
          {(step?.activity === 'select_price' || step?.activity === 'pagination') && (
            <div className="assistant-training-products">
              {assistantExamplePage(step.activity === 'pagination' ? pages : 1).map((product) => (
                <div key={product.name} className="assistant-training-product">
                  {step.activity === 'select_price' ? (
                    <>
                      <button
                        type="button"
                        className={selection === 'name' ? 'selected' : ''}
                        onClick={() => setSelection('name')}
                      >
                        {product.name}
                      </button>
                      <button
                        type="button"
                        className={selection === 'price' ? 'selected' : ''}
                        onClick={() => setSelection('price')}
                      >
                        ¥{product.price}
                      </button>
                      <button
                        className="button-ghost"
                        type="button"
                        onClick={() => setSelection('card')}
                      >
                        {text('整张商品卡片', 'Entire product card')}
                      </button>
                    </>
                  ) : (
                    <>
                      <span>{product.name}</span>
                      <strong>¥{product.price}</strong>
                    </>
                  )}
                </div>
              ))}
              {step.activity === 'pagination' && (
                <Button
                  className="button-secondary"
                  disabled={pages === 2}
                  onClick={() => event('load_more')}
                >
                  {pages === 2
                    ? text('已显示全部 6 条', 'All 6 records displayed')
                    : text('加载更多', 'Load more')}
                </Button>
              )}
            </div>
          )}
          <div className="assistant-entry-options">
            {progress.status === 'paused' ? (
              <Button disabled={assistant.pending} onClick={() => event('resume')}>
                {text('继续学习', 'Resume')}
              </Button>
            ) : (
              <>
                <Button
                  disabled={assistant.pending || assistant.busy}
                  onClick={() => event('verify')}
                >
                  {text('检查这一步', 'Check this step')}
                </Button>
                <Button
                  className="button-secondary"
                  disabled={assistant.pending || assistant.busy}
                  onClick={() => event('take_over')}
                >
                  {text('这一步帮我做', 'Help me with this step')}
                </Button>
                <Button
                  className="button-ghost"
                  disabled={assistant.pending}
                  onClick={() => event('pause')}
                >
                  {text('暂停', 'Pause')}
                </Button>
                <Button
                  className="button-ghost"
                  disabled={assistant.pending}
                  onClick={() => event('skip')}
                >
                  {text('跳过', 'Skip')}
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
function href(resource: NonNullable<AssistantContext['resource']>) {
  return resource.kind === 'draft'
    ? `/tasks/new?draft=${encodeURIComponent(resource.id)}`
    : `/${resource.kind === 'task' ? 'tasks' : resource.kind === 'run' ? 'runs' : 'datasets'}/${encodeURIComponent(resource.id)}`;
}
function toolLabel(tool: string, text: (zh: string, en: string) => string) {
  const labels: Record<string, [string, string]> = {
    search_sites: ['正在寻找来源…', 'Finding sources…'],
    inspect_page: ['正在查看页面…', 'Inspecting the page…'],
    generate_rule: ['正在准备字段…', 'Preparing fields…'],
    test_rule: ['正在检查数据预览…', 'Checking the preview…'],
    search_help: ['正在查阅操作说明…', 'Reading product help…'],
    prepare_repair: ['正在准备并验证修复…', 'Preparing and testing a repair…'],
  };
  const value = labels[tool];
  return value ? text(...value) : text('正在处理你的问题…', 'Working on your question…');
}
