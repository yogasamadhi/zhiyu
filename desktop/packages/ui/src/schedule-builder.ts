import i18n from './i18n.js';
import { productCopy } from './product-copy.js';
import type { Schedule } from '@zhiyun/shared';

export type SchedulePreset =
  'manual' | 'minutes' | 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'advanced';

export interface ScheduleFormModel {
  preset: SchedulePreset;
  intervalMinutes: number;
  minute: number;
  time: string;
  weekday: number;
  monthday: number;
}

const DEFAULT_FORM: ScheduleFormModel = {
  preset: 'daily',
  intervalMinutes: 15,
  minute: 0,
  time: '08:00',
  weekday: 1,
  monthday: 1,
};

export function scheduleFormFromValue(mode: Schedule['mode'], cron = ''): ScheduleFormModel {
  if (mode === 'manual') return { ...DEFAULT_FORM, preset: 'manual' };
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return { ...DEFAULT_FORM, preset: 'advanced' };
  const [minute, hour, monthday, month, weekday] = fields;

  const interval = minute?.match(/^\*\/(\d+)$/);
  if (interval && hour === '*' && monthday === '*' && month === '*' && weekday === '*') {
    return {
      ...DEFAULT_FORM,
      preset: 'minutes',
      intervalMinutes: clamp(Number(interval[1]), 5, 59),
    };
  }
  if (isNumber(minute) && hour === '*' && monthday === '*' && month === '*' && weekday === '*') {
    return { ...DEFAULT_FORM, preset: 'hourly', minute: clamp(Number(minute), 0, 59) };
  }
  if (isNumber(minute) && isNumber(hour) && monthday === '*' && month === '*') {
    const time = `${pad(Number(hour))}:${pad(Number(minute))}`;
    if (weekday === '*') return { ...DEFAULT_FORM, preset: 'daily', time };
    if (weekday === '1-5') return { ...DEFAULT_FORM, preset: 'weekdays', time };
    if (isNumber(weekday)) {
      return {
        ...DEFAULT_FORM,
        preset: 'weekly',
        time,
        weekday: clamp(Number(weekday), 0, 6),
      };
    }
  }
  if (
    isNumber(minute) &&
    isNumber(hour) &&
    isNumber(monthday) &&
    month === '*' &&
    weekday === '*'
  ) {
    return {
      ...DEFAULT_FORM,
      preset: 'monthly',
      time: `${pad(Number(hour))}:${pad(Number(minute))}`,
      monthday: clamp(Number(monthday), 1, 28),
    };
  }
  return { ...DEFAULT_FORM, preset: 'advanced' };
}

