import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CloudListPath, CloudListQuery, CloudListPage } from '@zhiyun/cloud-contracts';
import { DomainError } from './config.js';
import type { Database } from './db.js';

interface Definition {
  table: string;
  projection?: string | undefined;
  sort: string;
  status?: string | undefined;
  user?: string | undefined;
  roles: string[];
}
const revoked = "CASE WHEN r.revoked_at IS NULL THEN 'unrevoked' ELSE 'revoked' END";
const own = (
  table: string,
  sort = 'created_at',
  status?: string,
  projection?: string,
): Definition => ({ table, sort, status, projection, user: 'r.user_id', roles: [] });
const admin = (
  table: string,
  roles: string[],
  status?: string,
  sort = 'created_at',
  user?: string,
  projection?: string,
): Definition => ({ table, roles, status, sort, user, projection });
export const cloudLists: Record<CloudListPath, Definition> = {
  '/me/orders': own('cloud_orders', 'created_at', 'r.status'),
  '/me/credits': own('cloud_credit_ledger', 'created_at', 'r.kind'),
  '/me/periods': own('cloud_credit_periods', 'starts_at', 'r.state'),
  '/me/devices': own('cloud_devices', 'created_at', revoked),
  '/me/sessions': own(
    'cloud_sessions',
    'created_at',
    revoked,
    'id,device_id,created_at,expires_at,revoked_at',
  ),
  '/me/usage': own(
    'cloud_ai_requests',
    'created_at',
    'r.status',
    'id,turn_id,model_id,status,input_tokens,output_tokens,cost,created_at',
  ),
  '/admin/users': admin('cloud_users', ['owner', 'support'], 'r.status'),
  '/admin/prices': admin(
    'cloud_prices',
    ['owner', 'finance', 'operator'],
    "CASE WHEN r.published THEN 'published' ELSE 'draft' END",
  ),
  '/admin/models': admin(
    'cloud_models',
    ['owner', 'operator'],
    "CASE WHEN r.enabled THEN 'enabled' ELSE 'disabled' END",
  ),
  '/admin/subscriptions': admin(
    'cloud_terms',
    ['owner', 'finance', 'support'],
    revoked,
    'starts_at',
    'r.user_id',
  ),
  '/admin/orders': admin(
    'cloud_orders',
    ['owner', 'finance', 'support'],
    'r.status',
    'created_at',
    'r.user_id',
  ),
  '/admin/refunds': admin(
    'cloud_refunds',
    ['owner', 'finance'],
    'r.status',
    'created_at',
    '(SELECT o.user_id FROM cloud_orders o WHERE o.id=r.order_id)',
  ),
  '/admin/credits': admin(
    'cloud_credit_ledger',
    ['owner', 'finance', 'support'],
    'r.kind',
    'created_at',
    'r.user_id',
  ),
  '/admin/periods': admin(
    'cloud_credit_periods',
    ['owner', 'finance'],
    'r.state',
    'starts_at',
    'r.user_id',
  ),
  '/admin/devices': admin(
    'cloud_devices',
    ['owner', 'support'],
    revoked,
    'created_at',
    'r.user_id',
  ),
  '/admin/staff': admin(
    'cloud_staff',
    ['owner'],
    'r.role',
    'email',
    undefined,
    'id,email,role,disabled',
  ),
  '/admin/jobs': admin('cloud_jobs', ['owner', 'operator'], 'r.status'),
  '/admin/audit': admin('cloud_audit', ['owner', 'finance', 'operator', 'support']),
  '/admin/requests': admin(
    'cloud_ai_requests',
    ['owner', 'operator', 'finance'],
    'r.status',
    'created_at',
    'r.user_id',
    'id,user_id,turn_id,model_id,status,reserved,cost,input_tokens,output_tokens,error_code,created_at',
  ),
  '/admin/agreements': admin(
    'cloud_agreements',
    ['owner', 'finance', 'support'],
    'r.status',
    'created_at',
    'r.user_id',
    'id,user_id,price_id,channel,status,next_at,created_at',
  ),
  '/admin/inbox': admin('cloud_test_inbox', ['owner', 'support'], undefined, 'expires_at'),
};

export async function queryCloudList(
  db: Database,
  path: CloudListPath,
  query: CloudListQuery,
  principal: { actorId: string; role: string; userId?: string },
): Promise<CloudListPage<Record<string, unknown>>> {
  const definition = cloudLists[path];
  const scope = createHash('sha256')
    .update(
      JSON.stringify({
        path,
        actorId: principal.actorId,
        role: principal.role,
        ownUserId: principal.userId ?? null,
        q: query.q,
        status: query.status ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
        userId: query.userId ?? null,
      }),
    )
    .digest('hex');
  const values: (string | number)[] = [];
  const bind = (value: string | number) => {
    values.push(value);
    return `$${values.length}`;
  };
  const where: string[] = [];
  if (principal.userId) where.push(`${definition.user}=${bind(principal.userId)}::uuid`);
  if (query.userId) where.push(`${definition.user}=${bind(query.userId)}::uuid`);
  if (query.status) where.push(`${definition.status}=${bind(query.status)}`);
  // Force text parameters before the SQL cast: postgres.js's timestamp codec uses
  // JavaScript Date and would otherwise truncate an inferred timestamptz parameter.
  if (query.from) where.push(`r.${definition.sort}>=${bind(query.from)}::text::timestamptz`);
  if (query.to) where.push(`r.${definition.sort}<=${bind(query.to)}::text::timestamptz`);
  const projection = definition.projection ?? 'r.*';
  // Search only the projected row. Staff/session secrets are never in the search expression.
  if (query.q)
    where.push(
      `(SELECT row_to_json(search_row)::text FROM (SELECT ${projection}) search_row) ILIKE ${bind('%' + query.q.replace(/[\\%_]/g, '\\$&') + '%')} ESCAPE '\\'`,
    );
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor, scope, definition.sort === 'email');
    const sort = bind(cursor.sort),
      id = bind(cursor.id);
    where.push(
      `(r.${definition.sort},r.id)<(${sort}${definition.sort === 'email' ? '' : '::text::timestamptz'},${id}::uuid)`,
    );
  }
  const sortText =
    definition.sort === 'email'
      ? 'r.email'
      : `to_char(r.${definition.sort} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const rows = await db.sql.unsafe<Record<string, unknown>[]>(
    `SELECT ${projection},${sortText} AS "__cursorSort" FROM ${definition.table} r ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.${definition.sort} DESC,r.id DESC LIMIT ${bind(query.limit + 1)}`,
    values,
  );
  const visible = rows.slice(0, query.limit),
    last = visible.at(-1);
  return {
    items: visible.map(({ __cursorSort: _sort, ...row }) => {
      void _sort;
      return row;
    }),
    nextCursor:
      rows.length > query.limit && last
        ? Buffer.from(
            JSON.stringify({ v: 1, scope, sort: last.__cursorSort, id: last.id }),
          ).toString('base64url')
        : null,
  };
}

function decodeCursor(cursor: string, scope: string, text: boolean) {
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new Error();
    const parsed = z
      .object({
        v: z.literal(1),
        scope: z.literal(scope),
        id: z.uuid(),
        sort: text ? z.string().min(1).max(254) : z.iso.datetime(),
      })
      .strict()
      .parse(JSON.parse(bytes.toString('utf8')));
    return parsed;
  } catch {
    throw new DomainError('INVALID_CURSOR', 400);
  }
}
