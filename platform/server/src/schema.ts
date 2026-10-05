import {
  pgTable,
  text,
  timestamp,
  uuid,
  foreignKey,
  unique,
  boolean,
  integer,
  check,
  bigint,
  uniqueIndex,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const cloudMigrations = pgTable('cloud_migrations', {
  name: text().primaryKey().notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const cloudUsers = pgTable('cloud_users', {
  id: uuid().defaultRandom().primaryKey().notNull(),
  status: text().default('active').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const cloudIdentities = pgTable(
  'cloud_identities',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    userId: uuid('user_id').notNull(),
    target: text().notNull(),
    passwordHash: text('password_hash'),
    verified: boolean().default(false).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [cloudUsers.id],
      name: 'cloud_identities_user_id_fkey',
    }),
    unique('cloud_identities_target_key').on(table.target),
  ],
);

export const cloudChallenges = pgTable(
  'cloud_challenges',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    target: text().notNull(),
    purpose: text().notNull(),
    userId: uuid('user_id'),
    digest: text().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    attempts: integer().default(0).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [cloudUsers.id],
      name: 'cloud_challenges_user_id_fkey',
    }),
  ],
);

export const cloudDevices = pgTable(
  'cloud_devices',
  {
    id: uuid().primaryKey().notNull(),
    userId: uuid('user_id').notNull(),
    name: text().notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [cloudUsers.id],
      name: 'cloud_devices_user_id_fkey',
    }),
  ],
);

export const cloudSessions = pgTable(
  'cloud_sessions',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    userId: uuid('user_id'),
    staffId: uuid('staff_id'),
    deviceId: uuid('device_id'),
    digest: text().notNull(),
    refreshDigest: text('refresh_digest'),
    family: uuid().defaultRandom().notNull(),
    csrf: text().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    refreshExpiresAt: timestamp('refresh_expires_at', { withTimezone: true, mode: 'string' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [cloudUsers.id],
      name: 'cloud_sessions_user_id_fkey',
    }),
    foreignKey({
      columns: [table.staffId],
      foreignColumns: [cloudStaff.id],
      name: 'cloud_sessions_staff_id_fkey',
    }),
    foreignKey({
      columns: [table.deviceId],
      foreignColumns: [cloudDevices.id],
      name: 'cloud_sessions_device_id_fkey',
    }),
    unique('cloud_sessions_digest_key').on(table.digest),
    unique('cloud_sessions_refresh_digest_key').on(table.refreshDigest),
    check('cloud_sessions_check', sql`(user_id IS NULL) <> (staff_id IS NULL)`),
  ],
);

export const cloudStaff = pgTable(
  'cloud_staff',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    email: text().notNull(),
    passwordHash: text('password_hash').notNull(),
    mfaSecret: text('mfa_secret').notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    lastTotp: bigint('last_totp', { mode: 'number' })
      .default(sql`'-1'`)
      .notNull(),
    role: text().notNull(),
    disabled: boolean().default(false).notNull(),
  },
  (table) => [
    unique('cloud_staff_email_key').on(table.email),
    check(
      'cloud_staff_role_check',
      sql`role = ANY (ARRAY['owner'::text, 'support'::text, 'finance'::text, 'operator'::text])`,
    ),
  ],
);

export const cloudRefreshHistory = pgTable('cloud_refresh_history', {
  digest: text().primaryKey().notNull(),
  family: uuid().notNull(),
});

export const cloudDesktopCodes = pgTable(
  'cloud_desktop_codes',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    digest: text().notNull(),
    userId: uuid('user_id').notNull(),
    challenge: text().notNull(),
    redirectUri: text('redirect_uri').notNull(),
    deviceId: uuid('device_id').notNull(),
    deviceName: text('device_name').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [cloudUsers.id],
      name: 'cloud_desktop_codes_user_id_fkey',
    }),
    unique('cloud_desktop_codes_digest_key').on(table.digest),
  ],
);

export const cloudAgreements = pgTable(
  'cloud_agreements',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    userId: uuid('user_id').notNull(),
    product: text().default('hosted-ai').notNull(),
    priceId: uuid('price_id').notNull(),
    channel: text().notNull(),
    status: text().default('pending').notNull(),
    nextAt: timestamp('next_at', { withTimezone: true, mode: 'string' }),
    scenario: text().default('success').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex('cloud_one_agreement')
      .using(
        'btree',
        table.userId.asc().nullsLast().op('text_ops'),
        table.product.asc().nullsLast().op('text_ops'),
      )
      .where(sql`(status = ANY (ARRAY['pending'::text, 'active'::text, 'canceling'::text]))`),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [cloudUsers.id],
      name: 'cloud_agreements_user_id_fkey',
    }),
    foreignKey({
      columns: [table.priceId],
      foreignColumns: [cloudPrices.id],
      name: 'cloud_agreements_price_id_fkey',
    }),
  ],
);

