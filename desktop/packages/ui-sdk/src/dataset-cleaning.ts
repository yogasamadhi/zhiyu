import {
  cleaningStepSchema,
  type CleaningParameters,
  type CleaningResult,
  type CleaningStep,
} from '@zhiyun/shared';

export type CleaningOperation =
  'trim' | 'normalize_null' | 'number' | 'date' | 'split' | 'merge' | 'dedupe';
export type CleaningFieldTypes = CleaningParameters['expectedFields'];
export interface CleaningStepDraft {
  operation: CleaningOperation;
  fields: string[];
  tokens: string;
  delimiter: string;
  targets: string[];
  target: string;
  separator: string;
  onError: 'null' | 'fail';
}
export const newCleaningStepDraft = (): CleaningStepDraft => ({
  operation: 'trim',
  fields: [],
  tokens: '\nnull\nNULL\nN/A',
  delimiter: '|',
  targets: ['part_1', 'part_2'],
  target: 'combined',
  separator: ' ',
  onError: 'null',
});

export function buildCleaningStep(draft: CleaningStepDraft): CleaningStep {
  const { fields } = draft;
  const operation = draft.operation;
  if (operation === 'number' || operation === 'date')
    return cleaningStepSchema.parse({
      type: 'convert',
      fields,
      targetType: operation,
      onError: draft.onError,
    });
  if (operation === 'split')
    return cleaningStepSchema.parse({
      type: 'split',
      field: fields[0] ?? '',
      delimiter: draft.delimiter,
      targets: draft.targets,
    });
  if (operation === 'merge')
    return cleaningStepSchema.parse({
      type: 'merge',
      fields,
      target: draft.target,
      separator: draft.separator,
    });
  if (operation === 'normalize_null')
    return cleaningStepSchema.parse({ type: operation, fields, tokens: draft.tokens.split('\n') });
  return cleaningStepSchema.parse({ type: operation, fields });
}

export function cleaningOperationLabel(step: CleaningStep, zh: boolean): string {
  const operation = step.type === 'convert' ? step.targetType : step.type;
  const labels = {
    trim: ['去首尾空白', 'Trim whitespace'],
    normalize_null: ['空值归一', 'Normalize nulls'],
    number: ['转为数字', 'Convert to number'],
    date: ['转为日期', 'Convert to date'],
    split: ['拆分字段', 'Split field'],
    merge: ['合并字段', 'Merge fields'],
    dedupe: ['按字段去重', 'Deduplicate'],
  };
  return labels[operation][zh ? 0 : 1]!;
}

// Only describe the schema. The Worker remains the authority for compatibility and values.
export function projectedCleaningFields(
  initial: CleaningFieldTypes,
  steps: CleaningStep[],
): CleaningFieldTypes {
  const fields = new Map(Object.entries(initial));
  for (const step of steps) {
    if (step.type === 'convert')
      for (const name of step.fields)
        fields.set(name, step.targetType === 'number' ? 'float' : 'datetime');
    if (step.type === 'split') for (const name of step.targets) fields.set(name, 'string');
    if (step.type === 'merge') fields.set(step.target, 'string');
  }
  return Object.fromEntries(fields);
}

export function cleaningExpectedFields(
  initial: CleaningFieldTypes,
  steps: CleaningStep[],
): CleaningFieldTypes {
  const expected = new Map<string, CleaningFieldTypes[string]>();
  for (const step of steps) {
    for (const name of step.type === 'split' ? [step.field] : step.fields)
      if (Object.hasOwn(initial, name)) expected.set(name, initial[name]!);
  }
  return Object.fromEntries(expected);
}

export function cleaningQualityFields(quality: CleaningResult['inputQuality']): CleaningFieldTypes {
  return Object.fromEntries(
    Object.entries(quality.fields).map(([name, info]) => [name, info.type]),
  );
}

export function cleaningTypeLabel(type: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    string: ['文本', 'Text'],
    int: ['整数', 'Integer'],
    float: ['数字', 'Number'],
    bool: ['布尔', 'Boolean'],
    datetime: ['日期时间', 'Date/time'],
  };
  return labels[type]?.[zh ? 0 : 1] ?? type;
}
