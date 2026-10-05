import { productCopy } from '../product-copy.js';
import { CollectionFlowPage } from './CollectionFlowPage.js';
import { useEffect, useMemo, useState, type FormEvent, type MouseEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  taskCreateSchema,
  type BrowserElementMetadata,
  type CrawlPlanDefinition,
  type ExtractionRuleDefinition,
  type TaskTemplate,
  type CollectionPreviewRecord,
} from '@zhiyun/shared';
import type {
  OutputDestination,
  RuleRecord,
  RuleRepairProposal,
  RuleVersionRecord,
} from '@zhiyun/contracts';
import { runtimeClient } from '@zhiyun/client';
import { Badge, Button, Card, ErrorNotice, Input } from '../components/ui.js';
import {
  BrowserActionEditor,
  parseBrowserActions,
  type BrowserAction,
  updateActionSelector,
} from '../components/BrowserActionEditor.js';
import { ScheduleBuilder } from '../components/ScheduleBuilder.js';
import { CollectionPreview } from '../components/CollectionPreview.js';
import { RuleCacheNotice } from '../components/RuleCacheNotice.js';
import { RuleHistory, type RuleHistoryDiff } from '../components/task-editor/RuleHistory.js';
import { validateFiveFieldCron, validateTimezone } from '../schedule-builder.js';
import type { Analysis, Task } from '../types.js';
import { AssistantPage } from './AssistantPage.js';
import { resolveDevelopmentFixture } from '../development-demo.js';
import {
  applyTemplateParameters,
  missingTemplateParameters,
  templateParameterDefaults,
} from '../task-template.js';

const officialTemplateFallbacks = [
  { id: 'list-page', name: '普通列表页', description: '从重复列表卡片提取字段' },
  { id: 'list-detail', name: '列表加详情页', description: '发现详情链接并补充正文' },
  { id: 'next-pagination', name: '下一页分页', description: '重复翻页采集列表' },
  { id: 'infinite-scroll', name: '无限滚动', description: '滚动加载动态列表' },
  { id: 'json-api', name: 'JSON API', description: '提取公开结构化接口' },
  { id: 'sitemap-details', name: 'Sitemap 批量详情', description: '批量发现并采集详情页' },
  { id: 'authenticated-browser', name: '已登录浏览器采集', description: '复用安全登录会话' },
  { id: 'change-monitor', name: '变化监控', description: '监控价格、库存或内容变化' },
] as const;

const defaultRequest = {
  headers: {},
  cookies: [],
  timeoutMs: 30_000,
  retries: 2,
  retryBackoffMs: 1_000,
  concurrency: 2,
  delayMs: 500,
  maxRequests: 100,
  maxRuntimeMs: 300_000,
  domainRateLimitPerMinute: 60,
  respectRobotsTxt: true,
  maxResponseBytes: 20 * 1024 * 1024,
  redirectLimit: 10,
};

const manualDraftDefinition: CrawlPlanDefinition = {
  version: 1,
  list: {
    rule: {
      type: 'css',
      container: 'body',
      fields: {
        pageText: { selector: 'body', value: 'text', dataType: 'string' },
      },
    },
    mode: 'auto',
    actions: [],
  },
  pagination: { type: 'none' },
  dedupe: { strategy: 'hash', fields: [] },
  limits: { maxRecords: 1_000_000 },
};

export function TaskEditorPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  if (!id && searchParams.get('assistant') === '1') return <AssistantPage />;
  if (searchParams.get('professional') !== '1') return <CollectionFlowPage />;
  return <TaskEditorForm />;
}

