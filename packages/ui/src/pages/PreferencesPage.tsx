import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { runtimeClient } from '@zhiyun/client';
import type {
  PreferenceContent,
  PreferenceProfile,
  PreferenceSignal,
  PreferenceSignalKind,
  TrendItem,
  TrendSource,
  TrendsResponse,
} from '@zhiyun/shared';
import { Badge, Button, Card, ErrorNotice, Input } from '../components/ui.js';

const emptyProfile: PreferenceProfile = {
  positiveTags: [],
  negativeTags: [],
  contentTypes: [],
  platforms: [],
  signalCount: 0,
  updatedAt: null,
  recentSignals: [],
};

const emptyTrends: TrendsResponse = {
  items: [],
  terms: [],
  generatedAt: new Date(0).toISOString(),
};

function targetKey(content: PreferenceContent): string {
  return `${content.platform}:${content.contentType}:${content.externalId.trim().toLowerCase()}`;
}

function metricLabel(key: string): string {
  const labels: Record<string, string> = {
    view: '播放',
    like: '点赞',
    favorite: '收藏',
    share: '分享',
    reply: '评论',
    read: '在读',
    words: '字数',
    readCount: '在读',
    wordCount: '字数',
    monthlyTickets: '月票',
  };
  return labels[key] ?? key;
}

function stale(source: TrendSource): boolean {
  if (!source.lastSucceededAt) return false;
  const maximumAge = source.platform === 'bilibili' ? 12 : 48;
  return Date.now() - new Date(source.lastSucceededAt).getTime() > maximumAge * 3_600_000;
}

