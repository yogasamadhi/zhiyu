import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { testEnvironment } from '../../../tooling/scripts/test-environment.js';
import {
  repairEvaluationCases,
  repairEvaluationSources,
  repairFixtureVersion,
} from '../evaluations/rule-repair-cases.js';

type Metric = Record<string, unknown>;
interface Assertion {
  title: string;
  status: string;
  duration?: number;
}
interface VitestReport {
  testResults: Array<{ name: string; assertionResults: Assertion[] }>;
}
const root = resolve(import.meta.dirname, '../../..');
const argument = process.argv.slice(2);
if (
  argument.length > 1 ||
  argument.some((value) => !value.startsWith('--output=') || !value.endsWith('.json'))
)
  throw new Error(
    'Usage: bun --no-env-file desktop/tooling/scripts/evaluate-rule-repair.ts [--output=path.json]',
  );
const output = resolve(
  root,
  argument[0]?.slice('--output='.length) ??
    `.artifacts/ai-evaluation/${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID()}/report.json`,
);
const directory = await mkdtemp(join(tmpdir(), 'zhiyun-repair-evaluation-'));
const startedAt = new Date().toISOString();
const started = performance.now();
const sourceSnapshot = async () =>
  Object.fromEntries(
    await Promise.all(
      repairEvaluationSources.map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(join(root, file)))
          .digest('hex'),
      ]),
    ),
  );
try {
  const sourceHashes = await sourceSnapshot();
  const rawReport = join(directory, 'vitest.json');
  const files = [...new Set(repairEvaluationCases.map((item) => item.file))];
  const child = Bun.spawn(
    [
      'bun',
      '--no-env-file',
      'desktop/tooling/scripts/test-isolated.ts',
      ...files,
      '--reporter=default',
      '--reporter=json',
      `--outputFile=${rawReport}`,
    ],
    {
      cwd: root,
      env: testEnvironment(process.env),
      stdin: 'inherit',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  let raw: VitestReport | null = null;
  try {
    raw = JSON.parse(await readFile(rawReport, 'utf8')) as VitestReport;
  } catch {
    /* Missing runner output is a failed expectation, never an empty success. */
  }
  const metrics = [
    ...stdout.matchAll(
      /(REPAIR_CASE_METRICS|AGENT_CASE_METRICS|COST_CASE_METRICS|UI_CASE_METRICS) (\{[^\r\n]*\})/g,
    ),
  ].map((match) => ({ kind: match[1], value: JSON.parse(match[2]!) as Metric }));
  const number = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const cases = repairEvaluationCases.map((definition) => {
    const assertions =
      raw?.testResults
        .filter((suite) => relative(root, suite.name).replaceAll('\\', '/') === definition.file)
        .flatMap((suite) =>
          suite.assertionResults.filter((item) => item.title === definition.name),
        ) ?? [];
    const readings = metrics.filter(
      (item) => item.kind === definition.metric && item.value.name === definition.name,
    );
    const reading = readings.length === 1 ? readings[0]!.value : null;
    const required =
      definition.metric === 'REPAIR_CASE_METRICS'
        ? [
            'durationMs',
            'repairCalls',
            'analysisCalls',
            'proposalRequests',
            'proposalAccepted',
            'proposalRejected',
            'previewRequests',
            'previewPassed',
            'previewRejected',
            'activationRequests',
            'activationAccepted',
            'activationRejected',
            'cacheRequests',
            'cacheHits',
          ]
        : definition.metric === 'AGENT_CASE_METRICS'
          ? ['durationMs', 'providerCalls', 'toolExecutions']
          : ['durationMs', 'providerCalls'];
    const measured =
      !!reading &&
      reading.fixtureVersion === repairFixtureVersion &&
      required.every(
        (key) =>
          number(reading[key]) && (key === 'durationMs' || Number.isSafeInteger(reading[key])),
      );
    const status = assertions.length === 1 ? assertions[0]!.status : 'missing-or-duplicate';
    return {
      ...definition,
      status,
      passed: status === 'passed' && measured,
      metrics: measured ? reading : null,
    };
  });
  const sum = (key: string) =>
    cases.reduce(
      (total, item) => total + (number(item.metrics?.[key]) ? (item.metrics![key] as number) : 0),
      0,
    );
  const rate = (numerator: number, denominator: number) => ({
    numerator,
    denominator,
    value: denominator ? numerator / denominator : null,
  });
  const providerCalls = sum('repairCalls') + sum('analysisCalls') + sum('providerCalls');
  const sourceHashesAfter = await sourceSnapshot();
  const sourceStable = JSON.stringify(sourceHashes) === JSON.stringify(sourceHashesAfter);
  const report = {
    reportVersion: 1,
    fixtureVersion: repairFixtureVersion,
    title: 'Mock/规则夹具：规则修复、隐私、缓存与工具边界评测',
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: performance.now() - started,
    runnerExitCode: exitCode,
    expectations: rate(cases.filter((item) => item.passed).length, repairEvaluationCases.length),
    repairValidationPassRate: rate(sum('previewPassed'), sum('previewRequests')),
    validationRejectionRate: rate(
      sum('proposalRejected') + sum('previewRejected'),
      sum('proposalRequests') + sum('previewRequests'),
    ),
    cacheHitRate: rate(sum('cacheHits'), sum('cacheRequests')),
    providerCalls: {
      total: providerCalls,
      repair: sum('repairCalls'),
      analysis: sum('analysisCalls'),
      agentAndQueuedTools: sum('providerCalls'),
    },
    activation: {
      requests: sum('activationRequests'),
      accepted: sum('activationAccepted'),
      rejected: sum('activationRejected'),
    },
    coverage: {
      layout: true,
      pagination: true,
      missingFields: true,
      invalidActions: true,
      promptInjection: true,
      privacy: true,
      toolAuthorization: true,
      cache: true,
      costBudgetStop: true,
    },
    limitations: [
      '结果只描述固定 Mock/规则夹具的预期行为，不代表真实模型准确率。',
      '通过率的分母包含故意设置的失败样本与失败复验；拒绝率按候选检查及预览检查次数计算。',
      '缓存命中率只统计缓存用例中的三次分析请求。',
      '调用数只统计固定用例清单；同文件内附带回归用例不进入这些计数。',
      '成本上限为给定估价的调用额度，不是实际账单保证；本轮真实 Token 与实际结算费用未测量。',
    ],
    realModelAccuracy: null,
    realTokenUsage: null,
    settledCost: null,
    sourceHashes,
    sourceStable,
    ...(sourceStable ? {} : { sourceHashesAfter }),
    cases,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  await writeFile(output.replace(/\.json$/, '.log'), stdout + '\n' + stderr);
  const passed =
    exitCode === 0 && sourceStable && cases.every((item) => item.passed) && cases.length >= 12;
  console.info(
    JSON.stringify({
      title: report.title,
      fixtureVersion: repairFixtureVersion,
      passed,
      cases: report.expectations,
      providerCalls,
      output,
    }),
  );
  process.exitCode = passed ? 0 : 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