export const cloudPrices = pgTable('cloud_prices', {
  id: uuid().defaultRandom().primaryKey().notNull(),
  config: jsonb().notNull(),
  published: boolean().default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const cloudPaymentAttempts = pgTable(
  'cloud_payment_attempts',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    orderId: uuid('order_id').notNull(),
    channel: text().notNull(),
    status: text().default('pending').notNull(),
    providerState: text('provider_state').default('pending').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.orderId],
      foreignColumns: [cloudOrders.id],
      name: 'cloud_payment_attempts_order_id_fkey',
    }),
    unique('cloud_payment_attempts_order_id_key').on(table.orderId),
  ],
);

export const cloudOrders = pgTable(
  'cloud_orders',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    userId: uuid('user_id').notNull(),
    priceId: uuid('price_id').notNull(),
    snapshot: jsonb().notNull(),
    channel: text().notNull(),
    key: text().notNull(),
    status: text().default('pending').notNull(),
    agreementId: uuid('agreement_id'),
    cycleAt: timestamp('cycle_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    environment: text().default('test').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [cloudUsers.id],
      name: 'cloud_orders_user_id_fkey',
    }),
    foreignKey({
      columns: [table.priceId],
      foreignColumns: [cloudPrices.id],
      name: 'cloud_orders_price_id_fkey',
    }),
    foreignKey({
      columns: [table.agreementId],
      foreignColumns: [cloudAgreements.id],
      name: 'cloud_orders_agreement_id_fkey',
    }),
    unique('cloud_orders_user_id_key_key').on(table.userId, table.key),
    unique('cloud_orders_agreement_id_cycle_at_key').on(table.agreementId, table.cycleAt),
    check('cloud_orders_environment_check', sql`environment = 'test'::text`),
    check(
      'cloud_order_state',
      sql`status = ANY (ARRAY['pending'::text, 'paid'::text, 'failed'::text, 'canceled'::text, 'closed'::text, 'refunded'::text])`,
    ),
    check(
      'cloud_payment_channel',
      sql`channel = ANY (ARRAY['mock-wechat'::text, 'mock-alipay'::text])`,
    ),
  ],
);

export const cloudPaymentEvents = pgTable(
  'cloud_payment_events',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    key: text().notNull(),
    orderId: uuid('order_id'),
    agreementId: uuid('agreement_id'),
    kind: text().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.orderId],
      foreignColumns: [cloudOrders.id],
      name: 'cloud_payment_events_order_id_fkey',
    }),
    foreignKey({
      columns: [table.agreementId],
      foreignColumns: [cloudAgreements.id],
      name: 'cloud_payment_events_agreement_id_fkey',
    }),
    unique('cloud_payment_events_key_key').on(table.key),
  ],
);

export const cloudCreditPeriods = pgTable(
  'cloud_credit_periods',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    userId: uuid('user_id').notNull(),
    termId: uuid('term_id').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'string' }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'string' }).notNull(),
    allowance: integer().notNull(),
    available: integer().default(0).notNull(),
    reserved: integer().default(0).notNull(),
    state: text().default('scheduled').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [cloudUsers.id],
      name: 'cloud_credit_periods_user_id_fkey',
    }),
    foreignKey({
      columns: [table.termId],
      foreignColumns: [cloudTerms.id],
      name: 'cloud_credit_periods_term_id_fkey',
    }),
    unique('cloud_credit_periods_term_id_starts_at_key').on(table.termId, table.startsAt),
    check('cloud_credit_periods_allowance_check', sql`allowance > 0`),
    check('cloud_credit_periods_available_check', sql`available >= 0`),
    check('cloud_credit_periods_reserved_check', sql`reserved >= 0`),
    check(
      'cloud_period_state',
      sql`state = ANY (ARRAY['scheduled'::text, 'active'::text, 'expired'::text, 'revoked'::text])`,
    ),
  ],
);

