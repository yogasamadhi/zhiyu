import { describe, expect, it } from 'vitest';
import { scheduleSchema, validateFiveFieldCron } from '@zhiyun/shared';
import { previewSchedule } from '../src/application/index.js';

describe('schedule preview', () => {
  it('returns five increasing executions using the configured timezone', () => {
    const runs = previewSchedule(
      {
        mode: 'cron',
        cron: '0 8 * * *',
        timezone: 'Asia/Shanghai',
        misfirePolicy: 'skip',
      },
      5,
      new Date('2026-08-31T00:30:00.000Z'),
    );
    expect(runs).toHaveLength(5);
    expect(runs[0]).toBe('2026-09-01T00:00:00.000Z');
    expect(runs.map(Date.parse)).toEqual([...runs.map(Date.parse)].sort((a, b) => a - b));
  });

  it('reflects the daylight-saving offset transition in future executions', () => {
    const runs = previewSchedule(
      {
        mode: 'cron',
        cron: '30 2 * * *',
        timezone: 'America/New_York',
        misfirePolicy: 'run-once',
      },
      5,
      new Date('2026-03-07T00:00:00.000Z'),
    );
    expect(runs.slice(0, 3)).toEqual([
      '2026-03-07T07:30:00.000Z',
      '2026-03-08T07:30:00.000Z',
      '2026-03-09T06:30:00.000Z',
    ]);
  });

  it('rejects invalid timezone, six-field cron and unsafe one-minute schedules', () => {
    const base = { mode: 'cron' as const, misfirePolicy: 'skip' as const };
    expect(
      scheduleSchema.safeParse({ ...base, cron: '*/5 * * * *', timezone: 'Mars/Olympus' }).success,
    ).toBe(false);
    expect(
      scheduleSchema.safeParse({ ...base, cron: '0 0 8 * * *', timezone: 'UTC' }).success,
    ).toBe(false);
    expect(scheduleSchema.safeParse({ ...base, cron: '* * * * *', timezone: 'UTC' }).success).toBe(
      false,
    );
    expect(
      scheduleSchema.safeParse({ ...base, cron: '*/5 * * * *', timezone: 'UTC' }).success,
    ).toBe(true);
  });

  it.each([
    ['60 * * * *', 'minute outside its range'],
    ['0 24 * * *', 'hour outside its range'],
    ['0 0 0 * *', 'day outside its range'],
    ['0 0 * 13 *', 'month outside its range'],
    ['0 0 * * 8', 'weekday outside its range'],
    ['0 0 * * MON', 'unsupported named field'],
    ['0 0 ? * *', 'non-deterministic question mark'],
    ['0 0 * * */0', 'zero step'],
    ['0 0 * 12-1 *', 'reversed range'],
  ])('rejects %s because it has an invalid %s', (cron) => {
    expect(validateFiveFieldCron(cron)).not.toEqual([]);
    expect(
      scheduleSchema.safeParse({
        mode: 'cron',
        cron,
        timezone: 'UTC',
        misfirePolicy: 'skip',
      }).success,
    ).toBe(false);
  });

  it.each(['*/4 * * * *', '0,4 * * * *', '*/7 * * * *', '0,59 0,23 * * *'])(
    'rejects %s when an expanded pair of runs is less than five minutes apart',
    (cron) => {
      expect(validateFiveFieldCron(cron)).toContain(
        'scheduled tasks must run at intervals of at least five minutes',
      );
    },
  );

  it.each(['*/5 * * * *', '1/5 * * * *', '0 0 * * *', '0,59 0 1 * *'])(
    'accepts deterministic five-field expression %s with a safe minimum interval',
    (cron) => {
      expect(validateFiveFieldCron(cron)).toEqual([]);
    },
  );

  it.each(['0 0 30 2 *', '0 0 31 2 *', '0 0 31 4,6,9,11 *'])(
    'rejects expression %s because it has no possible calendar date',
    (cron) => {
      expect(validateFiveFieldCron(cron)).toContain(
        'cron does not contain a possible execution date',
      );
    },
  );

  it.each(['0 0 29 2 *', '0 0 31 2,3 *', '0 0 31 2 1'])(
    'keeps valid sparse calendar expression %s',
    (cron) => {
      expect(validateFiveFieldCron(cron)).toEqual([]);
    },
  );

  it('validates direct preview calls at the shared schema boundary', () => {
    expect(() =>
      previewSchedule({
        mode: 'cron',
        cron: '0,1 * * * *',
        timezone: 'UTC',
        misfirePolicy: 'skip',
      }),
    ).toThrow();
  });
});
