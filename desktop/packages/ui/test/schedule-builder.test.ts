import { describe, expect, it } from 'vitest';
import {
  cronFromScheduleForm,
  describeSchedule,
  scheduleFormFromValue,
  validateFiveFieldCron,
  validateTimezone,
} from '../src/schedule-builder.js';

describe('schedule builder', () => {
  it('round-trips supported presets to five-field cron', () => {
    const daily = scheduleFormFromValue('cron', '30 9 * * *');
    expect(daily).toMatchObject({ preset: 'daily', time: '09:30' });
    expect(cronFromScheduleForm(daily)).toBe('30 9 * * *');

    const weekdays = scheduleFormFromValue('cron', '0 8 * * 1-5');
    expect(weekdays.preset).toBe('weekdays');
    expect(cronFromScheduleForm(weekdays)).toBe('0 8 * * 1-5');

    const weekly = scheduleFormFromValue('cron', '15 12 * * 0');
    expect(weekly).toMatchObject({ preset: 'weekly', weekday: 0, time: '12:15' });
  });

  it('enforces safe minute and month-day bounds for generated presets', () => {
    expect(
      cronFromScheduleForm({
        ...scheduleFormFromValue('cron', '*/15 * * * *'),
        intervalMinutes: 1,
      }),
    ).toBe('*/5 * * * *');
    expect(
      cronFromScheduleForm({
        ...scheduleFormFromValue('cron', '0 8 1 * *'),
        monthday: 31,
      }),
    ).toBe('0 8 28 * *');
  });

  it('validates advanced cron and IANA timezone input', () => {
    expect(validateFiveFieldCron('0 8 * * *')).toBeNull();
    expect(validateFiveFieldCron('0 8 * *')).toContain('5 段');
    expect(validateFiveFieldCron('hello 8 * * *')).toContain('不支持');
    expect(validateFiveFieldCron('* * * * *')).toContain('5 分钟');
    expect(validateFiveFieldCron('0,1 * * * *')).toContain('5 分钟');
    expect(validateFiveFieldCron('*/5 * * * *')).toBeNull();
    expect(validateFiveFieldCron('60 8 * * *')).toContain('分钟段');
    expect(validateFiveFieldCron('0 24 * * *')).toContain('小时段');
    expect(validateFiveFieldCron('0 8 31 2 *')).toContain('不存在');
    expect(validateFiveFieldCron('0 8 29 2 *')).toBeNull();
    expect(validateTimezone('Asia/Shanghai')).toBeNull();
    expect(validateTimezone('Mars/Olympus')).toContain('IANA');
  });

  it('describes schedules without exposing cron to ordinary users', () => {
    expect(
      describeSchedule({
        mode: 'cron',
        cron: '0 8 * * 1-5',
        timezone: 'Asia/Shanghai',
        misfirePolicy: 'skip',
      }),
    ).toBe('工作日 08:00 运行');
    expect(describeSchedule({ mode: 'manual', timezone: 'UTC', misfirePolicy: 'skip' })).toBe(
      '仅手动运行',
    );
  });
});
