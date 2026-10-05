import { AsyncLocalStorage } from 'node:async_hooks';
import {
  aiCostAmountSchema,
  aiCostBudgetSchema,
  aiTurnAccountingSchema,
  type AiChatUsage,
  type AiCostAmount,
  type AiCostBudget,
  type AiProvider,
  type AiTurnAccounting,
} from '@zhiyun/contracts';

type Operation = keyof AiTurnAccounting['operations'];
interface Call {
  operation: Operation;
  inputTokens: number | null;
  outputTokens: number | null;
  tokensSource: 'mock' | 'reported' | 'unknown';
  cost: AiCostAmount | null;
  estimatedMicro: number;
}
const scopes = new AsyncLocalStorage<TurnCostLedger>();
const activeTurns = new Map<string, TurnCostLedger>();
const providers = new WeakMap<AiProvider, AiProvider>();
const methods = new Set([
  'streamChat',
  'generateSchema',
  'generateRule',
  'extract',
  'suggestRepair',
  'explainFailure',
  'repairBrowserAction',
]);
const micro = (amount: number) => Math.ceil(amount * 1_000_000);

/** A stopped turn must not be treated as a recoverable provider failure. */
export class TurnCostLimitError extends Error {
  constructor() {
    super('AI estimated cost budget stopped further requests');
  }
}

export class AccountedTurnError extends Error {
  constructor(
    message: string,
    readonly accounting: AiTurnAccounting,
  ) {
    super(message);
  }
}

/** One ledger follows the parent turn across sequential tools and its local queued browser job. */
export class TurnCostLedger {
  private readonly calls: Call[] = [];
  private estimatedMicro = 0;
  private closed = false;
  private lastKind: 'mock' | 'provider' = 'provider';
  private stopReason: AiTurnAccounting['stopReason'] = null;
  readonly budget: AiCostBudget | null;
  constructor(budget: AiCostBudget | null) {
    this.budget = budget ? aiCostBudgetSchema.parse(budget) : null;
  }

