import type { Billing } from './billing.js';
export class Worker {
  constructor(readonly billing: Billing) {}
  async tick() {
    const { db, clock } = this.billing;
    await db.sql`insert into cloud_runtime_status(key,updated_at) values ('worker',${clock.now()}) on conflict(key) do update set updated_at=excluded.updated_at`;
    await db.sql.begin((tx) => this.billing.syncCredits(tx));
    // A crash after dispatch leaves an uncertain call. It is never automatically re-dispatched.
    await db.sql`update cloud_ai_requests set status='review',error_code='WORKER_RECOVERY',updated_at=${clock.now()} where status in ('calling','reserved') and updated_at<${new Date(clock.now().getTime() - 120000)}`;
    if (
      this.billing.config.NODE_ENV === 'production' ||
      this.billing.config.CLOUD_MOCK_PAYMENTS !== 'true'
    )
      return;
    const agreements =
      await db.sql`select * from cloud_agreements where status='active' and next_at<=${clock.now()}`;
    for (const a of agreements) {
      // Duplicate worker passes share the same durable intent. Cancellation is checked at dispatch.
      await db.sql.begin(async (tx) => {
        const [locked] = await tx`select * from cloud_agreements where id=${a.id} for update`;
        if (locked?.status !== 'active' || locked.next_at > clock.now()) return;
        await this.billing.enqueue(tx, `debit:${a.id}:${a.next_at.toISOString()}`, 'debit', {
          agreementId: a.id,
          cycleAt: a.next_at.toISOString(),
        });
      });
    }
    for (let i = 0; i < 100; i++) {
      const job = await db.sql.begin(async (tx) => {
        const [j] =
          await tx`select * from cloud_jobs where (status='pending' or (status='running' and locked_until<${clock.now()})) and due_at<=${clock.now()} order by due_at,id limit 1 for update skip locked`;
        if (!j) return null;
        await tx`update cloud_jobs set status='running',locked_until=${new Date(clock.now().getTime() + 30000)},attempts=attempts+1 where id=${j.id}`;
        return j;
      });
      if (!job) break;
      try {
        const payload = job.payload as {
          orderId: string;
          kind: string;
          key: string;
          agreementId: string;
          cycleAt: string;
        };
        if (job.kind === 'payment')
          await this.billing.event(payload.orderId, payload.kind, payload.key);
        if (job.kind === 'refund') await this.billing.confirmRefund(payload.orderId);
        if (job.kind === 'close' || job.kind === 'query') {
          const [attempt] =
            await db.sql`select * from cloud_payment_attempts where order_id=${payload.orderId}`;
          if (attempt?.provider_state === 'success')
            await this.billing.event(
              payload.orderId,
              'success',
              `query:${payload.orderId}:success`,
            );
          else if (job.kind === 'close')
            await db.sql`update cloud_orders set status='closed' where id=${payload.orderId} and status='pending'`;
        }
        if (job.kind === 'debit') {
          // Advisory lock serializes cancellation and dispatch across API and worker processes.
          await db.sql.begin(async (tx) => {
            await tx`select pg_advisory_xact_lock(hashtext(${payload.agreementId}))`;
            const [a] = await tx`select * from cloud_agreements where id=${payload.agreementId}`;
            if (a?.status !== 'active') return;
            const order = await this.billing.order(
              a.user_id,
              a.price_id,
              a.channel,
              `debit:${a.id}:${payload.cycleAt}`,
              a.id,
              new Date(payload.cycleAt),
            );
            if (order.status === 'pending') await this.billing.simulate(null, order.id, a.scenario);
          });
        }
        await db.sql`update cloud_jobs set status='done',locked_until=null,last_error=null where id=${job.id}`;
      } catch (error) {
        await db.sql`update cloud_jobs set status=${job.attempts >= 7 ? 'failed' : 'pending'},due_at=${new Date(clock.now().getTime() + Math.min(3600000, 1000 * 2 ** job.attempts))},locked_until=null,last_error=${error instanceof Error ? error.name : 'Error'} where id=${job.id}`;
      }
    }
    await db.sql`delete from cloud_test_inbox where expires_at<=${clock.now()}`;
    await db.sql`delete from cloud_rate_limits where expires_at<=${clock.now()}`;
  }
}
