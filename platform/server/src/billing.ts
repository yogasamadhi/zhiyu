import type { z } from 'zod';
import { priceInput, type modelInput, type SimulationStatus } from '@zhiyun/cloud-contracts';
import type { Clock, Config } from './config.js';
import { DomainError, requireValue } from './config.js';
import type { Database, Tx } from './db.js';
export type Price = z.infer<typeof priceInput>;
export type Model = z.infer<typeof modelInput>;
// Preserve the original civil date in Asia/Shanghai, including a 29/30/31 day anchor.
export function calendarMonth(anchor: Date, offset: number): Date {
  const local = new Date(anchor.getTime() + 8 * 3600000);
  const y = local.getUTCFullYear(),
    m = local.getUTCMonth() + offset;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      y,
      m,
      Math.min(local.getUTCDate(), last),
      local.getUTCHours(),
      local.getUTCMinutes(),
      local.getUTCSeconds(),
      local.getUTCMilliseconds(),
    ) -
      8 * 3600000,
  );
}
export interface PaymentAdapter {
  channel: 'mock-wechat' | 'mock-alipay';
  confirm(tx: Tx, orderId: string, outcome: 'success' | 'failure' | 'cancel'): Promise<void>;
}
class MockAdapter implements PaymentAdapter {
  constructor(readonly channel: 'mock-wechat' | 'mock-alipay') {}
  async confirm(tx: Tx, orderId: string, outcome: 'success' | 'failure' | 'cancel') {
    await tx`update cloud_payment_attempts set provider_state=${outcome} where order_id=${orderId} and channel=${this.channel} and provider_state<>'success'`;
  }
}
export class Billing {
  readonly adapters = {
    'mock-wechat': new MockAdapter('mock-wechat'),
    'mock-alipay': new MockAdapter('mock-alipay'),
  };
  constructor(
    readonly db: Database,
    readonly config: Config,
    readonly clock: Clock,
  ) {}
  simulationOnly() {
    if (this.config.NODE_ENV === 'production' || this.config.CLOUD_MOCK_PAYMENTS !== 'true')
      throw new DomainError('SIMULATION_DISABLED', 403);
  }
  async audit(
    tx: Tx,
    actor: string | null,
    action: string,
    resource: string | null,
    detail: Record<string, unknown> = {},
  ) {
    await tx`insert into cloud_audit(actor_id,action,resource_id,detail) values (${actor},${action},${resource},${tx.json(detail as never)})`;
  }
  async ledger(
    tx: Tx,
    userId: string,
    periodId: string,
    kind: string,
    amount: number,
    key: string,
    requestId: string | null = null,
  ) {
    await tx`insert into cloud_credit_ledger(user_id,period_id,kind,amount,key,request_id,created_at) values (${userId},${periodId},${kind},${amount},${key},${requestId},${this.clock.now()})`;
  }
  async enqueue(
    tx: Tx,
    key: string,
    kind: string,
    payload: Record<string, unknown>,
    due = this.clock.now(),
  ) {
    await tx`insert into cloud_jobs(key,kind,payload,due_at) values (${key},${kind},${tx.json(payload as never)},${due}) on conflict(key) do nothing`;
  }
  async order(
    userId: string,
    priceId: string,
    channel: 'mock-wechat' | 'mock-alipay',
    key: string,
    agreementId: string | null = null,
    cycleAt: Date | null = null,
  ) {
    this.simulationOnly();
    return this.db.sql.begin(async (tx) => {
      await tx`select id from cloud_users where id=${userId} for no key update`;
      const [old] = await tx`select * from cloud_orders where user_id=${userId} and key=${key}`;
      if (old) {
        if (old.price_id !== priceId || old.channel !== channel)
          throw new DomainError('IDEMPOTENCY_MISMATCH');
        return old;
      }
      const price = requireValue(
        (await tx`select * from cloud_prices where id=${priceId} and published=true`)[0],
        'PRICE_NOT_AVAILABLE',
      );
      const snapshot = priceInput.parse(price.config);
      // Publishing does not keep a disabled model purchasable.
      const configured =
        await tx`select id from cloud_models where id in ${tx(snapshot.modelIds)} and enabled=true and tested_at is not null`;
      if (configured.length !== snapshot.modelIds.length)
        throw new DomainError('CATALOG_INCOMPLETE');
      const [row] =
        await tx`insert into cloud_orders(user_id,price_id,snapshot,channel,key,agreement_id,cycle_at,created_at) values (${userId},${priceId},${tx.json(snapshot)},${channel},${key},${agreementId},${cycleAt},${this.clock.now()}) returning *`;
      await tx`insert into cloud_payment_attempts(order_id,channel) values (${row!.id},${channel})`;
      await this.enqueue(
        tx,
        `close:${row!.id}`,
        'close',
        { orderId: row!.id },
        new Date(this.clock.now().getTime() + 1800000),
      );
      return row!;
    });
  }
  async simulate(userId: string | null, orderId: string, scenario: SimulationStatus) {
    this.simulationOnly();
    await this.db.sql.begin(async (tx) => {
      const o = requireValue(
        (await tx`select * from cloud_orders where id=${orderId} for update`)[0],
      );
      if (userId && o.user_id !== userId) throw new DomainError('NOT_FOUND', 404);
      const outcome =
        scenario === 'failure' ? 'failure' : scenario === 'cancel' ? 'cancel' : 'success';
      await this.adapters[o.channel as keyof typeof this.adapters].confirm(tx, orderId, outcome);
      if (scenario === 'unknown') {
        await tx`update cloud_payment_attempts set status='unknown' where order_id=${orderId}`;
        await this.enqueue(
          tx,
          `query:${orderId}`,
          'query',
          { orderId },
          new Date(this.clock.now().getTime() + 60000),
        );
        return;
      }
      if (scenario === 'out-of-order')
        await this.enqueue(tx, `event:${orderId}:failure:early`, 'payment', {
          orderId,
          kind: 'failure',
          key: `${orderId}:failure:early`,
        });
      await this.enqueue(
        tx,
        `event:${orderId}:${outcome}`,
        'payment',
        { orderId, kind: outcome, key: `${orderId}:${outcome}` },
        new Date(this.clock.now().getTime() + (scenario === 'delay' ? 60000 : 0)),
      );
      if (scenario === 'duplicate')
        await this.enqueue(tx, `duplicate:${orderId}`, 'payment', {
          orderId,
          kind: outcome,
          key: `${orderId}:${outcome}`,
        });
      await this.audit(tx, userId, 'simulation.payment', orderId, { scenario });
    });
  }
  async event(orderId: string, kind: string, key: string) {
    this.simulationOnly();
    await this.db.sql.begin(async (tx) => {
      const order = requireValue(
        (await tx`select * from cloud_orders where id=${orderId} for update`)[0],
      );
      const inserted =
        await tx`insert into cloud_payment_events(key,order_id,kind) values (${key},${orderId},${kind}) on conflict(key) do nothing returning id`;
      if (!inserted.length) return;
      if (kind === 'success') {
        const attempt = requireValue(
          (await tx`select * from cloud_payment_attempts where order_id=${orderId} for update`)[0],
        );
        if (attempt.provider_state !== 'success') throw new DomainError('PAYMENT_NOT_CONFIRMED');
        if (order.status !== 'paid' && order.status !== 'refunded') {
          // A settled provider fact wins over a locally closed order; fulfillment stays unique.
          await tx`update cloud_orders set status='paid' where id=${orderId}`;
          await tx`update cloud_payment_attempts set status='success' where order_id=${orderId}`;
          await this.fulfill(tx, {
            id: order.id as string,
            user_id: order.user_id as string,
            snapshot: order.snapshot as unknown,
            agreement_id: order.agreement_id as string | null,
          });
        }
      } else if (order.status !== 'paid' && order.status !== 'refunded') {
        await tx`update cloud_orders set status=${kind === 'failure' ? 'failed' : 'canceled'} where id=${orderId}`;
      }
      await tx`update cloud_payment_events set processed_at=${this.clock.now()} where id=${inserted[0]!.id}`;
    });
  }
  private async fulfill(
    tx: Tx,
    order: { id: string; user_id: string; snapshot: unknown; agreement_id?: string | null },
  ) {
    const userId = order.user_id as string;
    await tx`select id from cloud_users where id=${userId} for no key update`;
    if ((await tx`select 1 from cloud_terms where order_id=${order.id}`).length) return;
    const p = priceInput.parse(order.snapshot),
      now = this.clock.now();
    const [last] =
      await tx`select * from cloud_terms where user_id=${userId} and revoked_at is null order by ends_at desc limit 1`;
    const continuous = last && last.ends_at > now;
    const anchor = continuous ? (last.anchor as Date) : now;
    const offset = continuous ? Number(last.anchor_offset) + Number(last.months) : 0;
    // Persist the month's index explicitly; calendar clamping never becomes the next anchor.
    const start = continuous ? (last.ends_at as Date) : now;
    const months = p.cycle === 'year' ? 12 : 1,
      end = calendarMonth(anchor, offset + months);
    const [term] =
      await tx`insert into cloud_terms(user_id,order_id,starts_at,ends_at,anchor,anchor_offset,months) values (${userId},${order.id},${start},${end},${anchor},${offset},${months}) returning id`;
    for (let i = 0; i < months; i++) {
      const a = i === 0 ? start : calendarMonth(anchor, offset + i),
        b = calendarMonth(anchor, offset + i + 1);
      await tx`insert into cloud_credit_periods(user_id,term_id,starts_at,ends_at,allowance) values (${userId},${term!.id},${a},${b},${p.credits})`;
    }
    if (order.agreement_id)
      await tx`update cloud_agreements set next_at=${end} where id=${order.agreement_id} and status='active'`;
    await this.syncCredits(tx, userId);
  }
  async syncCredits(tx: Tx, userId?: string) {
    const periods =
      await tx`select p.* from cloud_credit_periods p join cloud_terms t on t.id=p.term_id where (${userId ?? null}::uuid is null or p.user_id=${userId ?? null}) and p.state in ('scheduled','active') and (p.starts_at<=${this.clock.now()} or t.revoked_at is not null) order by p.id for update of p`;
    for (const p of periods) {
      if (p.ends_at <= this.clock.now()) {
        if (p.available)
          await this.ledger(tx, p.user_id, p.id, 'expire', -p.available, `expire:${p.id}`);
        await tx`update cloud_credit_periods set state='expired',available=0 where id=${p.id}`;
      } else if (p.state === 'scheduled') {
        await tx`update cloud_credit_periods set state='active',available=allowance where id=${p.id}`;
        await this.ledger(tx, p.user_id, p.id, 'grant', p.allowance, `grant:${p.id}`);
      }
    }
  }
  async refund(actor: string, orderId: string, reason: string) {
    this.simulationOnly();
    return this.db.sql.begin(async (tx) => {
      const o = requireValue(
        (await tx`select * from cloud_orders where id=${orderId} for update`)[0],
      );
      if (o.status !== 'paid') throw new DomainError('ORDER_NOT_PAID');
      const [refund] =
        await tx`insert into cloud_refunds(order_id,reason) values (${orderId},${reason}) on conflict(order_id) do update set order_id=excluded.order_id returning *`;
      await this.audit(tx, actor, 'refund.request', orderId, { reason });
      return refund!;
    });
  }
  async confirmRefund(orderId: string) {
    this.simulationOnly();
    await this.db.sql.begin(async (tx) => {
      const r = requireValue(
        (await tx`select * from cloud_refunds where order_id=${orderId} for update`)[0],
      );
      if (r.status === 'confirmed') return;
      const o = requireValue(
        (await tx`select * from cloud_orders where id=${orderId} for update`)[0],
      );
      await tx`select id from cloud_users where id=${o.user_id} for no key update`;
      await tx`update cloud_refunds set status='confirmed' where id=${r.id}`;
      await tx`update cloud_orders set status='refunded' where id=${orderId}`;
      await tx`update cloud_terms set revoked_at=${this.clock.now()} where order_id=${orderId}`;
      const periods =
        await tx`select p.* from cloud_credit_periods p join cloud_terms t on t.id=p.term_id where t.order_id=${orderId} for update of p`;
      for (const p of periods) {
        await this.ledger(tx, p.user_id, p.id, 'refund', -p.available, `refund:${p.id}`);
        await tx`update cloud_credit_periods set state='revoked',available=0 where id=${p.id}`;
      }
      await tx`insert into cloud_payment_events(key,order_id,kind,processed_at) values (${`refund:${orderId}`},${orderId},'refund',${this.clock.now()}) on conflict do nothing`;
    });
  }
  async agreement(userId: string, priceId: string, channel: string) {
    this.simulationOnly();
    return this.db.sql.begin(async (tx) => {
      await tx`select id from cloud_users where id=${userId} for no key update`;
      requireValue(
        (await tx`select id from cloud_prices where id=${priceId} and published=true`)[0],
      );
      if (
        (
          await tx`select 1 from cloud_agreements where user_id=${userId} and status in ('active','pending','canceling')`
        ).length
      )
        throw new DomainError('END_OLD_AGREEMENT_FIRST');
      const [r] =
        await tx`insert into cloud_agreements(user_id,price_id,channel) values (${userId},${priceId},${channel}) returning *`;
      return r!;
    });
  }
  async agreementEvent(userId: string | null, id: string, kind: 'sign' | 'cancel') {
    this.simulationOnly();
    await this.db.sql.begin(async (tx) => {
      const a = requireValue(
        (await tx`select * from cloud_agreements where id=${id} for update`)[0],
      );
      if (userId && a.user_id !== userId) throw new DomainError('NOT_FOUND', 404);
      if (kind === 'sign' && a.status === 'pending') {
        const [term] =
          await tx`select ends_at from cloud_terms where user_id=${a.user_id} and revoked_at is null and ends_at>${this.clock.now()} order by ends_at desc limit 1`;
        await tx`update cloud_agreements set status='active',next_at=${term?.ends_at ?? this.clock.now()} where id=${id}`;
      }
      if (kind === 'cancel') await tx`update cloud_agreements set status='canceled' where id=${id}`;
      await tx`insert into cloud_payment_events(key,agreement_id,kind,processed_at) values (${`${id}:${kind}`},${id},${kind},${this.clock.now()}) on conflict do nothing`;
      await this.audit(tx, userId, `agreement.${kind}`, id);
    });
  }
  async adjust(actor: string, periodId: string, amount: number, key: string, reason: string) {
    return this.db.sql.begin(async (tx) => {
      const p = requireValue(
        (await tx`select * from cloud_credit_periods where id=${periodId} for update`)[0],
      );
      if ((await tx`select 1 from cloud_credit_ledger where key=${`adjust:${key}`}`).length) return;
      if (p.state !== 'active' || p.ends_at <= this.clock.now() || p.available + amount < 0)
        throw new DomainError('INVALID_ADJUSTMENT');
      await tx`update cloud_credit_periods set available=available+${amount} where id=${periodId}`;
      await this.ledger(tx, p.user_id, periodId, 'adjust', amount, `adjust:${key}`);
      await this.audit(tx, actor, 'credits.adjust', periodId, { amount, reason });
    });
  }
}
