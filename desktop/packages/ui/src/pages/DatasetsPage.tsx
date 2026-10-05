import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Database, ArrowRight } from 'lucide-react';
import { runtimeClient } from '@zhiyun/client';
import { Badge, Button, Card, ErrorNotice, Input } from '../components/ui.js';
import { EmptyState, Select, Skeleton } from '../components/experience.js';
export function DatasetsPage() {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const query = params.get('q') ?? '',
    sort = params.get('sort') === 'currentCount' ? 'currentCount' : 'updatedAt';
  const cursor = params.get('cursor') ?? undefined;
  const data = useQuery({
    queryKey: ['datasets', query, sort, cursor],
    queryFn: () =>
      runtimeClient.listDatasets(25, cursor, undefined, { query, sort, direction: 'desc' }),
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>{t('ux.datasets')}</h1>
          <p>
            {zh
              ? '查看采集结果，确认质量，开始分析或导出。'
              : 'Explore collected data, check quality, analyze and export.'}
          </p>
        </div>
        <Link className="button button-secondary" to="/corpora">
          {zh ? '语料工作台' : 'Corpus workbench'}
          <ArrowRight size={16} />
        </Link>
      </div>
      <form
        className="query-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          setParams({ q: search, sort });
        }}
      >
        <Input
          aria-label={t('ux.search')}
          placeholder={zh ? '搜索来源任务名称或网址' : 'Search source task name or URL'}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          aria-label={t('ux.sort')}
          value={sort}
          onChange={(e) => setParams({ q: query, sort: e.target.value })}
        >
          <option value="updatedAt">{zh ? '最近更新' : 'Recently updated'}</option>
          <option value="currentCount">{zh ? '记录数最多' : 'Most records'}</option>
        </Select>
        <Button type="submit" className="button-secondary">
          {t('ux.search')}
        </Button>
      </form>
      <ErrorNotice message={data.error?.message} onRetry={() => void data.refetch()} />
      {data.isPending ? (
        <Skeleton />
      ) : data.data?.items.length ? (
        <Card>
          <p>
            {data.data.totalCount} {zh ? '个数据集' : 'datasets'}
          </p>
          <div className="data-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('name')}</th>
                  <th>{t('records')}</th>
                  <th>{zh ? '更新时间' : 'Updated'}</th>
                  <th>{zh ? '质量状态' : 'Quality'}</th>
                </tr>
              </thead>
              <tbody>
                {data.data.items.map((d) => (
                  <tr key={d.id}>
                    <td>
                      <Link className="task-name" to={`/datasets/${d.id}`}>
                        <Database size={16} />
                        {d.name ?? (zh ? '来源任务已删除' : 'Source task deleted')}
                      </Link>
                    </td>
                    <td>{d.currentCount.toLocaleString()}</td>
                    <td>{new Date(d.updatedAt).toLocaleString(i18n.language)}</td>
                    <td>
                      <Badge>
                        {t(`ux.state.${d.qualityStatus ?? 'unassessed'}`, {
                          defaultValue: zh ? '未评估' : 'Not assessed',
                        })}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <Button
              className="button-secondary"
              disabled={!cursor}
              onClick={() => setParams({ q: query, sort })}
            >
              {zh ? '返回首页' : 'First page'}
            </Button>
            <Button
              className="button-secondary"
              disabled={!data.data.nextCursor}
              onClick={() => setParams({ q: query, sort, cursor: data.data!.nextCursor! })}
            >
              {zh ? '下一页' : 'Next page'}
            </Button>
          </div>
        </Card>
      ) : (
        !data.isError && (
          <EmptyState
            title={zh ? '暂无匹配的数据集' : 'No matching datasets'}
            description={
              zh
                ? '完成一次采集后，结果会自动出现在这里。'
                : 'After a collection completes, its results appear here.'
            }
            action={
              <Link className="button" to="/tasks/new">
                {t('newTask')}
              </Link>
            }
          />
        )
      )}
    </>
  );
}
