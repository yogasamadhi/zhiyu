import { z } from 'zod';
import { ruleCacheResultSchema } from './cache-results.js';

export const assistantModeSchema = z.enum(['guide', 'do', 'teach']);
export const assistantResourceSchema = z
  .object({
    kind: z.enum(['draft', 'task', 'run', 'dataset']),
    id: z.string().min(1).max(200),
    label: z.string().max(200).optional(),
  })
  .strict();
export const assistantContextSchema = z
  .object({
    intent: z.enum(['explore', 'collect', 'learn', 'diagnose', 'use_data']).default('explore'),
    resource: assistantResourceSchema.nullable().default(null),
    goal: z.string().max(2000).default(''),
    question: z.string().max(1000).default(''),
    revision: z.number().int().positive().default(1),
  })
  .strict();
export type AssistantContext = z.infer<typeof assistantContextSchema>;
export type AssistantResource = z.infer<typeof assistantResourceSchema>;
export const assistantLessonProgressSchema = z.object({
  lessonId: z.string(),
  version: z.number().int(),
  step: z.number().int().nonnegative(),
  status: z.enum(['active', 'paused', 'completed']),
  evidence: z.array(
    z.object({ step: z.number().int(), kind: z.string(), reference: z.string(), at: z.string() }),
  ),
  updatedAt: z.string(),
});
export type AssistantLessonProgress = z.infer<typeof assistantLessonProgressSchema>;
export const assistantConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  lifecycle: z.enum(['active', 'archived']),
  ownerId: z.string().nullable(),
  revision: z.number().int().positive(),
  mode: assistantModeSchema,
  language: z.enum(['zh', 'en']),
  context: assistantContextSchema,
  resources: z.array(assistantResourceSchema),
  activeTurnId: z.string().nullable(),
  collectionDraftId: z.string().nullable(),
  lessons: z.array(assistantLessonProgressSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AssistantConversation = z.infer<typeof assistantConversationSchema>;

export const assistantActionKindSchema = z.enum([
  'select_source',
  'create_example',
  'save',
  'save_and_run',
  'run',
  'schedule',
  'apply_repair',
  'retry_output',
  'export',
]);
export const assistantActionSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  revision: z.number().int().positive(),
  kind: assistantActionKindSchema,
  title: z.string(),
  summary: z.string(),
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'canceled', 'expired']),
  resource: assistantResourceSchema.nullable(),
  expectedRevision: z.number().int().nullable(),
  contextRevision: z.number().int(),
  parameters: z.record(z.string(), z.unknown()),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AssistantAction = z.infer<typeof assistantActionSchema>;
export const assistantMessageBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), id: z.string(), text: z.string() }),
  z.object({
    type: z.literal('source'),
    id: z.string(),
    title: z.string(),
    url: z.string(),
    summary: z.string(),
    actionId: z.string().optional(),
  }),
  z.object({
    type: z.literal('fields'),
    id: z.string(),
    draftId: z.string(),
    fields: z.array(z.string()),
    cache: ruleCacheResultSchema.strict().optional(),
    actionCache: ruleCacheResultSchema.strict().optional(),
  }),
  z.object({
    type: z.literal('preview'),
    id: z.string(),
    draftId: z.string().optional(),
    repairActionId: z.string().optional(),
    resource: assistantResourceSchema.optional(),
    revision: z.number(),
    createdAt: z.string(),
    records: z.array(z.object({ sourceUrl: z.string(), data: z.record(z.string(), z.unknown()) })),
  }),
  z.object({ type: z.literal('action'), id: z.string(), actionId: z.string() }),
  z.object({ type: z.literal('lesson'), id: z.string(), lessonId: z.string() }),
  z.object({ type: z.literal('navigation'), id: z.string(), label: z.string(), href: z.string() }),
]);
export type AssistantMessageBlock = z.infer<typeof assistantMessageBlockSchema>;
export const assistantMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  turnId: z.string().nullable(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  sequence: z.number(),
  createdAt: z.string(),
  blocks: z.array(assistantMessageBlockSchema),
});
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;
export const aiCostBudgetSchema = z
  .object({
    maximum: z.number().finite().min(0).max(10_000),
    perCallEstimate: z.number().finite().min(0).max(10_000).nullable().default(null),
    currency: z.enum(['CNY', 'USD']).default('CNY'),
  })
  .strict();
