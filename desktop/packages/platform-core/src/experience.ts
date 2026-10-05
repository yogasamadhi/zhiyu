import { createHash } from 'node:crypto';
import type { PlatformRepository } from './index.js';
export const experienceEventTypes = [
  'creation_started',
  'preview_completed',
  'run_succeeded',
  'export_completed',
  'analysis_completed',
  'sync_completed',
  'lesson_started',
  'lesson_completed',
  'example_started',
  'example_completed',
] as const;
export interface ExperienceEvent {
  id: string;
  type: (typeof experienceEventTypes)[number];
  correlationId: string;
  occurredAt: string;
  durationMs: number | null;
  outcome: 'success' | 'failure' | 'canceled';
}
export async function recordExperience(
  platform: PlatformRepository,
  input: {
    id: string;
    type: ExperienceEvent['type'];
    taskId: string;
    example?: boolean;
    durationMs?: number;
    outcome?: ExperienceEvent['outcome'];
  },
) {
  if (input.example) return;
  const workspaceId = await platform.getOrCreateWorkspaceId();
  await platform.recordExperienceEvent({
    id: hash(`${workspaceId}:${input.type}:${input.id}`),
    type: input.type,
    correlationId: hash(`${workspaceId}:${input.taskId}`),
    occurredAt: new Date().toISOString(),
    durationMs: input.durationMs === undefined ? null : Math.max(0, Math.round(input.durationMs)),
    outcome: input.outcome ?? 'success',
  });
}
export function summarizeExperience(events: ExperienceEvent[], now = Date.now()) {
  const groups = new Map<string, ExperienceEvent[]>();
  for (const e of events) {
    const list = groups.get(e.correlationId) ?? [];
    list.push(e);
    groups.set(e.correlationId, list);
  }
  let started = 0,
    completed = 0,
    used = 0,
    reused = 0,
    reuseEligible = 0;
  const durations: number[] = [];
  for (const items of groups.values()) {
    items.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    const start = items.find((e) => e.type === 'creation_started');
    const runs = items.filter((e) => e.type === 'run_succeeded' && e.outcome === 'success');
    if (start) started++;
    if (start && runs[0]) {
      completed++;
      durations.push(Math.max(0, Date.parse(runs[0].occurredAt) - Date.parse(start.occurredAt)));
    }
    if (
      runs.length &&
      items.some(
        (e) =>
          ['export_completed', 'analysis_completed', 'sync_completed'].includes(e.type) &&
          e.outcome === 'success',
      )
    )
      used++;
    if (runs[0] && now - Date.parse(runs[0].occurredAt) >= 7 * 86400000) {
      reuseEligible++;
      if (
        runs
          .slice(1)
          .some((e) => Date.parse(e.occurredAt) - Date.parse(runs[0]!.occurredAt) <= 7 * 86400000)
      )
        reused++;
    }
  }
  const resultTasks = [...groups.values()].filter((events) =>
    events.some((e) => e.type === 'run_succeeded' && e.outcome === 'success'),
  ).length;
  durations.sort((a, b) => a - b);
  return {
    started,
    completed,
    resultTasks,
    reuseEligible,
    firstCompletionRate: started ? completed / started : null,
    medianTimeToResultMs: durations.length
      ? (durations[Math.floor((durations.length - 1) / 2)]! +
          durations[Math.floor(durations.length / 2)]!) /
        2
      : null,
    resultUsageRate: resultTasks ? used / resultTasks : null,
    reuseWithin7DaysRate: reuseEligible ? reused / reuseEligible : null,
    eventCount: events.length,
    retentionDays: 90,
    lessonsStarted: events.filter((event) => event.type === 'lesson_started').length,
    lessonsCompleted: events.filter((event) => event.type === 'lesson_completed').length,
    examplesStarted: events.filter((event) => event.type === 'example_started').length,
    examplesCompleted: events.filter((event) => event.type === 'example_completed').length,
  };
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
