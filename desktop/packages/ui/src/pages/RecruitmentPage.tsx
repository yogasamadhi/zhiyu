import { useTranslation } from 'react-i18next';
import { ConfirmAction } from '../components/ConfirmAction.js';
import { productCopy } from '../product-copy.js';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { runtimeClient, type RecruitmentSourceView } from '@zhiyun/client';
import type {
  OutputDestination,
  RecruitmentFileInput,
  RecruitmentImportField,
  RecruitmentImportJob,
  RecruitmentImportPreview,
  RecruitmentJobCluster,
  RecruitmentSearchProfile,
  RecruitmentSearchProfileInput,
  RecruitmentSourceKey,
  RecruitmentWorkflowState,
} from '@zhiyun/shared';
import { Badge, Button, Card, ErrorNotice, Input } from '../components/ui.js';

const sourceKeys: RecruitmentSourceKey[] = ['boss', 'liepin', 'huibo'];
const workflowStates: RecruitmentWorkflowState[] = [
  'untracked',
  'saved',
  'planned',
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'withdrawn',
  'ignored',
];
const workflowLabels: Record<RecruitmentWorkflowState, string> = {
  untracked: '未跟进',
  saved: '已收藏',
  planned: '计划投递',
  applied: '已投递',
  interviewing: '面试中',
  offer: '已获 Offer',
  rejected: '未通过',
  withdrawn: '已撤回',
  ignored: '已忽略',
};
const importFields: Array<{ key: RecruitmentImportField; label: string; required?: boolean }> = [
  { key: 'externalId', label: '平台职位 ID' },
  { key: 'sourceUrl', label: '职位链接' },
  { key: 'title', label: '职位名称', required: true },
  { key: 'company', label: '公司名称', required: true },
  { key: 'location', label: '工作地点' },
  { key: 'salaryRaw', label: '薪资' },
  { key: 'description', label: '职位描述' },
  { key: 'publishedAt', label: '发布时间' },
  { key: 'expiresAt', label: '截止时间' },
  { key: 'experience', label: '经验要求' },
  { key: 'education', label: '学历要求' },
  { key: 'employmentType', label: '雇佣类型' },
  { key: 'skills', label: '技能标签' },
  { key: 'status', label: '职位状态' },
];

function emptyProfile(): RecruitmentSearchProfileInput {
  return {
    name: '',
    includeKeywords: [],
    keywordMode: 'any',
    excludeKeywords: [],
    cities: [],
    remoteAllowed: true,
    salaryMinMonthly: null,
    salaryMaxMonthly: null,
    experience: [],
    education: [],
    employmentTypes: [],
    includeCompanies: [],
    excludeCompanies: [],
    sourceKeys: [...sourceKeys],
    freshnessDays: 30,
    priority: 'normal',
    enabled: true,
    digestTime: '08:00',
    timezone: 'Asia/Shanghai',
    outputDestinationIds: [],
  };
}

function profileInput(profile: RecruitmentSearchProfile): RecruitmentSearchProfileInput {
  const {
    id: _id,
    revision: _revision,
    lastDigestAt: _last,
    createdAt: _created,
    updatedAt: _updated,
    ...input
  } = profile;
  void [_id, _revision, _last, _created, _updated];
  return input;
}