export type AiCostBudget = z.infer<typeof aiCostBudgetSchema>;
export const aiCostAmountSchema = z
  .object({
    source: z.enum(['mock', 'estimate', 'settled']),
    amount: z.number().finite().nonnegative(),
    currency: z.enum(['CNY', 'USD']),
  })
  .strict();
export type AiCostAmount = z.infer<typeof aiCostAmountSchema>;
export const aiTurnAccountingSchema = z
  .object({
    calls: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    tokensSource: z.enum(['mock', 'reported', 'mixed', 'unknown']),
    costs: z.array(aiCostAmountSchema).max(6),
    unknownCostCalls: z.number().int().nonnegative(),
    estimatedCost: z.number().finite().nonnegative().nullable(),
    budget: aiCostBudgetSchema.nullable(),
    stopReason: z.enum(['cost_limit', 'estimate_unavailable']).nullable(),
    operations: z.partialRecord(
      z.enum([
        'chat',
        'generateSchema',
        'generateRule',
        'extract',
        'suggestRepair',
        'explainFailure',
        'repairBrowserAction',
      ]),
      z.number().int().nonnegative(),
    ),
  })
  .strict();
export type AiTurnAccounting = z.infer<typeof aiTurnAccountingSchema>;
export const assistantMessageInputSchema = z
  .object({
    content: z.string().min(1).max(8000),
    costBudget: aiCostBudgetSchema.optional(),
  })
  .strict();
export const assistantTurnSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']),
  attempt: z.number(),
  modelRounds: z.number(),
  toolCalls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costBudget: aiCostBudgetSchema.nullable().optional(),
  accounting: aiTurnAccountingSchema.nullable().optional(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export const assistantDetailSchema = z.object({
  conversation: assistantConversationSchema,
  messages: z.array(assistantMessageSchema),
  actions: z.array(assistantActionSchema),
  turn: assistantTurnSchema.nullable(),
  providerConfigured: z.boolean(),
  nextCursor: z.string().nullable(),
});
export type AssistantDetail = z.infer<typeof assistantDetailSchema>;
export const assistantLessonSchema = z.object({
  id: z.string(),
  version: z.number(),
  title: z.string(),
  summary: z.string(),
  steps: z.array(
    z.object({
      title: z.string(),
      explanation: z.string(),
      activity: z.enum(['example', 'select_price', 'preview', 'pagination', 'run', 'export']),
      demonstration: z.string(),
    }),
  ),
});
export type AssistantLesson = z.infer<typeof assistantLessonSchema>;
export const assistantCapabilitiesSchema = z.object({
  enabled: z.boolean(),
  providerConfigured: z.boolean(),
  controlledLogin: z.boolean(),
  tools: z.array(z.string()),
  modes: z.array(assistantModeSchema),
  lessons: z.array(z.string()),
});
export type AssistantCapabilities = z.infer<typeof assistantCapabilitiesSchema>;
export const assistantCreateSchema = z
  .object({
    title: z.string().max(120).optional(),
    mode: assistantModeSchema.optional(),
    language: z.enum(['zh', 'en']).optional(),
    context: assistantContextSchema.optional(),
  })
  .strict();
export const assistantPatchSchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    mode: assistantModeSchema.optional(),
    language: z.enum(['zh', 'en']).optional(),
    lifecycle: z.enum(['active', 'archived']).optional(),
  })
  .strict();
export const assistantLessonEventSchema = z
  .object({
    lessonId: z.enum(['first-table', 'fields', 'pagination', 'export']),
    event: z.enum([
      'start',
      'pause',
      'resume',
      'skip',
      'restart',
      'verify',
      'take_over',
      'load_more',
    ]),
    selection: z.enum(['card', 'price', 'name']).optional(),
    pages: z.number().int().min(1).max(2).optional(),
    reference: z.string().max(200).optional(),
  })
  .strict();
