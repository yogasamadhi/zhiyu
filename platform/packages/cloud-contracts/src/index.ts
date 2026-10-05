import { z } from 'zod';
import type { balanceSchema, periodSchema, ledgerSchema, requestStatusSchema } from './responses';

export const cloudPrefix = '/api/cloud/v1';
export const aiModeSchema = z.enum(['byok', 'hosted']);
export type AiMode = z.infer<typeof aiModeSchema>;
export const channelSchema = z.enum(['mock-wechat', 'mock-alipay']);
export const cycleSchema = z.enum(['month', 'year']);
export const simulationSchema = z.enum([
  'success',
  'failure',
  'cancel',
  'delay',
  'duplicate',
  'out-of-order',
  'unknown',
]);
export const settlementSchema = z.enum(['reserved', 'calling', 'settled', 'released', 'review']);
export type SettlementStatus = z.infer<typeof settlementSchema>;
export type CreditBalance = z.infer<typeof balanceSchema>;
export interface HostedModel {
  id: string;
  name: string;
  maxOutput: number;
  inputRate: number;
  outputRate: number;
  environment: 'test';
}
export type CreditPeriod = z.infer<typeof periodSchema>;
export type CreditEntry = z.infer<typeof ledgerSchema>;
export type AiRequestStatus = z.infer<typeof requestStatusSchema>;
export type SimulationStatus = z.infer<typeof simulationSchema>;
export const id = z.string().uuid();
export const key = z.string().min(8).max(100);
export const email = z
  .email()
  .max(254)
  .transform((s) => s.toLowerCase());
export const password = z.string().min(12).max(128);
export const target = z.string().min(5).max(254);
export const challengeInput = z.object({
  target,
  purpose: z.enum(['login', 'verify', 'reset', 'bind']),
});
export const verifyInput = z.object({
  challengeId: id,
  code: z.string().regex(/^\d{6}$/),
  password: password.optional(),
});
export const loginInput = z.object({
  email,
  password: z.string().max(128),
  totp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export const priceInput = z.object({
  name: z.string().min(1).max(80),
  amountFen: z.number().int().positive().max(10000000),
  cycle: cycleSchema,
  credits: z.number().int().positive().max(100000000),
  modelIds: z.array(id).min(1).max(20),
});
export const modelInput = z.object({
  name: z.string().min(1).max(80),
  upstreamModel: z.string().min(1).max(100),
  baseUrl: z.url().optional(),
  keyRef: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{1,100}$/)
    .optional(),
  adapter: z.enum(['mock', 'openai-compatible']),
  inputRate: z.number().int().positive().max(100000),
  outputRate: z.number().int().positive().max(100000),
  maxOutput: z.number().int().min(16).max(8192),
  maxContext: z.number().int().min(1024).max(131072),
});
export const orderInput = z.object({ priceId: id, channel: channelSchema, key });
export const chatInput = z.object({
  model: id,
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant', 'tool']),
        content: z.string().max(262144).nullable().optional(),
        tool_calls: z
          .array(
            z.object({
              id: z.string().max(100),
              type: z.literal('function'),
              function: z.object({ name: z.string().max(100), arguments: z.string().max(65536) }),
            }),
          )
          .max(30)
          .optional(),
        tool_call_id: z.string().optional(),
      }),
    )
    .min(1)
    .max(100),
  tools: z
    .array(
      z.object({
        type: z.literal('function'),
        function: z.object({
          name: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
          description: z.string().max(4096).optional(),
          parameters: z.record(z.string(), z.unknown()),
        }),
      }),
    )
    .max(30)
    .optional(),
  tool_choice: z.unknown().optional(),
  temperature: z.number().min(0).max(2).optional(),
  response_format: z.unknown().optional(),
  stream: z.boolean().optional(),
  stream_options: z.unknown().optional(),
  max_tokens: z.number().int().min(1).max(8192).optional(),
});
export type ChatInput = z.infer<typeof chatInput>;
export * from './responses';
export * from './lists';
