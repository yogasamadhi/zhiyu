import { z } from 'zod';

// Field names are parameters, never SQL identifiers. Unicode and punctuation are supported.
export const dataFieldSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((s) => !s.includes('\0'));
export const scalarSchema = z.union([
  z.string().max(4000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const recordPredicateSchema = z
  .object({
    field: dataFieldSchema,
    operator: z.enum(['eq', 'ne', 'contains', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty']),
    value: scalarSchema.optional(),
    type: z.enum(['text', 'number', 'date', 'boolean']).optional(),
  })
  .strict()
  .superRefine((item, ctx) => {
    if (!['empty', 'not_empty'].includes(item.operator) && item.value === undefined) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'A comparison value is required' });
    }
    if (['gt', 'gte', 'lt', 'lte'].includes(item.operator)) {
      if (item.type === 'number' && typeof item.value !== 'number')
        ctx.addIssue({ code: 'custom', path: ['value'], message: 'A numeric value is required' });
      if (
        item.type === 'date' &&
        (typeof item.value !== 'string' || !Number.isFinite(Date.parse(item.value)))
      )
        ctx.addIssue({ code: 'custom', path: ['value'], message: 'A valid date is required' });
    }
  });
export const recordQuerySchema = z.object({
  query: z.string().max(500).optional(),
  filter: z
    .record(dataFieldSchema, scalarSchema)
    .refine((v) => Object.keys(v).length <= 20)
    .optional(),
  filters: z.array(recordPredicateSchema).max(20).default([]),
  sort: z
    .object({
      field: dataFieldSchema,
      direction: z.enum(['asc', 'desc']),
      type: z.enum(['text', 'number', 'date']).default('text'),
    })
    .strict()
    .optional(),
  includeRemoved: z.boolean().default(false),
});
export type RecordQuery = z.input<typeof recordQuerySchema>;
export type RecordPredicate = z.infer<typeof recordPredicateSchema>;
export interface DatasetFieldDescription {
  name: string;
  label?: string;
  type: 'text' | 'number' | 'date' | 'boolean' | 'mixed' | 'unknown';
  missingCount: number;
  sampleCount: number;
}
export interface DatasetSchemaDescription {
  datasetId: string;
  snapshotId: string | null;
  sampled: boolean;
  sampleCount: number;
  fields: DatasetFieldDescription[];
}
