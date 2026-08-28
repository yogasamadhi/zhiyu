import 'dotenv/config';
import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().default('postgresql://zhiyun:zhiyun@localhost:45432/zhiyun'),
    REDIS_URL: z.string().default('redis://localhost:46379'),
    WEB_PORT: z.coerce.number().int().positive().default(45173),
    API_PORT: z.coerce.number().int().positive().default(45300),
    FIXTURE_PORT: z.coerce.number().int().positive().default(45100),
    AI_BASE_URL: z.string().url().optional(),
    AI_API_KEY: z.string().optional(),
    AI_MODEL: z.string().optional(),
    ZHIYUN_CREDENTIAL_KEY: z.string().optional(),
    ZHIYUN_ADMIN_TOKEN: z.string().min(1).optional(),
    ZHIYUN_SESSION_NONCE: z.string().min(16).default('headless-development-session'),
    API_HOST: z.string().default('127.0.0.1'),
    ZHIYUN_PUBLIC_URL: z.string().url().optional(),
    ZHIYUN_ALLOWED_ORIGINS: z.string().optional(),
    ZHIYUN_TRUST_PROXY: z.stringbool().default(false),
    CRAWLER_CONCURRENCY: z.coerce.number().int().min(1).default(2),
    CRAWLER_TIMEOUT: z.coerce.number().int().min(1_000).default(30_000),
    CRAWLER_MAX_REQUESTS: z.coerce.number().int().min(1).default(100),
    STAGEHAND_ENABLED: z.stringbool().default(false),
    BROWSERBASE_API_KEY: z.string().optional(),
    BROWSERBASE_PROJECT_ID: z.string().optional(),
  })
  .superRefine((value, context) => {
    if (value.ZHIYUN_ADMIN_TOKEN && Buffer.byteLength(value.ZHIYUN_ADMIN_TOKEN, 'utf8') < 32) {
      context.addIssue({
        code: 'custom',
        path: ['ZHIYUN_ADMIN_TOKEN'],
        message: 'Administrator token must contain at least 32 bytes',
      });
    }
    if (value.NODE_ENV === 'production' && !value.ZHIYUN_ADMIN_TOKEN) {
      context.addIssue({
        code: 'custom',
        path: ['ZHIYUN_ADMIN_TOKEN'],
        message: 'Production requires a 32-byte administrator token',
      });
    }
    if (value.NODE_ENV === 'production' && !value.ZHIYUN_CREDENTIAL_KEY) {
      context.addIssue({
        code: 'custom',
        path: ['ZHIYUN_CREDENTIAL_KEY'],
        message: 'Production requires an encryption key',
      });
    }
    if (!['127.0.0.1', 'localhost', '::1'].includes(value.API_HOST)) {
      if (!value.ZHIYUN_ALLOWED_ORIGINS) {
        context.addIssue({
          code: 'custom',
          path: ['ZHIYUN_ALLOWED_ORIGINS'],
          message: 'Remote binding requires explicit CORS origins',
        });
      }
      if (!value.ZHIYUN_PUBLIC_URL?.startsWith('https://')) {
        context.addIssue({
          code: 'custom',
          path: ['ZHIYUN_PUBLIC_URL'],
          message: 'Remote binding requires an HTTPS public URL',
        });
      }
    }
  });

export type AppConfig = z.infer<typeof envSchema>;

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  cached ??= envSchema.parse(process.env);
  return cached;
}
