import {
  qualityPolicySchema,
  type DatasetStats,
  type QualityEvaluation,
  type QualityFieldProfile,
  type QualityIssue,
  type QualityIssueKind,
  type QualityPolicy,
  type QualityProfile,
} from '@zhiyun/shared';

export const defaultQualityPolicy = qualityPolicySchema.parse({});

export async function profileRecords(
  records:
    AsyncIterable<{ data: Record<string, unknown> }> | Iterable<{ data: Record<string, unknown> }>,
): Promise<QualityProfile> {
  const fields: Record<string, QualityFieldProfile> = {};
  let recordCount = 0;
  for await (const record of records) {
    recordCount += 1;
    for (const [field, value] of Object.entries(record.data)) {
      const profile = (fields[field] ??= { present: 0, nulls: 0, types: {} });
      profile.present += 1;
      if (value === null || value === undefined || value === '') profile.nulls += 1;
      const type = valueType(value);
      profile.types[type] = (profile.types[type] ?? 0) + 1;
    }
  }
  return { recordCount, fields };
}

export function evaluateProfile(input: {
  profile: QualityProfile;
  baselines: QualityProfile[];
  policy: QualityPolicy;
  datasetStats?: DatasetStats;
  everNonEmpty?: boolean;
}): QualityIssue[] {
  if (!input.policy.enabled) return [];
  const issues: QualityIssue[] = [];
  const rule = (kind: QualityIssueKind) =>
    input.policy.rules.find((candidate) => candidate.kind === kind && candidate.enabled);
  const baselineReady = input.baselines.length >= input.policy.minimumBaselineRuns;
  const counts = input.baselines.map((profile) => profile.recordCount);
  const baselineCount = median(counts);

  if (
    rule('empty-result') &&
    input.profile.recordCount === 0 &&
    (input.everNonEmpty === true || counts.some((count) => count > 0))
  ) {
    issues.push(issue('empty-result', '本次采集没有返回记录', 0, baselineCount));
  }

  const drop = rule('record-count-drop');
  if (drop && baselineReady && baselineCount > 0) {
    const dropRatio = 1 - input.profile.recordCount / baselineCount;
    if (input.profile.recordCount < baselineCount && dropRatio >= (drop.threshold ?? 0.5)) {
      issues.push(
        issue(
          'record-count-drop',
          `记录数较最近基线下降 ${Math.round((1 - input.profile.recordCount / baselineCount) * 100)}%`,
          input.profile.recordCount,
          baselineCount,
        ),
      );
    }
  }

  if (baselineReady) {
    const baselineFields = aggregateFields(input.baselines);
    for (const [field, previous] of Object.entries(baselineFields)) {
      const current = input.profile.fields[field] ?? { present: 0, nulls: 0, types: {} };
      const selected = (kind: QualityIssueKind) => {
        const configured = rule(kind);
        return configured && (configured.fields.length === 0 || configured.fields.includes(field));
      };
      const previousPresence = previous.present / Math.max(1, previous.records);
      const currentPresence = current.present / Math.max(1, input.profile.recordCount);
      const fieldMissing = rule('field-missing');
      if (
        selected('field-missing') &&
        previousPresence >= (fieldMissing?.baselineThreshold ?? 0.9) &&
        currentPresence < (fieldMissing?.threshold ?? 0.1)
      ) {
        issues.push(
          issue(
            'field-missing',
            `字段 ${field} 在本次数据中消失`,
            currentPresence,
            previousPresence,
            field,
          ),
        );
      }
      const previousNullRate = previous.nulls / Math.max(1, previous.present);
      const currentNullRate = current.nulls / Math.max(1, current.present);
      if (
        selected('null-rate-spike') &&
        currentNullRate >= (rule('null-rate-spike')?.threshold ?? 0.5) &&
        currentNullRate - previousNullRate >= (rule('null-rate-spike')?.deltaThreshold ?? 0.3)
      ) {
        issues.push(
          issue(
            'null-rate-spike',
            `字段 ${field} 的空值率显著上升`,
            currentNullRate,
            previousNullRate,
            field,
          ),
        );
      }
      if (selected('type-change')) {
        const previousType = dominant(previous.types);
        const currentType = dominant(current.types);
        const confidence = rule('type-change')?.threshold ?? 0.8;
        if (
          previousType &&
          currentType &&
          previousType.type !== currentType.type &&
          previousType.ratio >= confidence &&
          currentType.ratio >= confidence
        ) {
          issues.push({
            ...issue('type-change', `字段 ${field} 的主导类型发生变化`, null, null, field),
            metadata: { from: previousType.type, to: currentType.type },
          });
        }
      }
    }
  }

  const content = rule('content-change');
  if (content && input.datasetStats) {
    const changed =
      input.datasetStats.added + input.datasetStats.updated + input.datasetStats.removed;
    const ratio = changed / Math.max(1, input.datasetStats.current + input.datasetStats.removed);
    if (ratio >= (content.threshold ?? 0.2)) {
      issues.push(
        issue(
          'content-change',
          `数据变化比例达到 ${Math.round(ratio * 100)}%`,
          ratio,
          content.threshold ?? 0.2,
        ),
      );
    }
  }
  return issues;
}

export function failedEvaluation(
  input: {
    taskId: string;
    runId: string;
    error?: string | null;
  },
  issueEnabled = true,
): Omit<QualityEvaluation, 'id' | 'createdAt'> {
  return {
    taskId: input.taskId,
    runId: input.runId,
    status: 'failing',
    profile: { recordCount: 0, fields: {} },
    issues: issueEnabled
      ? [
          {
            kind: 'run-failed',
            severity: 'critical',
            message: input.error?.trim() || '采集运行失败',
            field: null,
            actual: null,
            expected: null,
            metadata: {},
          },
        ]
      : [],
  };
}

function issue(
  kind: QualityIssueKind,
  message: string,
  actual: number | null,
  expected: number | null,
  field: string | null = null,
): QualityIssue {
  return { kind, severity: 'warning', message, field, actual, expected, metadata: {} };
}

function valueType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  return typeof value;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2
    : (ordered[middle] ?? 0);
}

function aggregateFields(profiles: QualityProfile[]) {
  const result: Record<
    string,
    { records: number; present: number; nulls: number; types: Record<string, number> }
  > = {};
  for (const profile of profiles) {
    for (const [field, value] of Object.entries(profile.fields)) {
      const aggregate = (result[field] ??= { records: 0, present: 0, nulls: 0, types: {} });
      aggregate.present += value.present;
      aggregate.nulls += value.nulls;
      for (const [type, count] of Object.entries(value.types)) {
        aggregate.types[type] = (aggregate.types[type] ?? 0) + count;
      }
    }
  }
  for (const aggregate of Object.values(result)) {
    aggregate.records = profiles.reduce((total, profile) => total + profile.recordCount, 0);
  }
  return result;
}

function dominant(types: Record<string, number>): { type: string; ratio: number } | null {
  const entries = Object.entries(types).filter(([type]) => type !== 'null');
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  const selected = entries.sort((left, right) => right[1] - left[1])[0];
  return selected && total > 0 ? { type: selected[0], ratio: selected[1] / total } : null;
}