export const cloudAiRequests = pgTable(
  'cloud_ai_requests',
  {
    id: uuid().primaryKey().notNull(),
    userId: uuid('user_id').notNull(),
    deviceId: uuid('device_id'),
    turnId: text('turn_id').notNull(),
    fingerprint: text().notNull(),
    modelId: uuid('model_id').notNull(),
    rateSnapshot: jsonb('rate_snapshot').notNull(),
    periodId: uuid('period_id').notNull(),
    reserved: integer().notNull(),
    status: text().notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    cost: integer(),
    cancelRequested: boolean('cancel_requested').default(false).notNull(),
    upstreamId: text('upstream_id'),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
    environment: text().default('test').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [cloudUsers.id],
      name: 'cloud_ai_requests_user_id_fkey',
    }),
    foreignKey({
      columns: [table.deviceId],
      foreignColumns: [cloudDevices.id],
      name: 'cloud_ai_requests_device_id_fkey',
    }),
    foreignKey({
      columns: [table.modelId],
      foreignColumns: [cloudModels.id],
      name: 'cloud_ai_requests_model_id_fkey',
    }),
    foreignKey({
      columns: [table.periodId],
      foreignColumns: [cloudCreditPeriods.id],
      name: 'cloud_ai_requests_period_id_fkey',
    }),
    check('cloud_ai_requests_reserved_check', sql`reserved >= 0`),
    check('cloud_ai_requests_environment_check', sql`environment = 'test'::text`),
    check(
      'cloud_request_state',
      sql`status = ANY (ARRAY['reserved'::text, 'calling'::text, 'settled'::text, 'released'::text, 'review'::text])`,
    ),
  ],
);

export const cloudModels = pgTable('cloud_models', {
  id: uuid().defaultRandom().primaryKey().notNull(),
  config: jsonb().notNull(),
  testedAt: timestamp('tested_at', { withTimezone: true, mode: 'string' }),
  enabled: boolean().default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const cloudTerms = pgTable(
  'cloud_terms',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    userId: uuid('user_id').notNull(),
    orderId: uuid('order_id').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true, mode: 'string' }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true, mode: 'string' }).notNull(),
    anchor: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    anchorOffset: integer('anchor_offset').default(0).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    months: integer().default(1).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [cloudUsers.id],
      name: 'cloud_terms_user_id_fkey',
    }),
    foreignKey({
      columns: [table.orderId],
      foreignColumns: [cloudOrders.id],
      name: 'cloud_terms_order_id_fkey',
    }),
    unique('cloud_terms_order_id_key').on(table.orderId),
    check('cloud_terms_check', sql`ends_at > starts_at`),
    check('cloud_terms_months_check', sql`months = ANY (ARRAY[1, 12])`),
  ],
);

export const cloudCreditLedger = pgTable(
  'cloud_credit_ledger',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    userId: uuid('user_id').notNull(),
    periodId: uuid('period_id').notNull(),
    kind: text().notNull(),
    amount: integer().notNull(),
    key: text().notNull(),
    requestId: uuid('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [cloudUsers.id],
      name: 'cloud_credit_ledger_user_id_fkey',
    }),
    foreignKey({
      columns: [table.periodId],
      foreignColumns: [cloudCreditPeriods.id],
      name: 'cloud_credit_ledger_period_id_fkey',
    }),
    foreignKey({
      columns: [table.requestId],
      foreignColumns: [cloudAiRequests.id],
      name: 'cloud_credit_ledger_request_id_fkey',
    }),
    unique('cloud_credit_ledger_key_key').on(table.key),
  ],
);

export const cloudRefunds = pgTable(
  'cloud_refunds',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    orderId: uuid('order_id').notNull(),
    status: text().default('pending').notNull(),
    reason: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.orderId],
      foreignColumns: [cloudOrders.id],
      name: 'cloud_refunds_order_id_fkey',
    }),
    unique('cloud_refunds_order_id_key').on(table.orderId),
  ],
);

export const cloudJobs = pgTable(
  'cloud_jobs',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    key: text().notNull(),
    kind: text().notNull(),
    payload: jsonb().notNull(),
    dueAt: timestamp('due_at', { withTimezone: true, mode: 'string' }).notNull(),
    status: text().default('pending').notNull(),
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'string' }),
    attempts: integer().default(0).notNull(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('cloud_jobs_due').using(
      'btree',
      table.status.asc().nullsLast().op('text_ops'),
      table.dueAt.asc().nullsLast().op('text_ops'),
    ),
    unique('cloud_jobs_key_key').on(table.key),
  ],
);

export const cloudAudit = pgTable('cloud_audit', {
  id: uuid().defaultRandom().primaryKey().notNull(),
  actorId: uuid('actor_id'),
  action: text().notNull(),
  resourceId: text('resource_id'),
  detail: jsonb().default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const cloudTestInbox = pgTable(
  'cloud_test_inbox',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    challengeId: uuid('challenge_id').notNull(),
    target: text().notNull(),
    code: text().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.challengeId],
      foreignColumns: [cloudChallenges.id],
      name: 'cloud_test_inbox_challenge_id_fkey',
    }),
  ],
);

export const cloudRateLimits = pgTable('cloud_rate_limits', {
  key: text().primaryKey().notNull(),
  count: integer().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
});

export const cloudRuntimeStatus = pgTable('cloud_runtime_status', {
  key: text().primaryKey().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
});
