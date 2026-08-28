import { useEffect, useMemo, useState, type FormEvent, type MouseEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  taskCreateSchema,
  type CrawlPlanDefinition,
  type ExtractionRuleDefinition,
} from '@zhiyun/shared';
import type {
  OutputDestination,
  RuleRecord,
  RuleRepairProposal,
  RuleVersionRecord,
} from '@zhiyun/contracts';
import { runtimeClient } from '@zhiyun/client';
import { Badge, Button, Card, ErrorNotice, Input } from '../components/ui.js';
import type { Analysis, Task } from '../types.js';

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

export function TaskEditorPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [task, setTask] = useState<Task | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState(
    `${import.meta.env.VITE_FIXTURE_URL ?? 'http://127.0.0.1:45100'}/products`,
  );
  const [instruction, setInstruction] = useState('获取商品名称、价格、销量和链接');
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
  const [allowPrivateNetworks, setAllowPrivateNetworks] = useState(true);
  const [retentionRunDays, setRetentionRunDays] = useState('');
  const [retentionMaxRuns, setRetentionMaxRuns] = useState('');
  const [retentionArtifactDays, setRetentionArtifactDays] = useState('');
  const [retentionLogDays, setRetentionLogDays] = useState('');
  const [destinations, setDestinations] = useState<OutputDestination[]>([]);
  const [outputBindings, setOutputBindings] = useState<string[]>([]);
  const [rules, setRules] = useState<Array<RuleRecord & { versions: RuleVersionRecord[] }>>([]);
  const [versionDiff, setVersionDiff] = useState<
    Array<{ path: string; before: unknown; after: unknown }>
  >([]);
  const [scheduleMode, setScheduleMode] = useState<'manual' | 'cron'>('manual');
  const [cron, setCron] = useState('0 8 * * *');
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [misfirePolicy, setMisfirePolicy] = useState<'skip' | 'run-once'>('skip');
  const [useAi, setUseAi] = useState(false);
  const [candidate, setCandidate] = useState<CrawlPlanDefinition | null>(null);
  const [preview, setPreview] = useState<Array<Record<string, unknown>>>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [working, setWorking] = useState(false);
  const [ruleDirty, setRuleDirty] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [inspectionId, setInspectionId] = useState<string | null>(null);
  const [inspectionImage, setInspectionImage] = useState('');
  const [inspectionField, setInspectionField] = useState('');
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
  const [repairDiff, setRepairDiff] = useState<
    Array<{ path: string; before: unknown; after: unknown }>
  >([]);

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
    const parsedHeaders = JSON.parse(headers) as Record<string, string>;
    const parsedCookies = JSON.parse(cookies) as unknown[];
    const parsedActions = JSON.parse(actionsJson) as [];
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
    const created = await runtimeClient.createTask(payload);
    setHeaders(JSON.stringify(created.requestSettings.headers, null, 2));
    setCookies('[]');
    return created.id;
  };

  const analyze = async (taskId?: string) => {
    setWorking(true);
    setError('');
    setMessage('');
    try {
      const currentId = taskId ?? (await persistTask());
      const result = await runtimeClient.analyzeTask(currentId, {
        useAi,
        forceBrowser: browser,
      });
      setAnalysis(result);
      setCandidate(result.candidate);
      setPreview(result.preview);
      setRuleDirty(false);
      if (!id) void navigate(`/tasks/${currentId}/edit`, { replace: true });
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
      const currentId = id ?? (await persistTask());
      const result = await runtimeClient.runAiExtractDemo(currentId, candidate);
      setPreview(result.records);
      setMessage('AI Extract Demo 已完成；预览不会保存或修改正式规则。');
      if (!id) void navigate(`/tasks/${currentId}/edit`, { replace: true });
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
    setError('');
    try {
      const currentId = await persistTask();
      setMessage(t('taskSaved'));
      if (!id) void navigate(`/tasks/${currentId}/edit`, { replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
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
    const name = window.prompt('字段名称');
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
    if (!candidate || !id) return;
    setWorking(true);
    setError('');
    try {
      await persistTask();
      const result = await runtimeClient.testRule(id, candidate, 10);
      setPreview(result.records.map((record) => record.data));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  const saveRule = async () => {
    if (!candidate || !id) return;
    setWorking(true);
    setError('');
    try {
      const generatedBy = ruleDirty ? 'human' : analysis?.aiUsed ? 'ai' : 'system';
      if (task?.activeRule) {
        await runtimeClient.createRuleVersion(id, task.activeRule.rule.id, {
          definition: candidate,
          generatedBy,
        });
      } else {
        await runtimeClient.createRule(id, {
          name: 'Default rule',
          definition: candidate,
          generatedBy,
        });
      }
      setMessage(t('ruleSaved'));
      setRuleDirty(false);
      const loaded = await runtimeClient.getTask(id);
      setTask(loaded);
      setRules(await runtimeClient.listRules(id));
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
      setMessage(result.canceled ? '登录已取消' : '登录态已安全保存');
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
        setMessage('凭据已由 Desktop Host 加密保存');
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
      setMessage('凭据已删除');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const refreshInspection = async (sessionId: string) => {
    const screenshot = await runtimeClient.getInspectionScreenshot(sessionId);
    setInspectionImage(`data:image/png;base64,${screenshot.image}`);
  };

  const openInspection = async () => {
    if (!id || !candidate || candidate.list.rule.type === 'json') return;
    setWorking(true);
    setError('');
    try {
      const session = await runtimeClient.createInspectionSession(id);
      setInspectionId(session.id);
      setInspectionField(inspectionField || Object.keys(candidate.list.rule.fields)[0] || '');
      await refreshInspection(session.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setWorking(false);
    }
  };

  const selectInspectionElement = async (event: MouseEvent<HTMLImageElement>) => {
    if (!inspectionId || !inspectionField) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const point = {
      x: ((event.clientX - bounds.left) / bounds.width) * 1280,
      y: ((event.clientY - bounds.top) / bounds.height) * 800,
    };
    try {
      const selected = await runtimeClient.selectInspectionElement(inspectionId, point);
      updateField(inspectionField, 'selector', selected.selector);
      setMessage(`已将 ${inspectionField} 更新为 ${selected.selector}`);
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

  const requestRepair = async (ruleId: string) => {
    if (!id) return;
    const failure = window.prompt('描述当前规则失败现象', '页面结构变化，当前规则提取不到数据');
    if (!failure) return;
    setWorking(true);
    setError('');
    try {
      const proposal = await runtimeClient.createRepairProposal(id, ruleId, failure);
      setRepairProposals((current) => [proposal, ...current]);
      setRepairDiff(proposal.diff);
      setTestedProposalId(null);
      setMessage('AI 修复建议已生成；请先查看 Diff 并测试');
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
      setError('应用前必须先测试修复建议');
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
      setMessage(action === 'apply' ? '修复建议已创建为新 RuleVersion' : '修复建议已拒绝');
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
          <Link className="back-link" to={id ? `/tasks/${id}` : '/'}>
            ← {t('back')}
          </Link>
          <h1>{id ? t('edit') : t('newTask')}</h1>
          <p>{t('createHint')}</p>
        </div>
      </div>
      <ErrorNotice message={error} />
      {message && <div className="notice notice-success">{message}</div>}
      <form onSubmit={(event) => void saveTask(event)}>
        <Card className="editor-card">
          <div className="form-grid">
            <label>
              <span>{t('name')}</span>
              <Input
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="商品采集"
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
            <Button type="button" disabled={working} onClick={() => void analyze()}>
              {working ? t('analyzing') : `✦ ${t('analyze')}`}
            </Button>
            <Button className="button-secondary" type="submit">
              {t('save')}
            </Button>
            {candidate && (
              <Button
                className="button-secondary"
                type="button"
                disabled={working}
                onClick={() => void runAiExtractDemo()}
              >
                AI Extract Demo
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
                  <span className="field-label">登录 Session</span>
                  <label>
                    <span>登录 URL</span>
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
                      ? '重新登录'
                      : '打开安全登录窗口'}
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
                  <option value="none">None</option>
                  <option value="next">Next</option>
                  <option value="page">Page Number</option>
                  <option value="loadMore">Load More</option>
                  <option value="infinite">Infinite Scroll</option>
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
                  <span>URL Template</span>
                  <Input
                    value={pageTemplate}
                    onChange={(event) => setPageTemplate(event.target.value)}
                  />
                </label>
              )}
              <label>
                <span>Timeout (ms)</span>
                <Input
                  type="number"
                  value={timeoutMs}
                  onChange={(event) => setTimeoutMs(Number(event.target.value))}
                />
              </label>
              <label>
                <span>Retries</span>
                <Input
                  type="number"
                  value={retries}
                  onChange={(event) => setRetries(Number(event.target.value))}
                />
              </label>
              <label>
                <span>Concurrency</span>
                <Input
                  type="number"
                  value={concurrency}
                  onChange={(event) => setConcurrency(Number(event.target.value))}
                />
              </label>
              <label>
                <span>Request delay (ms)</span>
                <Input
                  type="number"
                  value={delayMs}
                  onChange={(event) => setDelayMs(Number(event.target.value))}
                />
              </label>
              <label>
                <span>Max requests</span>
                <Input
                  type="number"
                  value={maxRequests}
                  onChange={(event) => setMaxRequests(Number(event.target.value))}
                />
              </label>
              <label>
                <span>{t('schedule')}</span>
                <select
                  value={scheduleMode}
                  onChange={(event) => setScheduleMode(event.target.value as 'manual' | 'cron')}
                >
                  <option value="manual">Manual</option>
                  <option value="cron">Cron</option>
                </select>
              </label>
              {scheduleMode === 'cron' && (
                <>
                  <label>
                    <span>{t('cron')}</span>
                    <Input value={cron} onChange={(event) => setCron(event.target.value)} />
                  </label>
                  <label>
                    <span>{t('timezone')}</span>
                    <Input value={timezone} onChange={(event) => setTimezone(event.target.value)} />
                  </label>
                  <label>
                    <span>错过执行</span>
                    <select
                      value={misfirePolicy}
                      onChange={(event) =>
                        setMisfirePolicy(event.target.value as 'skip' | 'run-once')
                      }
                    >
                      <option value="skip">跳过（默认）</option>
                      <option value="run-once">恢复后补跑一次</option>
                    </select>
                  </label>
                </>
              )}
              {desktop ? (
                <div className="full credential-bindings">
                  <span className="field-label">敏感请求凭据（由 Desktop Host 安全输入）</span>
                  {(
                    [
                      ['secretHeaders', 'Authorization / 敏感 Headers', 'secretHeadersRef'],
                      ['cookies', 'Cookies', 'cookiesRef'],
                      ['proxy', 'Proxy', 'proxyRef'],
                    ] as const
                  ).map(([kind, label, binding]) => (
                    <div className="credential-binding" key={kind}>
                      <Badge tone={task?.credentialBindings[binding] ? 'success' : 'neutral'}>
                        {task?.credentialBindings[binding] ? '已保存' : '未设置'}
                      </Badge>
                      <span>{label}</span>
                      <Button
                        type="button"
                        className="button-secondary"
                        onClick={() => void promptTaskCredential(kind)}
                      >
                        {task?.credentialBindings[binding] ? '替换' : '安全输入'}
                      </Button>
                      {task?.credentialBindings[binding] && (
                        <Button
                          type="button"
                          className="button-danger"
                          onClick={() => void clearTaskCredential(kind)}
                        >
                          删除
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
              <label className="full">
                <span>Browser Actions (JSON)</span>
                <textarea
                  rows={5}
                  value={actionsJson}
                  onChange={(event) => setActionsJson(event.target.value)}
                />
              </label>
              <label>
                <span>Dataset mode</span>
                <select
                  value={datasetMode}
                  onChange={(event) => setDatasetMode(event.target.value as typeof datasetMode)}
                >
                  <option value="snapshot">Snapshot</option>
                  <option value="upsert">Upsert</option>
                  <option value="append">Append</option>
                </select>
              </label>
              <label>
                <span>Unique key fields</span>
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
                允许 localhost / 私网（可能访问本机服务）
              </label>
              <div className="full">
                <span className="field-label">数据保留策略（留空表示不自动删除）</span>
                <div className="form-grid">
                  <label>
                    <span>Run 保留天数</span>
                    <Input
                      type="number"
                      min={1}
                      value={retentionRunDays}
                      onChange={(event) => setRetentionRunDays(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>最多保留 Run 数</span>
                    <Input
                      type="number"
                      min={1}
                      value={retentionMaxRuns}
                      onChange={(event) => setRetentionMaxRuns(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>导出 Artifact 保留天数</span>
                    <Input
                      type="number"
                      min={1}
                      value={retentionArtifactDays}
                      onChange={(event) => setRetentionArtifactDays(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>日志保留天数</span>
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
                <span className="field-label">输出目的地</span>
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
                  {!destinations.length && <Link to="/outputs">先创建输出目的地</Link>}
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
              <h2>Rule Builder</h2>
              <p>
                {candidate.list.rule.type.toUpperCase()} · {analysis?.engine ?? 'saved'}{' '}
                {analysis?.aiUsed ? '· AI' : ''}
              </p>
            </div>
            <div className="row-actions">
              <Button
                className="button-secondary"
                disabled={working || !id}
                onClick={() => void testRule()}
              >
                {t('testRule')}
              </Button>
              <Button disabled={working || !id} onClick={() => void saveRule()}>
                {t('saveRule')}
              </Button>
              {candidate.list.rule.type !== 'json' && (
                <Button
                  className="button-secondary"
                  disabled={working || !id}
                  onClick={() => void openInspection()}
                >
                  可视化点选
                </Button>
              )}
            </div>
          </div>
          {inspectionId && inspectionImage && (
            <div className="inspection-panel">
              <div className="section-heading">
                <div>
                  <h3>页面检查器</h3>
                  <p>选择字段后点击截图中的元素</p>
                </div>
                <div className="row-actions">
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
                  <Button
                    className="button-secondary"
                    onClick={() => void refreshInspection(inspectionId)}
                  >
                    刷新
                  </Button>
                  <Button className="button-danger" onClick={() => void closeInspection()}>
                    关闭
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
                <span>Container</span>
                <Input
                  value={candidate.list.rule.container}
                  onChange={(event) => updateContainer(event.target.value)}
                />
              </label>
              <Button className="button-secondary" onClick={addField}>
                添加字段
              </Button>
              <Button className="button-secondary" onClick={toggleDetail}>
                {candidate.detail ? '移除详情步骤' : '添加详情步骤'}
              </Button>
            </div>
            <details className="advanced-rule-config">
              <summary>高级输入与 URL 发现</summary>
              <div className="form-grid">
                <label className="full">
                  <span>列表输入源 JSON（留空表示直接解析响应）</span>
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
                        setSourceConfigError('列表输入源必须是有效 JSON');
                      }
                    }}
                  />
                </label>
                <label className="full">
                  <span>Sitemap 发现 JSON（留空表示关闭）</span>
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
                        setSourceConfigError('Sitemap 发现配置必须是有效 JSON');
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
                  <th>取值</th>
                  <th>示例 / 空值</th>
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
                        <option value="string">String</option>
                        <option value="number">Number</option>
                        <option value="url">URL</option>
                        <option value="date">Date</option>
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
                            <option value="text">Text</option>
                            <option value="html">HTML</option>
                            <option value="attribute">Attribute</option>
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
                        空值 {preview.filter((record) => record[fieldName] == null).length}/
                        {preview.length}
                      </small>
                    </td>
                    <td>
                      <Button className="button-danger" onClick={() => removeField(fieldName)}>
                        删除
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {candidate.detail && (
            <div className="detail-builder">
              <h3>详情页步骤</h3>
              <div className="form-grid">
                <label>
                  <span>详情 URL 字段</span>
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
                  <span>详情运行模式</span>
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
                    <option value="auto">Auto</option>
                    <option value="http">HTTP</option>
                    <option value="browser">Browser</option>
                  </select>
                </label>
                <label>
                  <span>详情并发</span>
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
                  <span>合并优先级</span>
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
                    <option value="detailWins">Detail wins</option>
                    <option value="listWins">List wins</option>
                  </select>
                </label>
                <label>
                  <span>详情失败策略</span>
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
                    <option value="keep-list-record">Keep list record</option>
                    <option value="skip">Skip</option>
                    <option value="fail-run">Fail run</option>
                  </select>
                </label>
                <label className="full">
                  <span>详情规则 JSON</span>
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
                        setDetailRuleError('JSON 尚未形成有效规则，保存时仍使用上次有效内容');
                      }
                    }}
                  />
                  {detailRuleError && <small className="field-warning">{detailRuleError}</small>}
                </label>
                <label className="full">
                  <span>详情输入源 JSON（留空表示直接解析响应）</span>
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
                        setSourceConfigError('详情输入源必须是有效 JSON');
                      }
                    }}
                  />
                </label>
                <label className="full">
                  <span>详情 Browser Actions (JSON)</span>
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
                        setDetailRuleError('详情 Actions 必须是有效 JSON');
                      }
                    }}
                  />
                </label>
              </div>
            </div>
          )}
          {analysis?.warnings.map((warning) => (
            <div className="notice" key={warning}>
              {warning}
            </div>
          ))}
        </Card>
      )}
      {rules.map((rule) => (
        <Card key={rule.id}>
          <div className="section-heading">
            <div>
              <h2>RuleVersion 历史 · {rule.name}</h2>
              <p>版本不可变；回滚与修复都会创建新版本</p>
            </div>
            <Button
              className="button-secondary"
              disabled={working}
              onClick={() => void requestRepair(rule.id)}
            >
              AI 修复建议
            </Button>
          </div>
          <div className="version-list">
            {rule.versions.map((version, index) => (
              <div className="version-item" key={version.id}>
                <div>
                  <strong>v{version.version}</strong>
                  <small>
                    {version.generatedBy} · {new Date(version.createdAt).toLocaleString()}
                  </small>
                </div>
                <div className="row-actions">
                  {index < rule.versions.length - 1 && (
                    <Button
                      className="button-secondary"
                      onClick={() =>
                        void compareVersions(
                          rule.id,
                          rule.versions[index + 1]!.version,
                          version.version,
                        )
                      }
                    >
                      Diff
                    </Button>
                  )}
                  {rule.activeVersionId !== version.id && (
                    <Button
                      className="button-secondary"
                      onClick={() => void rollbackVersion(rule.id, version.version)}
                    >
                      回滚到此版本
                    </Button>
                  )}
                  {rule.activeVersionId === version.id && <Badge tone="success">active</Badge>}
                </div>
              </div>
            ))}
          </div>
          {versionDiff.length > 0 && (
            <pre className="diff-view">
              {versionDiff
                .map(
                  (change) =>
                    `${change.path}\n- ${JSON.stringify(change.before)}\n+ ${JSON.stringify(change.after)}`,
                )
                .join('\n\n')}
            </pre>
          )}
          {repairProposals.filter((proposal) => proposal.ruleId === rule.id).length > 0 && (
            <div className="repair-list">
              <h3>修复建议</h3>
              {repairProposals
                .filter((proposal) => proposal.ruleId === rule.id)
                .map((proposal) => (
                  <div className="version-item" key={proposal.id}>
                    <div>
                      <Badge
                        tone={
                          proposal.status === 'applied'
                            ? 'success'
                            : proposal.status === 'rejected'
                              ? 'danger'
                              : 'neutral'
                        }
                      >
                        {proposal.status}
                      </Badge>
                      <strong>{proposal.explanation}</strong>
                      <small>{new Date(proposal.createdAt).toLocaleString()}</small>
                    </div>
                    {proposal.status === 'pending' && (
                      <div className="row-actions">
                        <Button
                          className="button-secondary"
                          onClick={() => {
                            setRepairDiff(
                              definitionDiffForUi(
                                task?.activeRule?.version.definition,
                                proposal.definition,
                              ),
                            );
                          }}
                        >
                          查看 Diff
                        </Button>
                        <Button
                          className="button-secondary"
                          onClick={() => void testRepair(proposal)}
                        >
                          测试
                        </Button>
                        <Button
                          disabled={testedProposalId !== proposal.id}
                          onClick={() => void reviewRepair(proposal, 'apply')}
                        >
                          确认应用
                        </Button>
                        <Button
                          className="button-danger"
                          onClick={() => void reviewRepair(proposal, 'reject')}
                        >
                          拒绝
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
              {repairDiff.length > 0 && (
                <pre className="diff-view">
                  {repairDiff
                    .map(
                      (change) =>
                        `${change.path}\n- ${JSON.stringify(change.before)}\n+ ${JSON.stringify(change.after)}`,
                    )
                    .join('\n\n')}
                </pre>
              )}
            </div>
          )}
        </Card>
      ))}
      <Card>
        <h2>{t('preview')}</h2>
        <PreviewTable records={preview} empty={t('noPreview')} />
      </Card>
    </>
  );
}

function definitionDiffForUi(
  before: unknown,
  after: unknown,
  path = '',
): Array<{ path: string; before: unknown; after: unknown }> {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    before &&
    after &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])].flatMap((key) =>
      definitionDiffForUi(left[key], right[key], `${path}/${key}`),
    );
  }
  return [{ path: path || '/', before, after }];
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
