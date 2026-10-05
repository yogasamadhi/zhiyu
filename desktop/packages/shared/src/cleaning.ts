import { z } from 'zod';

// Python/JSON Schema count Unicode code points, rather than JavaScript UTF-16 units.
const boundedString = (minimum: number, maximum: number) =>
  z
    .string()
    .refine((value) => {
      const length = Array.from(value).length;
      return length >= minimum && length <= maximum;
    }, `Use ${minimum}–${maximum} Unicode characters`)
    .meta({ minLength: minimum, maxLength: maximum });
const field = boundedString(1, 255);
const fields = (minimum = 1, maximum = 50) =>
  z
    .array(field)
    .min(minimum)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, 'Fields must be unique');
const target = field.refine((value) => !value.startsWith('__zhiyun_'), 'Target is reserved');
export const cleaningFieldTypeSchema = z.enum(['string', 'int', 'float', 'bool', 'datetime']);
export const cleaningStepSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('trim'), fields: fields() }).strict(),
  z
    .object({
      type: z.literal('normalize_null'),
      fields: fields(),
      tokens: z.array(boundedString(0, 1000)).max(50).default(['', 'null', 'NULL', 'N/A']),
    })
    .strict(),
  z
    .object({
      type: z.literal('convert'),
      fields: fields(),
      targetType: z.enum(['number', 'date']),
      onError: z.enum(['null', 'fail']).default('null'),
    })
    .strict(),
  z
    .object({
      type: z.literal('split'),
      field,
      delimiter: boundedString(1, 100),
      targets: z
        .array(target)
        .min(2)
        .max(10)
        .refine((values) => new Set(values).size === values.length, 'Targets must be unique'),
    })
    .strict(),
  z
    .object({
      type: z.literal('merge'),
      fields: fields(2, 10),
      target,
      separator: boundedString(0, 100).default(' '),
    })
    .strict(),
  z.object({ type: z.literal('dedupe'), fields: fields() }).strict(),
]);
export type CleaningStep = z.infer<typeof cleaningStepSchema>;
export const cleaningParametersSchema = z
  .object({
    fingerprint: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]{64}$/),
    manifestArtifactRef: boundedString(1, 1024).refine(
      (value) =>
        !value.startsWith('/') &&
        !value.includes('\\') &&
        !/^[A-Za-z]:/.test(value) &&
        value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
      'Manifest must be a relative Artifact reference',
    ),
    steps: z.array(cleaningStepSchema).max(20),
    expectedFields: z
      .record(field, cleaningFieldTypeSchema)
      .refine((value) => Object.keys(value).length <= 1000, 'Too many fields')
      .default({}),
    previewLimit: z.number().int().min(0).max(100).default(10),
    facetLimit: z.number().int().min(1).max(50).default(10),
  })
  .strict();
export type CleaningParameters = z.infer<typeof cleaningParametersSchema>;

const count = z.number().int().nonnegative();
const value = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const error = z
  .object({ field: z.string(), reason: z.enum(['invalid_number', 'invalid_date']) })
  .strict();
export const cleaningQualitySchema = z
  .object({
    rowCount: count,
    fields: z.record(
      z.string(),
      z
        .object({
          type: cleaningFieldTypeSchema,
          nullCount: count,
          blankCount: count,
          invalidCount: count,
          stringCount: count,
          otherCount: count,
          trackedDistinctCount: count.max(50),
          omittedTrackedCount: count,
          facetScope: z.literal('first-50-distinct-values'),
          facets: z
            .array(
              z
                .object({
                  value,
                  valueTruncated: z.boolean(),
                  count,
                })
                .strict(),
            )
            .max(50),
        })
        .strict(),
    ),
  })
  .strict();
