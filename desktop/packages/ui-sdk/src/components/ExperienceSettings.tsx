import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { runtimeClient } from '@zhiyun/client';
import { useWorkspaceAuth } from '../auth.js';
import { Button, Card, ErrorNotice } from './ui.js';
import { Dialog, Skeleton } from './experience.js';
type Summary = {
  started: number;
  completed: number;
  eventCount: number;
  lessonsStarted: number;
  lessonsCompleted: number;
  examplesStarted: number;
  examplesCompleted: number;
  firstCompletionRate: number | null;
  medianTimeToResultMs: number | null;
  resultUsageRate: number | null;
  reuseWithin7DaysRate: number | null;
};
export function ExperienceSettings() {
  const auth = useWorkspaceAuth(),
    { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const allowed = !auth.identityEnabled || auth.permissions.includes('workspace.manage');
  const cache = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const config = useQuery({
    queryKey: ['experience', 'settings'],
    queryFn: () =>
      runtimeClient.request<{ enabled: boolean; retentionDays: number; revision: number }>(
        '/api/v2/experience/settings',
      ),
    enabled: allowed,
  });
  const summary = useQuery({
    queryKey: ['experience', 'summary'],
    queryFn: () => runtimeClient.request<Summary>('/api/v2/experience/summary'),
    enabled: allowed,
  });
  const update = useMutation({
    mutationFn: (enabled: boolean) =>
      runtimeClient.request('/api/v2/experience/settings', {
        method: 'PUT',
        headers: { 'If-Match': `"${config.data!.revision}"` },
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => cache.invalidateQueries({ queryKey: ['experience'] }),
  });
  const clear = useMutation({
    mutationFn: () => runtimeClient.request('/api/v2/experience/events', { method: 'DELETE' }),
    onSuccess: async () => {
      setConfirm(false);
      await cache.invalidateQueries({ queryKey: ['experience'] });
    },
  });
  if (!allowed) return null;
  const metric = (value: number | null | undefined, ms = false) =>
    value === null || value === undefined
      ? '—'
      : ms
        ? `${Math.round(value / 1000)} ${zh ? '秒' : 'sec'}`
        : `${Math.round(value * 100)}%`;
  return (
    <Card>
      <h2>{zh ? '本地体验指标' : 'Local experience metrics'}</h2>
      <p>
        {zh
          ? '仅保存在当前实例数据库，保留 90 天。记录操作类型、时间、匿名关联、耗时和结果，不记录网址、提示词、字段值或凭据。纯问答不计入采集漏斗，样例与教学单独统计。'
          : 'Stored only in this instance for 90 days: action types, times, anonymous correlations, durations and outcomes. URLs, prompts, field values and credentials are excluded. Questions do not enter the collection funnel; examples and lessons are counted separately.'}
      </p>
      <ErrorNotice
        message={(config.error ?? summary.error ?? update.error ?? clear.error)?.message}
      />
      {config.isPending ? (
        <Skeleton />
      ) : (
        <label className="check">
          <input
            type="checkbox"
            checked={config.data?.enabled ?? false}
            disabled={update.isPending || !config.data}
            onChange={(e) => update.mutate(e.target.checked)}
          />
          {zh ? '记录本地体验指标' : 'Record local experience metrics'}
        </label>
      )}
      <div className="stats">
        {[
          [zh ? '首次完成率' : 'First completion rate', metric(summary.data?.firstCompletionRate)],
          [
            zh ? '首次可用结果耗时（中位数）' : 'Median time to first result',
            metric(summary.data?.medianTimeToResultMs, true),
          ],
          [zh ? '结果使用率' : 'Result usage rate', metric(summary.data?.resultUsageRate)],
          [zh ? '7 天复用率' : '7-day reuse rate', metric(summary.data?.reuseWithin7DaysRate)],
          [
            zh ? '样例完成 / 开始' : 'Examples completed / started',
            `${summary.data?.examplesCompleted ?? '—'} / ${summary.data?.examplesStarted ?? '—'}`,
          ],
          [
            zh ? '教程完成 / 开始' : 'Lessons completed / started',
            `${summary.data?.lessonsCompleted ?? '—'} / ${summary.data?.lessonsStarted ?? '—'}`,
          ],
        ].map(([label, value]) => (
          <div key={label}>
            <small>{label}</small>
            <strong>{summary.isPending ? '…' : value}</strong>
          </div>
        ))}
      </div>
      <p>
        {zh
          ? '暂无数据的指标显示为“—”；这些是内部使用基线，并非真实用户研究结论。'
          : 'Metrics without data show “—”. These internal baselines are not user research findings.'}
      </p>
      <Button
        className="button-secondary"
        disabled={clear.isPending}
        onClick={() => setConfirm(true)}
      >
        {zh ? '清除本地指标' : 'Clear local metrics'}
      </Button>
      <Dialog
        open={confirm}
        title={zh ? '清除体验指标？' : 'Clear experience metrics?'}
        onClose={() => setConfirm(false)}
      >
        <p>
          {zh
            ? '将删除当前实例保存的所有体验事件。任务、采集数据和规则历史不受影响。此操作无法撤销。'
            : 'Deletes all experience events in this instance. Tasks, collected data and rule history are unaffected. This cannot be undone.'}
        </p>
        <div className="heading-actions">
          <Button className="button-secondary" onClick={() => setConfirm(false)}>
            {zh ? '取消' : 'Cancel'}
          </Button>
          <Button
            className="button-danger"
            disabled={clear.isPending}
            onClick={() => clear.mutate()}
          >
            {zh ? '确认清除' : 'Clear events'}
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}
