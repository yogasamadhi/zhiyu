import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  summarizeCollectionPreview,
  type CollectionPreviewRecord,
  type CrawlPlanDefinition,
} from '@zhiyun/shared';
import { Button } from './ui.js';
import { StatusNotice } from './experience.js';

const valueText = (value: unknown) =>
  (value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)).slice(
    0,
    160,
  );

export function CollectionPreview({
  plan,
  records,
}: {
  plan: CrawlPlanDefinition;
  records: CollectionPreviewRecord[];
}) {
  const { i18n } = useTranslation();
  const text = (cn: string, en: string) => (i18n.language.startsWith('zh') ? cn : en);
  const [selected, setSelected] = useState(0);
  const [reviewed, setReviewed] = useState<Set<number>>(new Set());
  const fields = summarizeCollectionPreview(plan, records);
  const sample = records[selected];
  const stateText = (status?: string) =>
    ({
      valid: text('匹配正常', 'Valid match'),
      missing: text('未匹配：检查选择器或属性', 'No match: check selector or attribute'),
      empty: text('已匹配但值为空', 'Matched with an empty value'),
      invalid_type: text('类型转换失败：检查字段类型', 'Conversion failed: check field type'),
    })[status ?? ''] ??
    text('旧预览未测量，请重新预览', 'Not measured in this preview; preview again');
  const relationText = (status?: string) =>
    ({
      resolved: text('每条列表记录对应一个详情记录', 'One detail record per list item'),
      missing_link: text(
        '详情链接缺失，请检查 URL 字段',
        'Detail link missing; check the URL field',
      ),
      ambiguous_link: text(
        '详情链接匹配多个元素，请缩小 URL 字段选择器',
        'Multiple detail links; narrow the URL field selector',
      ),
      ambiguous_record: text(
        '详情页匹配多个记录容器，请选择唯一详情容器',
        'Multiple detail containers; choose a unique detail container',
      ),
      empty_detail: text(
        '详情页没有匹配记录，请检查详情容器',
        'No detail record; check the detail container',
      ),
      failed: text(
        '详情访问失败，请检查地址和访问配置',
        'Detail request failed; check URL and access settings',
      ),
      budget: text(
        '详情预览达到请求上限，请调整上限后重试',
        'Detail preview reached the request limit; adjust it and retry',
      ),
    })[status ?? ''] ??
    text('详情关系尚未测量，请重新预览', 'Detail relationship not measured; preview again');
  const noise = records.filter(
    (row) => row.inspection?.containerHint !== 'content' && row.inspection?.containerHint,
  );
  return (
    <div className="collection-preview">
      <p>
        {text('样本', 'Samples')}: {records.length}
      </p>
      {records.length === 0 && (
        <StatusNotice>
          {text(
            '没有匹配记录。检查页面、记录容器或等待条件后重新预览。',
            'No records matched. Check the page, record container or wait condition, then preview again.',
          )}
        </StatusNotice>
      )}
      {records.length === 1 && (
        <StatusNotice>
          {text(
            '仅匹配一条记录。确认是否误选整个页面或详情容器；列表规则建议检查至少三个样本。',
            'Only one record matched. Check for a whole-page or detail container; review at least three samples for list rules.',
          )}
        </StatusNotice>
      )}
      {noise.length > 0 && (
        <StatusNotice>
          {text(
            `有 ${noise.length} 条记录疑似来自导航或广告容器。缩小列表项选择器，排除导航和广告后重新预览。`,
            `${noise.length} records may come from navigation or advertisements. Narrow the list selector and exclude those containers before previewing again.`,
          )}
        </StatusNotice>
      )}
      <div className="data-table-scroll">
        <table aria-label={text('预览记录', 'Preview records')}>
          <thead>
            <tr>
              {fields.map((field) => (
                <th key={field.name}>{field.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {records.map((record, index) => (
              <tr key={index}>
                {fields.map((field) => (
                  <td key={field.name}>{valueText(record.data[field.name])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>{text('字段质量', 'Field quality')}</h3>
      <p className="muted">
        {text(
          '缺失表示规则没有匹配字段；空值比例包含缺失、空白和转换失败后的空值。以下统计仅覆盖本次预览样本。',
          'Missing means the rule did not match the field. Empty ratio includes missing, blank and failed conversions. These statistics cover only this preview.',
        )}
      </p>
      <div className="data-table-scroll">
        <table aria-label={text('字段质量', 'Field quality')}>
          <thead>
            <tr>
              {[
                text('字段与来源', 'Field and source'),
                text('类型与规则', 'Type and rule'),
                text('缺失', 'Missing'),
                text('空值比例', 'Empty ratio'),
                text('类型异常', 'Type errors'),
                text('前三条样本值', 'First three samples'),
              ].map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => (
              <tr key={field.name}>
                <td>
                  {field.name}
                  <small>
                    {field.stage === 'detail'
                      ? text('详情页', 'Detail page')
                      : text('列表页', 'List page')}
                  </small>
                </td>
                <td>
                  {field.dataType}
                  <code>{field.selector}</code>
                </td>
                <td>
                  {field.missingCount ?? '—'}/{records.length}
                </td>
                <td>
                  {Math.round(field.emptyRatio * 100)}% ({field.emptyCount}/{records.length})
                </td>
                <td>{field.invalidTypeCount ?? '—'}</td>
                <td>
                  {field.samples.map((value, index) => (
                    <code key={index}>
                      {index + 1}: {valueText(value)}
                      {index < field.samples.length - 1 ? ' · ' : ''}
                    </code>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {records.length > 0 && (
        <>
          <h3>{text('逐条确认样本', 'Review individual samples')}</h3>
          <p>
            {text(
              `已检查 ${reviewed.size}/${records.length} 条；列表规则建议至少检查三个不同样本。`,
              `Reviewed ${reviewed.size}/${records.length}; review at least three different samples for list rules.`,
            )}
          </p>
          <div
            className="preview-sample-buttons"
            role="group"
            aria-label={text('选择预览样本', 'Choose preview sample')}
          >
            {records.map((_, index) => (
              <Button
                className="button-secondary"
                key={index}
                aria-pressed={selected === index}
                onClick={() => setSelected(index)}
              >
                {text('样本', 'Sample')} {index + 1}
                {reviewed.has(index) ? ' ✓' : ''}
              </Button>
            ))}
          </div>
          {sample && (
            <div className="preview-sample-detail">
              <p>
                {text('记录容器', 'Record container')}: <code>{plan.list.rule.container}</code>
              </p>
              <p>
                {text('来源页面', 'Source page')}: <code>{sample.sourceUrl}</code>
              </p>
              <dl>
                {fields.map((field) => (
                  <div key={field.name}>
                    <dt>
                      {field.name} · {stateText(sample.inspection?.fields[field.name]?.status)}
                    </dt>
                    <dd>
                      <code>{valueText(sample.data[field.name])}</code>
                    </dd>
                  </div>
                ))}
              </dl>
              {plan.detail && (
                <StatusNotice>
                  {text('列表 → 详情', 'List → detail')}: {plan.detail.urlField} →{' '}
                  <code>{plan.detail.rule.container}</code>
                  <br />
                  {relationText(sample.inspection?.detail?.status)}
                  {sample.inspection?.detail && (
                    <span>
                      {' '}
                      ({text('链接匹配', 'Link matches')}: {sample.inspection.detail.linkMatches};{' '}
                      {text('详情记录匹配', 'Detail record matches')}:{' '}
                      {sample.inspection.detail.recordMatches ?? '—'})
                    </span>
                  )}
                </StatusNotice>
              )}
              <Button
                className="button-secondary"
                disabled={reviewed.has(selected)}
                onClick={() => setReviewed((previous) => new Set([...previous, selected]))}
              >
                {reviewed.has(selected)
                  ? text('此样本已检查', 'Sample reviewed')
                  : text('确认此样本', 'Confirm this sample')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