export const cleaningStepResultSchema = z
  .object({
    index: count.max(19),
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    operation: cleaningStepSchema,
    inputRowCount: count,
    rowCount: count,
    changedRowCount: count,
    removedRowCount: count,
    errorRowCount: count,
    errorCount: count,
    errorSamples: z
      .array(
        z
          .object({
            rowIndex: count,
            recordKey: z.string(),
            errors: z.array(error),
          })
          .strict(),
      )
      .max(20),
    preview: z
      .array(
        z
          .object({
            rowIndex: count,
            recordKey: z.string(),
            sourceUrl: z.string(),
            before: z.record(z.string(), value),
            after: z.record(z.string(), value).nullable(),
            beforeTruncatedFields: z.array(z.string()),
            afterTruncatedFields: z.array(z.string()),
            beforeOmittedFieldCount: count,
            afterOmittedFieldCount: count,
            errors: z.array(error),
          })
          .strict(),
      )
      .max(100),
    parquetArtifactRef: z.string(),
    manifestArtifactRef: z.string(),
    inputQuality: cleaningQualitySchema,
    outputQuality: cleaningQualitySchema,
  })
  .strict();
export const cleaningResultSchema = z
  .object({
    version: z.literal('1.0.0'),
    inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    inputRowCount: count,
    rowCount: count,
    parquetArtifactRef: z.string(),
    manifestArtifactRef: z.string(),
    inputQuality: cleaningQualitySchema,
    outputQuality: cleaningQualitySchema,
    steps: z.array(cleaningStepResultSchema).max(20),
  })
  .strict();
export type CleaningResult = z.infer<typeof cleaningResultSchema>;

const identifier = z.uuid();
const timestamp = z.iso.datetime();
export const cleaningRecipeInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    steps: z.array(cleaningStepSchema).min(1).max(20),
    expectedFields: cleaningParametersSchema.shape.expectedFields,
    recipeId: identifier.optional(),
    expectedRevision: z.number().int().positive().optional(),
  })
  .strict();
export const cleaningRecipeSchema = z
  .object({
    id: identifier,
    datasetId: identifier,
    name: z.string(),
    revision: z.number().int().positive(),
    currentVersionId: identifier,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export const cleaningRecipeVersionSchema = z
  .object({
    id: identifier,
    recipeId: identifier,
    revision: z.number().int().positive(),
    name: z.string(),
    steps: z.array(cleaningStepSchema).min(1).max(20),
    expectedFields: cleaningParametersSchema.shape.expectedFields,
    createdAt: timestamp,
  })
  .strict();
export const cleaningSessionSchema = z
  .object({
    id: identifier,
    datasetId: identifier,
    inputSnapshotId: identifier,
    recipeVersionId: identifier,
    outputSnapshotIds: z.array(identifier).min(1).max(20),
    selectedStep: count.max(20),
    selectedSnapshotId: identifier,
    revision: z.number().int().positive(),
    reportArtifactId: identifier,
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .strict();
export const cleaningPreviewInputSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('steps'),
      snapshotId: identifier,
      steps: z.array(cleaningStepSchema).max(20),
      expectedFields: cleaningParametersSchema.shape.expectedFields,
    })
    .strict(),
  z
    .object({ mode: z.literal('recipe'), snapshotId: identifier, recipeVersionId: identifier })
    .strict(),
]);
export const cleaningApplyInputSchema = z
  .object({ snapshotId: identifier, recipeVersionId: identifier })
  .strict();
export const cleaningSelectInputSchema = z
  .object({ selectedStep: count.max(20), expectedRevision: z.number().int().positive() })
  .strict();
export const cleaningSessionDetailSchema = z
  .object({
    session: cleaningSessionSchema,
    recipeVersion: cleaningRecipeVersionSchema,
    report: cleaningResultSchema,
  })
  .strict();
export type CleaningRecipeInput = z.infer<typeof cleaningRecipeInputSchema>;
export type CleaningRecipe = z.infer<typeof cleaningRecipeSchema>;
export type CleaningRecipeVersion = z.infer<typeof cleaningRecipeVersionSchema>;
export type CleaningSession = z.infer<typeof cleaningSessionSchema>;
export type CleaningPreviewInput = z.infer<typeof cleaningPreviewInputSchema>;
export type CleaningApplyInput = z.infer<typeof cleaningApplyInputSchema>;
export type CleaningSessionDetail = z.infer<typeof cleaningSessionDetailSchema>;
