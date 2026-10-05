import { productCopy } from '../product-copy.js';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Database,
  Plus,
  Trash2,
  FlaskConical,
  Sparkles,
} from 'lucide-react';
import { runtimeClient } from '@zhiyun/client';
import {
  normalizeCrawlPlan,
  taskCreateSchema,
  type CollectionDraft,
  type CollectionDraftPatch,
  type CrawlPlanDefinition,
} from '@zhiyun/shared';
import { Button, Card, ErrorNotice, Input, Badge } from '../components/ui.js';
import { Field, Select, Skeleton, Stepper, StatusNotice } from '../components/experience.js';
import { ScheduleBuilder } from '../components/ScheduleBuilder.js';
import { DraftTemplates, DraftInspection } from '../components/DraftTools.js';
import { CollectionPreview } from '../components/CollectionPreview.js';
import { ActionCacheSummary } from '../components/RuleCacheNotice.js';
import { BrowserActionEditor, parseBrowserActions } from '../components/BrowserActionEditor.js';

const defaultPlan = () =>
  normalizeCrawlPlan({
    type: 'css',
    container: 'article',
    fields: { 标题: { selector: 'h2', value: 'text', dataType: 'string' } },
  });
export function CollectionFlowPage() {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const text = (cn: string, en: string) => (zh ? cn : en);
  const { id: taskId } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const [draft, setDraft] = useState<CollectionDraft | null>(null);
  const current = useRef<CollectionDraft | null>(null);
  const remote = useRef<CollectionDraft | null>(null);
  const entryRecorded = useRef<string | null>(null);
  const dirty = useRef(0),
    saved = useRef(0);
  const queue = useRef<Promise<CollectionDraft | null>>(Promise.resolve(null));
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cacheMessage, setCacheMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [validation, setValidation] = useState<Record<string, string>>({});
  const [fieldName, setFieldName] = useState('');
  const [fieldSelector, setFieldSelector] = useState('');
  const [fieldType, setFieldType] = useState('string');
  const draftId = params.get('draft');
  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => runtimeClient.getAiProviderSettings(),
  });
  const outputs = useQuery({
    queryKey: ['outputs', 'destinations'],
    queryFn: () => runtimeClient.listOutputDestinations(),
  });
  const assistantCapabilities = useQuery({
    queryKey: ['assistant-capabilities'],
    queryFn: () => runtimeClient.getAssistantCapabilities(),
    retry: false,
  });
  const assign = (value: CollectionDraft) => {
    current.current = value;
    setDraft(value);
  };
  useEffect(() => {
    let active = true;
    setError('');
    setConflict(false);
    setDraft(null);
    current.current = null;
    remote.current = null;
    dirty.current = 0;
    saved.current = 0;
    const load = async () => {
      let value: CollectionDraft;
      if (draftId) value = await runtimeClient.getCollectionDraft(draftId);
      else {
        const storageKey = `zhiyun-create-${taskId ?? 'new'}`;
        let key = sessionStorage.getItem(storageKey);
        if (!key) {
          key = crypto.randomUUID();
          sessionStorage.setItem(storageKey, key);
        }
        // Creation retries replay the original response. Read the current resource
        // before restoring it: it may have been submitted or deleted meanwhile.
        const create = (entryKey: string) =>
          runtimeClient.createCollectionDraft({ ...(taskId ? { taskId } : {}) }, entryKey);
        const created = await create(key);
        let restored: CollectionDraft | null = null;
        try {
          restored = await runtimeClient.getCollectionDraft(created.id);
        } catch (reason) {
          if ((reason as { status?: number }).status !== 404) throw reason;
        }
        if (!restored || restored.status === 'committed') {
          key = crypto.randomUUID();
          sessionStorage.setItem(storageKey, key);
          value = await create(key);
        } else value = restored;
      }
      if (!active) return;
      remote.current = value;
      assign(value);
      if (!draftId) setParams({ draft: value.id }, { replace: true });
    };
    void load().catch((reason) => {
      if (active) setError(String(reason instanceof Error ? reason.message : reason));
    });
    return () => {
      active = false;
      const pending = current.current;
      const previous = remote.current;
      const unsaved = dirty.current !== saved.current;
      if (
        pending &&
        previous &&
        pending.id === previous.id &&
        unsaved &&
        pending.status === 'editing'
      ) {
        // Preserve an edit when browser Back unmounts before the debounce expires.
        // Keep the observed revision: a concurrent AI edit must still return 412.
        queue.current = queue.current
          .catch(() => null)
          .then(async (last) => {
            const revision = last?.id === pending.id ? last.revision : previous.revision;
            return runtimeClient.updateCollectionDraft(pending.id, revision, {
              step: pending.step,
              mode: pending.mode,
              task: pending.task,
              definition: pending.definition,
            });
          });
        void queue.current.catch(() => undefined);
      }
    };
  }, [draftId, taskId]);
  const edit = (patch: CollectionDraftPatch) => {
    const value = current.current;
    if (!value || value.status !== 'editing') return;
    if (!value.taskId && !value.exampleId && entryRecorded.current !== value.id) {
      entryRecorded.current = value.id;
      void runtimeClient
        .request('/api/v2/experience/events', {
          method: 'POST',
          body: JSON.stringify({ eventId: value.id, draftId: value.id, type: 'creation_started' }),
        })
        .catch(() => {
          entryRecorded.current = null;
        });
    }
    dirty.current++;
    assign({ ...value, ...patch, task: { ...value.task, ...patch.task } });
    setError('');
  };
  const flush = (): Promise<CollectionDraft | null> => {
    queue.current = queue.current
      .catch(() => null)
      .then(async () => {
        if (!current.current || !remote.current || dirty.current === saved.current)
          return remote.current;
        if (conflict)
          throw new Error(text('请先解决版本冲突', 'Resolve the version conflict first'));
        const value = current.current,
          version = dirty.current;
        setSaving(true);
        try {
          const result = await runtimeClient.updateCollectionDraft(
            value.id,
            remote.current.revision,
            { step: value.step, mode: value.mode, task: value.task, definition: value.definition },
          );
          if (current.current?.id !== value.id) return result;
          remote.current = result;
          saved.current = version;
          if (version === dirty.current) assign(result);
          else if (current.current)
            assign({ ...current.current, revision: result.revision, preview: result.preview });
          return result;
        } catch (reason) {
          setConflict((reason as { status?: number }).status === 412);
          setError(reason instanceof Error ? reason.message : String(reason));
          throw reason;
        } finally {
          setSaving(false);
        }
      });
    return queue.current;
  };
  useEffect(() => {
    if (!draft || dirty.current === saved.current) return;
    const timer = setTimeout(() => void flush().catch(() => undefined), 600);
    return () => clearTimeout(timer);
  }, [draft]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current !== saved.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const execute = async (operation: (value: CollectionDraft) => Promise<CollectionDraft>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const value = await flush();
      if (!value) return;
      const result = await operation(value);
      if (result.status === 'committed')
        sessionStorage.removeItem(`zhiyun-create-${taskId ?? 'new'}`);
      remote.current = result;
      assign(result);
    } catch (reason) {
      if ((reason as { status?: number }).status === 412) setConflict(true);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const next = () => {
    if (!draft) return;
    const errors: Record<string, string> = {};
    if (draft.step === 1) {
      if (!taskCreateSchema.shape.startUrl.safeParse(draft.task.startUrl).success)
        errors.url = text('请输入完整的 HTTP 或 HTTPS 网址', 'Enter a complete HTTP or HTTPS URL');
      if (!draft.task.instruction?.trim())
        errors.goal = text('描述希望获取的数据', 'Describe the data you need');
    }
    if (draft.step === 2 && (!draft.preview || dirty.current !== saved.current))
      errors.preview = text('请先预览当前字段', 'Preview your current fields first');
    if (
      draft.step === 2 &&
      draft.preview?.records.some((row) =>
        ['ambiguous_link', 'ambiguous_record'].includes(row.inspection?.detail?.status ?? ''),
      )
    )
      errors.preview = text(
        '详情关系不唯一，请缩小链接或详情容器的选择器后重新预览',
        'Detail relationship is ambiguous; narrow the link or detail container selector and preview again',
      );
    setValidation(errors);
    if (Object.keys(errors).length) return;
    edit({
      step: Math.min(3, draft.step + 1) as 1 | 2 | 3,
      ...(!draft.definition ? { definition: defaultPlan() } : {}),
    });
  };
  const startExample = async () => {
    setBusy(true);
    try {
      const previous = await flush();
      const value = await runtimeClient.createExampleDraft();
      if (
        previous &&
        !previous.taskId &&
        !previous.task.startUrl &&
        !previous.task.instruction &&
        !previous.definition
      ) {
        await runtimeClient
          .deleteCollectionDraft(previous.id, previous.revision)
          .catch(() => undefined);
        sessionStorage.removeItem(`zhiyun-create-${taskId ?? 'new'}`);
      }
      await navigate(`/tasks/new?draft=${value.id}`);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };
  if (!draft)
    return (
      <>
        <h1>{t('newTask')}</h1>
        <ErrorNotice message={error} onRetry={() => window.location.reload()} />
        {!error && <Skeleton />}
      </>
    );
  if (draft.result)
    return (
      <Card className="flow-success">
        <Check size={36} />
        <h1>{text('任务已保存', 'Task saved')}</h1>
        <p>{draft.task.name}</p>
        <p>
          {draft.result.runId
            ? text(
                '采集已加入运行队列，可在任务页查看进度与输出状态。',
                'Collection is queued. Follow progress and delivery status on the task page.',
              )
            : text(
                '可以随时运行，或设置定时更新。',
                'Run whenever you are ready, or configure a schedule.',
              )}
        </p>
        <div className="heading-actions">
          <Link className="button" to={`/tasks/${draft.result.taskId}`}>
            {text('查看任务与结果', 'View task and results')}
          </Link>
          <Link className="button button-secondary" to={`/tasks/${draft.result.taskId}/dataset`}>
            {text('数据、导出与分析', 'Data, export and analysis')}
          </Link>
          <Link to={`/tasks/${draft.result.taskId}/edit`}>
            {text('设置定时更新', 'Schedule updates')}
          </Link>
        </div>
      </Card>
    );
  const plan = draft.definition ?? defaultPlan();
  const rule = plan.list.rule;
  const fields = rule.type === 'css' ? Object.entries(rule.fields) : [];
  const setPlan = (value: CrawlPlanDefinition) => edit({ definition: value });
  const setFields = (value: typeof rule extends never ? never : Record<string, unknown>) =>
    setPlan(
      normalizeCrawlPlan({ ...plan, list: { ...plan.list, rule: { ...rule, fields: value } } }),
    );
  const schedule = draft.task.schedule ?? taskCreateSchema.shape.schedule.parse(undefined);
  const browser =
    draft.task.browserSettings ?? taskCreateSchema.shape.browserSettings.parse(undefined);
  const commit = (run: boolean) => {
    const parsed = taskCreateSchema.safeParse(draft.task);
    if (!parsed.success) {
      setValidation({
        name:
          parsed.error.issues[0]?.message ??
          text('请补全任务配置', 'Complete the task configuration'),
      });
      return;
    }
    void execute((value) => runtimeClient.commitCollectionDraft(value.id, value.revision, run));
  };
  return (
    <>
      <div className="page-heading">
        <div>
          <Link to="/tasks" className="back-link">
            <ArrowLeft size={16} />
            {t('tasks')}
          </Link>
          <h1>{taskId ? text('编辑采集任务', 'Edit collection task') : t('newTask')}</h1>
          <p>
            {text(
              '先确认你需要的数据，再开始采集。',
              'Confirm the data you need, then start collecting.',
            )}
          </p>
        </div>
        <span className="save-status" role="status">
          {saving
            ? text('正在保存…', 'Saving…')
            : dirty.current === saved.current
              ? text('草稿已保存', 'Draft saved')
              : text('有未保存的修改', 'Unsaved changes')}
        </span>
      </div>
      <Stepper
        steps={[
          text('选择页面', 'Choose page'),
          text('确认字段与预览', 'Fields and preview'),
          text('保存运行', 'Save and run'),
        ]}
        current={draft.step - 1}
        onChange={(step) => {
          if (step < draft.step) edit({ step: (step + 1) as 1 | 2 | 3 });
        }}
      />
      <ErrorNotice message={error} onRetry={() => void flush().catch(() => undefined)} />
      {!draft.exampleId && draft.status === 'editing' && draft.task.startUrl && (
        <div className="toolbar">
          {assistantCapabilities.data?.controlledLogin ? (
            <Button
              className="button-secondary"
              disabled={busy || saving}
              onClick={() =>
                void execute(async (value) => {
                  const result = await runtimeClient.startDraftLoginSession(
                    value.id,
                    value.revision,
                  );
                  return result.draft ?? value;
                })
              }
            >
              {text('在安全窗口登录网站', 'Sign in in a secure window')}
            </Button>
          ) : (
            <Link to={`/tasks/new?draft=${draft.id}&mode=advanced`}>
              {text('配置受保护的登录凭据', 'Configure protected credentials')}
            </Link>
          )}
          <small>
            {text(
              '登录后请重新检查字段并预览。凭据不会进入聊天。',
              'Check fields and preview again after signing in. Credentials stay out of chat.',
            )}
          </small>
        </div>
      )}
      {draft.status === 'committing' && (
        <StatusNotice>
          {text(
            '提交尚未完成，可以继续同一次提交。',
            'Submission is incomplete. Resume the same submission.',
          )}
          <Button
            disabled={busy}
            onClick={() =>
              void execute((value) =>
                runtimeClient.commitCollectionDraft(
                  value.id,
                  value.revision,
                  value.commitRun ?? false,
                ),
              )
            }
          >
            {text('继续提交', 'Resume submission')}
          </Button>
          {draft.taskId && (
            <Link to={`/tasks/${draft.taskId}/edit`}>
              {text('从最新任务重新编辑', 'Edit the latest task')}
            </Link>
          )}
        </StatusNotice>
      )}
      {conflict && (
        <StatusNotice>
          {text(
            '其他窗口或 AI 修改了草稿。当前输入仍在页面中；重新载入会显示服务器版本。',
            'Another window or AI edited this draft. Your input remains on this page; reloading shows the server version.',
          )}
          <Button onClick={() => window.location.reload()}>
            {text('载入最新版本', 'Load latest version')}
          </Button>
        </StatusNotice>
      )}
      {draft.exampleId && (
        <StatusNotice>
          <FlaskConical size={18} />
          {text(
            '内置商品样例 · 可离线运行 · 不连接外部输出',
            'Built-in product example · works offline · no external outputs',
          )}
        </StatusNotice>
      )}
      <fieldset className="flow-fieldset" disabled={busy || draft.status === 'committing'}>
        {draft.step === 1 && (
          <div className="flow-layout">
            <Card>
              <h2>{text('你想从哪里获取数据？', 'Where is your data?')}</h2>
              <Field label={text('页面网址', 'Page URL')} error={validation.url}>
                <Input
                  type="url"
                  placeholder="https://example.com/products"
                  value={draft.task.startUrl ?? ''}
                  readOnly={Boolean(draft.exampleId)}
                  onChange={(e) => edit({ task: { startUrl: e.target.value } })}
                  aria-invalid={Boolean(validation.url)}
                />
              </Field>
              <Field label={text('数据目标', 'Data goal')} error={validation.goal}>
                <textarea
                  className="input"
                  rows={3}
                  placeholder={text(
                    '例如：商品名称、价格、库存和详情链接',
                    'For example: product names, prices, stock and detail links',
                  )}
                  value={draft.task.instruction ?? ''}
                  onChange={(e) => edit({ task: { instruction: e.target.value } })}
                />
              </Field>
              <div className="scenario-choices">
                {[
                  [text('商品价格', 'Product prices'), '商品名称、价格、库存和链接', 'prices'],
                  [text('文章列表', 'Article list'), '文章标题、作者、发布时间和正文', 'articles'],
                  [
                    text(productCopy('变化监控'), 'Change monitoring'),
                    '监控名称、价格和库存的变化',
                  ],
                ].map(([label, goal, kind]) => (
                  <Button
                    key={productCopy(label)}
                    className="button-secondary"
                    onClick={() =>
                      edit({
                        task: { instruction: zh ? goal! : label! },
                        mode: 'template',
                        ...(!draft.definition
                          ? { definition: businessPlan(kind ?? 'changes', zh) }
                          : {}),
                      })
                    }
                  >
                    {productCopy(label)}
                  </Button>
                ))}
              </div>
            </Card>
            <Card className="flow-help">
              <Database size={28} />
              <h2>{text('先体验一次完整流程', 'Try a complete workflow')}</h2>
              <p>
                {text(
                  '用内置商品页面练习选字段、运行和导出，无需模型或外网。',
                  'Practice selecting fields, running and exporting with the bundled product page. No model or network needed.',
                )}
              </p>
              <Button className="button-secondary" onClick={() => void startExample()}>
                {text('使用商品样例', 'Use product example')}
              </Button>
              <hr />
              <Sparkles size={22} />
              <h3>{text('AI 辅助配置', 'AI assistance')}</h3>
              <p>
                {providers.isPending
                  ? text('正在检查 AI 模型配置…', 'Checking AI model settings…')
                  : providers.isError
                    ? text(
                        '无法读取 AI 模型配置，请重试。',
                        'Could not load AI model settings. Please retry.',
                      )
                    : providers.data?.configured
                      ? text(
                          'AI 可帮助生成规则、修改字段和解释失败。',
                          'AI can generate rules, change fields and explain failures.',
                        )
                      : text(
                          '尚未连接 AI 模型。你可以继续手动配置或使用样例。',
                          'No AI model connected. Continue manually or use the example.',
                        )}
              </p>
              {providers.isError && (
                <ErrorNotice
                  message={providers.error.message}
                  onRetry={() => void providers.refetch()}
                />
              )}
              <Link
                onClick={(e) => {
                  e.preventDefault();
                  const href = e.currentTarget.getAttribute('href')!;
                  void flush()
                    .then(() => navigate(href))
                    .catch(() => undefined);
                }}
                to={`/settings?section=ai&returnTo=${encodeURIComponent(`/tasks/new?draft=${draft.id}&mode=ai`)}`}
              >
                {text('连接 AI 模型', 'Connect an AI model')}
              </Link>
              <Link
                to={`/tasks/new?draft=${draft.id}&mode=ai&assistant=1`}
                onClick={(e) => {
                  e.preventDefault();
                  const href = e.currentTarget.getAttribute('href')!;
                  void flush()
                    .then(() => navigate(href))
                    .catch(() => undefined);
                }}
              >
                {text('打开 AI 助手', 'Open AI assistant')}
              </Link>
            </Card>
          </div>
        )}
        {draft.step === 2 && (
          <>
            <div className="flow-layout">
              <Card>
                <div className="section-heading">
                  <h2>{text('要采集的字段', 'Fields to collect')}</h2>
                  <Badge>{fields.length}</Badge>
                </div>
                {rule.type === 'css' ? (
                  <>
                    <Field label={text('列表项选择器', 'List item selector')}>
                      <Input
                        value={rule.container}
                        onChange={(e) =>
                          setPlan({
                            ...plan,
                            list: { ...plan.list, rule: { ...rule, container: e.target.value } },
                          })
                        }
                      />
                    </Field>
                    {fields.map(([name, field]) => (
                      <div className="field-editor" key={name}>
                        <Field label={text(productCopy('字段名称'), 'Field name')}>
                          <Input
                            defaultValue={name}
                            onBlur={(e) => {
                              const renamed = e.target.value.trim();
                              if (!renamed || renamed === name) return;
                              if (rule.fields[renamed]) {
                                setError(text('字段名称重复', 'Field name already exists'));
                                e.target.value = name;
                                return;
                              }
                              setFields(
                                Object.fromEntries(
                                  fields.map(([key, value]) => [
                                    key === name ? renamed : key,
                                    value,
                                  ]),
                                ),
                              );
                            }}
                          />
                        </Field>
                        <Field label={text('提取规则', 'Extraction selector')}>
                          <Input
                            value={field.selector}
                            onChange={(e) =>
                              setFields({
                                ...rule.fields,
                                [name]: { ...field, selector: e.target.value },
                              })
                            }
                          />
                        </Field>
                        <Field label={text(productCopy('类型'), 'Type')}>
                          <Select
                            value={field.dataType}
                            onChange={(e) =>
                              setFields({
                                ...rule.fields,
                                [name]: { ...field, dataType: e.target.value },
                              })
                            }
                          >
                            {['string', 'number', 'date', 'url', 'json'].map((type) => (
                              <option key={type} value={type}>
                                {t(`ux.fieldType.${type}`)}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Button
                          className="button-ghost"
                          aria-label={`${text('删除字段', 'Remove field')} ${name}`}
                          onClick={() =>
                            setFields(Object.fromEntries(fields.filter(([key]) => key !== name)))
                          }
                        >
                          <Trash2 size={16} />
                        </Button>
                      </div>
                    ))}
                    <div className="field-editor">
                      <Field label={text('新字段', 'New field')}>
                        <Input value={fieldName} onChange={(e) => setFieldName(e.target.value)} />
                      </Field>
                      <Field label={text('选择器', 'Selector')}>
                        <Input
                          value={fieldSelector}
                          onChange={(e) => setFieldSelector(e.target.value)}
                        />
                      </Field>
                      <Select
                        aria-label={text('新字段类型', 'New field type')}
                        value={fieldType}
                        onChange={(e) => setFieldType(e.target.value)}
                      >
                        {['string', 'number', 'date', 'url', 'json'].map((type) => (
                          <option key={type} value={type}>
                            {t(`ux.fieldType.${type}`)}
                          </option>
                        ))}
                      </Select>
                      <Button
                        className="button-secondary"
                        aria-label={text(productCopy('添加字段'), 'Add field')}
                        disabled={
                          !fieldName.trim() ||
                          !fieldSelector.trim() ||
                          Boolean(rule.fields[fieldName.trim()])
                        }
                        onClick={() => {
                          setFields({
                            ...rule.fields,
                            [fieldName.trim()]: {
                              selector: fieldSelector,
                              value: 'text',
                              dataType: fieldType,
                            },
                          });
                          setFieldName('');
                          setFieldSelector('');
                        }}
                      >
                        <Plus size={16} />
                      </Button>
                    </div>
                  </>
                ) : (
                  <p>
                    {text(
                      '当前使用专业提取规则，可在下方规则配置中编辑。',
                      'This task uses professional extraction rules. Edit them below.',
                    )}
                  </p>
                )}
                <ErrorNotice message={validation.preview} />
                <Button
                  onClick={() =>
                    void execute((value) => {
                      setCacheMessage('');
                      return runtimeClient.previewCollectionDraft(value.id, value.revision);
                    })
                  }
                >
                  {text('预览数据', 'Preview data')}
                </Button>
              </Card>
              <Card>
                <h2>{text(productCopy('数据预览'), 'Data preview')}</h2>
                <ActionCacheSummary value={draft.preview?.actionCache} />
                {draft.preview?.actionCache && (
                  <Button
                    className="button-secondary"
                    disabled={busy}
                    onClick={() =>
                      void execute(async (value) => {
                        const cleared = await runtimeClient.clearRuleCache({
                          cacheScope: value.id,
                        });
                        setCacheMessage(
                          `${text('动作缓存已清理', 'Action cache cleared')} · ${cleared.deleted}`,
                        );
                        return value;
                      })
                    }
                  >
                    {text('清理动作缓存', 'Clear action cache')}
                  </Button>
                )}
                {cacheMessage && <p role="status">{cacheMessage}</p>}
                {draft.preview ? (
                  <CollectionPreview
                    key={draft.preview.createdAt}
                    plan={plan}
                    records={draft.preview.records}
                  />
                ) : (
                  <div className="empty-state">
                    <Database size={32} />
                    <p>
                      {text(
                        '预览后在这里确认真实样本。修改采集规则后需要重新预览。',
                        'Preview to inspect real samples here. Preview again after changing collection rules.',
                      )}
                    </p>
                  </div>
                )}
              </Card>
            </div>
            <details className="advanced-section">
              <summary>{text('专业配置', 'Professional settings')}</summary>
              <DraftTemplates onApply={edit} />
              {rule.type === 'css' && !draft.exampleId && (
                <DraftInspection
                  flush={flush}
                  fields={fields.map(([name]) => name)}
                  onSelect={(name, selector) => {
                    if (!name)
                      setPlan(
                        normalizeCrawlPlan({
                          ...plan,
                          list: { ...plan.list, rule: { ...rule, container: selector } },
                        }),
                      );
                    else setFields({ ...rule.fields, [name]: { ...rule.fields[name], selector } });
                  }}
                />
              )}
              {taskId && (
                <Link
                  className="button button-secondary"
                  to={`/tasks/${taskId}/edit?professional=1`}
                >
                  {text('规则历史、比较与回滚', 'Rule history, comparison & rollback')}
                </Link>
              )}
              <JsonConfig
                title={text('提取规则、分页与详情', 'Extraction rules, pagination and details')}
                value={plan}
                onChange={(value) => setPlan(normalizeCrawlPlan(value))}
              />
              <details>
                <summary>{text('页面访问与请求控制', 'Page access and request control')}</summary>
                <JsonConfig
                  title={text(
                    '请求配置（凭据由主机保护）',
                    'Request settings (credentials protected by host)',
                  )}
                  value={
                    draft.task.requestSettings ??
                    taskCreateSchema.shape.requestSettings.parse(undefined)
                  }
                  onChange={(value) =>
                    edit({
                      task: {
                        requestSettings: taskCreateSchema.shape.requestSettings.parse(value),
                      },
                    })
                  }
                />
                <JsonConfig
                  title={text('网络访问策略', 'Network access policy')}
                  value={
                    draft.task.networkPolicy ??
                    taskCreateSchema.shape.networkPolicy.parse(undefined)
                  }
                  onChange={(value) =>
                    edit({
                      task: { networkPolicy: taskCreateSchema.shape.networkPolicy.parse(value) },
                    })
                  }
                />
              </details>
              <details>
                <summary>{text('浏览器操作', 'Browser actions')}</summary>
                <label>
                  <input
                    type="checkbox"
                    checked={browser.enabled}
                    onChange={(e) =>
                      edit({ task: { browserSettings: { ...browser, enabled: e.target.checked } } })
                    }
                  />
                  {text('启用浏览器', 'Enable browser')}
                </label>
                <BrowserActionEditor
                  value={JSON.stringify(browser.actions)}
                  onChange={(value) =>
                    edit({
                      task: {
                        browserSettings: { ...browser, actions: parseBrowserActions(value) },
                      },
                    })
                  }
                />
                <JsonConfig
                  title={text('浏览器配置', 'Browser settings')}
                  value={browser}
                  onChange={(value) =>
                    edit({
                      task: {
                        browserSettings: taskCreateSchema.shape.browserSettings.parse(value),
                      },
                    })
                  }
                />
              </details>
              <JsonConfig
                title={text('数据更新', 'Data updates')}
                value={
                  draft.task.datasetSettings ??
                  taskCreateSchema.shape.datasetSettings.parse(undefined)
                }
                onChange={(value) =>
                  edit({
                    task: { datasetSettings: taskCreateSchema.shape.datasetSettings.parse(value) },
                  })
                }
              />
              <JsonConfig
                title={text('保存与保留策略', 'Storage and retention')}
                value={
                  draft.task.retentionPolicy ??
                  taskCreateSchema.shape.retentionPolicy.parse(undefined)
                }
                onChange={(value) =>
                  edit({
                    task: { retentionPolicy: taskCreateSchema.shape.retentionPolicy.parse(value) },
                  })
                }
              />
              <JsonConfig
                title={text('保存与输出', 'Save & output')}
                value={
                  draft.task.outputSettings ??
                  taskCreateSchema.shape.outputSettings.parse(undefined)
                }
                onChange={(value) =>
                  edit({
                    task: { outputSettings: taskCreateSchema.shape.outputSettings.parse(value) },
                  })
                }
              />
            </details>
          </>
        )}
        {draft.step === 3 && (
          <div className="flow-layout">
            <Card>
              <h2>{text('保存这次采集', 'Save this collection')}</h2>
              <Field label={text('任务名称', 'Task name')} error={validation.name}>
                <Input
                  value={draft.task.name ?? ''}
                  onChange={(e) => edit({ task: { name: e.target.value } })}
                />
              </Field>
              {!draft.exampleId && (
                <>
                  <ScheduleBuilder
                    mode={schedule.mode}
                    cron={schedule.cron ?? ''}
                    timezone={schedule.timezone}
                    misfirePolicy={schedule.misfirePolicy}
                    onModeChange={(mode) => edit({ task: { schedule: { ...schedule, mode } } })}
                    onCronChange={(cron) => edit({ task: { schedule: { ...schedule, cron } } })}
                    onTimezoneChange={(timezone) =>
                      edit({ task: { schedule: { ...schedule, timezone } } })
                    }
                    onMisfirePolicyChange={(misfirePolicy) =>
                      edit({ task: { schedule: { ...schedule, misfirePolicy } } })
                    }
                  />
                  <Field
                    label={text(productCopy('输出目的地'), 'Output destination')}
                    hint={text(
                      '采集结果始终可在当前实例的数据集中查看。',
                      'Collection results remain available in this instance’s datasets.',
                    )}
                  >
                    <Select
                      value={draft.task.outputBindings?.[0] ?? ''}
                      onChange={(e) =>
                        edit({ task: { outputBindings: e.target.value ? [e.target.value] : [] } })
                      }
                    >
                      <option value="">{text('仅保存到数据集', 'Save to dataset')}</option>
                      {(outputs.data ?? []).map((output) => (
                        <option key={output.id} value={output.id}>
                          {output.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </>
              )}
            </Card>
            <Card>
              <h2>{text('本次采集', 'Collection summary')}</h2>
              <p>{draft.task.instruction}</p>
              <p>
                {draft.preview?.records.length ?? 0} {text('条样本已确认', 'samples confirmed')}
              </p>
              <Badge tone="success">{text('预览已通过', 'Preview passed')}</Badge>
              <p>
                {text(
                  '保存后可以查看运行进度、导出数据或创建分析任务。',
                  'After saving, follow progress, export data or create an analysis task.',
                )}
              </p>
            </Card>
          </div>
        )}
      </fieldset>
      <div className="flow-footer">
        <Button
          className="button-secondary"
          disabled={busy || draft.step === 1}
          onClick={() => edit({ step: (draft.step - 1) as 1 | 2 })}
        >
          <ArrowLeft size={16} />
          {text(productCopy('上一步'), 'Back')}
        </Button>
        {draft.step < 3 ? (
          <Button disabled={busy || saving} onClick={next}>
            {text(productCopy('下一步'), 'Continue')}
            <ArrowRight size={16} />
          </Button>
        ) : (
          <div className="heading-actions">
            <Button
              className="button-secondary"
              disabled={busy || saving}
              onClick={() => commit(false)}
            >
              {text('仅保存', 'Save only')}
            </Button>
            <Button disabled={busy || saving} onClick={() => commit(true)}>
              {busy ? text('正在提交…', 'Submitting…') : text('保存并运行', 'Save and run')}
              <ArrowRight size={16} />
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
function JsonConfig({
  title,
  value,
  onChange,
}: {
  title: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const [source, setSource] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState('');
  useEffect(() => setSource(JSON.stringify(value, null, 2)), [JSON.stringify(value)]);
  return (
    <details>
      <summary>{title}</summary>
      <textarea
        className="input code-input"
        rows={8}
        aria-label={title}
        value={source}
        onChange={(e) => setSource(e.target.value)}
        onBlur={() => {
          try {
            onChange(JSON.parse(source));
            setError('');
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
          }
        }}
      />
      <ErrorNotice message={error} />
    </details>
  );
}

function businessPlan(kind: string, zh: boolean) {
  if (kind === 'prices')
    return normalizeCrawlPlan({
      type: 'css',
      container: '.product, .product-card, [data-product]',
      fields: {
        [zh ? '商品名称' : 'Product']: {
          selector: '.name, .title, h2, h3',
          value: 'text',
          dataType: 'string',
        },
        [zh ? '价格' : 'Price']: {
          selector: '.price, [data-price]',
          value: 'text',
          dataType: 'number',
        },
        [zh ? '库存' : 'Stock']: {
          selector: '.stock, .inventory',
          value: 'text',
          dataType: 'number',
        },
        [zh ? '链接' : 'URL']: {
          selector: 'a',
          value: 'attribute',
          attribute: 'href',
          dataType: 'url',
        },
      },
    });
  if (kind === 'articles')
    return normalizeCrawlPlan({
      type: 'css',
      container: 'article, .article, .post',
      fields: {
        [zh ? '标题' : 'Title']: {
          selector: 'h1, h2, h3, .title',
          value: 'text',
          dataType: 'string',
        },
        [zh ? '作者' : 'Author']: {
          selector: '.author, [rel=author]',
          value: 'text',
          dataType: 'string',
        },
        [zh ? '发布时间' : 'Published']: {
          selector: 'time',
          value: 'attribute',
          attribute: 'datetime',
          dataType: 'date',
        },
        [zh ? '正文' : 'Body']: {
          selector: '.content, .body, p',
          value: 'text',
          dataType: 'string',
        },
      },
    });
  return normalizeCrawlPlan({
    type: 'css',
    container: 'article, .item',
    fields: {
      [zh ? '名称' : 'Name']: { selector: 'h1, h2, h3, .title', value: 'text', dataType: 'string' },
      [zh ? '内容' : 'Content']: {
        selector: '.content, .body, p',
        value: 'text',
        dataType: 'string',
      },
      [zh ? '链接' : 'URL']: {
        selector: 'a',
        value: 'attribute',
        attribute: 'href',
        dataType: 'url',
      },
    },
  });
}
