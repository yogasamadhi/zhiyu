import { productCopy } from '../product-copy.js';
import { Field, Select, Stepper, StatusNotice } from '../components/experience.js';
import { DatasetVersionPicker } from '../components/DatasetVersionPicker.js';
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runtimeClient, type CorpusRecipeInput } from '@zhiyun/client';
import { Badge, Button, Card, ErrorNotice, Input } from '../components/ui.js';

const defaultRecipe: CorpusRecipeInput = {
  name: 'Default bilingual corpus',
  snapshotPolicy: { mode: 'latest' },
  selectedTextFields: [],
  metadataFields: [],
  stripHtml: true,
  unicodeNormalization: 'NFKC',
  deduplication: 'exact-and-near',
  nearDuplicateThreshold: 0.9,
  chunkSize: 2000,
  chunkOverlap: 200,
  languagePolicy: 'zh-en-first',
  outputFormats: ['parquet', 'jsonl'],
};

export function CorpusDetailPage() {
  const { corpusId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [step, setStep] = useState(0);
  const queryClient = useQueryClient();
  const corpus = useQuery({
    queryKey: ['corpus', corpusId],
    queryFn: () => runtimeClient.getCorpus(corpusId),
  });
  const recipes = useQuery({
    queryKey: ['corpus', corpusId, 'recipes'],
    queryFn: () => runtimeClient.listCorpusRecipes(corpusId),
  });
  const builds = useQuery({
    queryKey: ['corpus', corpusId, 'builds'],
    queryFn: () => runtimeClient.listCorpusBuilds(corpusId),
    refetchInterval: (query) =>
      (query.state.data ?? []).some((build) => isActive(build.state)) ? 1_000 : 5_000,
  });
  const versions = useQuery({
    queryKey: ['corpus', corpusId, 'versions'],
    queryFn: () => runtimeClient.listCorpusVersions(corpusId),
    refetchInterval: 2000,
  });
  const [recipe, setRecipe] = useState<CorpusRecipeInput>({
    ...defaultRecipe,
    name: zh ? '文本清洗方案' : 'Text cleaning recipe',
  });
  const [selectedRecipeId, setSelectedRecipeId] = useState('');
  const [preview, setPreview] = useState<{
    fingerprint: string;
    sampleSize: number;
    totalRows: number;
    documents: Array<{ text: string; language: string }>;
    chunks: Array<{ text: string }>;
    stats: Record<string, unknown>;
  } | null>(null);
  const [snapshotId, setSnapshotId] = useState(searchParams.get('snapshotId') ?? '');
  const fields = useQuery({
    queryKey: ['corpus-fields', corpus.data?.datasetId, snapshotId],
    queryFn: () => runtimeClient.getDatasetFields(corpus.data!.datasetId, snapshotId),
    enabled: Boolean(corpus.data?.datasetId && snapshotId),
  });
  const fingerprint = JSON.stringify({ snapshotId, recipe });
  const buildAttempt = useRef<{ fingerprint: string; key: string } | null>(null);
  const previewValid = preview?.fingerprint === fingerprint;
  useEffect(() => {
    if (!recipe.selectedTextFields.length && fields.data?.fields) {
      const first = fields.data.fields.find((field) => field.type === 'text');
      if (first) setRecipe((value) => ({ ...value, selectedTextFields: [first.name] }));
    }
  }, [fields.data]);
  const previewMutation = useMutation({
    mutationFn: async () => {
      const value = await runtimeClient.request<Omit<NonNullable<typeof preview>, 'fingerprint'>>(
        `/api/v2/corpora/${corpusId}/preview`,
        { method: 'POST', body: fingerprint },
      );
      return { ...value, fingerprint };
    },
    onSuccess: setPreview,
  });
  const createBuild = useMutation({
    mutationFn: async () => {
      if (buildAttempt.current?.fingerprint !== fingerprint)
        buildAttempt.current = { fingerprint, key: crypto.randomUUID() };
      const key = buildAttempt.current.key;
      const saved = await runtimeClient.createCorpusRecipe(corpusId, recipe, `${key}:recipe`);
      setSelectedRecipeId(saved.id);
      return runtimeClient.createCorpusBuild(
        corpusId,
        { recipeId: saved.id, snapshotId },
        `${key}:build`,
      );
    },
    onSuccess: async () => {
      buildAttempt.current = null;
      await queryClient.invalidateQueries({ queryKey: ['corpus', corpusId] });
    },
  });
  const cancel = useMutation({
    mutationFn: (id: string) => runtimeClient.cancelCorpusBuild(id),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['corpus', corpusId] }),
  });
  const retry = useMutation({
    mutationFn: (id: string) => runtimeClient.retryCorpusBuild(id),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['corpus', corpusId] }),
  });
  const error =
    corpus.error ??
    recipes.error ??
    builds.error ??
    versions.error ??
    fields.error ??
    previewMutation.error ??
    cancel.error ??
    retry.error ??
    createBuild.error;
  if (corpus.isPending) return <p role="status">{t('loading')}</p>;
  return (
    <>
      <Link className="back-link" to="/corpora">
        ← {t('back')}
      </Link>
      <div className="page-heading">
        <div>
          <h1>{corpus.data?.name ?? t('corpus.title')}</h1>
          <p>{t('corpus.detailIntro')}</p>
        </div>
      </div>
      <ErrorNotice message={error instanceof Error ? error.message : error ? String(error) : ''} />
      <Stepper
        steps={[
          zh ? '选择数据' : 'Choose data',
          zh ? '选择文本字段' : 'Choose text',
          zh ? '清洗与分块' : 'Clean & chunk',
          zh ? '预览' : 'Preview',
          zh ? '构建与导出' : 'Build & export',
        ]}
        current={step}
        onChange={(next) => {
          if (next < 4 || previewValid) setStep(next);
        }}
      />
      {step === 0 && corpus.data && (
        <Card>
          <DatasetVersionPicker
            locked
            datasetId={corpus.data.datasetId}
            snapshotId={snapshotId}
            onDatasetChange={() => undefined}
            onSnapshotChange={setSnapshotId}
          />
        </Card>
      )}
      {step === 1 && (
        <Card>
          <h2>{t('corpus.textFields')}</h2>
          <p>
            {zh
              ? '选择要组合为正文的文本字段，字段来自所选数据版本。'
              : 'Choose text fields to combine. Fields come from the selected data version.'}
          </p>
          <div className="form-grid two">
            <Field label={t('corpus.textFields')}>
              <Select
                multiple
                value={recipe.selectedTextFields}
                onChange={(event) =>
                  setRecipe({
                    ...recipe,
                    selectedTextFields: Array.from(
                      event.target.selectedOptions,
                      (option) => option.value,
                    ),
                  })
                }
              >
                {(fields.data?.fields ?? [])
                  .filter((field) => field.type === 'text')
                  .map((field) => (
                    <option key={field.name} value={field.name}>
                      {field.label ?? field.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <Field label={t('corpus.metadataFields')}>
              <Select
                multiple
                value={recipe.metadataFields}
                onChange={(event) =>
                  setRecipe({
                    ...recipe,
                    metadataFields: Array.from(
                      event.target.selectedOptions,
                      (option) => option.value,
                    ),
                  })
                }
              >
                {(fields.data?.fields ?? []).map((field) => (
                  <option key={field.name} value={field.name}>
                    {field.label ?? field.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {fields.data && !fields.data.fields.some((field) => field.type === 'text') && (
            <StatusNotice>
              {zh
                ? '此版本没有可用文本字段，请返回选择其他版本。'
                : 'This version has no text fields. Choose another version.'}
            </StatusNotice>
          )}
        </Card>
      )}
      {step === 2 && (
        <Card className="editor-card">
          <div className="form-grid two">
            <Field label={t('name')}>
              <Input
                value={recipe.name}
                onChange={(e) => setRecipe({ ...recipe, name: e.target.value })}
              />
            </Field>
            <Field label={t('corpus.chunkSize')}>
              <Input
                type="number"
                min={100}
                max={10000}
                value={recipe.chunkSize}
                onChange={(e) => setRecipe({ ...recipe, chunkSize: Number(e.target.value) })}
              />
            </Field>
            <Field
              label={t('corpus.chunkOverlap')}
              error={
                recipe.chunkOverlap >= recipe.chunkSize
                  ? zh
                    ? '重叠长度必须小于分块长度'
                    : 'Overlap must be smaller than chunk size'
                  : undefined
              }
            >
              <Input
                type="number"
                min={0}
                max={2000}
                value={recipe.chunkOverlap}
                onChange={(e) => setRecipe({ ...recipe, chunkOverlap: Number(e.target.value) })}
              />
            </Field>
            <label className="check">
              <input
                type="checkbox"
                checked={recipe.stripHtml}
                onChange={(e) => setRecipe({ ...recipe, stripHtml: e.target.checked })}
              />
              {t('corpus.stripHtml')}
            </label>
          </div>
          <details>
            <summary>{zh ? '高级清洗与输出' : 'Advanced cleaning & output'}</summary>
            <div className="form-grid two">
              <Field label={zh ? '字符规范化' : 'Unicode normalization'}>
                <Select
                  value={recipe.unicodeNormalization}
                  onChange={(e) =>
                    setRecipe({ ...recipe, unicodeNormalization: e.target.value as 'NFC' | 'NFKC' })
                  }
                >
                  <option>NFC</option>
                  <option>NFKC</option>
                </Select>
              </Field>
              <Field label={zh ? '去重策略' : 'Deduplication'}>
                <Select
                  value={recipe.deduplication}
                  onChange={(e) =>
                    setRecipe({
                      ...recipe,
                      deduplication: e.target.value as CorpusRecipeInput['deduplication'],
                    })
                  }
                >
                  <option value="none">{zh ? '保留全部' : 'Keep all'}</option>
                  <option value="exact">{zh ? '精确去重' : 'Exact duplicates'}</option>
                  <option value="exact-and-near">
                    {zh ? '精确与近似去重' : 'Exact & near duplicates'}
                  </option>
                </Select>
              </Field>
              <Field label={t('corpus.nearDuplicateThreshold')}>
                <Input
                  type="number"
                  min={0.5}
                  max={1}
                  step={0.01}
                  value={recipe.nearDuplicateThreshold}
                  onChange={(e) =>
                    setRecipe({ ...recipe, nearDuplicateThreshold: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label={zh ? '语言识别' : 'Language detection'}>
                <Select
                  value={recipe.languagePolicy}
                  onChange={(e) =>
                    setRecipe({
                      ...recipe,
                      languagePolicy: e.target.value as CorpusRecipeInput['languagePolicy'],
                    })
                  }
                >
                  <option value="zh-en-first">
                    {zh ? '中文与英文优先' : 'Chinese & English first'}
                  </option>
                  <option value="generic">{zh ? '通用文本' : 'Generic text'}</option>
                </Select>
              </Field>
              <label className="check">
                <input
                  type="checkbox"
                  checked={recipe.outputFormats.includes('markdown')}
                  onChange={(e) =>
                    setRecipe({
                      ...recipe,
                      outputFormats: e.target.checked
                        ? ['parquet', 'jsonl', 'markdown']
                        : ['parquet', 'jsonl'],
                    })
                  }
                />
                {t('corpus.markdown')}
              </label>
            </div>
          </details>
          {(recipes.data?.length ?? 0) > 0 && (
            <details>
              <summary>{zh ? '复用已有清洗方案' : 'Reuse a saved recipe'}</summary>
              <Select
                value={selectedRecipeId}
                onChange={(e) => {
                  const selected = recipes.data?.find((item) => item.id === e.target.value);
                  if (selected) {
                    setSelectedRecipeId(selected.id);
                    const next = Object.fromEntries(
                      Object.keys(defaultRecipe).map((key) => [
                        key,
                        selected[key as keyof typeof selected],
                      ]),
                    );
                    setRecipe(next as unknown as CorpusRecipeInput);
                  }
                }}
              >
                <option value="">{zh ? '选择方案' : 'Choose recipe'}</option>
                {recipes.data?.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · v{item.revision}
                  </option>
                ))}
              </Select>
            </details>
          )}
        </Card>
      )}
      {step === 3 && (
        <Card>
          <h2>{zh ? '预览清洗与分块结果' : 'Preview cleaned text & chunks'}</h2>
          <p>
            {zh
              ? '使用所选数据版本前 20 行和正式清洗逻辑；去重统计只覆盖样本。'
              : 'Uses the first 20 rows of the selected version and the production cleaning pipeline. Deduplication statistics cover this sample only.'}
          </p>
          <Button
            disabled={
              previewMutation.isPending ||
              !snapshotId ||
              !recipe.selectedTextFields.length ||
              recipe.chunkOverlap >= recipe.chunkSize
            }
            onClick={() => previewMutation.mutate()}
          >
            {previewMutation.isPending ? t('loading') : zh ? '生成预览' : 'Generate preview'}
          </Button>
          {previewValid && preview && (
            <>
              <StatusNotice>
                {zh
                  ? `已预览 ${preview.sampleSize} / ${preview.totalRows} 行`
                  : `Previewed ${preview.sampleSize} of ${preview.totalRows} rows`}
              </StatusNotice>
              <div className="two-column">
                <div>
                  <h3>{zh ? '清洗后正文' : 'Cleaned documents'}</h3>
                  {preview.documents.map((doc, i) => (
                    <pre className="text-preview" key={i}>
                      {doc.text}
                    </pre>
                  ))}
                </div>
                <div>
                  <h3>{zh ? '分块样本（最多 20 块）' : 'Sample chunks (up to 20)'}</h3>
                  {preview.chunks.map((chunk, i) => (
                    <pre className="text-preview" key={i}>
                      {chunk.text}
                    </pre>
                  ))}
                </div>
              </div>
            </>
          )}
        </Card>
      )}
      {step === 4 && (
        <Card>
          <h2>{t('corpus.build')}</h2>
          <p>
            {zh
              ? '将保存当前清洗方案并构建完整数据版本，完成后可在下方打开结果并导出。'
              : 'Save this recipe and build the complete data version. Open the completed result below to export.'}
          </p>
          <Button
            disabled={!previewValid || createBuild.isPending}
            onClick={() => createBuild.mutate()}
          >
            {createBuild.isPending ? t('corpus.starting') : t('corpus.startBuild')}
          </Button>
        </Card>
      )}
      <div className="heading-actions">
        {step > 0 && (
          <Button className="button-secondary" onClick={() => setStep(step - 1)}>
            {zh ? productCopy('上一步') : 'Back'}
          </Button>
        )}
        {step < 4 && (
          <Button
            className={step === 3 ? 'button-secondary' : ''}
            disabled={
              !snapshotId ||
              (step >= 1 && !recipe.selectedTextFields.length) ||
              (step === 2 && (!recipe.name || recipe.chunkOverlap >= recipe.chunkSize)) ||
              (step === 3 && !previewValid)
            }
            onClick={() => setStep(step + 1)}
          >
            {zh ? productCopy('下一步') : 'Next'}
          </Button>
        )}
      </div>
      <Card>
        <h2>{t('corpus.builds')}</h2>
        <div className="compact-list">
          {(builds.data ?? []).map((build) => (
            <div key={build.id}>
              <span>
                <strong>{t(`ux.state.${build.state}`, { defaultValue: build.state })}</strong>
                <small>
                  {t(`analytics.phase.${build.phase}`, { defaultValue: build.phase })} ·{' '}
                  {Math.round(build.progress * 100)}%
                </small>
              </span>
              <div className="row-actions">
                <Badge
                  tone={
                    build.state === 'succeeded'
                      ? 'success'
                      : build.state === 'failed'
                        ? 'danger'
                        : 'neutral'
                  }
                >
                  {t(`ux.state.${build.state}`, { defaultValue: build.state })}
                </Badge>
                {isActive(build.state) && (
                  <Button className="button-danger" onClick={() => cancel.mutate(build.id)}>
                    {t('analytics.cancel')}
                  </Button>
                )}
                {['failed', 'canceled', 'interrupted'].includes(build.state) && (
                  <Button className="button-secondary" onClick={() => retry.mutate(build.id)}>
                    {t('analytics.retry')}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <h2>{t('corpus.versions')}</h2>
        <div className="compact-list">
          {(versions.data ?? []).map((version) => (
            <Link key={version.id} to={`/corpora/${corpusId}/versions/${version.id}`}>
              <span>
                <strong>{zh ? '语料结果' : 'Corpus result'}</strong>
                <small>{new Date(version.createdAt).toLocaleString()}</small>
              </span>
              <Badge tone="success">
                {String(version.stats.documentCount ?? 0)} {zh ? '篇文档' : 'documents'}
              </Badge>
            </Link>
          ))}
        </div>
      </Card>
    </>
  );
}

function isActive(state: string): boolean {
  return ['queued', 'claimed', 'running', 'persisting', 'canceling', 'interrupted'].includes(state);
}
