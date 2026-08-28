ALTER TABLE "api_tokens" ADD COLUMN IF NOT EXISTS "rate_limit_per_minute" integer DEFAULT 60 NOT NULL;
