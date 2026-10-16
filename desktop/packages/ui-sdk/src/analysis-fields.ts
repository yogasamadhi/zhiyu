import type { DatasetFieldDescription } from '@zhiyun/shared';
export function allowedAnalysisFieldTypes(name: string, methodId?: string, supported?: string[]) {
  if (name === 'timeField') return ['date'];
  if (['valueField', 'valueFields', 'featureFields'].includes(name)) return ['number'];
  if (name === 'textFields' || (name === 'fields' && methodId?.startsWith('text.')))
    return ['text'];
  if (['groupField', 'groupFields', 'categoryField', 'outcomeField', 'keyFields'].includes(name))
    return ['any'];
  return (
    supported?.map(
      (type) => ({ integer: 'number', string: 'text', datetime: 'date' })[type] ?? type,
    ) ?? ['any']
  );
}
export function hasValidAnalysisFields(
  schema: Record<string, unknown>,
  parameters: Record<string, unknown>,
  fields: DatasetFieldDescription[],
  methodId?: string,
  supported?: string[],
) {
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
  return Object.entries(properties ?? {}).every(([name, definition]) => {
    if (!['field-selector', 'field-list'].includes(String(definition.format))) return true;
    const values = Array.isArray(parameters[name])
      ? (parameters[name] as string[])
      : parameters[name]
        ? [String(parameters[name])]
        : [];
    const types = allowedAnalysisFieldTypes(name, methodId, supported);
    const minimum = required.has(name) ? Number(definition.minItems ?? 1) : 0;
    return (
      values.length >= minimum &&
      values.every((value) =>
        fields.some(
          (field) => field.name === value && (types.includes('any') || types.includes(field.type)),
        ),
      )
    );
  });
}