function listValue(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，、\n]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function RecruitmentPage() {
  const { i18n } = useTranslation();
  const [panel, setPanel] = useState<'results' | 'profile' | 'sources' | 'import'>('results');
  const [loaded, setLoaded] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const [profiles, setProfiles] = useState<RecruitmentSearchProfile[]>([]);
  const [profileDraft, setProfileDraft] = useState<RecruitmentSearchProfileInput>(emptyProfile);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [sources, setSources] = useState<RecruitmentSourceView[]>([]);
  const [destinations, setDestinations] = useState<OutputDestination[]>([]);
  const [clusters, setClusters] = useState<RecruitmentJobCluster[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [wizardStep, setWizardStep] = useState(1);
  const [importSource, setImportSource] = useState<RecruitmentSourceKey>('boss');
  const [file, setFile] = useState<File | null>(null);
  const [fileContent, setFileContent] = useState('');
  const [preview, setPreview] = useState<RecruitmentImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [saveMapping, setSaveMapping] = useState(true);
  const [mappingName, setMappingName] = useState('');
  const [importJob, setImportJob] = useState<RecruitmentImportJob | null>(null);
  const [importErrors, setImportErrors] = useState<Array<{ row: number; message: string }>>([]);
  const profileId = searchParams.get('profile') ?? '';
  const keyword = searchParams.get('keyword') ?? '';
  const workflow = (searchParams.get('state') ?? '') as RecruitmentWorkflowState | '';
  const sourceFilter = (searchParams.get('source') ?? '') as RecruitmentSourceKey | '';
  const cityFilter = searchParams.get('city') ?? '';
  const salaryMinFilter = searchParams.get('salaryMin') ?? '';
  const salaryMaxFilter = searchParams.get('salaryMax') ?? '';
  const publishedAfterFilter = searchParams.get('publishedAfter') ?? '';
  const publishedBeforeFilter = searchParams.get('publishedBefore') ?? '';

  const updateQuery = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setSearchParams(next, { replace: true });
  };

  const loadProfileData = useCallback(
    async (selectedProfileId: string) => {
      const [sourceItems, clusterPage] = await Promise.all([
        runtimeClient.listRecruitmentSources(selectedProfileId || undefined),
        runtimeClient.listRecruitmentJobClusters({
          limit: 100,
          ...(selectedProfileId ? { profileId: selectedProfileId } : {}),
          ...(keyword ? { keyword } : {}),
          ...(workflow ? { workflowState: workflow } : {}),
          ...(sourceFilter ? { sourceKey: sourceFilter } : {}),
          ...(cityFilter ? { city: cityFilter } : {}),
          ...(salaryMinFilter ? { salaryMin: Number(salaryMinFilter) } : {}),
          ...(salaryMaxFilter ? { salaryMax: Number(salaryMaxFilter) } : {}),
          ...(publishedAfterFilter
            ? { publishedAfter: new Date(`${publishedAfterFilter}T00:00:00`).toISOString() }
            : {}),
          ...(publishedBeforeFilter
            ? { publishedBefore: new Date(`${publishedBeforeFilter}T23:59:59.999`).toISOString() }
            : {}),
        }),
      ]);
      setSources(sourceItems);
      setClusters(clusterPage.items);
    },
    [
      cityFilter,
      keyword,
      publishedAfterFilter,
      publishedBeforeFilter,
      salaryMaxFilter,
      salaryMinFilter,
      sourceFilter,
      workflow,
    ],
  );

  const load = useCallback(async () => {
    try {
      const [profileItems, outputItems] = await Promise.all([
        runtimeClient.listRecruitmentSearchProfiles(),
        runtimeClient.listOutputDestinations().catch(() => []),
      ]);
      setProfiles(profileItems);
      setLoaded(true);
      setDestinations(outputItems);
      const selected = profileItems.find((profile) => profile.id === profileId) ?? profileItems[0];
      if (selected && selected.id !== profileId) updateQuery({ profile: selected.id });
      await loadProfileData(selected?.id ?? '');
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [loadProfileData, profileId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedProfile = profiles.find((profile) => profile.id === profileId) ?? null;
  useEffect(() => {
    if (!selectedProfile || editingProfileId) return;
    setImportSource(selectedProfile.sourceKeys[0] ?? 'boss');
  }, [selectedProfile, editingProfileId]);

  const perform = async (key: string, operation: () => Promise<void>, success?: string) => {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      await operation();
      if (success) setNotice(success);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy('');
    }
  };

  const saveProfile = () =>
    perform(
      'profile',
      async () => {
        if (editingProfileId) {
          const current = profiles.find((profile) => profile.id === editingProfileId);
          if (!current) return;
          const saved = await runtimeClient.updateRecruitmentSearchProfile(
            current.id,
            current.revision,
            profileDraft,
          );
          updateQuery({ profile: saved.id });
        } else {
          const saved = await runtimeClient.createRecruitmentSearchProfile(profileDraft);
          updateQuery({ profile: saved.id });
        }
        setEditingProfileId(null);
        setProfileDraft(emptyProfile());
        setPanel('results');
        await load();
      },
      editingProfileId ? productCopy('搜索档案已更新') : productCopy('搜索档案已创建'),
    );

  const selectFile = async (selected: File | null) => {
    setFile(selected);
    setPreview(null);
    setImportJob(null);
    setImportErrors([]);
    if (!selected) {
      setFileContent('');
      return;
    }
    if (selected.size > 50 * 1024 * 1024) {
      setError(productCopy('文件不能超过 50 MB'));
      return;
    }
    setFileContent(await selected.text());
  };

  const fileRequest = (): RecruitmentFileInput => {
    if (!selectedProfile || !file) throw new Error(productCopy('请选择搜索档案和导入文件'));
    const format = file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv';
    return {
      sourceKey: importSource,
      searchProfileId: selectedProfile.id,
      filename: file.name,
      format,
      content: fileContent,
      saveMapping,
      ...(Object.keys(mapping).length ? { mapping } : {}),
      ...(mappingName.trim() ? { mappingName: mappingName.trim() } : {}),
    };
  };

  const previewImport = () =>
    perform('preview', async () => {
      const result = await runtimeClient.previewRecruitmentImport(fileRequest());
      setPreview(result);
      setMapping(result.suggestedMapping);
      setMappingName(result.reusableMapping?.name ?? `${importSource}-${file?.name ?? 'mapping'}`);
      setWizardStep(3);
    });

  const runImport = () =>
    perform(
      'import',
      async () => {
        const result = await runtimeClient.createRecruitmentImport(fileRequest());
        setImportJob(result);
        setWizardStep(5);
        if (result.errorRows) {
          const report = await runtimeClient.getRecruitmentImportErrors(result.id);
          setImportErrors(report.items.slice(0, 100));
        }
        await load();
        if (result.status === 'succeeded') setPanel('results');
      },
      productCopy('职位数据已导入'),
    );

  const updateWorkflow = (cluster: RecruitmentJobCluster, state: RecruitmentWorkflowState) =>
    perform(`state:${cluster.id}`, async () => {
      await runtimeClient.updateRecruitmentWorkflowState(cluster.id, {
        state,
        note: cluster.note,
      });
      await loadProfileData(profileId);
    });

  const selectedSource = sources.find((source) => source.key === importSource);
  const sourceCount = useMemo(
    () =>
      new Map(
        sourceKeys.map((key) => [
          key,
          clusters.filter((cluster) =>
            cluster.postings.some((posting) => posting.sourceKey === key),
          ).length,
        ]),
      ),
    [clusters],
  );

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{productCopy('职位雷达')}</p>
          <h1>{productCopy('职位雷达')}</h1>
          <p>{productCopy('导入你合法取得的招聘数据，跨来源去重并跟踪求职进度。')}</p>
        </div>
        <Button
          className="button-secondary"
          onClick={() => {
            setPanel('profile');
            setEditingProfileId(null);
            setProfileDraft(emptyProfile());
          }}
        >
          {productCopy('＋ 新建搜索档案')}
        </Button>
      </div>
      <ErrorNotice message={error} />
      {notice ? <div className="notice notice-success">{notice}</div> : null}

      <nav className="section-tabs" aria-label={productCopy('职位雷达工作区')}>
        {[
          ['results', productCopy('匹配职位')],
          ['profile', productCopy('搜索档案')],
          ['sources', productCopy('来源与通知')],
          ['import', productCopy('导入职位')],
        ].map(([key, label]) => (
          <Button
            key={key}
            className={panel === key ? 'button-secondary' : 'button-ghost'}
            onClick={() => setPanel(key as typeof panel)}
          >
            {productCopy(label)}
          </Button>
        ))}
      </nav>
      {!loaded && <p role="status">{productCopy('正在加载职位与搜索档案…')}</p>}
      {panel === 'results' && profiles.length > 0 && (
        <>
          <label className="form-field">
            <span>{productCopy('当前搜索档案')}</span>
            <select
              value={profileId}
              onChange={(event) => updateQuery({ profile: event.target.value })}
            >
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>{' '}
          <div className="section-heading">
            <div>
              <h2>{productCopy('匹配职位')}</h2>
              <p>{productCopy('同一职位的多个来源合并展示，来源事实仍分别保留。')}</p>
            </div>
            <div className="recruitment-filters">
              <Input
                value={keyword}
                placeholder={productCopy('搜索职位或公司')}
                onChange={(event) => updateQuery({ keyword: event.target.value || null })}
              />
              <Input
                value={cityFilter}
                placeholder={productCopy('城市')}
                onChange={(event) => updateQuery({ city: event.target.value || null })}
              />
              <Input
                type="number"
                min={0}
                value={salaryMinFilter}
                placeholder={productCopy('最低月薪')}
                onChange={(event) => updateQuery({ salaryMin: event.target.value || null })}
              />
              <Input
                type="number"
                min={0}
                value={salaryMaxFilter}
                placeholder={productCopy('最高月薪')}
                onChange={(event) => updateQuery({ salaryMax: event.target.value || null })}
              />
              <Input
                type="date"
                value={publishedAfterFilter}
                aria-label={productCopy('最早发布时间')}
                onChange={(event) => updateQuery({ publishedAfter: event.target.value || null })}
              />
              <Input
                type="date"
                value={publishedBeforeFilter}
                aria-label={productCopy('最晚发布时间')}
                onChange={(event) => updateQuery({ publishedBefore: event.target.value || null })}
              />
              <select
                value={sourceFilter}
                onChange={(event) => updateQuery({ source: event.target.value || null })}
              >
                <option value="">{productCopy('全部来源')}</option>
                <option value="boss">{productCopy('BOSS 直聘')}</option>
                <option value="liepin">{productCopy('猎聘')}</option>
                <option value="huibo">{productCopy('汇博招聘')}</option>
              </select>
              <select
                value={workflow}
                onChange={(event) => updateQuery({ state: event.target.value || null })}
              >
                <option value="">{productCopy('全部流程状态')}</option>
                {workflowStates.map((state) => (
                  <option key={state} value={state}>
                    {productCopy(workflowLabels[state])}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {clusters.length === 0 ? (
            <Card className="empty">
              <p>{productCopy('当前档案还没有匹配职位。完成一次文件导入后会显示在这里。')}</p>
              <Button onClick={() => setPanel('import')}>{productCopy('导入职位数据')}</Button>
            </Card>
          ) : (
            <div className="recruitment-cluster-grid">
              {clusters.map((cluster) => (
                <Card key={cluster.id} className="recruitment-cluster-card">
                  <div className="cluster-heading">
                    <div>
                      <Link
                        to={`/recruitment/job-clusters/${cluster.id}?profile=${encodeURIComponent(profileId)}`}
                      >
                        <h3>{cluster.title}</h3>
                      </Link>
                      <strong>{cluster.company}</strong>
                    </div>
                    {cluster.matchScore !== null ? (
                      <Badge tone="success">
                        {productCopy('匹配')}
                        {cluster.matchScore}
                      </Badge>
                    ) : null}
                  </div>
                  <p>
                    {cluster.location ?? productCopy('地点未提供')} · {cluster.postings.length}{' '}
                    {productCopy('个来源记录')}
                  </p>
                  <div className="tag-cloud">
                    {[...new Set(cluster.postings.map((posting) => posting.sourceKey))].map(
                      (key) => (
                        <Badge key={key}>{key}</Badge>
                      ),
                    )}
                    {cluster.matchReasons.slice(0, 3).map((reason) => (
                      <Badge key={reason} tone="neutral">
                        {reason}
                      </Badge>
                    ))}
                  </div>
                  <div className="cluster-source-links">
                    {cluster.postings
                      .filter((posting) => posting.sourceUrl)
                      .map((posting) => (
                        <a
                          key={posting.id}
                          href={posting.sourceUrl!}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {posting.sourceKey} {productCopy('原职位 ↗')}
                        </a>
                      ))}
                  </div>
                  <label>
                    <span>{productCopy('求职进度')}</span>
                    <select
                      value={cluster.workflowState}
                      disabled={busy === `state:${cluster.id}`}
                      onChange={(event) =>
                        void updateWorkflow(cluster, event.target.value as RecruitmentWorkflowState)
                      }
                    >
                      {workflowStates.map((state) => (
                        <option key={state} value={state}>
                          {productCopy(workflowLabels[state])}
                        </option>
                      ))}
                    </select>
                  </label>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
      {(panel === 'profile' || (loaded && profiles.length === 0)) && (
        <>
          <div className="recruitment-profile-layout">
            <Card className="recruitment-profile-list">
              <h2>{productCopy('搜索档案')}</h2>
              {profiles.length === 0 ? <p>{productCopy('先创建一个职位搜索档案。')}</p> : null}
              {profiles.map((profile) => (
                <button
                  type="button"
                  key={profile.id}
                  className={profile.id === profileId ? 'profile-choice active' : 'profile-choice'}
                  onClick={() => updateQuery({ profile: profile.id })}
                >
                  <span>
                    <strong>{profile.name}</strong>
                    <small>{profile.includeKeywords.join('、') || productCopy('不限关键词')}</small>
                  </span>
                  <Badge tone={profile.priority === 'high' ? 'danger' : 'neutral'}>
                    {profile.priority === 'high' ? productCopy('高优先级') : productCopy('普通')}
                  </Badge>
                </button>
              ))}
            </Card>

            <Card className="recruitment-profile-editor">
              <div className="section-heading compact">
                <div>
                  <h2>
                    {editingProfileId ? productCopy('编辑搜索档案') : productCopy('新建搜索档案')}
                  </h2>
                  <p>{productCopy('档案分别控制来源、匹配条件和通知优先级。')}</p>
                </div>
                {selectedProfile && !editingProfileId ? (
                  <Button
                    className="button-secondary"
                    onClick={() => {
                      setEditingProfileId(selectedProfile.id);
                      setProfileDraft(profileInput(selectedProfile));
                    }}
                  >
                    {productCopy('编辑当前档案')}
                  </Button>
                ) : null}
              </div>
              <div className="form-grid recruitment-form-grid">
                <label>
                  <span>{productCopy('档案名称')}</span>
                  <Input
                    value={profileDraft.name}
                    onChange={(event) =>
                      setProfileDraft({ ...profileDraft, name: event.target.value })
                    }
                  />
                </label>
                <label>
                  <span>{productCopy('包含关键词')}</span>
                  <Input
                    value={profileDraft.includeKeywords.join('，')}
                    onChange={(event) =>
                      setProfileDraft({
                        ...profileDraft,
                        includeKeywords: listValue(event.target.value),
                      })
                    }
                    placeholder={productCopy('TypeScript，数据工程')}
                  />
                </label>
              </div>
              <details className="advanced-section">
                <summary>{productCopy('更多匹配条件、来源与通知（可稍后设置）')}</summary>
                <div className="form-grid recruitment-form-grid">
                  <label>
                    <span>{productCopy('关键词规则')}</span>
                    <select
                      value={profileDraft.keywordMode}
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          keywordMode: event.target.value as 'any' | 'all',
                        })
                      }
                    >
                      <option value="any">{productCopy('命中任一关键词')}</option>
                      <option value="all">{productCopy('命中全部关键词')}</option>
                    </select>
                  </label>
                  <label>
                    <span>{productCopy('排除关键词')}</span>
                    <Input
                      value={profileDraft.excludeKeywords.join('，')}
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          excludeKeywords: listValue(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>{productCopy('城市')}</span>
                    <Input
                      value={profileDraft.cities.join('，')}
                      onChange={(event) =>
                        setProfileDraft({ ...profileDraft, cities: listValue(event.target.value) })
                      }
                      placeholder={productCopy('上海，杭州')}
                    />
                  </label>
                  <label>
                    <span>{productCopy('经验要求')}</span>
                    <Input
                      value={profileDraft.experience.join('，')}
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          experience: listValue(event.target.value),
                        })
                      }
                      placeholder={productCopy('3-5年，5-10年')}
                    />
                  </label>
                  <label>
                    <span>{productCopy('学历要求')}</span>
                    <Input
                      value={profileDraft.education.join('，')}
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          education: listValue(event.target.value),
                        })
                      }
                      placeholder={productCopy('本科，硕士')}
                    />
                  </label>
                  <label>
                    <span>{productCopy('雇佣类型')}</span>
                    <Input
                      value={profileDraft.employmentTypes.join('，')}
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          employmentTypes: listValue(event.target.value),
                        })
                      }
                      placeholder={productCopy('全职，兼职')}
                    />
                  </label>
                  <label>
                    <span>{productCopy('包含公司')}</span>
                    <Input
                      value={profileDraft.includeCompanies.join('，')}
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          includeCompanies: listValue(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>{productCopy('排除公司')}</span>
                    <Input
                      value={profileDraft.excludeCompanies.join('，')}
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          excludeCompanies: listValue(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>{productCopy('最低月薪（元）')}</span>
                    <Input
                      type="number"
                      min={0}
                      value={profileDraft.salaryMinMonthly ?? ''}
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          salaryMinMonthly: event.target.value ? Number(event.target.value) : null,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>{productCopy('最高月薪（元）')}</span>
                    <Input
                      type="number"
                      min={0}
                      value={profileDraft.salaryMaxMonthly ?? ''}
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          salaryMaxMonthly: event.target.value ? Number(event.target.value) : null,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>{productCopy('通知优先级')}</span>
                    <select
                      value={profileDraft.priority}
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          priority: event.target.value as 'normal' | 'high',
                        })
                      }
                    >
                      <option value="normal">{productCopy('普通（每日摘要）')}</option>
                      <option value="high">{productCopy('高（即时通知 + 每日摘要）')}</option>
                    </select>
                  </label>
                  <label>
                    <span>{productCopy('摘要时间')}</span>
                    <Input
                      type="time"
                      value={profileDraft.digestTime}
                      onChange={(event) =>
                        setProfileDraft({ ...profileDraft, digestTime: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    <span>{productCopy('新鲜度（天）')}</span>
                    <Input
                      type="number"
                      min={1}
                      max={3650}
                      value={profileDraft.freshnessDays}
                      onChange={(event) =>
                        setProfileDraft({
                          ...profileDraft,
                          freshnessDays: Number(event.target.value) || 30,
                        })
                      }
                    />
                  </label>
                  <label>
                    <span>{productCopy('摘要时区')}</span>
                    <Input
                      value={profileDraft.timezone}
                      onChange={(event) =>
                        setProfileDraft({ ...profileDraft, timezone: event.target.value })
                      }
                      placeholder="Asia/Shanghai"
                    />
                  </label>
                </div>
                <div className="source-switches recruitment-checks">
                  {sourceKeys.map((key) => (
                    <label className="check" key={key}>
                      <input
                        type="checkbox"
                        checked={profileDraft.sourceKeys.includes(key)}
                        onChange={(event) =>
                          setProfileDraft({
                            ...profileDraft,
                            sourceKeys: event.target.checked
                              ? [...profileDraft.sourceKeys, key]
                              : profileDraft.sourceKeys.filter((value) => value !== key),
                          })
                        }
                      />
                      {key === 'boss'
                        ? productCopy('BOSS 直聘')
                        : key === 'liepin'
                          ? productCopy('猎聘')
                          : productCopy('汇博招聘')}
                    </label>
                  ))}
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={profileDraft.remoteAllowed}
                      onChange={(event) =>
                        setProfileDraft({ ...profileDraft, remoteAllowed: event.target.checked })
                      }
                    />
                    {productCopy('接受远程')}
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={profileDraft.enabled}
                      onChange={(event) =>
                        setProfileDraft({ ...profileDraft, enabled: event.target.checked })
                      }
                    />
                    {productCopy('启用档案')}
                  </label>
                </div>
                {destinations.length ? (
                  <div className="recruitment-output-bindings">
                    <strong>{productCopy('通知输出')}</strong>
                    {destinations.map((destination) => (
                      <label className="check" key={destination.id}>
                        <input
                          type="checkbox"
                          checked={profileDraft.outputDestinationIds.includes(destination.id)}
                          onChange={(event) =>
                            setProfileDraft({
                              ...profileDraft,
                              outputDestinationIds: event.target.checked
                                ? [...profileDraft.outputDestinationIds, destination.id]
                                : profileDraft.outputDestinationIds.filter(
                                    (id) => id !== destination.id,
                                  ),
                            })
                          }
                        />
                        {destination.name}
                      </label>
                    ))}
                  </div>
                ) : null}
              </details>
              <div className="row-actions">
                <Button
                  disabled={
                    !profileDraft.name.trim() ||
                    profileDraft.includeKeywords.length === 0 ||
                    profileDraft.sourceKeys.length === 0 ||
                    busy === 'profile'
                  }
                  onClick={() => void saveProfile()}
                >
                  {busy === 'profile' ? productCopy('保存中…') : productCopy('保存档案')}
                </Button>
                {editingProfileId ? (
                  <Button
                    className="button-secondary"
                    onClick={() => {
                      setEditingProfileId(null);
                      setProfileDraft(emptyProfile());
                    }}
                  >
                    {productCopy('取消编辑')}
                  </Button>
                ) : null}
                {selectedProfile ? (
                  <ConfirmAction
                    label={productCopy('删除当前档案')}
                    disabled={Boolean(busy)}
                    description={
                      i18n.language.startsWith('zh')
                        ? `删除“${selectedProfile.name}”及其匹配记录，原始职位与跟进记录会保留。此操作无法撤销。`
                        : `Delete “${selectedProfile.name}” and its matches? Original jobs and tracking records remain. This cannot be undone.`
                    }
                    onConfirm={async () => {
                      await runtimeClient.deleteRecruitmentSearchProfile(selectedProfile.id);
                      updateQuery({ profile: null });
                      await load();
                    }}
                  />
                ) : null}
              </div>
            </Card>
          </div>
        </>
      )}
      {panel === 'sources' && (
        <>
          <div className="section-heading">
            <div>
              <h2>{productCopy('招聘来源')}</h2>
              <p>{productCopy('当前支持文件导入与原站跳转。此实例未安装招聘平台同步适配器。')}</p>
            </div>
          </div>
          <div className="source-grid recruitment-source-grid">
            {sources.map((source) => (
              <Card key={source.key} className="source-card">
                <div className="source-card-heading">
                  <div>
                    <h3>{productCopy(source.name)}</h3>
                    <p>
                      {sourceCount.get(source.key) ?? 0} {productCopy('个职位簇包含此来源')}
                    </p>
                  </div>
                  <Badge
                    tone={
                      source.authorizationStatus === 'authorized'
                        ? 'success'
                        : source.authorizationStatus === 'error'
                          ? 'danger'
                          : 'neutral'
                    }
                  >
                    {!source.liveSyncAvailable
                      ? productCopy('文件导入 / 原站跳转')
                      : source.authorizationStatus === 'authorized'
                        ? productCopy('已授权')
                        : source.authorizationStatus === 'revoked'
                          ? productCopy('授权已撤销')
                          : source.authorizationStatus === 'error'
                            ? productCopy('授权异常')
                            : productCopy('待授权')}
                  </Badge>
                </div>
                <p className="privacy-note">
                  {productCopy('仅支持合法文件导入和原站跳转；不调用隐藏接口、不自动登录。')}
                </p>
                <div className="row-actions">
                  <a className="button" href={source.searchUrl} target="_blank" rel="noreferrer">
                    {productCopy('打开原站搜索')}
                  </a>
                  <Button
                    className="button-secondary"
                    disabled={
                      !source.liveSyncAvailable ||
                      source.authorizationStatus !== 'authorized' ||
                      busy === `sync:${source.key}`
                    }
                    title={
                      source.liveSyncAvailable
                        ? productCopy('运行已审查的官方授权适配器')
                        : productCopy('此实例仅支持文件导入与原站跳转')
                    }
                    onClick={() =>
                      void perform(
                        `sync:${source.key}`,
                        async () => {
                          await runtimeClient.syncRecruitmentSource(source.key);
                          await loadProfileData(profileId);
                        },
                        `${productCopy(source.name)} 同步完成`,
                      )
                    }
                  >
                    {busy === `sync:${source.key}`
                      ? productCopy('同步中…')
                      : source.liveSyncAvailable
                        ? productCopy('实时同步')
                        : productCopy('未安装同步适配器')}
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}
      {panel === 'import' && (
        <Card className="recruitment-import-card">
          <div className="section-heading compact">
            <div>
              <h2>{productCopy('导入职位数据')}</h2>
              <p>{productCopy('CSV/JSON · 最大 50 MB / 100,000 行 · 原文件不保留')}</p>
            </div>
            <div className="wizard-steps" aria-label={productCopy('导入步骤')}>
              {[
                productCopy('来源'),
                productCopy('文件'),
                productCopy('映射'),
                productCopy('确认'),
                productCopy('结果'),
              ].map((label, index) => (
                <span
                  key={productCopy(label)}
                  className={
                    wizardStep === index + 1 ? 'active' : wizardStep > index + 1 ? 'done' : ''
                  }
                >
                  {index + 1}. {productCopy(label)}
                </span>
              ))}
            </div>
          </div>
          {!selectedProfile ? <p>{productCopy('请先创建搜索档案。')}</p> : null}
          {selectedProfile && wizardStep === 1 ? (
            <div className="wizard-panel">
              <label>
                <span>{productCopy('导入到档案')}</span>
                <select
                  value={selectedProfile.id}
                  onChange={(event) => updateQuery({ profile: event.target.value })}
                >
                  {profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{productCopy('数据来源')}</span>
                <select
                  value={importSource}
                  onChange={(event) => setImportSource(event.target.value as RecruitmentSourceKey)}
                >
                  {selectedProfile.sourceKeys.map((key) => (
                    <option key={key} value={key}>
                      {key === 'boss'
                        ? productCopy('BOSS 直聘')
                        : key === 'liepin'
                          ? productCopy('猎聘')
                          : productCopy('汇博招聘')}
                    </option>
                  ))}
                </select>
              </label>
              <a href={selectedSource?.searchUrl} target="_blank" rel="noreferrer">
                {productCopy('先在原站搜索并合法导出数据 ↗')}
              </a>
              <Button onClick={() => setWizardStep(2)}>{productCopy('下一步')}</Button>
            </div>
          ) : null}
          {selectedProfile && wizardStep === 2 ? (
            <div className="wizard-panel">
              <input
                type="file"
                accept=".csv,.json,text/csv,application/json"
                onChange={(event) => void selectFile(event.target.files?.[0] ?? null)}
              />
              {file ? (
                <p>
                  {file.name} · {(file.size / 1024).toFixed(1)} KB
                </p>
              ) : null}
              <div className="row-actions">
                <Button className="button-secondary" onClick={() => setWizardStep(1)}>
                  {productCopy('上一步')}
                </Button>
                <Button
                  disabled={!file || !fileContent || busy === 'preview'}
                  onClick={() => void previewImport()}
                >
                  {busy === 'preview' ? productCopy('解析中…') : productCopy('预览并识别字段')}
                </Button>
              </div>
            </div>
          ) : null}
          {preview && wizardStep === 3 ? (
            <div className="wizard-panel">
              <p>
                {productCopy('识别到')} {preview.totalRows} {productCopy('行、')}
                {preview.headers.length} {productCopy('列。请确认字段映射。')}
              </p>
              <div className="mapping-grid">
                {importFields.map((field) => (
                  <label key={field.key}>
                    <span>
                      {productCopy(field.label)}
                      {field.required ? ' *' : ''}
                    </span>
                    <select
                      value={mapping[field.key] ?? ''}
                      onChange={(event) =>
                        setMapping({ ...mapping, [field.key]: event.target.value })
                      }
                    >
                      <option value="">{productCopy('不导入')}</option>
                      {preview.headers.map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={saveMapping}
                  onChange={(event) => setSaveMapping(event.target.checked)}
                />
                {productCopy('保存为可复用映射')}
              </label>
              {saveMapping ? (
                <Input
                  value={mappingName}
                  onChange={(event) => setMappingName(event.target.value)}
                  placeholder={productCopy('映射名称')}
                />
              ) : null}
              <div className="row-actions">
                <Button className="button-secondary" onClick={() => setWizardStep(2)}>
                  {productCopy('上一步')}
                </Button>
                <Button
                  disabled={
                    !mapping.title ||
                    !mapping.company ||
                    (!mapping.externalId && !mapping.sourceUrl)
                  }
                  onClick={() => setWizardStep(4)}
                >
                  {productCopy('检查完成')}
                </Button>
              </div>
            </div>
          ) : null}
          {preview && wizardStep === 4 ? (
            <div className="wizard-panel">
              <h3>{productCopy('确认导入')}</h3>
              <dl className="source-meta">
                <div>
                  <dt>{productCopy('档案')}</dt>
                  <dd>{selectedProfile?.name}</dd>
                </div>
                <div>
                  <dt>{productCopy('来源')}</dt>
                  <dd>{selectedSource?.name}</dd>
                </div>
                <div>
                  <dt>{productCopy('文件')}</dt>
                  <dd>{preview.filename}</dd>
                </div>
                <div>
                  <dt>{productCopy('数据行')}</dt>
                  <dd>{preview.totalRows}</dd>
                </div>
              </dl>
              <p className="privacy-note">
                {productCopy(
                  '描述会转为纯文本，联系方式字段会被丢弃或脱敏；文件内容在请求完成后不保留。',
                )}
              </p>
              <div className="row-actions">
                <Button className="button-secondary" onClick={() => setWizardStep(3)}>
                  {productCopy('上一步')}
                </Button>
                <Button disabled={busy === 'import'} onClick={() => void runImport()}>
                  {busy === 'import' ? productCopy('导入中…') : productCopy('开始导入')}
                </Button>
              </div>
            </div>
          ) : null}
          {importJob && wizardStep === 5 ? (
            <div className="wizard-panel">
              <Badge tone={importJob.status === 'succeeded' ? 'success' : 'danger'}>
                {importJob.status === 'succeeded'
                  ? productCopy('导入完成')
                  : productCopy('导入失败')}
              </Badge>
              <div className="import-stat-grid">
                <div>
                  <strong>{importJob.importedRows}</strong>
                  <small>{productCopy('有效行')}</small>
                </div>
                <div>
                  <strong>{importJob.createdRows}</strong>
                  <small>{productCopy('新增')}</small>
                </div>
                <div>
                  <strong>{importJob.updatedRows}</strong>
                  <small>{productCopy('更新')}</small>
                </div>
                <div>
                  <strong>{importJob.unchangedRows}</strong>
                  <small>{productCopy('未变化')}</small>
                </div>
                <div>
                  <strong>{importJob.errorRows}</strong>
                  <small>{productCopy('错误')}</small>
                </div>
              </div>
              {importErrors.length ? (
                <div className="import-errors">
                  <strong>{productCopy('错误摘要')}</strong>
                  {importErrors.slice(0, 10).map((item) => (
                    <small key={`${item.row}:${item.message}`}>
                      {productCopy('第')}
                      {item.row} {productCopy('行：')}
                      {item.message}
                    </small>
                  ))}
                  {importJob.errorArtifactId ? (
                    <small>
                      {productCopy('完整 JSONL 报告 Artifact：')}
                      {importJob.errorArtifactId}
                    </small>
                  ) : null}
                </div>
              ) : null}
              <Button
                onClick={() => {
                  setWizardStep(1);
                  setPreview(null);
                  setFile(null);
                  setFileContent('');
                  setImportJob(null);
                }}
              >
                {productCopy('继续导入')}
              </Button>
            </div>
          ) : null}
        </Card>
      )}
    </>
  );
}
