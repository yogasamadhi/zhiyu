import { productCopy } from '../product-copy.js';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { runtimeClient } from '@zhiyun/client';
import type { RecruitmentJobCluster, RecruitmentWorkflowState } from '@zhiyun/shared';
import { Badge, Button, Card, ErrorNotice } from '../components/ui.js';

const states: Array<{ value: RecruitmentWorkflowState; label: string }> = [
  { value: 'untracked', label: '未跟进' },
  { value: 'saved', label: '已收藏' },
  { value: 'planned', label: '计划投递' },
  { value: 'applied', label: '已投递' },
  { value: 'interviewing', label: '面试中' },
  { value: 'offer', label: '已获 Offer' },
  { value: 'rejected', label: '未通过' },
  { value: 'withdrawn', label: '已撤回' },
  { value: 'ignored', label: '已忽略' },
];

export function RecruitmentClusterPage() {
  const { clusterId = '' } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const profileId = searchParams.get('profile') ?? undefined;
  const [cluster, setCluster] = useState<RecruitmentJobCluster | null>(null);
  const [selectedPostings, setSelectedPostings] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const item = await runtimeClient.getRecruitmentJobCluster(clusterId, profileId);
      setCluster(item);
      setNote(item.note);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [clusterId, profileId]);

  useEffect(() => {
    void load();
  }, [load]);

  const perform = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setError('');
    try {
      await action();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy('');
    }
  };

  if (!cluster) {
    return (
      <Card>
        <ErrorNotice message={error} />
        <p>{error ? productCopy('职位簇无法加载。') : productCopy('正在加载职位详情…')}</p>
        <Link to={`/recruitment${profileId ? `?profile=${encodeURIComponent(profileId)}` : ''}`}>
          {productCopy('返回职位雷达')}
        </Link>
      </Card>
    );
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <Link to={`/recruitment${profileId ? `?profile=${encodeURIComponent(profileId)}` : ''}`}>
            {productCopy('← 返回职位雷达')}
          </Link>
          <p className="eyebrow">{productCopy('职位详情')}</p>
          <h1>{cluster.title}</h1>
          <p>
            {cluster.company} · {cluster.location ?? productCopy('地点未提供')}
          </p>
        </div>
        <div className="heading-actions">
          {cluster.matchScore !== null ? (
            <Badge tone="success">
              {productCopy('匹配')}
              {cluster.matchScore}
            </Badge>
          ) : null}
          <Badge tone="neutral">
            {productCopy('聚类置信度')}
            {Math.round(cluster.confidence * 100)}%
          </Badge>
        </div>
      </div>
      <ErrorNotice message={error} />

      <div className="recruitment-detail-grid">
        <Card>
          <h2>{productCopy('求职流程')}</h2>
          <label>
            <span>{productCopy('当前状态')}</span>
            <select
              value={cluster.workflowState}
              disabled={busy === 'state'}
              onChange={(event) =>
                void perform('state', async () => {
                  await runtimeClient.updateRecruitmentWorkflowState(cluster.id, {
                    state: event.target.value as RecruitmentWorkflowState,
                    note,
                  });
                })
              }
            >
              {states.map((state) => (
                <option key={state.value} value={state.value}>
                  {productCopy(state.label)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{productCopy('备注')}</span>
            <textarea rows={6} value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
          <Button
            disabled={busy === 'note'}
            onClick={() =>
              void perform('note', async () => {
                await runtimeClient.updateRecruitmentWorkflowState(cluster.id, {
                  state: cluster.workflowState,
                  note,
                });
              })
            }
          >
            {productCopy('保存备注')}
          </Button>
          <dl className="source-meta">
            <div>
              <dt>{productCopy('首次发现')}</dt>
              <dd>{new Date(cluster.firstSeenAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt>{productCopy('最后发现')}</dt>
              <dd>{new Date(cluster.lastSeenAt).toLocaleString()}</dd>
            </div>
          </dl>
        </Card>

        <Card>
          <h2>{productCopy('匹配原因')}</h2>
          {cluster.matchReasons.length ? (
            <div className="tag-cloud">
              {cluster.matchReasons.map((reason) => (
                <Badge key={reason} tone="success">
                  {reason}
                </Badge>
              ))}
            </div>
          ) : (
            <p>{productCopy('未指定搜索档案，或该档案尚无匹配解释。')}</p>
          )}
          <h3>{productCopy('来源字段差异')}</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{productCopy('来源')}</th>
                  <th>{productCopy('职位')}</th>
                  <th>{productCopy('地点')}</th>
                  <th>{productCopy('薪资')}</th>
                  <th>{productCopy('发布时间')}</th>
                </tr>
              </thead>
              <tbody>
                {cluster.postings.map((posting) => (
                  <tr key={posting.id}>
                    <td>{posting.sourceKey}</td>
                    <td>{posting.title}</td>
                    <td>{posting.location ?? '—'}</td>
                    <td>{posting.salaryRaw ?? '—'}</td>
                    <td>
                      {posting.publishedAt
                        ? new Date(posting.publishedAt).toLocaleDateString()
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      <div className="section-heading compact">
        <div>
          <h2>{productCopy('来源职位')}</h2>
          <p>{productCopy('每条来源事实独立保留；可选择部分记录手动拆分。')}</p>
        </div>
        <Button
          className="button-secondary"
          disabled={
            selectedPostings.length === 0 ||
            selectedPostings.length === cluster.postings.length ||
            busy === 'split'
          }
          onClick={() =>
            void perform('split', async () => {
              const created = await runtimeClient.splitRecruitmentJobCluster(
                cluster.id,
                selectedPostings,
              );
              setSelectedPostings([]);
              void navigate(
                `/recruitment/job-clusters/${created.id}${profileId ? `?profile=${encodeURIComponent(profileId)}` : ''}`,
              );
            })
          }
        >
          {productCopy('拆分所选来源')}
        </Button>
      </div>
      <div className="recruitment-posting-list">
        {cluster.postings.map((posting) => (
          <Card key={posting.id}>
            <div className="cluster-heading">
              <div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={selectedPostings.includes(posting.id)}
                    onChange={(event) =>
                      setSelectedPostings(
                        event.target.checked
                          ? [...selectedPostings, posting.id]
                          : selectedPostings.filter((id) => id !== posting.id),
                      )
                    }
                  />
                  {productCopy('选择拆分')}
                </label>
                <h3>
                  {posting.sourceKey} · {posting.title}
                </h3>
                <p>
                  {posting.company} · {posting.location ?? productCopy('地点未提供')}
                </p>
              </div>
              <Badge tone={posting.status === 'closed' ? 'danger' : 'success'}>
                {posting.status}
              </Badge>
            </div>
            <div className="posting-meta-grid">
              <span>
                {productCopy('薪资：')}
                {posting.salaryRaw ?? productCopy('未提供')}
              </span>
              <span>
                {productCopy('经验：')}
                {posting.experience ?? productCopy('未提供')}
              </span>
              <span>
                {productCopy('学历：')}
                {posting.education ?? productCopy('未提供')}
              </span>
              <span>
                {productCopy('类型：')}
                {posting.employmentType ?? productCopy('未提供')}
              </span>
            </div>
            {posting.skills.length ? (
              <div className="tag-cloud">
                {posting.skills.map((skill) => (
                  <Badge key={skill}>{skill}</Badge>
                ))}
              </div>
            ) : null}
            {posting.description ? (
              <p className="posting-description">{posting.description}</p>
            ) : null}
            {posting.sourceUrl ? (
              <a
                className="button button-secondary"
                href={posting.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                {productCopy('打开原职位 ↗')}
              </a>
            ) : null}
          </Card>
        ))}
      </div>

      {cluster.suggestions.length ? (
        <Card>
          <h2>{productCopy('可能重复的职位簇')}</h2>
          {cluster.suggestions.map((suggestion) => (
            <div className="evidence-item" key={suggestion.candidateClusterId}>
              <div>
                <strong>
                  {productCopy('候选簇')}
                  {suggestion.candidateClusterId}
                </strong>
                <small>
                  {productCopy('相似度')}
                  {Math.round(suggestion.score * 100)}%
                </small>
              </div>
              <Button
                disabled={busy === `merge:${suggestion.candidateClusterId}`}
                onClick={() =>
                  void perform(`merge:${suggestion.candidateClusterId}`, async () => {
                    await runtimeClient.mergeRecruitmentJobClusters(cluster.id, [
                      suggestion.candidateClusterId,
                    ]);
                  })
                }
              >
                {productCopy('合并到当前职位')}
              </Button>
            </div>
          ))}
        </Card>
      ) : null}

      <Card>
        <h2>{productCopy('变更记录')}</h2>
        {cluster.changes.length === 0 ? (
          <p>{productCopy('暂无业务字段变化。')}</p>
        ) : (
          <div className="evidence-list">
            {cluster.changes.map((change) => (
              <div className="evidence-item" key={change.id}>
                <div>
                  <strong>{change.changedFields.join('、')}</strong>
                  <small>
                    {new Date(change.createdAt).toLocaleString()} {productCopy('· 来源记录')}
                    {change.postingId}
                  </small>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
