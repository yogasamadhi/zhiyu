import { allowedAnalysisFieldTypes } from '../analysis-fields.js';
import { useTranslation } from 'react-i18next';
import type { DatasetFieldDescription } from '@zhiyun/shared';
import { Input } from './ui.js';

export interface SchemaFormProps {
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  onChange(value: Record<string, unknown>): void;
  disabled?: boolean;
  fields?: DatasetFieldDescription[] | undefined;
  methodId?: string | undefined;
  supportedFieldTypes?: string[] | undefined;
}

export function SchemaForm({
  schema,
  value,
  onChange,
  disabled,
  fields,
  methodId,
  supportedFieldTypes,
}: SchemaFormProps) {
  const { t } = useTranslation();
  const properties = objectValue(schema.properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return (
    <div className="schema-form">
      {Object.entries(properties).map(([name, raw]) => {
        const definition = objectValue(raw);
        const type = Array.isArray(definition.type) ? definition.type[0] : definition.type;
        const label = t(`analytics.parameters.${name}`, {
          defaultValue: String(definition.title ?? name),
        });
        const update = (next: unknown) => {
          const updated = { ...value, [name]: next };
          if (next === undefined || (!required.has(name) && next === '')) delete updated[name];
          onChange(updated);
        };
        if (definition.format === 'field-selector' || definition.format === 'field-list') {
          const expected = allowedAnalysisFieldTypes(name, methodId, supportedFieldTypes);
          const candidates = (fields ?? []).filter(
            (field) => expected.includes('any') || expected.includes(field.type),
          );
          const multiple = definition.format === 'field-list';
          return (
            <label key={name}>
              <span>
                {label}
                {required.has(name) ? ' *' : ''}
              </span>
              <select
                multiple={multiple}
                aria-label={label}
                size={multiple ? Math.min(Math.max(candidates.length, 2), 6) : undefined}
                disabled={disabled || !candidates.length}
                value={
                  multiple
                    ? Array.isArray(value[name])
                      ? (value[name] as string[])
                      : []
                    : String(value[name] ?? '')
                }
                onChange={(event) =>
                  update(
                    multiple
                      ? Array.from(event.target.selectedOptions, (option) => option.value)
                      : event.target.value,
                  )
                }
              >
                {!multiple && <option value="">—</option>}
                {candidates.map((field) => (
                  <option value={field.name} key={field.name}>
                    {field.label ?? field.name} ·{' '}
                    {t(`ux.fieldType.${field.type === 'text' ? 'string' : field.type}`)}
                  </option>
                ))}
              </select>
              {!candidates.length && <small>{t('analytics.noCompatibleFields')}</small>}
            </label>
          );
        }
        const arrayEnum = type === 'array' ? objectValue(definition.items).enum : undefined;
        if (Array.isArray(arrayEnum))
          return (
            <label key={name}>
              <span>{label}</span>
              <select
                multiple
                disabled={disabled}
                aria-label={label}
                value={Array.isArray(value[name]) ? (value[name] as string[]) : []}
                onChange={(event) =>
                  update(Array.from(event.target.selectedOptions, (option) => option.value))
                }
              >
                {arrayEnum.map((option) => (
                  <option key={String(option)} value={String(option)}>
                    {t(`analytics.options.${option}`, { defaultValue: String(option) })}
                  </option>
                ))}
              </select>
            </label>
          );
        if (Array.isArray(definition.enum)) {
          return (
            <label key={name}>
              <span>
                {label}
                {required.has(name) ? ' *' : ''}
              </span>
              <select
                aria-label={label}
                value={String(value[name] ?? definition.default ?? '')}
                disabled={disabled}
                onChange={(event) => update(event.target.value)}
              >
                <option value="">—</option>
                {definition.enum.map((item) => (
                  <option
                    key={t(`analytics.options.${item}`, { defaultValue: String(item) })}
                    value={String(item)}
                  >
                    {t(`analytics.options.${item}`, { defaultValue: String(item) })}
                  </option>
                ))}
              </select>
            </label>
          );
        }
        if (type === 'boolean') {
          return (
            <label className="check schema-check" key={name}>
              <input
                type="checkbox"
                checked={Boolean(value[name] ?? definition.default ?? false)}
                disabled={disabled}
                onChange={(event) => update(event.target.checked)}
              />
              {label}
            </label>
          );
        }
        if (type === 'array') {
          const itemType = String(objectValue(definition.items).type ?? 'string');
          return (
            <label key={name}>
              <span>
                {label}
                {required.has(name) ? ' *' : ''}
              </span>
              <Input
                aria-label={label}
                value={arrayText(value[name])}
                disabled={disabled}
                placeholder={itemType === 'string' ? 'field_a, field_b' : '1, 2, 3'}
                onChange={(event) =>
                  update(
                    event.target.value
                      .split(',')
                      .map((item) => item.trim())
                      .filter(Boolean)
                      .map((item) => (itemType === 'integer' ? Number.parseInt(item, 10) : item)),
                  )
                }
              />
            </label>
          );
        }
        const numeric = type === 'number' || type === 'integer';
        return (
          <label key={name}>
            <span>
              {label}
              {required.has(name) ? ' *' : ''}
            </span>
            <Input
              aria-label={label}
              type={numeric ? 'number' : 'text'}
              value={String(value[name] ?? definition.default ?? '')}
              min={
                numeric && typeof definition.minimum === 'number' ? definition.minimum : undefined
              }
              max={
                numeric && typeof definition.maximum === 'number' ? definition.maximum : undefined
              }
              step={type === 'integer' ? 1 : numeric ? 'any' : undefined}
              disabled={disabled}
              required={required.has(name)}
              onChange={(event) =>
                update(
                  numeric
                    ? event.target.value === ''
                      ? undefined
                      : Number(event.target.value)
                    : event.target.value,
                )
              }
            />
          </label>
        );
      })}
    </div>
  );
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayText(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(', ') : '';
}
