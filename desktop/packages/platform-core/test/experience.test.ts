import { describe, expect, it } from 'vitest';
import { summarizeExperience, type ExperienceEvent } from '../src/experience.js';
describe('local experience cohorts', () => {
  it('does not treat an incomplete seven-day observation window as a failure', () => {
    const now = Date.now();
    const event = (
      id: string,
      correlationId: string,
      type: ExperienceEvent['type'],
      age: number,
    ): ExperienceEvent => ({
      id,
      correlationId,
      type,
      occurredAt: new Date(now - age).toISOString(),
      durationMs: null,
      outcome: 'success',
    });
    const day = 86400000;
    const summary = summarizeExperience(
      [
        event('start-a', 'a', 'creation_started', 10 * day + 3000),
        event('first-a', 'a', 'run_succeeded', 10 * day),
        event('again-a', 'a', 'run_succeeded', 9 * day),
        event('export-a', 'a', 'export_completed', 9 * day),
        event('start-b', 'b', 'creation_started', day + 1000),
        event('first-b', 'b', 'run_succeeded', day),
      ],
      now,
    );
    expect(summary).toMatchObject({
      firstCompletionRate: 1,
      medianTimeToResultMs: 2000,
      resultUsageRate: 0.5,
      reuseEligible: 1,
      reuseWithin7DaysRate: 1,
    });
    expect(summarizeExperience([], now).reuseWithin7DaysRate).toBeNull();
  });
});
