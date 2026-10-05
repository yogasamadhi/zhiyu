import type { CleaningResult } from '@zhiyun/shared';
import { cleaningTypeLabel } from '../../dataset-cleaning.js';
import { Select } from '../experience.js';

export function CleaningReport({
  report,
  selectedStep,
  onStepChange,
  zh,
}: {
  report: CleaningResult;
  selectedStep: number;
  onStepChange: (step: number) => void;
  zh: boolean;
}) {
  const step = report.steps[selectedStep - 1];
  const quality = step?.outputQuality ?? report.inputQuality;
  const errorRows = step?.errorRowCount ?? 0;
  return (
    <div className="cleaning-report" data-testid="cleaning-report">
      <label className="form-field">
        <span>{zh ? '查看步骤结果' : 'Inspect a step'}</span>
        <Select value={selectedStep} onChange={(e) => onStepChange(Number(e.target.value))}>
          <option value={0}>{zh ? '原始输入' : 'Original input'}</option>
          {report.steps.map((item) => (
            <option key={item.index} value={item.index + 1}>
              {zh ? '步骤' : 'Step'} {item.index + 1}
            </option>
          ))}
        </Select>
      </label>
      <p className="cleaning-summary" data-testid="cleaning-summary">
        {zh ? '行数' : 'Rows'}：{quality.rowCount} · {zh ? '转换错误行' : 'Conversion error rows'}：
        {errorRows}
        {step && (
          <>
            {' '}
            · {zh ? '更改行' : 'Changed rows'}：{step.changedRowCount} ·{' '}
            {zh ? '删除行' : 'Removed rows'}：{step.removedRowCount}
          </>
        )}
      </p>
      <h3>{zh ? '字段质量与 Facet' : 'Field quality and facets'}</h3>
      <p>
        {zh
          ? 'Facet 跟踪前 50 种不同值；计数和省略范围如下，不能作为完整值分布。'
          : 'Facets track the first 50 distinct values. Counts and omissions are shown below; this is a bounded view.'}
      </p>
      <div className="data-table-scroll">
        <table aria-label={zh ? '清洗字段质量' : 'Cleaning field quality'}>
          <thead>
            <tr>
              {(zh
                ? ['字段', '类型', '空值 / 比例', '空白文本', 'Facet']
                : ['Field', 'Type', 'Nulls / ratio', 'Blank text', 'Facets']
              ).map((label) => (
                <th key={label}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.entries(quality.fields).map(([name, info]) => (
              <tr key={name}>
                <td>{name}</td>
                <td>{cleaningTypeLabel(info.type, zh)}</td>
                <td>
                  {info.nullCount} /{' '}
                  {quality.rowCount
                    ? `${((info.nullCount / quality.rowCount) * 100).toFixed(1)}%`
                    : '—'}
                </td>
                <td>{info.blankCount}</td>
                <td>
                  <details>
                    <summary>
                      {zh ? '查看值与次数' : 'Values and counts'} ({info.facets.length})
                    </summary>
                    <ul>
                      {info.facets.map((facet, index) => (
                        <li key={index}>
                          {JSON.stringify(facet.value)}
                          {facet.valueTruncated ? (zh ? '（已截断）' : ' (truncated)') : ''} ·{' '}
                          {facet.count}
                        </li>
                      ))}
                    </ul>
                    <small>
                      {zh ? '未跟踪值次数' : 'Untracked occurrences'}：{info.otherCount} ·{' '}
                      {zh ? '已跟踪但未展示次数' : 'Tracked occurrences omitted'}：
                      {info.omittedTrackedCount}
                    </small>
                  </details>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {step && (
        <>
          <h3>{zh ? '转换前后预览' : 'Before and after preview'}</h3>
          <p>
            {zh
              ? '展示该步骤输入的前 10 行，每行最多 25 个字段，文本最多 500 字符；删除行仍显示在预览中。完整输出保存在所选数据版本中。'
              : 'The first 10 input rows of this step, up to 25 fields per row and 500 characters per text value. Removed rows remain visible here. The full output is stored in its data version.'}
          </p>
          <div className="data-table-scroll">
            <table aria-label={zh ? '清洗转换预览' : 'Cleaning transformation preview'}>
              <thead>
                <tr>
                  {(zh
                    ? ['输入行', '转换前', '转换后', '错误']
                    : ['Input row', 'Before', 'After', 'Errors']
                  ).map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {step.preview.map((row) => (
                  <tr key={row.rowIndex}>
                    <td>{row.rowIndex + 1}</td>
                    <td>
                      <code>{JSON.stringify(row.before)}</code>
                      {(row.beforeOmittedFieldCount > 0 ||
                        row.beforeTruncatedFields.length > 0) && (
                        <small>
                          {zh ? '部分字段省略或截断' : 'Some fields omitted or truncated'}
                        </small>
                      )}
                    </td>
                    <td>
                      {row.after === null ? (
                        zh ? (
                          '已删除（重复）'
                        ) : (
                          'Removed (duplicate)'
                        )
                      ) : (
                        <code>{JSON.stringify(row.after)}</code>
                      )}
                      {(row.afterOmittedFieldCount > 0 || row.afterTruncatedFields.length > 0) && (
                        <small>
                          {zh ? '部分字段省略或截断' : 'Some fields omitted or truncated'}
                        </small>
                      )}
                    </td>
                    <td>
                      {row.errors
                        .map(
                          (error) =>
                            `${error.field}: ${error.reason === 'invalid_number' ? (zh ? '无法转为数字' : 'Invalid number') : zh ? '无法转为日期' : 'Invalid date'}`,
                        )
                        .join('; ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {step.errorSamples.length > 0 && (
            <details>
              <summary>{zh ? '错误样本（最多 20 行）' : 'Error samples (up to 20 rows)'}</summary>
              <ul>
                {step.errorSamples.map((row) => (
                  <li key={row.rowIndex}>
                    {zh ? '输入行' : 'Input row'} {row.rowIndex + 1} ·{' '}
                    {row.errors.map((error) => `${error.field}: ${error.reason}`).join('; ')}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
