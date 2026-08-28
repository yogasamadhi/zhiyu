import { Input } from './ui.js';

export interface SchemaFormProps {
  schema: Record<string, unknown>;
  value: Record<string, unknown>;
  onChange(value: Record<string, unknown>): void;
  disabled?: boolean;
}

export function SchemaForm({ schema, value, onChange, disabled }: SchemaFormProps) {
  const properties = objectValue(schema.properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return (
    <div className="schema-form">
      {Object.entries(properties).map(([name, raw]) => {
        const definition = objectValue(raw);
        const type = Array.isArray(definition.type) ? definition.type[0] : definition.type;
        const label = String(definition.title ?? name);
        const update = (next: unknown) => onChange({ ...value, [name]: next });
        if (Array.isArray(definition.enum)) {
          return (
            <label key={name}>
              <span>
                {label}
                {required.has(name) ? ' *' : ''}
              </span>
              <select
                value={String(value[name] ?? definition.default ?? '')}
                disabled={disabled}
                onChange={(event) => update(event.target.value)}
              >
                <option value="">—</option>
                {definition.enum.map((item) => (
                  <option key={String(item)} value={String(item)}>
                    {String(item)}
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