export function cronFromScheduleForm(form: ScheduleFormModel): string | null {
  const [hour, minute] = parseTime(form.time);
  switch (form.preset) {
    case 'manual':
      return null;
    case 'minutes':
      return `*/${clamp(Math.round(form.intervalMinutes), 5, 59)} * * * *`;
    case 'hourly':
      return `${clamp(Math.round(form.minute), 0, 59)} * * * *`;
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`;
    case 'weekly':
      return `${minute} ${hour} * * ${clamp(Math.round(form.weekday), 0, 6)}`;
    case 'monthly':
      return `${minute} ${hour} ${clamp(Math.round(form.monthday), 1, 28)} * *`;
    case 'advanced':
      return null;
  }
}

export function validateFiveFieldCron(value: string): string | null {
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) return 'Cron 必须包含 5 段：分 时 日 月 周';
  if (fields.some((field) => !/^[\d*/,-]+$/.test(field))) {
    return 'Cron 包含不支持的字符';
  }
  const ranges = [
    [0, 59, '分钟'],
    [0, 23, '小时'],
    [1, 31, '日期'],
    [1, 12, '月份'],
    [0, 7, '星期'],
  ] as const;
  const parsed = fields.map((field, index) =>
    parseCronField(field!, ranges[index]![0], ranges[index]![1]),
  );
  const invalidIndex = parsed.findIndex((field) => !field);
  if (invalidIndex >= 0) return `Cron ${ranges[invalidIndex]![2]}段超出允许范围`;
  if (minimumCircularGap(parsed[0]!, 60) < 5) {
    return '自动计划的最短间隔为 5 分钟';
  }
  const days = parsed[2]!;
  const months = parsed[3]!;
  if (
    fields[2] !== '*' &&
    fields[3] !== '*' &&
    days.some((day) => months.every((month) => day > maximumMonthDay(month)))
  ) {
    return 'Cron 日期在所选月份中不存在';
  }
  return null;
}

export function validateTimezone(value: string): string | null {
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: value }).format(new Date());
    return null;
  } catch {
    return '请输入有效的 IANA 时区，例如 Asia/Shanghai';
  }
}

export function describeSchedule(schedule: Schedule): string {
  if (schedule.mode === 'manual') return productCopy('仅手动运行');
  const form = scheduleFormFromValue(schedule.mode, schedule.cron);
  switch (form.preset) {
    case 'minutes':
      return productCopy('每 {{minutes}} 分钟运行', { minutes: form.intervalMinutes });
    case 'hourly':
      return productCopy('每小时第 {{minute}} 分钟运行', { minute: form.minute });
    case 'daily':
      return productCopy('每天 {{time}} 运行', { time: form.time });
    case 'weekdays':
      return productCopy('工作日 {{time}} 运行', { time: form.time });
    case 'weekly':
      return productCopy('每周{{day}} {{time}} 运行', {
        day: i18n.language.startsWith('zh')
          ? weekdayLabel(form.weekday)
          : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
              form.weekday
            ]!,
        time: form.time,
      });
    case 'monthly':
      return productCopy('每月 {{day}} 日 {{time}} 运行', { day: form.monthday, time: form.time });
    default:
      return `Cron：${schedule.cron ?? ''}`;
  }
}

export function scheduleValue(
  mode: Schedule['mode'],
  cron: string,
  timezone: string,
  misfirePolicy: Schedule['misfirePolicy'],
): Schedule {
  return mode === 'manual'
    ? { mode: 'manual', timezone, misfirePolicy: 'skip' }
    : { mode: 'cron', cron, timezone, misfirePolicy };
}

export function weekdayLabel(day: number): string {
  return ['日', '一', '二', '三', '四', '五', '六'][day] ?? '一';
}

function parseTime(value: string): [number, number] {
  const [rawHour, rawMinute] = value.split(':');
  return [clamp(Number(rawHour), 0, 23), clamp(Number(rawMinute), 0, 59)];
}

function isNumber(value: string | undefined): value is string {
  return Boolean(value && /^\d+$/.test(value));
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

function parseCronField(value: string, minimum: number, maximum: number): number[] | null {
  const values = new Set<number>();
  for (const segment of value.split(',')) {
    if (!segment) return null;
    const [base, rawStep, extra] = segment.split('/');
    if (extra !== undefined) return null;
    const step = rawStep === undefined ? 1 : Number(rawStep);
    if (!Number.isInteger(step) || step < 1 || step > maximum - minimum + 1) return null;
    let start: number;
    let end: number;
    if (base === '*') {
      start = minimum;
      end = maximum;
    } else if (base?.includes('-')) {
      const [rawStart, rawEnd, trailing] = base.split('-');
      if (trailing !== undefined || !integer(rawStart) || !integer(rawEnd)) return null;
      start = Number(rawStart);
      end = Number(rawEnd);
    } else {
      if (rawStep !== undefined || !integer(base)) return null;
      start = Number(base);
      end = start;
    }
    if (start < minimum || end > maximum || start > end) return null;
    for (let item = start; item <= end; item += step) values.add(item);
  }
  return [...values].sort((left, right) => left - right);
}

function minimumCircularGap(values: number[], size: number): number {
  if (values.length <= 1) return size;
  let minimum = size;
  for (let index = 0; index < values.length; index += 1) {
    const current = values[index]!;
    const next = values[index + 1] ?? values[0]! + size;
    minimum = Math.min(minimum, next - current);
  }
  return minimum;
}

function maximumMonthDay(month: number): number {
  if (month === 2) return 29;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function integer(value: string | undefined): value is string {
  return Boolean(value && /^\d+$/.test(value));
}
