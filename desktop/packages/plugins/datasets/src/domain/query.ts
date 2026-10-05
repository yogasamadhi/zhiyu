import { createHash } from 'node:crypto';
import { recordQuerySchema, type RecordQuery } from '@zhiyun/shared';

export function compileRecordQuery(datasetId: string, input: RecordQuery) {
  const query = recordQuerySchema.parse(input);
  const parameters: Array<string | number | boolean | null> = [];
  const bind = (value: string | number | boolean | null) => {
    parameters.push(typeof value === 'boolean' ? Number(value) : value);
    return '?';
  };
  const field = (name: string, type?: string): string => {
    if (type === 'number')
      return `(SELECT CASE WHEN type IN ('integer','real') THEN value END FROM json_each(dataset_records.data) WHERE key=${bind(name)} LIMIT 1)`;
    const raw = `(SELECT value FROM json_each(dataset_records.data) WHERE key=${bind(name)} LIMIT 1)`;
    return type === 'date' ? `datasets_epoch(${raw})` : raw;
  };
  const clauses = [`dataset_id=${bind(datasetId)}`];
  if (!query.includeRemoved) clauses.push('removed=0');
  if (query.query) {
    const term = bind(query.query.toLowerCase());
    clauses.push(
      `EXISTS (SELECT 1 FROM json_each(dataset_records.data) WHERE type NOT IN ('object','array','null') AND instr(lower(CASE WHEN type='true' THEN 'true' WHEN type='false' THEN 'false' ELSE CAST(value AS TEXT) END),${term})>0)`,
    );
  }
  const predicates = [
    ...Object.entries(query.filter ?? {}).map(([name, value]) => ({
      field: name,
      legacy: true,
      operator: 'eq' as const,
      value,
      type: typeof value === 'number' ? ('number' as const) : undefined,
    })),
    ...query.filters,
  ];
  for (const predicate of predicates) {
    const { operator, value, type } = predicate;
    const scalar = () => field(predicate.field, type);
    if ('legacy' in predicate && predicate.legacy && value === null) {
      clauses.push(
        `(SELECT type FROM json_each(dataset_records.data) WHERE key=${bind(predicate.field)} LIMIT 1)='null'`,
      );
    } else if (operator === 'empty' || operator === 'not_empty') {
      const expression = `(${scalar()} IS NULL OR CAST(${scalar()} AS TEXT)='')`;
      clauses.push(operator === 'empty' ? expression : `NOT ${expression}`);
    } else if (value === null) {
      clauses.push(`${scalar()} IS ${operator === 'ne' ? 'NOT ' : ''}NULL`);
    } else if (operator === 'contains') {
      const expression = `lower(CAST(${scalar()} AS TEXT))`;
      const needle = bind(String(value).toLowerCase());
      clauses.push(`instr(${expression},${needle})>0`);
    } else {
      const comparison = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[operator];
      const expected = type === 'date' ? Date.parse(String(value)) : value!;
      clauses.push(`${scalar()} ${comparison} ${bind(expected)}`);
    }
  }
  const whereParameters = [...parameters];
  const order = query.sort
    ? `${field(query.sort.field, query.sort.type)} ${query.sort.direction.toUpperCase()} NULLS LAST,id ${query.sort.direction.toUpperCase()}`
    : 'last_seen_at DESC,id DESC';
  return {
    where: clauses.join(' AND '),
    order,
    parameters,
    whereParameters,
    fingerprint: createHash('sha256')
      .update(JSON.stringify([datasetId, query]))
      .digest('hex')
      .slice(0, 24),
  };
}

export function recordQueryOffset(cursor: string | undefined, fingerprint: string): number {
  if (!cursor) return 0;
  let decoded: { offset?: number; query?: string };
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid record query cursor');
  }
  if (decoded.query !== fingerprint || !Number.isSafeInteger(decoded.offset) || decoded.offset! < 0)
    throw new Error('Record query changed; restart pagination');
  return decoded.offset!;
}
export function recordQueryCursor(offset: number, fingerprint: string): string {
  return Buffer.from(JSON.stringify({ offset, query: fingerprint })).toString('base64url');
}

export function legacyRecordPosition(cursor?: string): { at: string; id: string } | null {
  if (!cursor) return null;
  const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
    at?: unknown;
    id?: unknown;
  };
  return typeof decoded.at === 'string' &&
    Number.isFinite(Date.parse(decoded.at)) &&
    typeof decoded.id === 'string'
    ? { at: decoded.at, id: decoded.id }
    : null;
}
