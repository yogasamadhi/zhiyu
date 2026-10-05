import type { ChatInput } from '@zhiyun/cloud-contracts';
import { modelInput, priceInput } from '@zhiyun/cloud-contracts';
import type { Principal } from './auth.js';
import type { Billing, Model } from './billing.js';
import { DomainError, requireValue } from './config.js';
import { hash } from './security.js';
export const creditCost = (input: number, output: number, model: Model) =>
  Math.ceil((input * model.inputRate + output * model.outputRate) / 1000);
export class AiGateway {
  constructor(
    readonly billing: Billing,
    private readonly testUpstream?: (
      input: ChatInput,
      id: string,
      signal: AbortSignal,
    ) => Promise<Response>,
  ) {}
  async modelTest(id: string) {
    const { db, clock } = this.billing;
    const row = requireValue((await db.sql`select * from cloud_models where id=${id}`)[0]);
    const model = modelInput.parse(row.config);
    if (model.adapter === 'openai-compatible') {
      this.upstream(model);
      const response = await fetch(`${model.baseUrl!.replace(/\/$/, '')}/models`, {
        headers: { authorization: `Bearer ${process.env[model.keyRef!]}` },
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
      const data = (await response.json()) as { data?: { id: string }[] };
      if (!response.ok || !data.data?.some((m) => m.id === model.upstreamModel))
        throw new DomainError('MODEL_TEST_FAILED', 400);
    }
    await db.sql`update cloud_models set tested_at=${clock.now()},enabled=true where id=${id}`;
    return { tested: true };
  }
  private upstream(model: Model) {
    const { config } = this.billing;
    // This release deliberately has no production model pool, including with mock payments off.
    if (config.NODE_ENV === 'production')
      throw new DomainError('PRODUCTION_MODEL_POOL_UNAVAILABLE', 503);
    if (model.adapter === 'mock') return;
    const uri = new URL(model.baseUrl ?? 'http://invalid');
    const allow = config.CLOUD_MODEL_ORIGINS.split(',').filter(Boolean);
    if (
      uri.protocol !== 'https:' ||
      uri.username ||
      uri.password ||
      uri.search ||
      uri.hash ||
      !allow.includes(uri.origin) ||
      !model.keyRef ||
      !process.env[model.keyRef]
    )
      throw new DomainError('UPSTREAM_NOT_ALLOWED', 400);
  }
  async reserve(p: Principal, id: string, turnId: string, input: ChatInput) {
    const { db, clock, config } = this.billing;
    if (!p.userId || !p.deviceId) throw new DomainError('DESKTOP_DEVICE_REQUIRED', 403);
    const fingerprint = hash(JSON.stringify(input));
    return db.sql.begin(async (tx) => {
      await tx`select id from cloud_users where id=${p.userId} for no key update`;
      const [prior] = await tx`select * from cloud_ai_requests where id=${id}`;
      if (prior) {
        if (prior.user_id !== p.userId) throw new DomainError('NOT_FOUND', 404);
        if (prior.fingerprint !== fingerprint || prior.turn_id !== turnId)
          throw new DomainError('IDEMPOTENCY_MISMATCH');
        throw new DomainError(`REQUEST_${String(prior.status).toUpperCase()}`);
      }
      const device = (
        await tx`select id from cloud_devices where id=${p.deviceId} and user_id=${p.userId} and revoked_at is null`
      )[0];
      if (!device) throw new DomainError('DEVICE_REVOKED', 403);
      await this.billing.syncCredits(tx, p.userId!);
      const period = requireValue(
        (
          await tx`select p.*,o.snapshot from cloud_credit_periods p join cloud_terms t on t.id=p.term_id join cloud_orders o on o.id=t.order_id where p.user_id=${p.userId} and p.state='active' and p.starts_at<=${clock.now()} and p.ends_at>${clock.now()} and t.revoked_at is null order by p.starts_at limit 1 for update of p`
        )[0],
        'SUBSCRIPTION_REQUIRED',
      );
      const plan = priceInput.parse(period.snapshot);
      if (!plan.modelIds.includes(input.model)) throw new DomainError('MODEL_NOT_IN_PLAN', 403);
      const model = modelInput.parse(
        requireValue(
          (
            await tx`select config from cloud_models where id=${input.model} and enabled=true and tested_at is not null`
          )[0],
          'MODEL_UNAVAILABLE',
        ).config,
      );
      this.upstream(model);
      const inputBound =
        Buffer.byteLength(JSON.stringify({ messages: input.messages, tools: input.tools ?? [] })) +
        input.messages.length * 64 +
        256;
      const outputBound = input.max_tokens ?? model.maxOutput;
      if (inputBound + outputBound > model.maxContext || outputBound > model.maxOutput)
        throw new DomainError('CONTEXT_LIMIT', 400);
      const amount = creditCost(inputBound, outputBound, model);
      if (period.available < amount) throw new DomainError('INSUFFICIENT_CREDITS', 402);
      const [active] =
        await tx`select count(*)::int as n from cloud_ai_requests where user_id=${p.userId} and status in ('reserved','calling')`;
      if (active!.n >= 2) throw new DomainError('CONCURRENCY_LIMIT', 429);
      await tx`select pg_advisory_xact_lock(947153)`;
      const day = new Date(clock.now());
      day.setUTCHours(0, 0, 0, 0);
      const [budget] =
        await tx`select coalesce(sum(case when status='settled' then input_tokens+output_tokens when status='released' then 0 else (rate_snapshot->>'tokenBound')::int end),0)::int as used from cloud_ai_requests where created_at>=${day}`;
      if (budget!.used + inputBound + outputBound > config.CLOUD_DAILY_TOKEN_BUDGET)
        throw new DomainError('SYSTEM_BUDGET', 429);
      await tx`insert into cloud_ai_requests(id,user_id,device_id,turn_id,fingerprint,model_id,rate_snapshot,period_id,reserved,status,created_at,updated_at) values (${id},${p.userId},${p.deviceId},${turnId},${fingerprint},${input.model},${tx.json({ ...model, tokenBound: inputBound + outputBound, inputBound, outputBound })},${period.id},${amount},'reserved',${clock.now()},${clock.now()})`;
      await tx`update cloud_credit_periods set available=available-${amount},reserved=reserved+${amount} where id=${period.id}`;
      await this.billing.ledger(tx, p.userId!, period.id, 'reserve', -amount, `reserve:${id}`, id);
      return model;
    });
  }
  async settle(
    id: string,
    usage: { prompt_tokens: number; completion_tokens: number } | null,
    release = false,
    audit?: { actorId: string; reason: string },
  ) {
    const { db, clock } = this.billing;
    await db.sql.begin(async (tx) => {
      const r = requireValue(
        (await tx`select * from cloud_ai_requests where id=${id} for update`)[0],
      );
      if (audit && r.status !== 'review') throw new DomainError('NOT_IN_REVIEW');
      if (['settled', 'released'].includes(r.status)) return;
      if (!usage && !release) {
        await tx`update cloud_ai_requests set status='review',error_code='USAGE_UNKNOWN',updated_at=${clock.now()} where id=${id}`;
        return;
      }
      const config = modelInput.parse(r.rate_snapshot);
      const cost = release ? 0 : creditCost(usage!.prompt_tokens, usage!.completion_tokens, config);
      if (
        !Number.isSafeInteger(cost) ||
        cost < 0 ||
        cost > r.reserved ||
        (usage &&
          (usage.prompt_tokens < 0 ||
            usage.completion_tokens < 0 ||
            !Number.isSafeInteger(usage.prompt_tokens) ||
            !Number.isSafeInteger(usage.completion_tokens)))
      ) {
        await tx`update cloud_ai_requests set status='review',error_code='INVALID_UPSTREAM_USAGE',updated_at=${clock.now()} where id=${id}`;
        return;
      }
      const p = requireValue(
        (await tx`select * from cloud_credit_periods where id=${r.period_id} for update`)[0],
      );
      const refund = r.reserved - cost;
      const usable = p.state === 'active' && p.ends_at > clock.now();
      await tx`update cloud_credit_periods set reserved=reserved-${r.reserved},available=available+${usable ? refund : 0} where id=${p.id}`;
      await this.billing.ledger(
        tx,
        r.user_id,
        p.id,
        release ? 'release' : 'settle',
        refund,
        `${release ? 'release' : 'settle'}:${id}`,
        id,
      );
      if (!usable && refund)
        await this.billing.ledger(
          tx,
          r.user_id,
          p.id,
          p.state === 'revoked' ? 'refund' : 'expire',
          -refund,
          `unused:${id}`,
          id,
        );
      await tx`update cloud_ai_requests set status=${release ? 'released' : 'settled'},cost=${cost},input_tokens=${usage?.prompt_tokens ?? 0},output_tokens=${usage?.completion_tokens ?? 0},updated_at=${clock.now()} where id=${id}`;
      if (audit)
        await this.billing.audit(tx, audit.actorId, 'request.compensate', id, {
          reason: audit.reason,
        });
    });
  }
  async call(
    p: Principal,
    id: string,
    turnId: string,
    input: ChatInput,
    clientSignal: AbortSignal,
  ): Promise<Response> {
    const model = await this.reserve(p, id, turnId, input);
    const { db, clock } = this.billing;
    if (clientSignal.aborted) {
      await this.settle(id, null, true);
      throw new DomainError('REQUEST_CANCELED', 409);
    }
    await db.sql`update cloud_ai_requests set status='calling',updated_at=${clock.now()} where id=${id}`;
    const abort = new AbortController();
    const signal = AbortSignal.any([clientSignal, abort.signal, AbortSignal.timeout(90000)]);
    const monitor = setInterval(() => {
      void db.sql`select r.cancel_requested,d.revoked_at from cloud_ai_requests r join cloud_devices d on d.id=r.device_id where r.id=${id}`
        .then(([r]) => {
          if (r?.cancel_requested || r?.revoked_at) abort.abort();
        })
        .catch(() => abort.abort());
    }, 1000);
    let upstream: Response;
    try {
      if (this.testUpstream && this.billing.config.NODE_ENV === 'test')
        upstream = await this.testUpstream(input, id, signal);
      else if (model.adapter === 'mock') {
        const text = '这是织云托管 AI 的模拟响应。工具会继续在桌面端执行。';
        const usage = {
          prompt_tokens: Math.ceil(JSON.stringify(input.messages).length / 3),
          completion_tokens: 24,
        };
        const message = {
          role: 'assistant',
          content: input.response_format ? JSON.stringify({ explanation: text }) : text,
        };
        upstream = new Response(
          input.stream
            ? `data: ${JSON.stringify({ id, choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\ndata: [DONE]\n\n`
            : JSON.stringify({ id, choices: [{ message, finish_reason: 'stop' }], usage }),
          { headers: { 'content-type': input.stream ? 'text/event-stream' : 'application/json' } },
        );
      } else
        upstream = await fetch(`${model.baseUrl!.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${process.env[model.keyRef!]}`,
            'content-type': 'application/json',
            'x-request-id': id,
          },
          body: JSON.stringify({
            ...input,
            model: model.upstreamModel,
            max_tokens: input.max_tokens ?? model.maxOutput,
            ...(input.stream ? { stream_options: { include_usage: true } } : {}),
          }),
          signal,
          redirect: 'error',
        });
      if (!upstream.ok) {
        clearInterval(monitor);
        // Even an upstream error may follow completed work. Keep the reservation for review.
        await upstream.body?.cancel();
        await this.settle(id, null);
        throw new DomainError('UPSTREAM_UNCERTAIN', 502);
      }
    } catch (error) {
      clearInterval(monitor);
      await this.settle(id, null);
      throw error;
    }
    const settle = (usage: { prompt_tokens: number; completion_tokens: number } | null) =>
      this.settle(id, usage);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let usage: { prompt_tokens: number; completion_tokens: number } | null = null;
        let buffer = '',
          bytes = 0;
        const reader = upstream.body!.getReader(),
          decoder = new TextDecoder();
        try {
          while (true) {
            signal.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 4 * 1024 * 1024) throw new Error('RESPONSE_LIMIT');
            buffer += decoder.decode(value, { stream: true });
            if (input.stream) {
              const lines = buffer.split('\n');
              buffer = lines.pop()!;
              for (const line of lines)
                if (line.startsWith('data: ') && line.trim() !== 'data: [DONE]') {
                  const event = JSON.parse(line.slice(6)) as {
                    usage?: { prompt_tokens: number; completion_tokens: number };
                  };
                  if (event.usage) usage = event.usage;
                }
            }
            controller.enqueue(value);
          }
          if (!input.stream) usage = (JSON.parse(buffer) as { usage?: typeof usage }).usage ?? null;
          await settle(usage);
          controller.close();
        } catch {
          await settle(null);
          try {
            controller.error(new Error('AI_REQUEST_REQUIRES_REVIEW'));
          } catch {
            /* disconnected */
          }
        } finally {
          clearInterval(monitor);
          await reader.cancel().catch(() => undefined);
        }
      },
      cancel() {
        abort.abort();
      },
    });
    return new Response(stream, {
      headers: {
        'content-type': input.stream ? 'text/event-stream' : 'application/json',
        'cache-control': 'no-store',
        'x-request-id': id,
        'x-accel-buffering': 'no',
      },
    });
  }
}
