import { z } from 'zod';

export const ruleCacheResultSchema = z.object({
  status: z.enum(['hit', 'stored', 'miss', 'bypassed']),
  reason: z.enum([
    'matched',
    'empty',
    'structure_changed',
    'rule_changed',
    'configuration_changed',
    'session_changed',
    'provider_changed',
    'prompt_changed',
    'expired',
    'corrupt',
    'validation_failed',
    'privacy_rejected',
    'provider_unknown',
    'scope_missing',
    'cleared_during_analysis',
    'storage_unavailable',
    'generation_failed',
    'fingerprint_limit',
  ]),
  hitCount: z.number().int().nonnegative(),
  providerCalls: z.number().int().nonnegative(),
  previousValidated: z.boolean().optional(),
});

const actionCacheStageCount = z.number().int().nonnegative().max(10_000);
export const browserActionCacheSummarySchema = z
  .object({
    stages: actionCacheStageCount,
    hitStages: actionCacheStageCount,
    storedStages: actionCacheStageCount,
    bypassedStages: actionCacheStageCount,
    providerCalls: z.number().int().nonnegative().max(30_000),
    reasons: z.partialRecord(ruleCacheResultSchema.shape.reason, actionCacheStageCount),
  })
  .strict()
  .refine(
    (value) =>
      value.hitStages + value.storedStages + value.bypassedStages <= value.stages &&
      Object.values(value.reasons).reduce((sum, count) => sum + count, 0) === value.stages,
    'Invalid browser action cache counts',
  );
export type BrowserActionCacheSummary = z.infer<typeof browserActionCacheSummarySchema>;