  canContinue(): boolean {
    if (this.closed) return false;
    if (!this.budget) return true;
    const limit = Math.floor(this.budget.maximum * 1_000_000);
    const estimate = this.budget.perCallEstimate ?? (this.lastKind === 'mock' ? 0 : null);
    if (this.estimatedMicro >= limit) this.stopReason = 'cost_limit';
    else if (estimate === null) this.stopReason = 'estimate_unavailable';
    else if (this.estimatedMicro + micro(estimate) > limit) this.stopReason = 'cost_limit';
    return this.stopReason === null;
  }
  reserve(kind: 'mock' | 'provider', operation: Operation): Call {
    this.lastKind = kind;
    if (!this.canContinue()) throw new TurnCostLimitError();
    if (this.calls.length >= 256) throw new Error('AI turn accounting call limit exceeded');
    const estimate = this.budget?.perCallEstimate ?? (kind === 'mock' ? 0 : null);
    const call: Call = {
      operation,
      inputTokens: kind === 'mock' ? 0 : null,
      outputTokens: kind === 'mock' ? 0 : null,
      tokensSource: kind === 'mock' ? 'mock' : 'unknown',
      cost:
        kind === 'mock'
          ? { source: 'mock', amount: 0, currency: this.budget?.currency ?? 'CNY' }
          : null,
      estimatedMicro: estimate === null ? 0 : micro(estimate),
    };
    this.estimatedMicro += call.estimatedMicro;
    this.calls.push(call);
    return call;
  }
  observe(call: Call, usage: AiChatUsage): void {
    const source = usage.tokensSource ?? call.tokensSource;
    const valid = [usage.inputTokens, usage.outputTokens].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    );
    call.tokensSource = valid && source !== 'unknown' ? source : 'unknown';
    call.inputTokens = call.tokensSource === 'unknown' ? null : usage.inputTokens;
    call.outputTokens = call.tokensSource === 'unknown' ? null : usage.outputTokens;
    if (usage.cost !== undefined) {
      const parsed = aiCostAmountSchema.safeParse(usage.cost);
      call.cost = parsed.success ? parsed.data : null;
      if (this.budget && call.cost?.source === 'settled') {
        if (call.cost.currency !== this.budget.currency) this.stopReason = 'estimate_unavailable';
        else {
          const actual = micro(call.cost.amount);
          if (actual > call.estimatedMicro) {
            this.estimatedMicro += actual - call.estimatedMicro;
            call.estimatedMicro = actual;
          }
        }
      }
    }
  }
  close() {
    this.closed = true;
  }
  snapshot(): AiTurnAccounting {
    const known =
      this.calls.length > 0 && this.calls.every((call) => call.tokensSource !== 'unknown');
    const sources = new Set(this.calls.map((call) => call.tokensSource));
    const costs = new Map<string, AiCostAmount>();
    const operations: AiTurnAccounting['operations'] = {};
    for (const call of this.calls) {
      operations[call.operation] = (operations[call.operation] ?? 0) + 1;
      if (call.cost) {
        const key = `${call.cost.source}:${call.cost.currency}`;
        const current = costs.get(key);
        costs.set(key, {
          ...call.cost,
          amount: (micro(current?.amount ?? 0) + micro(call.cost.amount)) / 1_000_000,
        });
      }
    }
    return aiTurnAccountingSchema.parse({
      calls: this.calls.length,
      inputTokens: known ? this.calls.reduce((sum, call) => sum + call.inputTokens!, 0) : null,
      outputTokens: known ? this.calls.reduce((sum, call) => sum + call.outputTokens!, 0) : null,
      tokensSource: !known ? 'unknown' : sources.size === 1 ? this.calls[0]!.tokensSource : 'mixed',
      costs: [...costs.values()],
      unknownCostCalls: this.calls.filter((call) => call.cost === null).length,
      estimatedCost: this.budget ? this.estimatedMicro / 1_000_000 : null,
      budget: this.budget,
      stopReason: this.stopReason,
      operations,
    });
  }
}

export async function withTurnAccounting<T>(
  turnId: string,
  budget: AiCostBudget | null,
  run: (ledger: TurnCostLedger) => Promise<T>,
): Promise<T> {
  if (activeTurns.has(turnId)) throw new Error('AI turn accounting scope is already active');
  const ledger = new TurnCostLedger(budget);
  activeTurns.set(turnId, ledger);
  try {
    return await scopes.run(ledger, () => run(ledger));
  } finally {
    ledger.close();
    activeTurns.delete(turnId);
  }
}

export function continueTurnAccounting<T>(turnId: string, run: () => Promise<T>): Promise<T> {
  const ledger = activeTurns.get(turnId);
  if (!ledger) throw new Error('AI turn accounting context is no longer active');
  return scopes.run(ledger, run);
}

/** Preserve provider identity and credentials outside the ledger; account every actual method invocation. */
export function trackedAiProvider(provider: AiProvider): AiProvider {
  const existing = providers.get(provider);
  if (existing) return existing;
  const wrapped = new Proxy(provider, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== 'function') return value;
      if (!methods.has(String(key))) return value.bind(target);
      if (key === 'streamChat')
        return async function* (...args: unknown[]) {
          const ledger = scopes.getStore();
          const call = ledger?.reserve(target.usageKind ?? 'provider', 'chat');
          for await (const event of value.apply(target, args) as ReturnType<
            AiProvider['streamChat']
          >) {
            if (ledger && call && (event.type === 'usage' || event.type === 'done'))
              ledger.observe(call, event.usage);
            yield event;
          }
        };
      return (...args: unknown[]) => {
        const ledger = scopes.getStore();
        ledger?.reserve(target.usageKind ?? 'provider', key as Operation);
        return value.apply(target, args) as Promise<unknown>;
      };
    },
  });
  providers.set(provider, wrapped);
  providers.set(wrapped, wrapped);
  return wrapped;
}
