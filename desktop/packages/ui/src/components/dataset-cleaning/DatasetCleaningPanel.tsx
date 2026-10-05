import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError, runtimeClient } from '@zhiyun/client';
import {
  cleaningResultSchema,
  cleaningSessionDetailSchema,
  type CleaningRecipe,
  type CleaningRecipeVersion,
  type CleaningResult,
  type CleaningSessionDetail,
  type CleaningStep,
} from '@zhiyun/shared';
import {
  cleaningExpectedFields,
  cleaningOperationLabel,
  cleaningQualityFields,
  projectedCleaningFields,
} from '../../dataset-cleaning.js';
import { Badge, Button, Card, ErrorNotice, Input } from '../ui.js';
import { Field, Select } from '../experience.js';
import { CleaningReport } from './CleaningReport.js';
import { CleaningStepEditor } from './CleaningStepEditor.js';
import './cleaning.css';

type SavedRecipe = { recipe: CleaningRecipe; version: CleaningRecipeVersion };
export function DatasetCleaningPanel({
  datasetId,
  onSnapshotChange,
}: {
  datasetId: string;
  onSnapshotChange: (snapshotId: string | null) => void;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const cache = useQueryClient();
  const controller = useRef<AbortController | null>(null);
  const [inputId, setInputId] = useState('');
  const [pendingSnapshot, setPendingSnapshot] = useState('');
  const [name, setName] = useState('');
  const [steps, setSteps] = useState<CleaningStep[]>([]);
  const [saved, setSaved] = useState<SavedRecipe | null>(null);
  const [editingRecipe, setEditingRecipe] = useState<CleaningRecipe | null>(null);
  const [preview, setPreview] = useState<CleaningResult | null>(null);
  const [detail, setDetail] = useState<CleaningSessionDetail | null>(null);
  const [reportStep, setReportStep] = useState(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const versions = useQuery({
    queryKey: ['dataset-versions', datasetId],
    queryFn: () => runtimeClient.listDatasetSnapshots(datasetId),
    refetchInterval: (query) =>
      query.state.data?.some((snapshot) => snapshot.status === 'preparing') ? 1000 : false,
  });
  const recipes = useQuery({
    queryKey: ['cleaning-recipes', datasetId],
    queryFn: () => runtimeClient.listDatasetCleaningRecipes(datasetId),
  });
  const sessions = useQuery({
    queryKey: ['cleaning-sessions', datasetId],
    queryFn: () => runtimeClient.listDatasetCleaningSessions(datasetId),
  });
  const quality = useQuery({
    queryKey: ['cleaning-quality', datasetId, inputId],
    queryFn: async ({ signal }) =>
      cleaningResultSchema.parse(
        await runtimeClient.previewDatasetCleaning(
          datasetId,
          { mode: 'steps', snapshotId: inputId, steps: [], expectedFields: {} },
          signal,
        ),
      ),
    enabled: Boolean(inputId),
    staleTime: Infinity,
  });
  useEffect(() => {
    const selected = versions.data?.find((snapshot) => snapshot.id === pendingSnapshot);
    if (selected?.status === 'failed') {
      setPendingSnapshot('');
      setError(zh ? '数据版本准备失败，请重试。' : 'Data version preparation failed. Retry.');
    }
    if (selected?.status === 'ready') {
      setInputId(selected.id);
      setPendingSnapshot('');
    } else if (!inputId && !pendingSnapshot) {
      const ready = versions.data?.find(
        (snapshot) => snapshot.status === 'ready' && snapshot.sourceRunId !== null,
      );
      if (ready) setInputId(ready.id);
    }
  }, [versions.data, pendingSnapshot, inputId, zh]);
  useEffect(() => {
    onSnapshotChange(detail?.session.selectedSnapshotId ?? null);
  }, [detail?.session.selectedSnapshotId, onSnapshotChange]);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  const clearResult = () => {
    setPreview(null);
    setDetail(null);
    setReportStep(0);
    setError('');
    setMessage('');
  };
  const editSteps = (next: CleaningStep[]) => {
    setSteps(next);
    setSaved(null);
    clearResult();
  };
  const createSnapshot = useMutation({
    mutationFn: () => runtimeClient.createDatasetSnapshot(datasetId),
    onSuccess: async (value) => {
      clearResult();
      if (value.status === 'ready') setInputId(value.id);
      else if (value.status === 'preparing') setPendingSnapshot(value.id);
      else setError(zh ? '数据版本准备失败。' : 'Data version preparation failed.');
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['dataset-versions', datasetId] }),
        cache.invalidateQueries({ queryKey: ['records', datasetId] }),
        cache.invalidateQueries({ queryKey: ['dataset-fields', datasetId] }),
        cache.invalidateQueries({ queryKey: ['dataset'] }),
      ]);
    },
  });
  const loadRecipe = useMutation({
    mutationFn: ({ recipeId, versionId }: { recipeId: string; versionId?: string }) =>
      runtimeClient.getDatasetCleaningRecipe(datasetId, recipeId, versionId),
    onSuccess: (value) => {
      setSaved(value);
      setEditingRecipe(value.recipe);
      setName(value.version.name);
      setSteps(value.version.steps);
      clearResult();
    },
  });
  const runPreview = useMutation({
    mutationFn: async () => {
      controller.current = new AbortController();
      return cleaningResultSchema.parse(
        await runtimeClient.previewDatasetCleaning(
          datasetId,
          saved
            ? { mode: 'recipe', snapshotId: inputId, recipeVersionId: saved.version.id }
            : {
                mode: 'steps',
                snapshotId: inputId,
                steps,
                expectedFields: cleaningExpectedFields(initialFields, steps),
              },
          controller.current.signal,
        ),
      );
    },
    onSuccess: (value) => {
      setPreview(value);
      setDetail(null);
      setReportStep(value.steps.length);
      setError('');
    },
    onSettled: () => {
      controller.current = null;
    },
  });
  const saveRecipe = useMutation({
    mutationFn: () =>
      runtimeClient.saveDatasetCleaningRecipe(datasetId, {
        name,
        steps,
        expectedFields: cleaningExpectedFields(initialFields, steps),
        ...(editingRecipe
          ? { recipeId: editingRecipe.id, expectedRevision: editingRecipe.revision }
          : {}),
      }),
    onSuccess: async (value) => {
      setSaved(value);
      setEditingRecipe(value.recipe);
      setMessage(
        zh
          ? `已保存配方版本 v${value.version.revision}`
          : `Recipe v${value.version.revision} saved`,
      );
      await cache.invalidateQueries({ queryKey: ['cleaning-recipes', datasetId] });
    },
  });
  const apply = useMutation({
    mutationFn: async () => {
      if (!saved) throw new Error(zh ? '请先保存配方。' : 'Save the recipe first.');
      controller.current = new AbortController();
      return cleaningSessionDetailSchema.parse(
        await runtimeClient.applyDatasetCleaning(
          datasetId,
          { snapshotId: inputId, recipeVersionId: saved.version.id },
          controller.current.signal,
        ),
      );
    },
    onSuccess: async (value) => {
      setDetail(value);
      setPreview(null);
      setReportStep(value.session.selectedStep);
      setMessage(
        zh
          ? '结果已保存，可撤销、重做或用于分析。'
          : 'Result saved. Undo, redo or analyze this version.',
      );
      await Promise.all([
        cache.invalidateQueries({ queryKey: ['cleaning-sessions', datasetId] }),
        cache.invalidateQueries({ queryKey: ['dataset-versions', datasetId] }),
      ]);
    },
    onSettled: () => {
      controller.current = null;
    },
  });
  const loadSession = useMutation({
    mutationFn: async (sessionId: string) =>
      cleaningSessionDetailSchema.parse(
        await runtimeClient.getDatasetCleaningSession(datasetId, sessionId),
      ),
    onSuccess: (value) => {
      setDetail(value);
      setPreview(null);
      setReportStep(value.session.selectedStep);
      setError('');
      setMessage('');
    },
  });
  const selectStep = useMutation({
    mutationFn: async (step: number) => {
      if (!detail) throw new Error('No cleaning history selected');
      return cleaningSessionDetailSchema.parse(
        await runtimeClient.selectDatasetCleaningStep(
          datasetId,
          detail.session.id,
          step,
          detail.session.revision,
        ),
      );
    },
    onSuccess: async (value) => {
      setDetail(value);
      setPreview(null);
      setReportStep(value.session.selectedStep);
      setError('');
      await cache.invalidateQueries({ queryKey: ['cleaning-sessions', datasetId] });
    },
    onError: () => {
      void cache.invalidateQueries({ queryKey: ['cleaning-sessions', datasetId] });
    },
  });
  const initialFields = quality.data ? cleaningQualityFields(quality.data.inputQuality) : {};
  const mutations = [
    createSnapshot,
    loadRecipe,
    runPreview,
    saveRecipe,
    apply,
    loadSession,
    selectStep,
  ];
  const busy = mutations.some((mutation) => mutation.isPending);
  const mutationError = mutations.find((mutation) => mutation.error)?.error;
  const failureMessage =
    mutationError instanceof ApiError &&
    ['INVALID_INPUT', 'METHOD_INCOMPATIBLE'].includes(mutationError.problem.code)
      ? `${zh ? '输入字段、类型或参数不兼容。请检查所选版本和步骤。' : 'Input fields, types or parameters are incompatible. Check the selected version and steps.'} ${mutationError.message}`
      : mutationError?.message;
  const report = preview ?? detail?.report ?? quality.data;
  const ready = Boolean(inputId && quality.data && !quality.isFetching);
  const resetErrors = () => {
    for (const mutation of mutations) mutation.reset();
    setError('');
    setMessage('');
  };

  return (
    <Card className="dataset-cleaning-panel">
      <div data-testid="dataset-cleaning-panel">
        <h2>{zh ? '清洗与数据版本' : 'Cleaning and data versions'}</h2>
        <p>
          {zh
            ? '按顺序预览清洗步骤，保存为可复用配方。每步生成独立数据版本，原始采集记录保持不变。'
            : 'Preview ordered steps and save a reusable recipe. Each step creates a data version and preserves the original collection.'}
        </p>
        <div className="cleaning-form-grid">
          <Field label={zh ? '清洗输入版本' : 'Cleaning input version'}>
            <Select
              disabled={busy || Boolean(pendingSnapshot)}
              value={inputId}
              onChange={(e) => {
                setInputId(e.target.value);
                clearResult();
                resetErrors();
              }}
            >
              <option value="">
                {zh ? '选择已准备好的数据版本' : 'Choose a ready data version'}
              </option>
              {(versions.data ?? [])
                .filter((value) => value.status === 'ready')
                .map((value) => (
                  <option key={value.id} value={value.id}>
                    {value.sourceRunId ? (zh ? '采集' : 'Collected') : zh ? '清洗' : 'Cleaned'} ·{' '}
                    {new Date(value.createdAt).toLocaleString(i18n.language)} · {value.rowCount}{' '}
                    {zh ? '行' : 'rows'} · {value.fingerprint.slice(0, 8)}
                  </option>
                ))}
            </Select>
          </Field>
          <div className="cleaning-actions">
            <Button
              className="button-secondary"
              disabled={busy || Boolean(pendingSnapshot)}
              onClick={() => {
                resetErrors();
                createSnapshot.mutate();
              }}
            >
              {pendingSnapshot || createSnapshot.isPending
                ? zh
                  ? '正在准备版本…'
                  : 'Preparing version…'
                : zh
                  ? '从当前采集创建输入版本'
                  : 'Create input from current collection'}
            </Button>
          </div>
          <Field label={zh ? '复用已保存配方' : 'Reuse a saved recipe'}>
            <Select
              disabled={busy}
              value={saved?.recipe.id ?? editingRecipe?.id ?? ''}
              onChange={(e) => {
                resetErrors();
                if (e.target.value) loadRecipe.mutate({ recipeId: e.target.value });
                else {
                  setSaved(null);
                  setEditingRecipe(null);
                  setName('');
                  editSteps([]);
                }
              }}
            >
              <option value="">{zh ? '新建配方' : 'New recipe'}</option>
              {(recipes.data ?? []).map((value) => (
                <option key={value.id} value={value.id}>
                  {value.name} · v{value.revision}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={zh ? '清洗配方名称' : 'Cleaning recipe name'}>
            <Input
              disabled={busy}
              maxLength={120}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(null);
                setMessage('');
              }}
            />
          </Field>
        </div>
        <ol className="cleaning-steps" aria-label={zh ? '清洗操作顺序' : 'Cleaning step order'}>
          {steps.map((step, index) => (
            <li key={index}>
              <span>
                {cleaningOperationLabel(step, zh)} ·{' '}
                {step.type === 'split'
                  ? `${step.field} → ${step.targets.join(', ')}`
                  : step.fields.join(', ')}
              </span>
              {step.type !== 'trim' && step.type !== 'dedupe' && (
                <details>
                  <summary>{zh ? '步骤参数' : 'Step parameters'}</summary>
                  {step.type === 'normalize_null' && (
                    <p>
                      {zh ? '精确匹配空值标记' : 'Exact null tokens'}：
                      <code>{JSON.stringify(step.tokens)}</code>
                    </p>
                  )}
                  {step.type === 'convert' && (
                    <p>
                      {zh ? '转换失败时' : 'On conversion error'}：
                      {step.onError === 'fail'
                        ? zh
                          ? '停止并保留原数据'
                          : 'Stop and preserve input'
                        : zh
                          ? '置空并报告错误行'
                          : 'Set null and report errors'}
                    </p>
                  )}
                  {step.type === 'split' && (
                    <p>
                      {zh ? '分隔符' : 'Delimiter'}：<code>{JSON.stringify(step.delimiter)}</code>
                    </p>
                  )}
                  {step.type === 'merge' && (
                    <p>
                      {zh ? '目标字段 / 连接符' : 'Target field / separator'}：{step.target} /{' '}
                      <code>{JSON.stringify(step.separator)}</code>
                    </p>
                  )}
                </details>
              )}
              <div className="cleaning-actions">
                <Button
                  className="button-ghost"
                  disabled={busy || index === 0}
                  aria-label={`${zh ? '上移步骤' : 'Move step up'} ${index + 1}`}
                  onClick={() => {
                    const next = [...steps];
                    [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                    editSteps(next);
                    resetErrors();
                  }}
                >
                  ↑
                </Button>
                <Button
                  className="button-ghost"
                  disabled={busy || index === steps.length - 1}
                  aria-label={`${zh ? '下移步骤' : 'Move step down'} ${index + 1}`}
                  onClick={() => {
                    const next = [...steps];
                    [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                    editSteps(next);
                    resetErrors();
                  }}
                >
                  ↓
                </Button>
                <Button
                  className="button-ghost"
                  disabled={busy}
                  aria-label={`${zh ? '删除步骤' : 'Remove step'} ${index + 1}`}
                  onClick={() => {
                    editSteps(steps.filter((_, i) => index !== i));
                    resetErrors();
                  }}
                >
                  {zh ? '删除' : 'Remove'}
                </Button>
              </div>
            </li>
          ))}
        </ol>
        <CleaningStepEditor
          fields={projectedCleaningFields(initialFields, steps)}
          disabled={busy || !ready || steps.length >= 20}
          zh={zh}
          onAdd={(step) => {
            editSteps([...steps, step]);
            resetErrors();
          }}
        />
        <div className="cleaning-actions">
          <Button
            disabled={busy || !ready || !steps.length}
            onClick={() => {
              resetErrors();
              runPreview.mutate();
            }}
          >
            {runPreview.isPending
              ? zh
                ? '正在预览…'
                : 'Previewing…'
              : zh
                ? '预览清洗'
                : 'Preview cleaning'}
          </Button>
          <Button
            className="button-secondary"
            disabled={busy || !ready || !preview || !name.trim() || !steps.length || Boolean(saved)}
            onClick={() => {
              resetErrors();
              saveRecipe.mutate();
            }}
          >
            {editingRecipe
              ? zh
                ? '保存配方新版本'
                : 'Save a new recipe version'
              : zh
                ? '保存清洗配方'
                : 'Save cleaning recipe'}
          </Button>
          <Button
            disabled={busy || !preview || !saved}
            onClick={() => {
              resetErrors();
              apply.mutate();
            }}
          >
            {apply.isPending
              ? zh
                ? '正在应用…'
                : 'Applying…'
              : zh
                ? '应用配方并保存结果'
                : 'Apply recipe and save result'}
          </Button>
          {(runPreview.isPending || apply.isPending) && (
            <Button className="button-ghost" onClick={() => controller.current?.abort()}>
              {zh ? '停止清洗' : 'Stop cleaning'}
            </Button>
          )}
        </div>
        {saved && (
          <p data-testid="cleaning-recipe-version">
            {zh ? '使用不可变配方版本' : 'Using immutable recipe version'}{' '}
            <Badge>v{saved.version.revision}</Badge>
          </p>
        )}
        {busy && <p role="status">{zh ? '正在处理，请稍候…' : 'Processing…'}</p>}
        {quality.isFetching && (
          <p role="status">{zh ? '正在读取输入质量…' : 'Reading input quality…'}</p>
        )}
        <ErrorNotice
          message={
            error ||
            failureMessage ||
            quality.error?.message ||
            versions.error?.message ||
            recipes.error?.message ||
            sessions.error?.message
          }
          onRetry={() => {
            resetErrors();
            if (inputId) void quality.refetch();
            void versions.refetch();
            void recipes.refetch();
            void sessions.refetch();
          }}
        />
        {message && <p role="status">{message}</p>}
        {detail && (
          <div className="cleaning-history-selection" data-testid="cleaning-history-selection">
            <strong>
              {detail.recipeVersion.name} · v{detail.recipeVersion.revision}
            </strong>
            <p>
              {zh ? '当前选择步骤' : 'Selected step'}：{detail.session.selectedStep}/
              {detail.session.outputSnapshotIds.length} ·{' '}
              {zh ? '用于分析的数据版本' : 'Data version for analysis'}：
              {detail.session.selectedSnapshotId.slice(0, 8)}
            </p>
            <div className="cleaning-actions">
              <Button
                className="button-secondary"
                disabled={busy || detail.session.selectedStep === 0}
                onClick={() => {
                  resetErrors();
                  selectStep.mutate(detail.session.selectedStep - 1);
                }}
              >
                {zh ? '撤销一步' : 'Undo one step'}
              </Button>
              <Button
                className="button-secondary"
                disabled={
                  busy || detail.session.selectedStep === detail.session.outputSnapshotIds.length
                }
                onClick={() => {
                  resetErrors();
                  selectStep.mutate(detail.session.selectedStep + 1);
                }}
              >
                {zh ? '重做一步' : 'Redo one step'}
              </Button>
              <Button
                className="button-ghost"
                disabled={busy}
                onClick={() => {
                  resetErrors();
                  loadRecipe.mutate({
                    recipeId: detail.recipeVersion.recipeId,
                    versionId: detail.recipeVersion.id,
                  });
                }}
              >
                {zh ? '复用此配方版本' : 'Reuse this recipe version'}
              </Button>
            </div>
          </div>
        )}
        {report && (
          <CleaningReport
            report={report}
            selectedStep={Math.min(reportStep, report.steps.length)}
            onStepChange={setReportStep}
            zh={zh}
          />
        )}
        <h3>{zh ? '已保存的清洗历史' : 'Saved cleaning history'}</h3>
        <ul className="cleaning-history-list">
          {(sessions.data ?? []).map((session) => (
            <li key={session.id}>
              <span>
                {new Date(session.createdAt).toLocaleString(i18n.language)} ·{' '}
                {session.outputSnapshotIds.length} {zh ? '步' : 'steps'} ·{' '}
                {zh ? '当前步骤' : 'Selected'} {session.selectedStep}
              </span>
              <Button
                className="button-ghost"
                disabled={busy}
                aria-label={`${zh ? '查看清洗历史' : 'View cleaning history'} ${session.id.slice(0, 8)}`}
                onClick={() => {
                  resetErrors();
                  loadSession.mutate(session.id);
                }}
              >
                {zh ? '查看历史' : 'View history'}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