export function PreferencesPage() {
  const { t, i18n } = useTranslation();
  const [sources, setSources] = useState<TrendSource[]>([]);
  const [trends, setTrends] = useState<TrendsResponse>(emptyTrends);
  const [profile, setProfile] = useState<PreferenceProfile>(emptyProfile);
  const [signals, setSignals] = useState<PreferenceSignal[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [manualTags, setManualTags] = useState('');
  const [importUrl, setImportUrl] = useState('');
  const [importKind, setImportKind] = useState<PreferenceSignalKind>('like');

  const load = useCallback(async () => {
    try {
      const [sourceItems, trendItems, currentProfile, signalPage] = await Promise.all([
        runtimeClient.listTrendSources(),
        runtimeClient.getTrends({ limit: 100 }),
        runtimeClient.getPreferenceProfile(),
        runtimeClient.listPreferenceSignals(500),
      ]);
      setSources(sourceItems);
      setTrends(trendItems);
      setProfile(currentProfile);
      setSignals(signalPage.items);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const running = sources.some((source) => ['queued', 'running'].includes(source.status));
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void load(), 4_000);
    return () => window.clearInterval(timer);
  }, [load, running]);

  const installed = sources.some((source) => source.supported && source.taskId);
  const signalIndex = useMemo(
    () => new Map(signals.map((signal) => [`${signal.targetKey}:${signal.kind}`, signal])),
    [signals],
  );

  const formatDate = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat(i18n.language, {
          dateStyle: 'short',
          timeStyle: 'short',
        }).format(new Date(value))
      : '—';

  const perform = async (key: string, operation: () => Promise<unknown>, message?: string) => {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      await operation();
      if (message) setNotice(message);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy('');
    }
  };

  const setSignal = async (content: PreferenceContent, kind: PreferenceSignalKind) => {
    const existing = signalIndex.get(`${targetKey(content)}:${kind}`);
    await perform(`signal:${targetKey(content)}:${kind}`, () =>
      existing
        ? runtimeClient.deletePreferenceSignal(existing.id)
        : runtimeClient.upsertPreferenceSignal({ kind, content }),
    );
  };

  const addManual = async (kind: 'like' | 'dislike') => {
    const tags = [
      ...new Set(
        manualTags
          .split(/[,，、\n]+/)
          .map((tag) => tag.trim())
          .filter(Boolean),
      ),
    ];
    if (tags.length === 0) return;
    const title = tags.join('、');
    await perform(
      `manual:${kind}`,
      () =>
        runtimeClient.upsertPreferenceSignal({
          kind,
          content: {
            platform: 'manual',
            contentType: 'topic',
            externalId: tags
              .map((tag) => tag.toLowerCase())
              .sort()
              .join('|'),
            title,
            url: null,
            coverUrl: null,
            author: null,
            summary: null,
            tags,
            metadata: {},
          },
        }),
      t('preferenceSaved'),
    );
    setManualTags('');
  };

  const importContent = async () => {
    if (!importUrl.trim()) return;
    await perform(
      'import',
      () => runtimeClient.importPreferenceContent({ url: importUrl.trim(), kind: importKind }),
      t('preferenceImported'),
    );
    setImportUrl('');
  };

  const renderSignalButtons = (item: TrendItem) => {
    const key = targetKey(item);
    const button = (kind: PreferenceSignalKind, label: string) => {
      const active = signalIndex.has(`${key}:${kind}`);
      return (
        <Button
          key={kind}
          className={active ? 'preference-action active' : 'preference-action button-secondary'}
          disabled={busy.startsWith('signal:')}
          aria-pressed={active}
          onClick={() => void setSignal(item, kind)}
        >
          {label}
        </Button>
      );
    };
    return [
      button('like', t('like')),
      button('dislike', t('notInterested')),
      button('completed', item.contentType === 'novel' ? t('readCompleted') : t('watchCompleted')),
    ];
  };

  const trendSections = [
    { key: 'hongguo.latest', title: t('latestDrama') },
    { key: 'fanqie.read-ranking', title: t('novelRanking') },
    { key: 'qidian.monthly-ticket-ranking', title: t('qidianRanking') },
    { key: 'bilibili.popular', title: t('bilibiliPopular') },
  ];

  if (loading) return <Card className="empty">{t('loading')}</Card>;

  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">{t('workspace')}</p>
          <h1>{t('preferencesAndTrends')}</h1>
          <p>{t('preferencesIntro')}</p>
        </div>
        {installed ? (
          <Button
            disabled={Boolean(busy) || running}
            onClick={() =>
              void perform('run-all', () => runtimeClient.runTrendSources(), t('updateQueued'))
            }
          >
            {running ? t('updating') : t('updateAll')}
          </Button>
        ) : null}
      </div>
      <ErrorNotice message={error} />
      {notice ? <div className="notice notice-success">{notice}</div> : null}

      {!installed ? (
        <Card className="preference-onboarding">
          <span className="onboarding-icon">◎</span>
          <h2>{t('enableTrendTitle')}</h2>
          <p>{t('enableTrendDescription')}</p>
          <div className="onboarding-sources">
            {sources
              .filter((source) => source.supported)
              .map((source) => (
                <div key={source.key}>
                  <strong>{source.name}</strong>
                  <small>{source.description}</small>
                  <Badge tone="neutral">{source.scheduleLabel}</Badge>
                </div>
              ))}
          </div>
          <div className="privacy-note">{t('preferencePrivacy')}</div>
          <Button
            disabled={busy === 'bootstrap'}
            onClick={() =>
              void perform(
                'bootstrap',
                () => runtimeClient.bootstrapTrendSources(),
                t('sourcesEnabled'),
              )
            }
          >
            {busy === 'bootstrap' ? t('enabling') : t('enableOneClick')}
          </Button>
        </Card>
      ) : (
        <>
          <div className="section-heading">
            <div>
              <h2>{t('trendSources')}</h2>
              <p>{t('trendSourcesHint')}</p>
            </div>
          </div>
          <div className="source-grid">
            {sources.map((source) => (
              <Card key={source.key} className={`source-card source-${source.status}`}>
                <div className="source-card-heading">
                  <div>
                    <h3>{source.name}</h3>
                    <p>{source.description}</p>
                  </div>
                  <Badge
                    tone={
                      source.status === 'failed'
                        ? 'danger'
                        : source.status === 'succeeded'
                          ? 'success'
                          : 'neutral'
                    }
                  >
                    {t(`sourceStatus.${source.status}`)}
                  </Badge>
                </div>
                {source.supported ? (
                  <>
                    <dl className="source-meta">
                      <div>
                        <dt>{t('updateFrequency')}</dt>
                        <dd>{source.scheduleLabel}</dd>
                      </div>
                      <div>
                        <dt>{t('lastSuccess')}</dt>
                        <dd>{formatDate(source.lastSucceededAt)}</dd>
                      </div>
                    </dl>
                    {source.lastError ? (
                      <div className="source-error">{source.lastError}</div>
                    ) : null}
                    {stale(source) ? <div className="source-stale">{t('staleData')}</div> : null}
                    <div className="source-switches">
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={source.enabled}
                          disabled={busy === source.key}
                          onChange={(event) =>
                            void perform(source.key, () =>
                              runtimeClient.updateTrendSource(source.key, {
                                enabled: event.target.checked,
                              }),
                            )
                          }
                        />
                        {t('enabled')}
                      </label>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={source.autoRefresh}
                          disabled={!source.enabled || busy === source.key}
                          onChange={(event) =>
                            void perform(source.key, () =>
                              runtimeClient.updateTrendSource(source.key, {
                                autoRefresh: event.target.checked,
                              }),
                            )
                          }
                        />
                        {t('autoRefresh')}
                      </label>
                    </div>
                    <div className="row-actions">
                      <Button
                        disabled={!source.enabled || Boolean(busy) || running}
                        onClick={() =>
                          void perform(
                            `run:${source.key}`,
                            () => runtimeClient.runTrendSource(source.key),
                            t('updateQueued'),
                          )
                        }
                      >
                        {t('updateNow')}
                      </Button>
                      {source.taskId ? (
                        <Link className="button button-secondary" to={`/tasks/${source.taskId}`}>
                          {t('viewRawTask')}
                        </Link>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <div className="planned-source">{t('douyinPlanned')}</div>
                )}
              </Card>
            ))}
          </div>

          <div className="profile-layout">
            <Card>
              <div className="section-heading compact">
                <div>
                  <h2>{t('preferenceProfile')}</h2>
                  <p>{t('evidenceCount', { count: profile.signalCount })}</p>
                </div>
                {profile.signalCount > 0 ? (
                  <Button
                    className="button-danger"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      if (!window.confirm(t('confirmResetProfile'))) return;
                      void perform('reset', () => runtimeClient.clearPreferenceSignals());
                    }}
                  >
                    {t('resetProfile')}
                  </Button>
                ) : null}
              </div>
              {profile.signalCount === 0 ? (
                <p>{t('emptyProfile')}</p>
              ) : (
                <div className="profile-groups">
                  <div>
                    <strong>{t('positiveTags')}</strong>
                    <div className="tag-cloud">
                      {profile.positiveTags.map((tag) => (
                        <Badge key={tag.key} tone="success">
                          {tag.label} {tag.score.toFixed(1)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div>
                    <strong>{t('negativeTags')}</strong>
                    <div className="tag-cloud">
                      {profile.negativeTags.map((tag) => (
                        <Badge key={tag.key} tone="danger">
                          {tag.label} {tag.score.toFixed(1)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="profile-bars">
                    {[...profile.contentTypes, ...profile.platforms].map((item) => (
                      <div key={`${item.key}:${item.label}`}>
                        <span>{item.label}</span>
                        <strong>{item.score.toFixed(1)}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>

            <Card>
              <h2>{t('teachPreferences')}</h2>
              <label>
                <span>{t('manualTags')}</span>
                <Input
                  value={manualTags}
                  placeholder={t('manualTagsPlaceholder')}
                  onChange={(event) => setManualTags(event.target.value)}
                />
              </label>
              <div className="row-actions preference-form-actions">
                <Button
                  disabled={!manualTags.trim() || Boolean(busy)}
                  onClick={() => void addManual('like')}
                >
                  {t('addPositiveTag')}
                </Button>
                <Button
                  className="button-danger"
                  disabled={!manualTags.trim() || Boolean(busy)}
                  onClick={() => void addManual('dislike')}
                >
                  {t('addNegativeTag')}
                </Button>
              </div>
              <div className="form-divider" />
              <label>
                <span>{t('contentLink')}</span>
                <Input
                  type="url"
                  value={importUrl}
                  placeholder="https://m.qidian.com/book/..."
                  onChange={(event) => setImportUrl(event.target.value)}
                />
              </label>
              <div className="inline-form">
                <select
                  aria-label={t('preferenceAction')}
                  value={importKind}
                  onChange={(event) => setImportKind(event.target.value as PreferenceSignalKind)}
                >
                  <option value="like">{t('like')}</option>
                  <option value="dislike">{t('notInterested')}</option>
                  <option value="completed">{t('completed')}</option>
                </select>
                <Button
                  disabled={!importUrl.trim() || Boolean(busy)}
                  onClick={() => void importContent()}
                >
                  {busy === 'import' ? t('importing') : t('importLink')}
                </Button>
              </div>
              <small className="form-help">{t('supportedLinks')}</small>
            </Card>
          </div>

          {profile.recentSignals.length > 0 ? (
            <Card>
              <h2>{t('recentEvidence')}</h2>
              <div className="evidence-list">
                {profile.recentSignals.map((signal) => (
                  <div key={signal.id} className="evidence-item">
                    <div>
                      <Badge tone={signal.kind === 'dislike' ? 'danger' : 'success'}>
                        {t(`signalKind.${signal.kind}`)}
                      </Badge>
                      <strong>{signal.content.title}</strong>
                      <small>{formatDate(signal.updatedAt)}</small>
                    </div>
                    <Button
                      className="button-danger"
                      disabled={Boolean(busy)}
                      onClick={() => {
                        if (!window.confirm(t('confirmDeleteEvidence'))) return;
                        void perform(`delete:${signal.id}`, () =>
                          runtimeClient.deletePreferenceSignal(signal.id),
                        );
                      }}
                    >
                      {t('delete')}
                    </Button>
                  </div>
                ))}
              </div>
            </Card>
          ) : null}

          <Card>
            <div className="section-heading compact">
              <div>
                <h2>{t('trendingTerms')}</h2>
                <p>{t('trendingTermsHint')}</p>
              </div>
            </div>
            {trends.terms.length > 0 ? (
              <div className="term-grid">
                {trends.terms.map((term, index) => (
                  <div className="term-card" key={term.term}>
                    <span>{index + 1}</span>
                    <strong>{term.term}</strong>
                    <small>{t('termEvidence', { count: term.itemCount })}</small>
                  </div>
                ))}
              </div>
            ) : (
              <p>{running ? t('firstSyncing') : t('emptyTrends')}</p>
            )}
          </Card>

          {trendSections.map((section) => {
            const items = trends.items.filter((item) => item.sourceKey === section.key);
            return (
              <section key={section.key} className="trend-section">
                <div className="section-heading compact">
                  <h2>{section.title}</h2>
                  <small>{t('trendScoreHint')}</small>
                </div>
                {items.length === 0 ? (
                  <Card className="empty compact-empty">
                    {running ? t('firstSyncing') : t('emptySourceData')}
                  </Card>
                ) : (
                  <div className="trend-grid">
                    {items.map((item) => (
                      <article className="trend-card" key={item.id}>
                        {item.coverUrl ? (
                          <img
                            src={item.coverUrl}
                            alt=""
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="cover-placeholder">{item.rank ?? '·'}</div>
                        )}
                        <div className="trend-card-body">
                          <div className="trend-card-rank">
                            {item.rank ? <Badge tone="neutral">#{item.rank}</Badge> : null}
                            <Badge tone="success">{Math.round(item.score)}</Badge>
                          </div>
                          <a href={item.url ?? '#'} target="_blank" rel="noreferrer">
                            <h3>{item.title}</h3>
                          </a>
                          <p>{item.author ?? item.summary ?? t('noSummary')}</p>
                          <div className="tag-cloud">
                            {item.tags.slice(0, 5).map((tag) => (
                              <Badge
                                key={tag}
                                tone={item.matchingTags.includes(tag) ? 'success' : 'neutral'}
                              >
                                {tag}
                              </Badge>
                            ))}
                          </div>
                          <div className="metric-row">
                            {Object.entries(item.metrics)
                              .slice(0, 4)
                              .map(([key, value]) => (
                                <small key={key}>
                                  {metricLabel(key)}{' '}
                                  {Intl.NumberFormat(i18n.language, { notation: 'compact' }).format(
                                    value,
                                  )}
                                </small>
                              ))}
                          </div>
                          <div className="row-actions preference-actions">
                            {renderSignalButtons(item)}
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </>
      )}
    </>
  );
}
