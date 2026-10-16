import type { AnalysisMethodDescriptor } from '@zhiyun/client';
import type { DatasetFieldDescription } from '@zhiyun/shared';
import { hasValidAnalysisFields } from './analysis-fields.js';

export const analysisQuestions = [
  { id: 'group-comparison', methodId: 'group.aggregate' },
  { id: 'time-trend', methodId: 'time.trend' },
  { id: 'distribution', methodId: 'stats.descriptive' },
  { id: 'outliers', methodId: 'stats.outliers' },
] as const;
export type AnalysisQuestionId = (typeof analysisQuestions)[number]['id'];

export function recommendAnalysisQuestions(
  fields: DatasetFieldDescription[],
  methods: AnalysisMethodDescriptor[],
) {
  const number = fields.find((field) => field.type === 'number');
  const date = fields.find((field) => field.type === 'date');
  const group = fields.find((field) => ['text', 'boolean'].includes(field.type)) ?? fields[0];
  return analysisQuestions.map((question) => {
    const method = methods.find((item) => item.id === question.methodId);
    let reason: 'methodUnavailable' | 'noFields' | 'noDate' | 'noNumber' | null = null;
    if (!method) reason = 'methodUnavailable';
    else if (!fields.length) reason = 'noFields';
    else if (question.id === 'time-trend' && !date) reason = 'noDate';
    else if (question.id !== 'time-trend' && !number) reason = 'noNumber';
    const parameters: Record<string, unknown> = defaultAnalysisParameters(method);
    if (question.id === 'group-comparison' && group && number) {
      parameters.groupFields = [group.name];
      parameters.valueFields = [number.name];
      parameters.aggregations = ['mean'];
    } else if (question.id === 'time-trend' && date) {
      parameters.timeField = date.name;
      parameters.interval = 'day';
      parameters.aggregation = number ? 'mean' : 'count';
      if (number) parameters.valueField = number.name;
    } else if (number) parameters.fields = [number.name];
    return { ...question, method, reason, parameters };
  });
}

export function defaultAnalysisParameters(
  method?: AnalysisMethodDescriptor,
): Record<string, unknown> {
  const properties = objectValue(method?.parameterSchema).properties;
  return Object.fromEntries(
    Object.entries(objectValue(properties)).flatMap(([name, raw]) => {
      const value = objectValue(raw).default;
      return value === undefined ? [] : [[name, structuredClone(value)]];
    }),
  );
}

// The launcher handles the catalog's scalar/array constraints; the Runtime remains authoritative.
export function hasValidAnalysisParameters(
  method: AnalysisMethodDescriptor | undefined,
  parameters: Record<string, unknown>,
  fields: DatasetFieldDescription[],
): boolean {
  if (!method) return false;
  const schema = objectValue(method.parameterSchema);
  const properties = objectValue(schema.properties);
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  if (required.some((name) => !Object.hasOwn(parameters, name) || parameters[name] === undefined))
    return false;
  if (
    schema.additionalProperties === false &&
    Object.keys(parameters).some((name) => !Object.hasOwn(properties, name))
  )
    return false;
  if (
    !Object.entries(properties).every(([name, raw]) => {
      const value = parameters[name];
      return value === undefined ? !required.includes(name) : validValue(value, objectValue(raw));
    })
  )
    return false;
  if (method.id === 'time.trend' && parameters.aggregation !== 'count' && !parameters.valueField)
    return false;
  return hasValidAnalysisFields(schema, parameters, fields, method.id, method.supportedFieldTypes);
}

function validValue(value: unknown, definition: Record<string, unknown>): boolean {
  if (Array.isArray(definition.enum) && !definition.enum.includes(value)) return false;
  if (value === null) return Array.isArray(definition.type) && definition.type.includes('null');
  const type = Array.isArray(definition.type)
    ? definition.type.find((item) => item !== 'null')
    : definition.type;
  if (type === 'number' || type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      (type === 'integer' && !Number.isInteger(value))
    )
      return false;
    if (typeof definition.minimum === 'number' && value < definition.minimum) return false;
    if (typeof definition.maximum === 'number' && value > definition.maximum) return false;
  } else if (type === 'string') {
    if (typeof value !== 'string') return false;
    if (typeof definition.minLength === 'number' && value.length < definition.minLength)
      return false;
    if (typeof definition.maxLength === 'number' && value.length > definition.maxLength)
      return false;
  } else if (type === 'boolean' && typeof value !== 'boolean') return false;
  else if (type === 'array') {
    if (!Array.isArray(value)) return false;
    if (typeof definition.minItems === 'number' && value.length < definition.minItems) return false;
    if (typeof definition.maxItems === 'number' && value.length > definition.maxItems) return false;
    if (definition.uniqueItems && new Set(value).size !== value.length) return false;
    if (!value.every((item) => validValue(item, objectValue(definition.items)))) return false;
  }
  return true;
}
function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
