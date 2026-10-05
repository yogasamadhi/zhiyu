import { z } from 'zod';

export const ownListResources = [
  'orders',
  'credits',
  'periods',
  'devices',
  'sessions',
  'usage',
] as const;
export const adminListResources = [
  'users',
  'prices',
  'models',
  'subscriptions',
  'orders',
  'refunds',
  'credits',
  'periods',
  'devices',
  'staff',
  'jobs',
  'audit',
  'requests',
  'agreements',
  'inbox',
] as const;
export type CloudListPath =
  `/me/${(typeof ownListResources)[number]}` | `/admin/${(typeof adminListResources)[number]}`;
export interface CloudListOptions {
  statuses: readonly string[];
  statusLabel?: string;
  timeLabel?: string;
  userFilter?: boolean;
}
const orders = {
  statuses: ['pending', 'paid', 'failed', 'canceled', 'closed', 'refunded'],
  timeLabel: '创建时间',
};
const credits = {
  statuses: ['grant', 'reserve', 'settle', 'release', 'expire', 'adjust', 'refund'],
  statusLabel: '流水类型',
  timeLabel: '创建时间',
};
const periods = {
  statuses: ['scheduled', 'active', 'expired', 'revoked'],
  timeLabel: '周期开始时间',
};
const revocable = { statuses: ['unrevoked', 'revoked'], timeLabel: '创建时间' };
const requests = {
  statuses: ['reserved', 'calling', 'settled', 'released', 'review'],
  timeLabel: '创建时间',
};
export const cloudListOptions: Record<CloudListPath, CloudListOptions> = {
  '/me/orders': orders,
  '/me/credits': credits,
  '/me/periods': periods,
  '/me/devices': revocable,
  '/me/sessions': revocable,
  '/me/usage': requests,
  '/admin/users': { statuses: ['active', 'disabled'], timeLabel: '创建时间' },
  '/admin/prices': { statuses: ['published', 'draft'], timeLabel: '创建时间' },
  '/admin/models': { statuses: ['enabled', 'disabled'], timeLabel: '创建时间' },
  '/admin/subscriptions': {
    statuses: ['unrevoked', 'revoked'],
    timeLabel: '服务开始时间',
    userFilter: true,
  },
  '/admin/orders': { ...orders, userFilter: true },
  '/admin/refunds': { statuses: ['pending', 'confirmed'], timeLabel: '创建时间', userFilter: true },
  '/admin/credits': { ...credits, userFilter: true },
  '/admin/periods': { ...periods, userFilter: true },
  '/admin/devices': { ...revocable, userFilter: true },
  '/admin/staff': { statuses: ['owner', 'support', 'finance', 'operator'], statusLabel: '角色' },
  '/admin/jobs': { statuses: ['pending', 'running', 'done', 'failed'], timeLabel: '创建时间' },
  '/admin/audit': { statuses: [], timeLabel: '创建时间' },
  '/admin/requests': { ...requests, userFilter: true },
  '/admin/agreements': {
    statuses: ['pending', 'active', 'canceling', 'canceled'],
    timeLabel: '创建时间',
    userFilter: true,
  },
  '/admin/inbox': { statuses: [], timeLabel: '到期时间' },
};

export function isCloudListPath(value: string): value is CloudListPath {
  return Object.hasOwn(cloudListOptions, value);
}

const timestamp = z.iso
  .datetime({ offset: true })
  .refine((value) => !/\.\d{7}/.test(value), 'Use at most six fractional digits');
function timestampMicros(value: string) {
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? '';
  return BigInt(Date.parse(value)) * 1000n + BigInt(fraction.slice(3, 6).padEnd(3, '0'));
}

export function cloudListQuerySchema(path: CloudListPath) {
  const options = cloudListOptions[path];
  const fields = {
    limit: z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/)
      .default('50')
      .transform(Number)
      .pipe(z.number().int().max(100)),
    cursor: z
      .string()
      .min(1)
      .max(4096)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    q: z.string().trim().max(160).default(''),
    ...(options.statuses.length
      ? { status: z.enum(options.statuses as [string, ...string[]]).optional() }
      : {}),
    ...(options.timeLabel
      ? {
          from: timestamp.optional(),
          to: timestamp.optional(),
        }
      : {}),
    ...(options.userFilter ? { userId: z.uuid().optional() } : {}),
  };
  return z
    .object(fields)
    .strict()
    .superRefine((query, context) => {
      if (
        'from' in query &&
        'to' in query &&
        typeof query.from === 'string' &&
        typeof query.to === 'string' &&
        Number.isFinite(Date.parse(query.from)) &&
        Number.isFinite(Date.parse(query.to)) &&
        timestampMicros(query.from) > timestampMicros(query.to)
      )
        context.addIssue({
          code: 'custom',
          path: ['to'],
          message: 'End time must not precede start time',
        });
    });
}

export interface CloudListQuery {
  limit: number;
  q: string;
  cursor?: string;
  status?: string;
  from?: string;
  to?: string;
  userId?: string;
}
export type CloudListInput = Partial<CloudListQuery>;
export interface CloudListPage<T> {
  items: T[];
  nextCursor: string | null;
}
export const cloudListPageSchema = <T extends z.ZodType>(row: T) =>
  z.object({
    items: z.array(row),
    nextCursor: z.string().max(4096).nullable(),
  });
