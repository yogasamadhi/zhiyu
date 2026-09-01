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
    <section className="schedule-builder full" aria-label="运行计划">
      <div className="schedule-builder-heading">
        <div>
          <span className="field-label">运行计划</span>
          <p>
            {describeSchedule(schedule)} · {props.timezone}
          </p>
        </div>
        {props.mode === 'cron' && <code>{props.cron}</code>}
      </div>
      <div className="schedule-presets" role="radiogroup" aria-label="计划频率">
        {(
          [
            ['manual', '手动'],
            ['minutes', '每 N 分钟'],
            ['hourly', '每小时'],
            ['daily', '每天'],
            ['weekdays', '工作日'],
            ['weekly', '每周'],
            ['monthly', '每月'],
            ['advanced', '高级 Cron'],
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
              <span>间隔分钟（最少 5 分钟）</span>
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
              <span>每小时第几分钟</span>
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
              <span>执行时间</span>
              <Input
                type="time"
                value={form.time}
                onChange={(event) => patchForm({ time: event.target.value })}
              />
            </label>
          )}
          {form.preset === 'weekly' && (
            <label>
              <span>星期</span>
              <select
                value={form.weekday}
                onChange={(event) => patchForm({ weekday: Number(event.target.value) })}
              >
                <option value={1}>星期一</option>
                <option value={2}>星期二</option>
                <option value={3}>星期三</option>
                <option value={4}>星期四</option>
                <option value={5}>星期五</option>
                <option value={6}>星期六</option>
                <option value={0}>星期日</option>
              </select>
            </label>
          )}
          {form.preset === 'monthly' && (
            <label>
              <span>每月日期（1–28）</span>
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
              <span>Cron（分 时 日 月 周）</span>
              <Input
                value={props.cron}
                onChange={(event) => props.onCronChange(event.target.value)}
              />
              {cronError && <small className="field-warning">{cronError}</small>}
            </label>
          )}
          <label>
            <span>时区</span>
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
            <span>错过执行</span>
            <select
              value={props.misfirePolicy}
              onChange={(event) =>
                props.onMisfirePolicyChange(event.target.value as Schedule['misfirePolicy'])
              }
            >
              <option value="skip">跳过（默认）</option>
              <option value="run-once">恢复后补跑一次</option>
            </select>
          </label>
        </div>
      )}
      {nextRuns.length > 0 && (
        <div className="schedule-preview">
          <strong>未来 5 次执行</strong>
          <ol>
            {nextRuns.map((value) => (
              <li key={value}>{new Date(value).toLocaleString()}</li>
            ))}
          </ol>
          <small>夏令时跳变已按所选时区计算。</small>
        </div>
      )}
      {previewError && (
        <div className="notice notice-warning">无法预览执行时间：{previewError}</div>
      )}
      {props.mode === 'cron' && !previewClient.previewSchedule && (
        <small className="schedule-preview-unavailable">
          保存后由 Runtime 校验计划；升级 Runtime 后此处会显示未来执行时间。
        </small>
      )}
    </section>
  );
}
