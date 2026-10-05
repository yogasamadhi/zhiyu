import { z } from 'zod';
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CLOUD_DATABASE_URL: z
    .string()
    .default('postgres://zhiyun:zhiyun-local@127.0.0.1:55432/zhiyun_cloud'),
  CLOUD_REDIS_URL: z.string().default('redis://127.0.0.1:56379'),
  CLOUD_PORT: z.coerce.number().default(3200),
  CLOUD_PORTAL_ORIGIN: z.url().default('http://localhost:3100'),
  CLOUD_ADMIN_ORIGIN: z.url().default('http://localhost:3101'),
  CLOUD_MOCK_PAYMENTS: z.enum(['true', 'false']).default('true'),
  CLOUD_REAL_MESSAGES: z.enum(['true', 'false']).default('false'),
  CLOUD_MODEL_ORIGINS: z.string().default(''),
  CLOUD_DAILY_TOKEN_BUDGET: z.coerce.number().int().positive().default(1000000),
  CLOUD_MFA_KEY: z.string().min(32).default('development-only-change-this-mfa-key-32'),
});
export function readConfig(env: Record<string, string | undefined> = process.env) {
  const config = schema.parse(env);
  if (config.NODE_ENV === 'production') {
    if (config.CLOUD_MOCK_PAYMENTS === 'true')
      throw new Error('Production refuses simulated payments');
    if (config.CLOUD_MFA_KEY.startsWith('development-')) throw new Error('Configure CLOUD_MFA_KEY');
    for (const origin of [config.CLOUD_PORTAL_ORIGIN, config.CLOUD_ADMIN_ORIGIN])
      if (!origin.startsWith('https://')) throw new Error('HTTPS required');
  }
  return config;
}
export type Config = ReturnType<typeof readConfig>;
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };
export class DomainError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
  }
}
export function requireValue<T>(value: T | undefined | null, code = 'NOT_FOUND'): T {
  if (value == null) throw new DomainError(code, 404);
  return value;
}
