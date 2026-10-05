import { isDeepStrictEqual } from 'node:util';
import type { RecordChange, QualityPolicy } from '@zhiyun/shared';

export interface FieldChangeCounts {
  added: number;
  updated: number;
  removed: number;
  total: number;
}
export type FieldChangeProfile = Record<string, FieldChangeCounts>;
export async function profileFieldChanges(
  changes:
    | AsyncIterable<Pick<RecordChange, 'type' | 'before' | 'after'>>
    | Iterable<Pick<RecordChange, 'type' | 'before' | 'after'>>,
): Promise<FieldChangeProfile> {
  const fields: FieldChangeProfile = Object.create(null) as FieldChangeProfile;
  for await (const change of changes) {
    const before = change.before ?? {},
      after = change.after ?? {};
    for (const field of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (
        change.type === 'updated' &&
        Object.hasOwn(before, field) === Object.hasOwn(after, field) &&
        isDeepStrictEqual(before[field], after[field])
      )
        continue;
      const counts = (fields[field] ??= { added: 0, updated: 0, removed: 0, total: 0 });
      counts[change.type] += 1;
      counts.total += 1;
    }
  }
  return fields;
}

export function includesMonitoringField(
  rule: QualityPolicy['rules'][number],
  field: string,
): boolean {
  return (
    (rule.fields.length === 0 || rule.fields.includes(field)) &&
    !(rule.excludeFields ?? []).includes(field)
  );
}