function TaskEditorForm() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [task, setTask] = useState<Task | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [instruction, setInstruction] = useState(productCopy('获取商品名称、价格、销量和链接'));
  const [headers, setHeaders] = useState('{}');
  const [cookies, setCookies] = useState('[]');
  const [browser, setBrowser] = useState(false);
  const [loginUrl, setLoginUrl] = useState('');
  const [paginationType, setPaginationType] = useState<
    'none' | 'next' | 'page' | 'loadMore' | 'infinite'
  >('next');
  const [paginationSelector, setPaginationSelector] = useState('.next-page');
  const [pageTemplate, setPageTemplate] = useState(`${url}?page={page}`);
  const [timeoutMs, setTimeoutMs] = useState(30_000);
  const [retries, setRetries] = useState(2);
  const [concurrency, setConcurrency] = useState(2);
  const [delayMs, setDelayMs] = useState(500);
  const [maxRequests, setMaxRequests] = useState(100);
  const [actionsJson, setActionsJson] = useState('[]');
  const [datasetMode, setDatasetMode] = useState<'snapshot' | 'upsert' | 'append'>('snapshot');
  const [keyFields, setKeyFields] = useState('');
  const [allowPrivateNetworks, setAllowPrivateNetworks] = useState(false);
  const [retentionRunDays, setRetentionRunDays] = useState('');
  const [retentionMaxRuns, setRetentionMaxRuns] = useState('');
  const [retentionArtifactDays, setRetentionArtifactDays] = useState('');
  const [retentionLogDays, setRetentionLogDays] = useState('');
  const [destinations, setDestinations] = useState<OutputDestination[]>([]);
  const [outputBindings, setOutputBindings] = useState<string[]>([]);
  const [rules, setRules] = useState<Array<RuleRecord & { versions: RuleVersionRecord[] }>>([]);
  const [versionDiff, setVersionDiff] = useState<RuleHistoryDiff>([]);
  const [scheduleMode, setScheduleMode] = useState<'manual' | 'cron'>('manual');
  const [cron, setCron] = useState('0 8 * * *');
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [misfirePolicy, setMisfirePolicy] = useState<'skip' | 'run-once'>('skip');
  const [useAi, setUseAi] = useState(false);
  const [cacheScope] = useState(() => crypto.randomUUID());
  const [candidate, setCandidate] = useState<CrawlPlanDefinition | null>(null);
  const [preview, setPreviewData] = useState<Array<Record<string, unknown>>>([]);
  const [previewRecords, setPreviewRecords] = useState<CollectionPreviewRecord[]>([]);
  const [previewPlan, setPreviewPlan] = useState<CrawlPlanDefinition | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const setPreview = (data: Array<Record<string, unknown>>) => {
    setPreviewData(data);
    setPreviewRecords([]);
    setPreviewPlan(null);
    setPreviewRevision((version) => version + 1);
  };
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [working, setWorking] = useState(false);
  const [ruleDirty, setRuleDirty] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [inspectionId, setInspectionId] = useState<string | null>(null);
  const [inspectionImage, setInspectionImage] = useState('');
  const [inspectionField, setInspectionField] = useState('');
  const [inspectionActionIndex, setInspectionActionIndex] = useState<number | null>(null);
  const [inspectionTargets, setInspectionTargets] = useState<
    Record<string, BrowserElementMetadata>
  >({});
  const desktop = typeof window !== 'undefined' && Boolean(window.zhiyunRuntime);
  const [detailRuleDraft, setDetailRuleDraft] = useState('');
  const [detailActionsDraft, setDetailActionsDraft] = useState('[]');
  const [detailRuleError, setDetailRuleError] = useState('');
  const [listSourceDraft, setListSourceDraft] = useState('');
  const [detailSourceDraft, setDetailSourceDraft] = useState('');
  const [discoveryDraft, setDiscoveryDraft] = useState('');
  const [sourceConfigError, setSourceConfigError] = useState('');
  const [repairProposals, setRepairProposals] = useState<RuleRepairProposal[]>([]);
  const [testedProposalId, setTestedProposalId] = useState<string | null>(null);
  const [repairDiff, setRepairDiff] = useState<RuleHistoryDiff>([]);
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<TaskTemplate | null>(null);
  const [templateParameters, setTemplateParameters] = useState<Record<string, string>>({});
  const [templateLoading, setTemplateLoading] = useState(false);

  useEffect(() => {
    if (!id) return;
    runtimeClient
      .getTask(id)
      .then((loaded) => {
        setTask(loaded);
        setName(loaded.name);
        setUrl(loaded.startUrl);
        setLoginUrl(loaded.startUrl);
        setInstruction(loaded.instruction);
        setHeaders(JSON.stringify(loaded.requestSettings.headers, null, 2));
        setCookies(JSON.stringify(loaded.requestSettings.cookies, null, 2));
        setBrowser(loaded.browserSettings.enabled);
        setActionsJson(JSON.stringify(loaded.browserSettings.actions, null, 2));
        setTimeoutMs(loaded.requestSettings.timeoutMs);
        setRetries(loaded.requestSettings.retries);
        setConcurrency(loaded.requestSettings.concurrency);
        setDelayMs(loaded.requestSettings.delayMs);
        setMaxRequests(loaded.requestSettings.maxRequests);
        setDatasetMode(loaded.datasetSettings.mode);
        setKeyFields(loaded.datasetSettings.keyFields.join(', '));
        setAllowPrivateNetworks(loaded.networkPolicy.allowPrivateNetworks);
        setRetentionRunDays(String(loaded.retentionPolicy.runDays ?? ''));
        setRetentionMaxRuns(String(loaded.retentionPolicy.maxRuns ?? ''));
        setRetentionArtifactDays(String(loaded.retentionPolicy.artifactDays ?? ''));
        setRetentionLogDays(String(loaded.retentionPolicy.logDays ?? ''));
        setOutputBindings(loaded.outputBindings);
        setScheduleMode(loaded.schedule.mode);
        setCron(loaded.schedule.cron ?? '0 8 * * *');
        setTimezone(loaded.schedule.timezone);
        setMisfirePolicy(loaded.schedule.misfirePolicy);
        setPaginationType(loaded.pagination.type);
        if ('selector' in loaded.pagination) setPaginationSelector(loaded.pagination.selector);
        if (loaded.pagination.type === 'page') setPageTemplate(loaded.pagination.urlTemplate);
        if (loaded.activeRule) {
          setCandidate(loaded.activeRule.version.definition);
          void runtimeClient
            .listRepairProposals(loaded.id, loaded.activeRule.rule.id)
            .then(setRepairProposals);
        }
        void runtimeClient.listRules(loaded.id).then(setRules);
      })
      .catch((reason: Error) => setError(reason.message));
  }, [id]);

  useEffect(() => {
    void runtimeClient
      .listOutputDestinations()
      .then(setDestinations)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (id) return;
    void runtimeClient
      .listTaskTemplates()
      .then(setTemplates)
      .catch(() => undefined);
  }, [id]);

  useEffect(() => {
    if (candidate?.detail) {
      setDetailRuleDraft(JSON.stringify(candidate.detail.rule, null, 2));
      setDetailActionsDraft(JSON.stringify(candidate.detail.actions, null, 2));
    } else {
      setDetailRuleDraft('');
      setDetailActionsDraft('[]');
    }
    setDetailRuleError('');
  }, [candidate?.detail?.rule, candidate?.detail?.actions]);

  useEffect(() => {
    setListSourceDraft(
      candidate?.list.source ? JSON.stringify(candidate.list.source, null, 2) : '',
    );
    setDetailSourceDraft(
      candidate?.detail?.source ? JSON.stringify(candidate.detail.source, null, 2) : '',
    );
    setDiscoveryDraft(candidate?.discovery ? JSON.stringify(candidate.discovery, null, 2) : '');
    setSourceConfigError('');
  }, [candidate?.list.source, candidate?.detail?.source, candidate?.discovery]);

  const taskPayload = () => {
    const timezoneError = validateTimezone(timezone);
    if (timezoneError) throw new Error(timezoneError);
    if (scheduleMode === 'cron') {
      const cronError = validateFiveFieldCron(cron);
      if (cronError) throw new Error(cronError);
    }
    const parsedHeaders = JSON.parse(headers) as Record<string, string>;
    const parsedCookies = JSON.parse(cookies) as unknown[];
    const parsedActions = parseBrowserActions(actionsJson, inspectionTargets);
    const pagination =
      paginationType === 'next'
        ? { type: 'next' as const, selector: paginationSelector, maxPages: 10 }
        : paginationType === 'loadMore'
          ? { type: 'loadMore' as const, selector: paginationSelector, maxClicks: 10, waitMs: 500 }
          : paginationType === 'infinite'
            ? { type: 'infinite' as const, maxScrolls: 10, waitMs: 500 }
            : paginationType === 'page'
              ? { type: 'page' as const, urlTemplate: pageTemplate, startPage: 1, maxPages: 10 }
              : { type: 'none' as const };
    return taskCreateSchema.parse({
      name,
      startUrl: url,
      instruction,
      schedule:
        scheduleMode === 'cron'
          ? { mode: 'cron' as const, cron, timezone, misfirePolicy }
          : { mode: 'manual' as const, timezone, misfirePolicy: 'skip' as const },
      requestSettings: {
        ...defaultRequest,
        headers: parsedHeaders,
        cookies: parsedCookies,
        timeoutMs,
        retries,
        concurrency,
        delayMs,
        maxRequests,
      },
      browserSettings: {
        enabled: browser,
        waitUntil: 'domcontentloaded' as const,
        actions: parsedActions,
      },
      credentialBindings: task?.credentialBindings ?? {},
      pagination,
      outputSettings: { persistRecords: true },
      datasetSettings: {
        mode: datasetMode,
        keyFields: keyFields
          .split(',')
          .map((field) => field.trim())
          .filter(Boolean),
        detectRemoved: datasetMode === 'snapshot',
      },
      retentionPolicy: {
        runDays: retentionRunDays ? Number(retentionRunDays) : null,
        maxRuns: retentionMaxRuns ? Number(retentionMaxRuns) : null,
        artifactDays: retentionArtifactDays ? Number(retentionArtifactDays) : null,
        logDays: retentionLogDays ? Number(retentionLogDays) : null,
      },
      networkPolicy: { allowPrivateNetworks, allowedHosts: [], allowedCidrs: [] },
      outputBindings,
    });
  };

  const persistTask = async () => {
    const payload = taskPayload();
    if (id) {
      const updated = await runtimeClient.updateTask(id, payload);
      setTask((current) => (current ? { ...current, ...updated } : updated));
      setHeaders(JSON.stringify(updated.requestSettings.headers, null, 2));
      setCookies('[]');
      return id;
    }
    throw new Error(productCopy('新任务必须通过原子初始化保存任务与首个规则版本'));
  };

  const analyze = async (taskId?: string) => {
    setWorking(true);
    setError('');
    setMessage('');
    try {
      const result = taskId
        ? await runtimeClient.analyzeTask(taskId, { useAi, forceBrowser: browser })
        : await runtimeClient.analyzeDraftTask(taskPayload(), {
            useAi,
            forceBrowser: browser,
            cacheScope,
          });
      setAnalysis(result);
      setCandidate(result.candidate);
      setPreview(result.preview);
      setPreviewPlan(result.candidate);
      setRuleDirty(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  const clearRuleCache = async () => {
    setWorking(true);
    setError('');
    setMessage('');
    try {
      const result = await runtimeClient.clearRuleCache(id ? { taskId: id } : { cacheScope });
      setAnalysis((current) => {
        if (!current) return current;
        const next = { ...current };
        delete next.cache;
        delete next.actionCache;
        return next;
      });
      setMessage(`${productCopy('规则缓存已清理')} · ${result.deleted}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  const runAiExtractDemo = async () => {
    if (!candidate) return;
    setWorking(true);
    setError('');
    try {
      const result = id
        ? await runtimeClient.runAiExtractDemo(id, candidate)
        : await runtimeClient.runDraftAiExtractDemo(taskPayload(), candidate);
      setPreview(result.records);
      setPreviewPlan(candidate);
      setMessage(productCopy('AI Extract Demo 已完成；预览不会保存或修改正式规则。'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  useEffect(() => {
    if (id && task && searchParams.get('analyze') === '1') void analyze(id);
  }, [id, task]);

  const saveTask = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setError('');
    try {
      if (!id) {
        if (candidate) validateTemplateReady();
        const payload = taskPayload();
        const definition = candidate ?? manualDraftDefinition;
        const created =
          selectedTemplate && candidate
            ? await runtimeClient.instantiateTaskTemplate(selectedTemplate.id, {
                startUrl: payload.startUrl,
                parameters: templateParameters,
                task: payload,
                definition,
                limit: 10,
                saveAsDraft: true,
              })
            : (
                await runtimeClient.createTaskWithInitialRule({
                  task: payload,
                  definition,
                  ruleName: initialRuleName(),
                  limit: 10,
                  saveAsDraft: true,
                })
              ).task;
        setTask(created);
        setMessage(`${t('taskSaved')}（草稿，首个规则版本已保存）`);
        void navigate(`/tasks/${created.id}/edit?professional=1`, { replace: true });
        return;
      }
      const currentId = await persistTask();
      if (id && candidate && (ruleDirty || !task?.activeRule)) {
        await persistCandidateRule(currentId);
      }
      setMessage(`${t('taskSaved')}（草稿）`);
      if (!id) void navigate(`/tasks/${currentId}/edit?professional=1`, { replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  const patchField = (fieldName: string, patch: Record<string, unknown>) => {
    if (!candidate) return;
    const rule = candidate.list.rule;
    const field = rule.fields[fieldName];
    if (!field) return;
    setCandidate({
      ...candidate,
      list: {
        ...candidate.list,
        rule: {
          ...rule,
          fields: { ...rule.fields, [fieldName]: { ...field, ...patch } },
        } as ExtractionRuleDefinition,
      },
    });
    setRuleDirty(true);
  };

  const updateField = (fieldName: string, key: 'selector' | 'path' | 'dataType', value: string) =>
    patchField(fieldName, { [key]: value });

  const renameField = (oldName: string, nextName: string) => {
    const name = nextName.trim();
    if (!candidate || !name || name === oldName || candidate.list.rule.fields[name]) return;
    const fields = Object.fromEntries(
      Object.entries(candidate.list.rule.fields).map(([key, field]) => [
        key === oldName ? name : key,
        field,
      ]),
    );
    setCandidate({
      ...candidate,
      list: {
        ...candidate.list,
        rule: { ...candidate.list.rule, fields } as ExtractionRuleDefinition,
      },
      ...(candidate.detail?.urlField === oldName
        ? { detail: { ...candidate.detail, urlField: name } }
        : {}),
    });
    setRuleDirty(true);
  };

  const updateFieldValue = (fieldName: string, value: 'text' | 'html' | 'attribute') => {
    if (!candidate) return;
    const field = candidate.list.rule.fields[fieldName];
    if (!field || !('value' in field)) return;
    const rest = { ...field };
    delete rest.attribute;
    patchField(
      fieldName,
      value === 'attribute' ? { ...rest, value, attribute: 'href' } : { ...rest, value },
    );
  };

  const updateContainer = (value: string) => {
    if (!candidate) return;
    setCandidate({
      ...candidate,
      list: { ...candidate.list, rule: { ...candidate.list.rule, container: value } },
    });
    setRuleDirty(true);
  };

  const addField = () => {
    if (!candidate) return;
    const name = window.prompt(productCopy('字段名称'));
    if (!name || candidate.list.rule.fields[name]) return;
    const rule = candidate.list.rule;
    const field =
      rule.type === 'json'
        ? { path: `$.${name}`, dataType: 'string' as const }
        : { selector: `.${name}`, value: 'text' as const, dataType: 'string' as const };
    setCandidate({
      ...candidate,
      list: {
        ...candidate.list,
        rule: { ...rule, fields: { ...rule.fields, [name]: field } } as ExtractionRuleDefinition,
      },
    });
    setRuleDirty(true);
  };

  const removeField = (name: string) => {
    if (!candidate || Object.keys(candidate.list.rule.fields).length <= 1) return;
    const fields = { ...candidate.list.rule.fields };
    delete fields[name];
    setCandidate({
      ...candidate,
      list: {
        ...candidate.list,
        rule: { ...candidate.list.rule, fields } as ExtractionRuleDefinition,
      },
    });
    setRuleDirty(true);
  };

  const toggleDetail = () => {
    if (!candidate) return;
    setCandidate({
      ...candidate,
      detail: candidate.detail
        ? undefined
        : {
            urlField: Object.keys(candidate.list.rule.fields).includes('url')
              ? 'url'
              : Object.keys(candidate.list.rule.fields)[0]!,
            rule: candidate.list.rule,
            mode: 'auto',
            actions: [],
            mergeStrategy: 'detailWins',
            onError: 'keep-list-record',
            concurrency: 2,
          },
    });
    setRuleDirty(true);
  };

  const testRule = async () => {
    if (!candidate) return;
    setWorking(true);
    setError('');
    try {
      validateTemplateReady();
      const result = id
        ? await (async () => {
            await persistTask();
            return runtimeClient.testRule(id, candidate, 10);
          })()
        : await runtimeClient.previewInitialRule({
            task: taskPayload(),
            definition: candidate,
            ruleName: initialRuleName(),
            limit: 10,
          });
      setPreview(result.records.map((record) => record.data));
      setPreviewRecords(result.records);
      setPreviewPlan(candidate);
      setMessage(
        result.records.length
          ? `预览测试成功，获得 ${result.records.length} 条记录。`
          : productCopy('预览请求已完成，但未提取到记录；请调整规则后再运行。'),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  const saveRule = async () => {
    if (!candidate) return;
    setWorking(true);
    setError('');
    try {
      if (!id) {
        validateTemplateReady();
        const payload = taskPayload();
        const created = selectedTemplate
          ? await runtimeClient.instantiateTaskTemplate(selectedTemplate.id, {
              startUrl: payload.startUrl,
              parameters: templateParameters,
              task: payload,
              definition: candidate,
              limit: 10,
              saveAsDraft: true,
            })
          : (
              await runtimeClient.createTaskWithInitialRule({
                task: payload,
                definition: candidate,
                ruleName: initialRuleName(),
                limit: 10,
                saveAsDraft: true,
              })
            ).task;
        setTask(created);
        void navigate(`/tasks/${created.id}/edit?professional=1`, { replace: true });
      } else {
        await persistCandidateRule(id);
      }
      setMessage(t('ruleSaved'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  const initialRuleName = () =>
    selectedTemplate ? `${productCopy(selectedTemplate.name)}规则` : 'Default rule';

  const validateTemplateReady = () => {
    if (!selectedTemplate) return;
    const missing = missingTemplateParameters(selectedTemplate, templateParameters);
    if (missing.length) throw new Error(`请先填写模板参数：${missing.join('、')}`);
  };

  const persistCandidateRule = async (currentId: string) => {
    if (!candidate) throw new Error(productCopy('请先生成或选择规则'));
    const generatedBy = ruleDirty ? 'human' : analysis?.aiUsed ? 'ai' : 'system';
    if (task?.activeRule) {
      await runtimeClient.createRuleVersion(currentId, task.activeRule.rule.id, {
        definition: candidate,
        generatedBy,
      });
    } else {
      await runtimeClient.createRule(currentId, {
        name: initialRuleName(),
        definition: candidate,
        generatedBy,
      });
    }
    setRuleDirty(false);
    const loaded = await runtimeClient.getTask(currentId);
    setTask(loaded);
    setRules(await runtimeClient.listRules(currentId));
  };

  const saveAndRun = async () => {
    if (!candidate) {
      setError(productCopy('保存并运行前，请先选择模板或分析网页生成规则。'));
      return;
    }
    setWorking(true);
    setError('');
    setMessage('');
    try {
      validateTemplateReady();
      if (!id) {
        const payload = taskPayload();
        const tested = await runtimeClient.previewInitialRule({
          task: payload,
          definition: candidate,
          ruleName: initialRuleName(),
          limit: 10,
        });
        setPreview(tested.records.map((record) => record.data));
        setPreviewRecords(tested.records);
        setPreviewPlan(candidate);
        if (!tested.records.length) {
          throw new Error(
            productCopy('预览未提取到数据，已取消创建和运行。请调整字段或页面动作后重试。'),
          );
        }
        if (selectedTemplate) {
          const created = await runtimeClient.instantiateTaskTemplate(selectedTemplate.id, {
            startUrl: payload.startUrl,
            parameters: templateParameters,
            task: payload,
            definition: candidate,
            previewKey: tested.previewKey,
            limit: 10,
          });
          setTask(created);
          const run = await runtimeClient.runTask(created.id);
          void navigate(`/runs/${run.runId}`);
          return;
        }
        const created = await runtimeClient.createTaskWithInitialRule({
          task: payload,
          definition: candidate,
          previewKey: tested.previewKey,
          ruleName: initialRuleName(),
          limit: 10,
          runAfterCreate: true,
        });
        setTask(created.task);
        if (!created.run)
          throw new Error(productCopy('任务已创建，但 Runtime 未返回首次运行记录。'));
        void navigate(`/runs/${created.run.id}`);
        return;
      }

      await persistTask();
      const tested = await runtimeClient.testRule(id, candidate, 10);
      setPreview(tested.records.map((record) => record.data));
      setPreviewRecords(tested.records);
      setPreviewPlan(candidate);
      if (!tested.records.length) {
        throw new Error(productCopy('预览未提取到数据，已取消运行。请调整规则后重试。'));
      }
      if (ruleDirty || !task?.activeRule) await persistCandidateRule(id);
      const run = await runtimeClient.runTask(id);
      void navigate(`/runs/${run.runId}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  const loginSession = async () => {
    if (!id) return;
    setWorking(true);
    setError('');
    try {
      const result = await runtimeClient.startLoginSession(id, loginUrl || url);
      if (result.task) setTask(await runtimeClient.getTask(id));
      setBrowser(!result.canceled);
      setMessage(result.canceled ? productCopy('登录已取消') : productCopy('登录态已安全保存'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  const promptTaskCredential = async (kind: 'secretHeaders' | 'cookies' | 'proxy') => {
    if (!id || !task) return;
    setWorking(true);
    setError('');
    try {
      const result = await runtimeClient.promptTaskCredential(id, kind, task.revision);
      if (!result.canceled) {
        setTask(await runtimeClient.getTask(id));
        setMessage(productCopy('凭据已由 Desktop Host 加密保存'));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  const clearTaskCredential = async (kind: 'secretHeaders' | 'cookies' | 'proxy') => {
    if (!id || !task) return;
    try {
      await runtimeClient.deleteTaskCredential(id, kind, task.revision);
      setTask(await runtimeClient.getTask(id));
      setMessage(productCopy('凭据已删除'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const refreshInspection = async (sessionId: string) => {
    const screenshot = await runtimeClient.getInspectionScreenshot(sessionId);
    setInspectionImage(`data:image/png;base64,${screenshot.image}`);
  };

  const executeInspectionStep = async (stepIndex: number, action: BrowserAction) => {
    if (!id) throw new Error(productCopy('请先保存任务，再逐步执行浏览器动作'));
    setError('');
    let sessionId = inspectionId;
    if (!sessionId) {
      const session = await runtimeClient.createInspectionSession(id);
      sessionId = session.id;
      setInspectionId(session.id);
    }
    const result = await runtimeClient.executeInspectionStep(sessionId, stepIndex, action);
    const observedTarget = result.target;
    if (observedTarget && 'selector' in action) {
      setInspectionTargets((current) => ({ ...current, [action.selector]: observedTarget }));
    }
    if (result.screenshot.image) {
      setInspectionImage(`data:image/png;base64,${result.screenshot.image}`);
    }
    return result;
  };

  const openInspection = async (actionIndex?: number) => {
    if (!id) return;
    if (actionIndex === undefined && (!candidate || candidate.list.rule.type === 'json')) return;
    setWorking(true);
    setError('');
    try {
      const session = await runtimeClient.createInspectionSession(id);
      setInspectionId(session.id);
      setInspectionActionIndex(actionIndex ?? null);
      if (actionIndex === undefined && candidate) {
        setInspectionField(inspectionField || Object.keys(candidate.list.rule.fields)[0] || '');
      }
      await refreshInspection(session.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  const selectInspectionElement = async (event: MouseEvent<HTMLImageElement>) => {
    if (!inspectionId || (inspectionActionIndex === null && !inspectionField)) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = {
      x: ((event.clientX - bounds.left) / bounds.width) * 1280,
      y: ((event.clientY - bounds.top) / bounds.height) * 800,
    };
    try {
      const selected = await runtimeClient.selectInspectionElement(inspectionId, point);
      if (inspectionActionIndex !== null) {
        setInspectionTargets((current) => ({
          ...current,
          [selected.selector]: selected.metadata,
        }));
        setActionsJson(updateActionSelector(actionsJson, inspectionActionIndex, selected));
        setMessage(`已将第 ${inspectionActionIndex + 1} 个动作更新为 ${selected.selector}`);
      } else {
        updateField(inspectionField, 'selector', selected.selector);
        setMessage(`已将 ${inspectionField} 更新为 ${selected.selector}`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const closeInspection = async () => {
    if (inspectionId) {
      await runtimeClient.closeInspectionSession(inspectionId).catch(() => undefined);
    }
    setInspectionId(null);
    setInspectionImage('');
    setInspectionActionIndex(null);
  };

  // Keep the guard at the call site so production builds remove the configured
  // URL itself, including when the dev launcher passes VITE_FIXTURE_URL.
  const developmentFixtureUrl = import.meta.env.DEV
    ? resolveDevelopmentFixture(true, import.meta.env.VITE_FIXTURE_URL)
    : undefined;

  const loadDevelopmentDemo = () => {
    if (!developmentFixtureUrl) return;
    const demoUrl = `${developmentFixtureUrl}/products`;
    setUrl(demoUrl);
    setPageTemplate(`${demoUrl}?page={page}`);
    if (!name) setName(productCopy('开发环境商品采集'));
    setInstruction(productCopy('获取商品名称、价格、销量和链接'));
    setMessage(productCopy('已加载开发环境演示地址；该入口不会出现在生产构建中。'));
  };

  const applyOfficialTemplate = async (templateId: string) => {
    setTemplateLoading(true);
    setError('');
    try {
      const template = await runtimeClient.getTaskTemplate(templateId);
      const parameters = templateParameterDefaults(template);
      const definition = applyTemplateParameters(template, parameters);
      setSelectedTemplate(template);
      setTemplateParameters(parameters);
      setCandidate(definition);
      setName(template.taskDefaults.name ?? template.name);
      setInstruction(template.taskDefaults.instruction ?? template.description);
      setBrowser(
        template.taskDefaults.browserSettings?.enabled ?? template.compatibility.browserRequired,
      );
      setActionsJson(
        JSON.stringify(
          template.taskDefaults.browserSettings?.actions ?? definition.list.actions,
          null,
          2,
        ),
      );
      setPaginationType(definition.pagination.type);
      if ('selector' in definition.pagination)
        setPaginationSelector(definition.pagination.selector);
      if (definition.pagination.type === 'page') setPageTemplate(definition.pagination.urlTemplate);
      if (template.taskDefaults.schedule) {
        setScheduleMode(template.taskDefaults.schedule.mode);
        setCron(template.taskDefaults.schedule.cron ?? '0 8 * * *');
        setTimezone(template.taskDefaults.schedule.timezone);
        setMisfirePolicy(template.taskDefaults.schedule.misfirePolicy);
      }
      if (template.taskDefaults.datasetSettings) {
        setDatasetMode(template.taskDefaults.datasetSettings.mode);
        setKeyFields(template.taskDefaults.datasetSettings.keyFields.join(', '));
      }
      setRuleDirty(false);
      setPreview([]);
      setMessage(
        `已加载官方模板“${productCopy(template.name)}”；填写 URL 与模板参数后先测试再保存。`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTemplateLoading(false);
    }
  };

  const updateTemplateParameter = (key: string, value: string) => {
    if (!selectedTemplate) return;
    const next = { ...templateParameters, [key]: value };
    setTemplateParameters(next);
    setCandidate(applyTemplateParameters(selectedTemplate, next));
    setRuleDirty(true);
  };

  const compareVersions = async (ruleId: string, from: number, to: number) => {
    if (!id) return;
    const result = await runtimeClient.diffRuleVersions(id, ruleId, from, to);
    setVersionDiff(result.changes);
  };

  const rollbackVersion = async (ruleId: string, version: number) => {
    if (!id) return;
    await runtimeClient.rollbackRule(id, ruleId, version);
    const loaded = await runtimeClient.getTask(id);
    setTask(loaded);
    setCandidate(loaded.activeRule?.version.definition ?? null);
    setRules(await runtimeClient.listRules(id));
  };

  const requestRepair = async (ruleId: string, failure: string) => {
    if (!id) return;
    if (!failure.trim()) return;
    setWorking(true);
    setError('');
    try {
      const proposal = await runtimeClient.createRepairProposal(id, ruleId, failure);
      setRepairProposals((current) => [proposal, ...current]);
      setRepairDiff(proposal.diff);
      setTestedProposalId(null);
      setMessage(productCopy('AI 修复建议已生成；请先查看 Diff 并测试'));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  const testRepair = async (proposal: RuleRepairProposal) => {
    if (!id) return;
    setWorking(true);
    try {
      const result = await runtimeClient.testRepairProposal(id, proposal.ruleId, proposal.id);
      setPreview(result.records.map((record) => record.data));
      setPreviewRecords(result.records);
      setPreviewPlan(candidate);
      setTestedProposalId(proposal.id);
      setRepairProposals((current) =>
        current.map((item) =>
          item.id === proposal.id ? { ...item, testedAt: new Date().toISOString() } : item,
        ),
      );
      setMessage(`修复建议测试通过，预览 ${result.records.length} 条`);
    } catch (reason) {
      setTestedProposalId(null);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  const reviewRepair = async (proposal: RuleRepairProposal, action: 'apply' | 'reject') => {
    if (!id || !task?.activeRule) return;
    if (action === 'apply' && testedProposalId !== proposal.id) {
      setError(productCopy('应用前必须先测试修复建议'));
      return;
    }
    try {
      await runtimeClient.reviewRepairProposal(id, task.activeRule.rule.id, proposal.id, action);
      const loaded = await runtimeClient.getTask(id);
      setTask(loaded);
      setCandidate(loaded.activeRule?.version.definition ?? candidate);
      setRepairProposals((current) =>
        current.map((item) =>
          item.id === proposal.id
            ? { ...item, status: action === 'apply' ? 'applied' : 'rejected' }
            : item,
        ),
      );
      setMessage(
        action === 'apply'
          ? productCopy('修复建议已创建为新 RuleVersion')
          : productCopy('修复建议已拒绝'),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const fields = useMemo(
    () => (candidate ? Object.entries(candidate.list.rule.fields) : []),
    [candidate],
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <Link className="back-link" to={id ? `/tasks/${id}` : '/tasks'}>
            ← {t('back')}
          </Link>
          <h1>{id ? t('edit') : t('newTask')}</h1>
          <p>{t('createHint')}</p>
        </div>
      </div>
      <ErrorNotice message={error} />
      {message && <div className="notice notice-success">{message}</div>}
      {!id && (
        <Card className="task-start-card">
          <div className="section-heading compact">
            <div>
              <h2>{productCopy('选择创建方式')}</h2>
              <p>{productCopy('手动配置当前表单，或交给 AI 助手对话生成并测试同一种任务草稿。')}</p>
            </div>
            <Link className="button" to="/tasks/new?mode=ai">
              {productCopy('✦ AI 对话创建')}
            </Link>
          </div>
          <div
            className="scenario-grid official-template-grid"
            aria-label={productCopy('官方模板')}
          >
            {(templates.length ? templates : officialTemplateFallbacks).map((template) => (
              <button
                type="button"
                className={selectedTemplate?.id === template.id ? 'active' : ''}
                disabled={templateLoading}
                key={template.id}
                onClick={() => void applyOfficialTemplate(template.id)}
              >
                <strong>{productCopy(template.name)}</strong>
                <small>{template.description}</small>
              </button>
            ))}
          </div>
          {selectedTemplate && selectedTemplate.parameters.length > 0 && (
            <div className="template-parameters">
              <div>
                <strong>
                  {productCopy(selectedTemplate.name)} {productCopy('参数')}
                </strong>
                <small>{productCopy('可稍后在规则编辑器继续微调 Selector。')}</small>
              </div>
              <div className="form-grid">
                {selectedTemplate.parameters.map((parameter) => (
                  <label key={parameter.key}>
                    <span>{productCopy(parameter.label)}</span>
                    <Input
                      required={parameter.required}
                      type={parameter.type === 'number' ? 'number' : 'text'}
                      value={templateParameters[parameter.key] ?? ''}
                      onChange={(event) =>
                        updateTemplateParameter(parameter.key, event.target.value)
                      }
                    />
                  </label>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}
      <form onSubmit={(event) => void saveTask(event)}>
        <Card className="editor-card">
          <div className="form-grid">
            <label>
              <span>{t('name')}</span>
              <Input
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={productCopy('商品采集')}
              />
            </label>
            <label>
              <span>{t('url')}</span>
              <Input
                required
                type="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
              {developmentFixtureUrl && (
                <button className="inline-demo-link" type="button" onClick={loadDevelopmentDemo}>
                  {productCopy('加载开发演示')}
                </button>
              )}
            </label>
            <label className="full">
              <span>{t('instruction')}</span>
              <textarea
                required
                rows={3}
                value={instruction}
                onChange={(event) => setInstruction(event.target.value)}
              />
            </label>
          </div>
          <div className="primary-actions">
            <Button type="button" disabled={working} onClick={() => void analyze(id)}>
              {working ? t('analyzing') : `✦ ${t('analyze')}`}
            </Button>
            <Button className="button-secondary" type="submit">
              {productCopy('保存草稿')}
            </Button>
            <Button
              type="button"
              disabled={working || !candidate}
              onClick={() => void saveAndRun()}
            >
              {productCopy('预览通过后保存并运行')}
            </Button>
            {candidate && (
              <Button
                className="button-secondary"
                type="button"
                disabled={working}
                onClick={() => void runAiExtractDemo()}
              >
                {productCopy('AI 提取测试')}
              </Button>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={useAi}
                onChange={(event) => setUseAi(event.target.checked)}
              />{' '}
              {t('useAi')}
            </label>
          </div>
          <details>
            <summary>{t('advanced')}</summary>
            <div className="form-grid advanced-grid">
              <label className="check">
                <input
                  type="checkbox"
                  checked={browser}
                  onChange={(event) => setBrowser(event.target.checked)}
                />{' '}
                {t('browser')}
              </label>
              {id && (
                <div>
                  <span className="field-label">{productCopy('登录 Session')}</span>
                  <label>
                    <span>{productCopy('登录 URL')}</span>
                    <Input
                      type="url"
                      value={loginUrl}
                      placeholder={url}
                      onChange={(event) => setLoginUrl(event.target.value)}
                    />
                  </label>
                  <Button
                    type="button"
                    className="button-secondary"
                    disabled={working}
                    onClick={() => void loginSession()}
                  >
                    {task?.credentialBindings.browserStorageStateRef
                      ? productCopy('重新登录')
                      : productCopy('打开安全登录窗口')}
                  </Button>
                </div>
              )}
              <label>
                <span>{t('pagination')}</span>
                <select
                  value={paginationType}
                  onChange={(event) =>
                    setPaginationType(event.target.value as typeof paginationType)
                  }
                >
                  <option value="none">{productCopy('不分页')}</option>
                  <option value="next">{productCopy('下一页链接')}</option>
                  <option value="page">{productCopy('页码递增')}</option>
                  <option value="loadMore">{productCopy('加载更多')}</option>
                  <option value="infinite">{productCopy('无限滚动')}</option>
                </select>
              </label>
              {(paginationType === 'next' || paginationType === 'loadMore') && (
                <label>
                  <span>{t('paginationSelector')}</span>
                  <Input
                    value={paginationSelector}
                    onChange={(event) => setPaginationSelector(event.target.value)}
                  />
                </label>
              )}
              {paginationType === 'page' && (
                <label>
                  <span>{productCopy('分页网址模板')}</span>
                  <Input
                    value={pageTemplate}
                    onChange={(event) => setPageTemplate(event.target.value)}
                  />
                </label>
              )}
              <label>
                <span>{productCopy('请求超时（毫秒）')}</span>
                <Input
                  type="number"
                  value={timeoutMs}
                  onChange={(event) => setTimeoutMs(Number(event.target.value))}
                />
              </label>
              <label>
                <span>{productCopy('重试次数')}</span>
                <Input
                  type="number"
                  value={retries}
                  onChange={(event) => setRetries(Number(event.target.value))}
                />
              </label>
              <label>
                <span>{productCopy('并发请求数')}</span>
                <Input
                  type="number"
                  value={concurrency}
                  onChange={(event) => setConcurrency(Number(event.target.value))}
                />
              </label>
              <label>
                <span>{productCopy('请求间隔（毫秒）')}</span>
                <Input
                  type="number"
                  value={delayMs}
                  onChange={(event) => setDelayMs(Number(event.target.value))}
                />
              </label>
              <label>
                <span>{productCopy('最多请求数')}</span>
                <Input
                  type="number"
                  value={maxRequests}
                  onChange={(event) => setMaxRequests(Number(event.target.value))}
                />
              </label>
              <ScheduleBuilder
                mode={scheduleMode}
                cron={cron}
                timezone={timezone}
                misfirePolicy={misfirePolicy}
                onModeChange={setScheduleMode}
                onCronChange={setCron}
                onTimezoneChange={setTimezone}
                onMisfirePolicyChange={setMisfirePolicy}
              />
              {desktop ? (
                <div className="full credential-bindings">
                  <span className="field-label">
                    {productCopy('敏感请求凭据（由 Desktop Host 安全输入）')}
                  </span>
                  {(
                    [
                      [
                        'secretHeaders',
                        productCopy('Authorization / 敏感 Headers'),
                        'secretHeadersRef',
                      ],
                      ['cookies', 'Cookies', 'cookiesRef'],
                      ['proxy', 'Proxy', 'proxyRef'],
                    ] as const
                  ).map(([kind, label, binding]) => (
                    <div className="credential-binding" key={kind}>
                      <Badge tone={task?.credentialBindings[binding] ? 'success' : 'neutral'}>
                        {task?.credentialBindings[binding]
                          ? productCopy('已保存')
                          : productCopy('未设置')}
                      </Badge>
                      <span>{productCopy(label)}</span>
                      <Button
                        type="button"
                        className="button-secondary"
                        onClick={() => void promptTaskCredential(kind)}
                      >
                        {task?.credentialBindings[binding]
                          ? productCopy('替换')
                          : productCopy('安全输入')}
                      </Button>
                      {task?.credentialBindings[binding] && (
                        <Button
                          type="button"
                          className="button-danger"
                          onClick={() => void clearTaskCredential(kind)}
                        >
                          {productCopy('删除')}
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <>
                  <label>
                    <span>{t('headers')}</span>
                    <textarea
                      rows={5}
                      value={headers}
                      onChange={(event) => setHeaders(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>{t('cookies')}</span>
                    <textarea
                      rows={5}
                      value={cookies}
                      onChange={(event) => setCookies(event.target.value)}
                    />
                  </label>
                </>
              )}
              <BrowserActionEditor
                value={actionsJson}
                onChange={setActionsJson}
                knownTargets={inspectionTargets}
                onPickSelector={id && candidate ? (index) => void openInspection(index) : undefined}
                onExecuteStep={id ? executeInspectionStep : undefined}
              />
              <label>
                <span>{productCopy('数据更新方式')}</span>
                <select
                  value={datasetMode}
                  onChange={(event) => setDatasetMode(event.target.value as typeof datasetMode)}
                >
                  <option value="snapshot">{productCopy('完整快照')}</option>
                  <option value="upsert">{productCopy('按唯一字段更新')}</option>
                  <option value="append">{productCopy('追加记录')}</option>
                </select>
              </label>
              <label>
                <span>{productCopy('唯一标识字段')}</span>
                <Input
                  value={keyFields}
                  onChange={(event) => setKeyFields(event.target.value)}
                  placeholder="id, url"
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={allowPrivateNetworks}
                  onChange={(event) => setAllowPrivateNetworks(event.target.checked)}
                />
                {productCopy('允许 localhost / 私网（可能访问本机服务）')}
              </label>
              <div className="full">
                <span className="field-label">
                  {productCopy('数据保留策略（留空表示不自动删除）')}
                </span>
                <div className="form-grid">
                  <label>
                    <span>{productCopy('Run 保留天数')}</span>
                    <Input
                      type="number"
                      min={1}
                      value={retentionRunDays}
                      onChange={(event) => setRetentionRunDays(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>{productCopy('最多保留 Run 数')}</span>
                    <Input
                      type="number"
                      min={1}
                      value={retentionMaxRuns}
                      onChange={(event) => setRetentionMaxRuns(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>{productCopy('导出 Artifact 保留天数')}</span>
                    <Input
                      type="number"
                      min={1}
                      value={retentionArtifactDays}
                      onChange={(event) => setRetentionArtifactDays(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>{productCopy('日志保留天数')}</span>
                    <Input
                      type="number"
                      min={1}
                      value={retentionLogDays}
                      onChange={(event) => setRetentionLogDays(event.target.value)}
                    />
                  </label>
                </div>
              </div>
              <div className="full">
                <span className="field-label">{productCopy('输出目的地')}</span>
                <div className="binding-list">
                  {destinations.map((destination) => (
                    <label className="check" key={destination.id}>
                      <input
                        type="checkbox"
                        checked={outputBindings.includes(destination.id)}
                        onChange={(event) =>
                          setOutputBindings((current) =>
                            event.target.checked
                              ? [...current, destination.id]
                              : current.filter((id) => id !== destination.id),
                          )
                        }
                      />
                      {destination.name} ({destination.type})
                    </label>
                  ))}
                  {!destinations.length && (
                    <Link to="/outputs">{productCopy('先创建输出目的地')}</Link>
                  )}
                </div>
              </div>
            </div>
          </details>
        </Card>
      </form>

      {candidate && (
        <Card>
          <div className="section-heading">
            <div>
              <h2>{productCopy('提取规则')}</h2>
              <p>
                {candidate.list.rule.type.toUpperCase()} · {analysis?.engine ?? 'saved'}{' '}
                {analysis?.aiUsed ? '· AI' : ''}
              </p>
            </div>
            <div className="row-actions">
              {(analysis?.cache || analysis?.actionCache) && (
                <Button
                  className="button-secondary"
                  disabled={working}
                  onClick={() => void clearRuleCache()}
                >
                  {productCopy('清理规则缓存')}
                </Button>
              )}
              <Button
                className="button-secondary"
                disabled={working}
                onClick={() => void testRule()}
              >
                {t('testRule')}
              </Button>
              <Button disabled={working} onClick={() => void saveRule()}>
                {t('saveRule')}
              </Button>
              {candidate.list.rule.type !== 'json' && (
                <Button
                  className="button-secondary"
                  disabled={working || !id}
                  onClick={() => void openInspection()}
                >
                  {productCopy('可视化点选')}
                </Button>
              )}
            </div>
          </div>
          {inspectionId && inspectionImage && (
            <div className="inspection-panel">
              <div className="section-heading">
                <div>
                  <h3>{productCopy('页面检查器')}</h3>
                  <p>
                    {inspectionActionIndex === null
                      ? productCopy('选择字段后点击截图中的元素')
                      : `点击截图，为第 ${inspectionActionIndex + 1} 个动作选择元素`}
                  </p>
                </div>
                <div className="row-actions">
                  {inspectionActionIndex === null && (
                    <select
                      value={inspectionField}
                      onChange={(event) => setInspectionField(event.target.value)}
                    >
                      {fields.map(([name]) => (
                        <option key={name} value={name}>
                          {name}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button
                    className="button-secondary"
                    onClick={() => void refreshInspection(inspectionId)}
                  >
                    {productCopy('刷新')}
                  </Button>
                  <Button className="button-danger" onClick={() => void closeInspection()}>
                    {productCopy('关闭')}
                  </Button>
                </div>
              </div>
              <img
                src={inspectionImage}
                alt="Browser inspection"
                onClick={(event) => void selectInspectionElement(event)}
              />
            </div>
          )}
          <div className="table-wrap">
            <div className="rule-toolbar">
              <label>
                <span>{productCopy('记录容器')}</span>
                <Input
                  value={candidate.list.rule.container}
                  onChange={(event) => updateContainer(event.target.value)}
                />
              </label>
              <Button className="button-secondary" onClick={addField}>
                {productCopy('添加字段')}
              </Button>
              <Button className="button-secondary" onClick={toggleDetail}>
                {candidate.detail ? productCopy('移除详情步骤') : productCopy('添加详情步骤')}
              </Button>
            </div>
            <details className="advanced-rule-config">
              <summary>{productCopy('高级输入与 URL 发现')}</summary>
              <div className="form-grid">
                <label className="full">
                  <span>{productCopy('列表输入源 JSON（留空表示直接解析响应）')}</span>
                  <textarea
                    rows={5}
                    value={listSourceDraft}
                    placeholder={
                      '{"type":"script-json-assignment","selector":"script","marker":"_ROUTER_DATA ="}'
                    }
                    onChange={(event) => {
                      const value = event.target.value;
                      setListSourceDraft(value);
                      try {
                        const source = value.trim()
                          ? (JSON.parse(value) as CrawlPlanDefinition['list']['source'])
                          : undefined;
                        setCandidate({
                          ...candidate,
                          list: { ...candidate.list, source },
                        });
                        setSourceConfigError('');
                        setRuleDirty(true);
                      } catch {
                        setSourceConfigError(productCopy('列表输入源必须是有效 JSON'));
                      }
                    }}
                  />
                </label>
                <label className="full">
                  <span>{productCopy('Sitemap 发现 JSON（留空表示关闭）')}</span>
                  <textarea
                    rows={8}
                    value={discoveryDraft}
                    placeholder={
                      '{"type":"sitemap","urlField":"detailUrl","include":["/detail?series_id="],"maxDepth":1,"maxSitemaps":50,"maxUrls":1000}'
                    }
                    onChange={(event) => {
                      const value = event.target.value;
                      setDiscoveryDraft(value);
                      try {
                        const discovery = value.trim()
                          ? (JSON.parse(value) as CrawlPlanDefinition['discovery'])
                          : undefined;
                        setCandidate({ ...candidate, discovery });
                        setSourceConfigError('');
                        setRuleDirty(true);
                      } catch {
                        setSourceConfigError(productCopy('Sitemap 发现配置必须是有效 JSON'));
                      }
                    }}
                  />
                </label>
                {sourceConfigError && (
                  <small className="field-warning full">{sourceConfigError}</small>
                )}
              </div>
            </details>
            <table>
              <thead>
                <tr>
                  <th>{t('fields')}</th>
                  <th>{t('selector')}</th>
                  <th>{t('type')}</th>
                  <th>{productCopy('取值')}</th>
                  <th>{productCopy('示例 / 空值')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {fields.map(([fieldName, field]) => (
                  <tr key={fieldName}>
                    <td>
                      <Input
                        defaultValue={fieldName}
                        aria-label={`字段 ${fieldName}`}
                        onBlur={(event) => renameField(fieldName, event.target.value)}
                      />
                    </td>
                    <td>
                      <Input
                        value={'selector' in field ? field.selector : field.path}
                        onChange={(event) =>
                          updateField(
                            fieldName,
                            'selector' in field ? 'selector' : 'path',
                            event.target.value,
                          )
                        }
                      />
                    </td>
                    <td>
                      <select
                        value={field.dataType}
                        onChange={(event) => updateField(fieldName, 'dataType', event.target.value)}
                      >
                        <option value="string">{productCopy('文本')}</option>
                        <option value="number">{productCopy('数字')}</option>
                        <option value="url">URL</option>
                        <option value="date">{productCopy('日期')}</option>
                        <option value="json">JSON</option>
                      </select>
                    </td>
                    <td>
                      {'value' in field ? (
                        <div className="stacked-controls">
                          <select
                            value={field.value}
                            onChange={(event) =>
                              updateFieldValue(
                                fieldName,
                                event.target.value as 'text' | 'html' | 'attribute',
                              )
                            }
                          >
                            <option value="text">{productCopy('文本内容')}</option>
                            <option value="html">HTML</option>
                            <option value="attribute">{productCopy('属性值')}</option>
                          </select>
                          {field.value === 'attribute' && (
                            <Input
                              value={field.attribute ?? ''}
                              placeholder="href"
                              onChange={(event) =>
                                patchField(fieldName, { attribute: event.target.value })
                              }
                            />
                          )}
                        </div>
                      ) : (
                        'JSONPath'
                      )}
                    </td>
                    <td>
                      <code>
                        {String(
                          preview.find((record) => record[fieldName] != null)?.[fieldName] ?? '—',
                        ).slice(0, 80)}
                      </code>
                      <small>
                        {productCopy('空值')}
                        {preview.filter((record) => record[fieldName] == null).length}/
                        {preview.length}
                      </small>
                    </td>
                    <td>
                      <Button className="button-danger" onClick={() => removeField(fieldName)}>
                        {productCopy('删除')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {candidate.detail && (
            <div className="detail-builder">
              <h3>{productCopy('详情页步骤')}</h3>
              <div className="form-grid">
                <label>
                  <span>{productCopy('详情 URL 字段')}</span>
                  <select
                    value={candidate.detail.urlField}
                    onChange={(event) => {
                      setCandidate({
                        ...candidate,
                        detail: { ...candidate.detail!, urlField: event.target.value },
                      });
                      setRuleDirty(true);
                    }}
                  >
                    {fields.map(([name]) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{productCopy('详情运行模式')}</span>
                  <select
                    value={candidate.detail.mode}
                    onChange={(event) => {
                      setCandidate({
                        ...candidate,
                        detail: {
                          ...candidate.detail!,
                          mode: event.target.value as 'auto' | 'http' | 'browser',
                        },
                      });
                      setRuleDirty(true);
                    }}
                  >
                    <option value="auto">{productCopy('自动选择')}</option>
                    <option value="http">HTTP</option>
                    <option value="browser">{productCopy('内置浏览器')}</option>
                  </select>
                </label>
                <label>
                  <span>{productCopy('详情并发')}</span>
                  <Input
                    type="number"
                    min={1}
                    max={20}
                    value={candidate.detail.concurrency}
                    onChange={(event) => {
                      setCandidate({
                        ...candidate,
                        detail: {
                          ...candidate.detail!,
                          concurrency: Number(event.target.value),
                        },
                      });
                      setRuleDirty(true);
                    }}
                  />
                </label>
                <label>
                  <span>{productCopy('合并优先级')}</span>
                  <select
                    value={candidate.detail.mergeStrategy}
                    onChange={(event) => {
                      setCandidate({
                        ...candidate,
                        detail: {
                          ...candidate.detail!,
                          mergeStrategy: event.target.value as 'detailWins' | 'listWins',
                        },
                      });
                      setRuleDirty(true);
                    }}
                  >
                    <option value="detailWins">{productCopy('优先详情页字段')}</option>
                    <option value="listWins">{productCopy('优先列表页字段')}</option>
                  </select>
                </label>
                <label>
                  <span>{productCopy('详情失败策略')}</span>
                  <select
                    value={candidate.detail.onError}
                    onChange={(event) => {
                      setCandidate({
                        ...candidate,
                        detail: {
                          ...candidate.detail!,
                          onError: event.target.value as 'skip' | 'keep-list-record' | 'fail-run',
                        },
                      });
                      setRuleDirty(true);
                    }}
                  >
                    <option value="keep-list-record">{productCopy('保留列表记录')}</option>
                    <option value="skip">{productCopy('跳过此条记录')}</option>
                    <option value="fail-run">{productCopy('停止本次运行')}</option>
                  </select>
                </label>
                <label className="full">
                  <span>{productCopy('详情规则 JSON')}</span>
                  <textarea
                    rows={8}
                    value={detailRuleDraft}
                    onChange={(event) => {
                      setDetailRuleDraft(event.target.value);
                      try {
                        const rule = JSON.parse(event.target.value) as ExtractionRuleDefinition;
                        setCandidate({ ...candidate, detail: { ...candidate.detail!, rule } });
                        setDetailRuleError('');
                        setRuleDirty(true);
                      } catch {
                        setDetailRuleError(
                          productCopy('JSON 尚未形成有效规则，保存时仍使用上次有效内容'),
                        );
                      }
                    }}
                  />
                  {detailRuleError && <small className="field-warning">{detailRuleError}</small>}
                </label>
                <label className="full">
                  <span>{productCopy('详情输入源 JSON（留空表示直接解析响应）')}</span>
                  <textarea
                    rows={5}
                    value={detailSourceDraft}
                    placeholder={
                      '{"type":"script-json-assignment","selector":"script","marker":"_ROUTER_DATA ="}'
                    }
                    onChange={(event) => {
                      const value = event.target.value;
                      setDetailSourceDraft(value);
                      try {
                        const source = value.trim()
                          ? (JSON.parse(value) as CrawlPlanDefinition['list']['source'])
                          : undefined;
                        setCandidate({
                          ...candidate,
                          detail: { ...candidate.detail!, source },
                        });
                        setSourceConfigError('');
                        setRuleDirty(true);
                      } catch {
                        setSourceConfigError(productCopy('详情输入源必须是有效 JSON'));
                      }
                    }}
                  />
                </label>
                <label className="full">
                  <span>{productCopy('详情 Browser Actions (JSON)')}</span>
                  <textarea
                    rows={5}
                    value={detailActionsDraft}
                    onChange={(event) => {
                      setDetailActionsDraft(event.target.value);
                      try {
                        const actions = JSON.parse(
                          event.target.value,
                        ) as CrawlPlanDefinition['list']['actions'];
                        setCandidate({
                          ...candidate,
                          detail: { ...candidate.detail!, actions },
                        });
                        setRuleDirty(true);
                      } catch {
                        setDetailRuleError(productCopy('详情 Actions 必须是有效 JSON'));
                      }
                    }}
                  />
                </label>
              </div>
            </div>
          )}
          {analysis?.cache && <RuleCacheNotice result={analysis.cache} />}
          {analysis?.actionCache && <RuleCacheNotice result={analysis.actionCache} kind="action" />}
          {analysis?.warnings.map((warning) => (
            <div className="notice" key={warning}>
              {warning}
            </div>
          ))}
        </Card>
      )}
      <RuleHistory
        rules={rules}
        versionDiff={versionDiff}
        repairProposals={repairProposals}
        repairDiff={repairDiff}
        working={working}
        testedProposalId={testedProposalId}
        activeDefinition={task?.activeRule?.version.definition}
        compareVersions={compareVersions}
        rollbackVersion={rollbackVersion}
        requestRepair={requestRepair}
        testRepair={testRepair}
        reviewRepair={reviewRepair}
        onShowRepairDiff={setRepairDiff}
      />
      <Card>
        <h2>{t('preview')}</h2>
        {previewPlan && JSON.stringify(previewPlan) !== JSON.stringify(candidate) && (
          <p role="status">{productCopy('规则已修改，以下为上一次预览。请重新预览当前规则。')}</p>
        )}
        {candidate && previewRevision > 0 ? (
          <CollectionPreview
            key={previewRevision}
            plan={previewPlan ?? candidate}
            records={
              previewRecords.length
                ? previewRecords
                : preview.map((data) => ({ data, sourceUrl: url }))
            }
          />
        ) : (
          <PreviewTable records={preview} empty={t('noPreview')} />
        )}
      </Card>
    </>
  );
}

function PreviewTable({
  records,
  empty,
}: {
  records: Array<Record<string, unknown>>;
  empty: string;
}) {
  if (records.length === 0) return <div className="empty-small">{empty}</div>;
  const columns = [...new Set(records.flatMap((record) => Object.keys(record)))];
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.map((record, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td key={column}>{String(record[column] ?? '—')}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
