import { z } from 'zod';
import { cloudListPageSchema, type CloudListPath } from './lists';
const id = z.uuid(),
  date = z.string(),
  nullableDate = date.nullable();
const config = z.record(z.string(), z.unknown());
const order = z.object({
  id,
  user_id: id,
  price_id: id,
  snapshot: config,
  channel: z.enum(['mock-wechat', 'mock-alipay']),
  key: z.string(),
  status: z.enum(['pending', 'paid', 'failed', 'canceled', 'closed', 'refunded']),
  agreement_id: id.nullable(),
  cycle_at: nullableDate,
  created_at: date,
  environment: z.literal('test'),
});
const term = z.object({
  id,
  user_id: id,
  order_id: id,
  starts_at: date,
  ends_at: date,
  anchor: date,
  anchor_offset: z.number().int(),
  months: z.number().int(),
  revoked_at: nullableDate,
});
const agreement = z.object({
  id,
  user_id: id,
  price_id: id,
  channel: z.enum(['mock-wechat', 'mock-alipay']),
  status: z.string(),
  next_at: nullableDate,
  created_at: date,
});
export const balanceSchema = z.object({
  available: z.number().int(),
  reserved: z.number().int(),
  expiresAt: nullableDate,
});
export const periodSchema = z.object({
  id,
  user_id: id,
  term_id: id,
  starts_at: date,
  ends_at: date,
  allowance: z.number().int(),
  available: z.number().int(),
  reserved: z.number().int(),
  state: z.enum(['scheduled', 'active', 'expired', 'revoked']),
});
export const ledgerSchema = z.object({
  id,
  user_id: id,
  period_id: id,
  kind: z.enum(['grant', 'reserve', 'settle', 'release', 'expire', 'adjust', 'refund']),
  amount: z.number().int(),
  key: z.string(),
  request_id: id.nullable(),
  created_at: date,
});
export const requestStatusSchema = z.object({
  id,
  turn_id: z.string(),
  status: z.enum(['reserved', 'calling', 'settled', 'released', 'review']),
  input_tokens: z.number().nullable(),
  output_tokens: z.number().nullable(),
  cost: z.number().nullable(),
  error_code: z.string().nullable(),
});
const session = z.object({ csrf: z.string(), expiresAt: date });
const desktopSession = session.extend({ access: z.string(), refresh: z.string(), sessionId: id });
const device = z.object({
  id,
  user_id: id,
  name: z.string(),
  revoked_at: nullableDate,
  created_at: date,
});
const ownSession = z.object({
  id,
  device_id: id.nullable(),
  created_at: date,
  expires_at: date,
  revoked_at: nullableDate,
});
const usage = requestStatusSchema
  .omit({ error_code: true })
  .extend({ model_id: id, created_at: date });
export const cloudListRowSchemas: Record<CloudListPath, z.ZodType> = {
  '/me/orders': order,
  '/me/credits': ledgerSchema,
  '/me/periods': periodSchema,
  '/me/devices': device,
  '/me/sessions': ownSession,
  '/me/usage': usage,
  '/admin/users': z.object({ id, status: z.string(), created_at: date }),
  '/admin/prices': z.object({ id, config, published: z.boolean(), created_at: date }),
  '/admin/models': z.object({
    id,
    config,
    tested_at: nullableDate,
    enabled: z.boolean(),
    created_at: date,
  }),
  '/admin/subscriptions': term,
  '/admin/orders': order,
  '/admin/refunds': z.object({
    id,
    order_id: id,
    status: z.string(),
    reason: z.string(),
    created_at: date,
  }),
  '/admin/credits': ledgerSchema,
  '/admin/periods': periodSchema,
  '/admin/devices': device,
  '/admin/staff': z.object({
    id,
    email: z.string(),
    role: z.enum(['owner', 'support', 'finance', 'operator']),
    disabled: z.boolean(),
  }),
  '/admin/jobs': z.object({
    id,
    key: z.string(),
    kind: z.string(),
    payload: config,
    due_at: date,
    status: z.string(),
    locked_until: nullableDate,
    attempts: z.number().int(),
    last_error: z.string().nullable(),
    created_at: date,
  }),
  '/admin/audit': z.object({
    id,
    actor_id: id.nullable(),
    action: z.string(),
    resource_id: z.string().nullable(),
    detail: config,
    created_at: date,
  }),
  '/admin/requests': requestStatusSchema.extend({
    user_id: id,
    model_id: id,
    reserved: z.number().int(),
    created_at: date,
  }),
  '/admin/agreements': agreement,
  '/admin/inbox': z.object({
    id,
    challenge_id: id,
    target: z.string(),
    code: z.string(),
    expires_at: date,
  }),
};
export const responseSchemas: Record<string, z.ZodType> = {
  '/health': z.object({
    database: z.literal('available'),
    cache: z.enum(['available', 'degraded']),
    payments: z.enum(['simulation', 'disabled']),
  }),
  '/catalog': z.object({
    simulation: z.boolean(),
    prices: z.array(
      z.object({
        id,
        config: z.object({
          name: z.string(),
          cycle: z.enum(['month', 'year']),
          amountFen: z.number().int(),
          credits: z.number().int(),
          modelIds: z.array(id),
        }),
      }),
    ),
    models: z.array(z.object({ id, name: z.string() })),
  }),
  '/auth/challenges': z.object({ challengeId: id, expiresAt: date }),
  '/auth/login': session,
  '/auth/verify': z.union([session, z.object({ bound: z.literal(true) })]),
  '/me': z.object({
    id,
    csrf: z.string(),
    identities: z.array(z.object({ id, target: z.string(), verified: z.boolean() })),
    balance: balanceSchema,
    terms: z.array(term),
    agreements: z.array(agreement),
    environment: z.literal('test'),
    deviceLimit: z.literal(2),
  }),
  '/billing/orders': order,
  '/billing/agreements': agreement,
  '/desktop/authorize': z.object({ code: z.string() }),
  '/desktop/exchange': desktopSession.extend({ deviceId: id }),
  '/desktop/refresh': desktopSession,
  '/ai/models': z.array(
    z.object({
      id,
      name: z.string(),
      inputRate: z.number().int(),
      outputRate: z.number().int(),
      maxOutput: z.number().int(),
      environment: z.literal('test'),
    }),
  ),
  '/ai/status': requestStatusSchema,
  '/admin/login': session,
  '/admin/me': z.object({
    id,
    role: z.enum(['owner', 'support', 'operator', 'finance']),
    csrf: z.string(),
  }),
};
export const cloudListResponseSchemas: Record<string, z.ZodType> = {};
for (const [path, row] of Object.entries(cloudListRowSchemas))
  cloudListResponseSchemas[path] = cloudListPageSchema(row);
