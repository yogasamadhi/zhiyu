import { productCopy } from '../product-copy.js';
import { useEffect, useMemo, useState } from 'react';
import type { Schedule } from '@zhiyun/shared';
import { runtimeClient } from '@zhiyun/client';
import { Input } from './ui.js';
import {
  cronFromScheduleForm,
  describeSchedule,
  scheduleFormFromValue,
  scheduleValue,
  type ScheduleFormModel,
  type SchedulePreset,
  validateFiveFieldCron,
  validateTimezone,
} from '../schedule-builder.js';

interface ScheduleBuilderProps {
  mode: Schedule['mode'];
  cron: string;
  timezone: string;
  misfirePolicy: Schedule['misfirePolicy'];
  onModeChange(mode: Schedule['mode']): void;
  onCronChange(cron: string): void;
  onTimezoneChange(timezone: string): void;
  onMisfirePolicyChange(policy: Schedule['misfirePolicy']): void;
}

interface SchedulePreviewClient {
  previewSchedule?: (schedule: Schedule) => Promise<{ nextRuns: string[] }>;
}

const previewClient = runtimeClient as unknown as SchedulePreviewClient;

export function ScheduleBuilder(props: ScheduleBuilderProps) {
  const [form, setForm] = useState<ScheduleFormModel>(() =>
    scheduleFormFromValue(props.mode, props.cron),
  );
  const [nextRuns, setNextRuns] = useState<string[]>([]);
  const [previewError, setPreviewError] = useState('');
  const cronError = props.mode === 'cron' ? validateFiveFieldCron(props.cron) : null;
  const timezoneError = validateTimezone(props.timezone);
  const schedule = useMemo(
    () => scheduleValue(props.mode, props.cron, props.timezone, props.misfirePolicy),
    [props.mode, props.cron, props.timezone, props.misfirePolicy],
  );

  useEffect(() => {
    setForm(scheduleFormFromValue(props.mode, props.cron));
  }, [props.mode, props.cron]);

  useEffect(() => {
    if (!previewClient.previewSchedule || cronError || timezoneError || props.mode === 'manual') {
      setNextRuns([]);
      setPreviewError('');
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void previewClient.previewSchedule!(schedule)
        .then((result) => {
          if (!active) return;
          setNextRuns(result.nextRuns.slice(0, 5));
          setPreviewError('');
        })
        .catch((reason: unknown) => {
          if (!active) return;
          setNextRuns([]);
          setPreviewError(reason instanceof Error ? reason.message : String(reason));
        });
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [schedule, cronError, timezoneError, props.mode]);

  const changePreset = (preset: SchedulePreset) => {
    const next = { ...form, preset };
    setForm(next);
    if (preset === 'manual') {
      props.onModeChange('manual');
      return;
    }
    props.onModeChange('cron');
    const generated = cronFromScheduleForm(next);
    if (generated) props.onCronChange(generated);
  };

  const patchForm = (patch: Partial<ScheduleFormModel>) => {
    const next = { ...form, ...patch };
    setForm(next);
    const generated = cronFromScheduleForm(next);
    if (generated) props.onCronChange(generated);
  };

  return (
    <section className="schedule-builder full" aria-label={productCopy('运行计划')}>
      <div className="schedule-builder-heading">
        <div>
          <span className="field-label">{productCopy('运行计划')}</span>
          <p>
            {describeSchedule(schedule)} · {props.timezone}
          </p>
        </div>
        {props.mode === 'cron' && <code>{props.cron}</code>}
      </div>
      <div className="schedule-presets" role="radiogroup" aria-label={productCopy('计划频率')}>
        {(
          [
            ['manual', productCopy('手动')],
            ['minutes', productCopy('每 N 分钟')],
            ['hourly', productCopy('每小时')],
            ['daily', productCopy('每天')],
            ['weekdays', productCopy('工作日')],
            ['weekly', productCopy('每周')],
            ['monthly', productCopy('每月')],
            ['advanced', productCopy('高级 Cron')],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            role="radio"
            aria-checked={form.preset === value}
            className={form.preset === value ? 'schedule-preset active' : 'schedule-preset'}
            key={value}
            onClick={() => changePreset(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {props.mode === 'cron' && (
        <div className="schedule-options">
          {form.preset === 'minutes' && (
            <label>
              <span>{productCopy('间隔分钟（最少 5 分钟）')}</span>
              <Input
                type="number"
                min={5}
                max={59}
                value={form.intervalMinutes}
                onChange={(event) => patchForm({ intervalMinutes: Number(event.target.value) })}
              />
            </label>
          )}
          {form.preset === 'hourly' && (
            <label>
              <span>{productCopy('每小时第几分钟')}</span>
              <Input
                type="number"
                min={0}
                max={59}
                value={form.minute}
                onChange={(event) => patchForm({ minute: Number(event.target.value) })}
              />
            </label>
          )}
          {['daily', 'weekdays', 'weekly', 'monthly'].includes(form.preset) && (
            <label>
              <span>{productCopy('执行时间')}</span>
              <Input
                type="time"
                value={form.time}
                onChange={(event) => patchForm({ time: event.target.value })}
              />
            </label>
          )}
          {form.preset === 'weekly' && (
            <label>
              <span>{productCopy('星期')}</span>
              <select
                value={form.weekday}
                onChange={(event) => patchForm({ weekday: Number(event.target.value) })}
              >
                <option value={1}>{productCopy('星期一')}</option>
                <option value={2}>{productCopy('星期二')}</option>
                <option value={3}>{productCopy('星期三')}</option>
                <option value={4}>{productCopy('星期四')}</option>
                <option value={5}>{productCopy('星期五')}</option>
                <option value={6}>{productCopy('星期六')}</option>
                <option value={0}>{productCopy('星期日')}</option>
              </select>
            </label>
          )}
          {form.preset === 'monthly' && (
            <label>
              <span>{productCopy('每月日期（1–28）')}</span>
              <Input
                type="number"
                min={1}
                max={28}
                value={form.monthday}
                onChange={(event) => patchForm({ monthday: Number(event.target.value) })}
              />
            </label>
          )}
          {form.preset === 'advanced' && (
            <label>
              <span>{productCopy('Cron（分 时 日 月 周）')}</span>
              <Input
                value={props.cron}
                onChange={(event) => props.onCronChange(event.target.value)}
              />
              {cronError && <small className="field-warning">{cronError}</small>}
            </label>
          )}
          <label>
            <span>{productCopy('时区')}</span>
            <Input
              list="zhiyun-timezones"
              value={props.timezone}
              onChange={(event) => props.onTimezoneChange(event.target.value)}
            />
            <datalist id="zhiyun-timezones">
              <option value="Asia/Shanghai" />
              <option value="Asia/Hong_Kong" />
              <option value="Asia/Tokyo" />
              <option value="Europe/London" />
              <option value="America/New_York" />
              <option value="UTC" />
            </datalist>
            {timezoneError && <small className="field-warning">{timezoneError}</small>}
          </label>
          <label>
            <span>{productCopy('错过执行')}</span>
            <select
              value={props.misfirePolicy}
              onChange={(event) =>
                props.onMisfirePolicyChange(event.target.value as Schedule['misfirePolicy'])
              }
            >
              <option value="skip">{productCopy('跳过（默认）')}</option>
              <option value="run-once">{productCopy('恢复后补跑一次')}</option>
            </select>
          </label>
        </div>
      )}
      {nextRuns.length > 0 && (
        <div className="schedule-preview">
          <strong>{productCopy('未来 5 次执行')}</strong>
          <ol>
            {nextRuns.map((value) => (
              <li key={value}>{new Date(value).toLocaleString()}</li>
            ))}
          </ol>
          <small>{productCopy('夏令时跳变已按所选时区计算。')}</small>
        </div>
      )}
      {previewError && (
        <div className="notice notice-warning">
          {productCopy('无法预览执行时间：')}
          {previewError}
        </div>
      )}
      {props.mode === 'cron' && !previewClient.previewSchedule && (
        <small className="schedule-preview-unavailable">
          {productCopy('保存后由 Runtime 校验计划；升级 Runtime 后此处会显示未来执行时间。')}
        </small>
      )}
    </section>
  );
}
