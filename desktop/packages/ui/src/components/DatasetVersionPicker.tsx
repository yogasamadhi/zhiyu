import { useEffect, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { runtimeClient } from '@zhiyun/client';
import { Button, ErrorNotice, Input } from './ui.js';
import { Field, Select, StatusNotice } from './experience.js';
export function DatasetVersionPicker({
  datasetId,
  snapshotId,
  onDatasetChange,
  onSnapshotChange,
  showVersion = true,
  locked = false,
  disabled = false,
}: {
  datasetId: string;
  snapshotId: string;
  onDatasetChange: (id: string) => void;
  onSnapshotChange: (id: string) => void;
  showVersion?: boolean;
  locked?: boolean;
  disabled?: boolean;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const cache = useQueryClient();
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const datasets = useInfiniteQuery({
    queryKey: ['dataset-picker', search],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      runtimeClient.listDatasets(100, pageParam, undefined, { query: search }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = datasets.data?.pages.flatMap((page) => page.items) ?? [];
  const versions = useQuery({
    queryKey: ['dataset-versions', datasetId],
    queryFn: () => runtimeClient.listDatasetSnapshots(datasetId),
    enabled: Boolean(datasetId) && showVersion,
    refetchInterval: (query) =>
      query.state.data?.some((s) => s.status === 'preparing') ? 1000 : false,
  });
  const create = useMutation({
    mutationFn: () => runtimeClient.createDatasetSnapshot(datasetId),
    onSuccess: async (value) => {
      setFailed(value.status === 'failed');
      if (value.status === 'ready') onSnapshotChange(value.id);
      else if (value.status === 'preparing') setPending(value.id);
      await cache.invalidateQueries({ queryKey: ['dataset-versions', datasetId] });
    },
  });
  useEffect(() => {
    if (!datasetId && items[0]) onDatasetChange(items[0].id);
  }, [datasets.data, datasetId]);
  useEffect(() => {
    if (pending) {
      const version = versions.data?.find((v) => v.id === pending);
      if (version?.status === 'ready') {
        onSnapshotChange(version.id);
        setPending(null);
      } else if (version?.status === 'failed') {
        setPending(null);
        setFailed(true);
      }
    } else if (!snapshotId) {
      const latest = versions.data?.find((s) => s.status === 'ready');
      if (latest) onSnapshotChange(latest.id);
    }
  }, [versions.data, pending, snapshotId]);
  return (
    <div className="dataset-picker">
      <Field label={zh ? '选择数据集' : 'Choose dataset'}>
        <Input
          disabled={locked || disabled}
          type="search"
          aria-label={zh ? '搜索数据集' : 'Search datasets'}
          placeholder={zh ? '搜索来源任务' : 'Search source task'}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          disabled={locked || disabled}
          value={datasetId}
          onChange={(e) => {
            onDatasetChange(e.target.value);
            onSnapshotChange('');
            setPending(null);
            setFailed(false);
          }}
        >
          <option value="">
            {datasets.isPending
              ? zh
                ? '加载中…'
                : 'Loading…'
              : zh
                ? '选择数据集'
                : 'Choose dataset'}
          </option>
          {datasetId && !items.some((d) => d.id === datasetId) && (
            <option value={datasetId}>{zh ? '当前数据集' : 'Current dataset'}</option>
          )}
          {items.map((d) => (
            <option value={d.id} key={d.id}>
              {d.name ?? (zh ? '来源任务已删除' : 'Deleted source task')} · {d.currentCount}{' '}
              {zh ? '条记录' : 'records'}
            </option>
          ))}
        </Select>
      </Field>
      {datasets.hasNextPage && !locked && (
        <Button
          className="button-ghost"
          disabled={disabled || datasets.isFetchingNextPage}
          onClick={() => void datasets.fetchNextPage()}
        >
          {zh ? '加载更多' : 'Load more'}
        </Button>
      )}
      {showVersion && datasetId && (
        <Field label={zh ? '数据版本' : 'Data version'}>
          <Select
            disabled={disabled}
            value={snapshotId}
            onChange={(e) => onSnapshotChange(e.target.value)}
          >
            <option value="">{zh ? '选择已准备好的版本' : 'Choose a ready version'}</option>
            {(versions.data ?? [])
              .filter((s) => s.status === 'ready')
              .map((s, index) => (
                <option key={s.id} value={s.id}>
                  {index === 0 ? (zh ? '最新可用 · ' : 'Latest ready · ') : ''}
                  {new Date(s.createdAt).toLocaleString(i18n.language)} · {s.rowCount}{' '}
                  {zh ? '条' : 'rows'}
                </option>
              ))}
          </Select>
          <Button
            className="button-secondary"
            disabled={disabled || create.isPending || Boolean(pending)}
            onClick={() => create.mutate()}
          >
            {create.isPending || pending
              ? zh
                ? '正在准备数据版本…'
                : 'Preparing data version…'
              : zh
                ? '从当前数据创建版本'
                : 'Create version from current data'}
          </Button>
        </Field>
      )}
      {pending && (
        <StatusNotice>
          {zh
            ? '数据正在准备，完成后将自动选中。你可以留在此页。'
            : 'Preparing data. The version will be selected automatically when ready.'}
        </StatusNotice>
      )}
      <ErrorNotice
        message={
          failed
            ? zh
              ? '数据版本准备失败。请检查诊断信息后重新创建版本。'
              : 'Data version preparation failed. Check diagnostics and create a new version.'
            : (datasets.error ?? versions.error ?? create.error)?.message
        }
        onRetry={() => {
          void datasets.refetch();
          if (datasetId) void versions.refetch();
        }}
      />
      {!datasets.isPending && items.length === 0 && !search && (
        <p>
          {zh ? '尚无数据集，请先完成采集。' : 'No datasets yet. Complete a collection first.'}{' '}
          <Link to="/tasks/new">{zh ? '创建采集任务' : 'Create a collection'}</Link>
        </p>
      )}
    </div>
  );
}
