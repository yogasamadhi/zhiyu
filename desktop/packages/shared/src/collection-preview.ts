import { z } from 'zod';
import type { CrawlPlanDefinition } from './index.js';

export const previewInspectionSchema = z.object({
  fields: z.record(
    z.string(),
    z.object({
      status: z.enum(['valid', 'missing', 'empty', 'invalid_type']),
      matches: z.number().int().nonnegative(),
    }),
  ),
  containerHint: z.enum(['content', 'navigation', 'advertisement']),
  detail: z
    .object({
      urlField: z.string(),
      linkMatches: z.number().int().nonnegative(),
      recordMatches: z.number().int().nonnegative().nullable(),
      status: z.enum([
        'resolved',
        'missing_link',
        'ambiguous_link',
        'ambiguous_record',
        'empty_detail',
        'failed',
        'budget',
      ]),
    })
    .optional(),
});
export type PreviewInspection = z.infer<typeof previewInspectionSchema>;
export interface CollectionPreviewRecord {
  data: Record<string, unknown>;
  sourceUrl: string;
  inspection?: PreviewInspection | undefined;
}

/** Summaries use declared fields, so a field missing from every row stays visible. */
export function summarizeCollectionPreview(
  plan: CrawlPlanDefinition,
  records: CollectionPreviewRecord[],
) {
  const listFields = plan.list.rule.fields;
  const detailFields = plan.detail?.rule.fields ?? {};
  const fields =
    plan.detail?.mergeStrategy === 'listWins'
      ? { ...detailFields, ...listFields }
      : { ...listFields, ...detailFields };
  return Object.entries(fields).map(([name, field]) => {
    const measured = records.length > 0 && records.every((row) => row.inspection?.fields[name]);
    const state = (row: CollectionPreviewRecord) => row.inspection?.fields[name]?.status;
    const empty = (value: unknown) =>
      value == null || (typeof value === 'string' && value.trim() === '');
    return {
      name,
      dataType: field.dataType,
      selector: 'selector' in field ? field.selector : field.path,
      stage:
        name in detailFields && !(plan.detail?.mergeStrategy === 'listWins' && name in listFields)
          ? ('detail' as const)
          : ('list' as const),
      measured,
      missingCount: measured ? records.filter((row) => state(row) === 'missing').length : null,
      invalidTypeCount: measured
        ? records.filter((row) => state(row) === 'invalid_type').length
        : null,
      emptyCount: records.filter((row) => empty(row.data[name])).length,
      emptyRatio: records.length
        ? records.filter((row) => empty(row.data[name])).length / records.length
        : 0,
      samples: records.slice(0, 3).map((row) => row.data[name] ?? null),
    };
  });
}
