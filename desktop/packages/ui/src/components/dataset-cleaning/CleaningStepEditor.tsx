import { useState } from 'react';
import type { CleaningStep } from '@zhiyun/shared';
import {
  buildCleaningStep,
  cleaningTypeLabel,
  newCleaningStepDraft,
  type CleaningFieldTypes,
  type CleaningOperation,
} from '../../dataset-cleaning.js';
import { Button, ErrorNotice, Input } from '../ui.js';
import { Field, Select } from '../experience.js';

export function CleaningStepEditor({
  fields,
  disabled,
  zh,
  onAdd,
}: {
  fields: CleaningFieldTypes;
  disabled: boolean;
  zh: boolean;
  onAdd: (step: CleaningStep) => void;
}) {
  const [draft, setDraft] = useState(newCleaningStepDraft);
  const [error, setError] = useState('');
  const single = draft.operation === 'split';
  const operations: Array<[CleaningOperation, string, string]> = [
    ['trim', '去首尾空白', 'Trim whitespace'],
    ['normalize_null', '空值归一', 'Normalize nulls'],
    ['number', '转为数字', 'Convert to number'],
    ['date', '转为日期', 'Convert to date'],
    ['split', '拆分字段', 'Split field'],
    ['merge', '合并字段', 'Merge fields'],
    ['dedupe', '按字段去重', 'Deduplicate'],
  ];
  return (
    <form
      className="cleaning-editor"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const step = buildCleaningStep(draft);
          const sources = step.type === 'split' ? [step.field] : step.fields;
          if (sources.some((name) => !Object.hasOwn(fields, name)))
            throw new Error(
              zh ? '请选择当前步骤可用的字段。' : 'Choose fields available at this step.',
            );
          const targets =
            step.type === 'split' ? step.targets : step.type === 'merge' ? [step.target] : [];
          if (targets.some((name) => Object.hasOwn(fields, name)))
            throw new Error(
              zh ? '目标字段必须使用尚不存在的名称。' : 'Target fields must have new names.',
            );
          onAdd(step);
          setError('');
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }}
    >
      <fieldset disabled={disabled}>
        <legend>{zh ? '添加受限清洗步骤' : 'Add a cleaning step'}</legend>
        <div className="cleaning-form-grid">
          <Field label={zh ? '清洗操作' : 'Operation'}>
            <Select
              value={draft.operation}
              onChange={(e) => {
                setDraft({ ...draft, operation: e.target.value as CleaningOperation, fields: [] });
                setError('');
              }}
            >
              {operations.map(([value, cn, en]) => (
                <option value={value} key={value}>
                  {zh ? cn : en}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label={zh ? '清洗字段' : 'Fields to clean'}
            hint={
              single
                ? undefined
                : zh
                  ? '可选择多个字段。合并至少选择两个字段。'
                  : 'Choose one or more fields; merging needs at least two.'
            }
          >
            <Select
              multiple={!single}
              size={single ? 1 : 4}
              value={single ? (draft.fields[0] ?? '') : draft.fields}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  fields: Array.from(e.target.selectedOptions, (option) => option.value).filter(
                    Boolean,
                  ),
                })
              }
            >
              {single && <option value="">{zh ? '选择字段' : 'Choose a field'}</option>}
              {Object.entries(fields).map(([name, type]) => (
                <option key={name} value={name}>
                  {name} · {cleaningTypeLabel(type, zh)}
                </option>
              ))}
            </Select>
          </Field>
          {draft.operation === 'normalize_null' && (
            <Field
              label={zh ? '空值标记' : 'Null tokens'}
              hint={
                zh
                  ? '每行一个；空行表示空字符串。按完整值精确匹配。'
                  : 'One per line; an empty line represents an empty string. Match the complete value.'
              }
            >
              <textarea
                className="input"
                rows={4}
                aria-label={zh ? '空值标记' : 'Null tokens'}
                value={draft.tokens}
                onChange={(e) => setDraft({ ...draft, tokens: e.target.value })}
              />
            </Field>
          )}
          {(draft.operation === 'number' || draft.operation === 'date') && (
            <Field
              label={zh ? '转换失败时' : 'On conversion error'}
              hint={
                zh
                  ? '数字采用十进制；日期接受 ISO 日期或时间。'
                  : 'Numbers use decimal notation; dates accept ISO dates or timestamps.'
              }
            >
              <Select
                value={draft.onError}
                onChange={(e) => setDraft({ ...draft, onError: e.target.value as 'null' | 'fail' })}
              >
                <option value="null">
                  {zh ? '置空并报告错误行' : 'Set null and report errors'}
                </option>
                <option value="fail">
                  {zh ? '停止并保留原数据' : 'Stop and preserve the input'}
                </option>
              </Select>
            </Field>
          )}
          {draft.operation === 'split' && (
            <>
              <Field label={zh ? '分隔符' : 'Delimiter'}>
                <Input
                  value={draft.delimiter}
                  onChange={(e) => setDraft({ ...draft, delimiter: e.target.value })}
                />
              </Field>
              {draft.targets.map((name, index) => (
                <Field key={index} label={`${zh ? '拆分目标字段' : 'Split target'} ${index + 1}`}>
                  <Input
                    value={name}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        targets: draft.targets.map((value, i) =>
                          i === index ? e.target.value : value,
                        ),
                      })
                    }
                  />
                </Field>
              ))}
              <Button
                className="button-ghost"
                disabled={draft.targets.length >= 10}
                onClick={() =>
                  setDraft({
                    ...draft,
                    targets: [...draft.targets, `part_${draft.targets.length + 1}`],
                  })
                }
              >
                {zh ? '增加拆分目标' : 'Add split target'}
              </Button>
              <Button
                className="button-ghost"
                disabled={draft.targets.length <= 2}
                onClick={() => setDraft({ ...draft, targets: draft.targets.slice(0, -1) })}
              >
                {zh ? '减少拆分目标' : 'Remove last target'}
              </Button>
            </>
          )}
          {draft.operation === 'merge' && (
            <>
              <Field label={zh ? '合并目标字段' : 'Merged field'}>
                <Input
                  value={draft.target}
                  onChange={(e) => setDraft({ ...draft, target: e.target.value })}
                />
              </Field>
              <Field label={zh ? '连接符' : 'Separator'}>
                <Input
                  value={draft.separator}
                  onChange={(e) => setDraft({ ...draft, separator: e.target.value })}
                />
              </Field>
            </>
          )}
        </div>
        <ErrorNotice message={error} />
        <Button
          type="submit"
          className="button-secondary"
          disabled={disabled || !draft.fields.length}
        >
          {zh ? '添加步骤' : 'Add step'}
        </Button>
      </fieldset>
    </form>
  );
}
