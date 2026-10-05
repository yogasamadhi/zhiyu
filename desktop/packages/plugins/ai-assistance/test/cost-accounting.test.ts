import { describe, expect, it } from 'vitest';
import { MockAiProvider } from '@zhiyun/ai-runtime';
import {
  continueTurnAccounting,
  trackedAiProvider,
  TurnCostLimitError,
  withTurnAccounting,
} from '../src/application/cost-accounting.js';

describe('turn cost accounting lifecycle', () => {
  it('keeps overlapping turns and their independently resumed jobs within separate budgets', async () => {
    let actualCalls = 0;
    class CountingProvider extends MockAiProvider {
      override async generateSchema(input: Parameters<MockAiProvider['generateSchema']>[0]) {
        actualCalls++;
        return super.generateSchema(input);
      }
    }
    const provider = trackedAiProvider(new CountingProvider());
    const input = { instruction: 'name', sample: '<h2>Fixture</h2>' };
    let enter!: () => void;
    let leave!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const released = new Promise<void>((resolve) => {
      leave = resolve;
    });
    const first = withTurnAccounting(
      'cost-first',
      { maximum: 0.25, perCallEstimate: 0.25, currency: 'CNY' },
      async (ledger) => {
        await provider.generateSchema(input);
        enter();
        await released;
        return ledger.snapshot();
      },
    );
    await entered;
    const second = withTurnAccounting(
      'cost-second',
      { maximum: 1, perCallEstimate: 0.25, currency: 'USD' },
      async (ledger) => {
        await provider.generateSchema(input);
        await provider.generateSchema(input);
        return ledger.snapshot();
      },
    );
    try {
      await expect(
        continueTurnAccounting('cost-first', async () => provider.generateSchema(input)),
      ).rejects.toBeInstanceOf(TurnCostLimitError);
      expect(await second).toMatchObject({
        calls: 2,
        estimatedCost: 0.5,
        budget: { currency: 'USD' },
        stopReason: null,
      });
    } finally {
      leave();
    }
    expect(await first).toMatchObject({
      calls: 1,
      estimatedCost: 0.25,
      budget: { currency: 'CNY' },
      stopReason: 'cost_limit',
    });
    expect(actualCalls).toBe(3);
    expect(() =>
      continueTurnAccounting('cost-first', () => provider.generateSchema(input)),
    ).toThrow('no longer active');
  });

  it('counts a failed provider request and releases its scope before a retry', async () => {
    class FailingProvider extends MockAiProvider {
      override async generateSchema(): Promise<never> {
        throw new Error('Fixture provider failed');
      }
    }
    const provider = trackedAiProvider(new FailingProvider());
    const budget = { maximum: 1, perCallEstimate: 0.25, currency: 'CNY' as const };
    for (let attempt = 0; attempt < 2; attempt++) {
      await withTurnAccounting('cost-retry', budget, async (ledger) => {
        await expect(provider.generateSchema({ instruction: 'name', sample: '' })).rejects.toThrow(
          'Fixture provider failed',
        );
        expect(ledger.snapshot()).toMatchObject({
          calls: 1,
          estimatedCost: 0.25,
          operations: { generateSchema: 1 },
        });
      });
    }
  });

  it('refuses detached provider work after its parent scope has closed', async () => {
    let actualCalls = 0;
    class CountingProvider extends MockAiProvider {
      override async generateSchema(input: Parameters<MockAiProvider['generateSchema']>[0]) {
        actualCalls++;
        return super.generateSchema(input);
      }
    }
    const provider = trackedAiProvider(new CountingProvider());
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let detached!: Promise<unknown>;
    await withTurnAccounting('cost-detached', null, async () => {
      detached = wait.then(() => provider.generateSchema({ instruction: 'name', sample: '' }));
    });
    release();
    await expect(detached).rejects.toBeInstanceOf(TurnCostLimitError);
    expect(actualCalls).toBe(0);
  });
});
