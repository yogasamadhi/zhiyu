export const repairFixtureVersion = 'repair-quality-v3';
const repairFile = 'desktop/packages/runtime/test/repair-validation.integration.test.ts';
const agentFile = 'desktop/packages/plugins/ai-assistance/test/pi-adapter.test.ts';

/** Fixed identities prevent missing or skipped expectations from becoming a green evaluation. */
export const repairEvaluationCases = [
  [
    'layout',
    'layout',
    'tests current records after a layout change and activates only an explicitly requested new version',
  ],
  ['missing-field', 'quality', "refuses 'missing field' and preserves the active version"],
  ['empty-field', 'quality', "refuses 'empty field' and preserves the active version"],
  ['numeric-type', 'quality', "refuses 'invalid numeric field' and preserves the active version"],
  ['navigation', 'quality', "refuses 'navigation records' and preserves the active version"],
  ['empty-result', 'quality', "refuses 'empty result' and preserves the active version"],
  ['removed-field', 'schema', 'rejects a removed-field proposal before persisting or executing it'],
  [
    'type-downgrade',
    'schema',
    'rejects a type-downgrade proposal before persisting or executing it',
  ],
  [
    'injected-action',
    'invalid-action',
    'rejects a injected-action proposal before persisting or executing it',
  ],
  [
    'failed-retest',
    'quality',
    'clears an earlier successful test when a repeated validation fails',
  ],
  [
    'configured-values',
    'privacy',
    'keeps configured fill, select and sensitive wait targets local while validating the restored browser actions',
  ],
  [
    'page-injection',
    'prompt-injection',
    'omits malicious page instructions and rejects a compromised response before activation',
  ],
  [
    'credential-reflection',
    'privacy',
    'rejects credential reflection in a returned selector without persisting the proposal',
  ],
  [
    'scan-bound',
    'privacy',
    'stops before a model call when the complete privacy scan would exceed its source bound',
  ],
  [
    'waiting-values',
    'privacy',
    'keeps waiting-state values and their structural reflections local without requiring a sensitive flag',
  ],
  [
    'short-fill',
    'privacy',
    'redacts a one-character fill value reflected in structural attributes while preserving field types',
  ],
  [
    'json-structure',
    'layout',
    'repairs json paths using only a type skeleton and validates current records locally',
  ],
  [
    'embedded-structure',
    'layout',
    'repairs embedded paths using only a type skeleton and validates current records locally',
  ],
  [
    'moved-pagination',
    'pagination',
    'repairs a moved pagination button and validates the records from its actual destination',
  ],
  [
    'cache-current-records',
    'cache',
    'uses a validated cached rule for two fresh previews without further Mock calls',
  ],
  [
    'missing-action-target',
    'invalid-action',
    'rejects a configured missing-target action during the actual browser preview without activating or replaying it',
  ],
  [
    'wrong-action-state',
    'invalid-action',
    'rejects a configured wrong-state action during the actual browser preview without activating or replaying it',
  ],
].map(([id, category, name]) => ({
  id: id!,
  category: category!,
  name: name!,
  file: repairFile,
  metric: 'REPAIR_CASE_METRICS',
}));

repairEvaluationCases.push(
  ...[
    [
      'authorized-tools',
      'tool-boundary',
      'executes only supplied crawler tools sequentially and streams lifecycle events',
    ],
    [
      'unauthorized-tool',
      'tool-boundary',
      'does not expose shell, file, SQL, Python, or arbitrary HTTP tools',
    ],
    ['cancel-before-call', 'cancellation', 'honors cancellation before a provider request'],
    ['nested-deadline', 'cancellation', 'propagates the turn deadline to an in-flight nested tool'],
    [
      'destructive-tool',
      'tool-boundary',
      'rejects a supplied destructive tool without execution or a further provider call',
    ],
    [
      'tool-budget',
      'tool-boundary',
      'stops a partially executed tool batch at its limit without a further provider call',
    ],
  ].map(([id, category, name]) => ({
    id: id!,
    category: category!,
    name: name!,
    file: agentFile,
    metric: 'AGENT_CASE_METRICS',
  })),
);

export const repairEvaluationSources = [
  repairFile,
  agentFile,
  'desktop/tooling/evaluations/rule-repair-cases.ts',
  'desktop/tooling/scripts/evaluate-rule-repair.ts',
  'desktop/packages/plugins/ai-assistance/src/application/repair-privacy.ts',
  'desktop/packages/plugins/ai-assistance/src/application/repair-validation.ts',
  'desktop/packages/plugins/ai-assistance/src/application/index.ts',
  'desktop/packages/plugins/ai-assistance/src/application/pi-adapter.ts',
  'desktop/packages/plugins/ai-assistance/src/application/analyzer.ts',
  'desktop/packages/plugins/ai-assistance/src/application/rule-cache.ts',
  'desktop/packages/plugins/ai-assistance/src/persistence/sqlite/index.ts',
  'desktop/packages/browser-runtime/src/action-execution.ts',
  'desktop/packages/crawler-runtime/src/index.ts',
  'desktop/packages/extraction/src/index.ts',
  'desktop/packages/ai-runtime/src/index.ts',
  'desktop/packages/contracts/src/index.ts',
  'desktop/packages/shared/src/index.ts',
];

const additional = [
  [
    'cost-mock',
    'cost',
    'labels Mock token and cost values explicitly rather than claiming settlement',
  ],
  [
    'cost-limit',
    'cost-budget',
    'stops at the estimated cost limit before executing a returned tool or calling the provider again',
  ],
  [
    'cost-nested',
    'cost-budget',
    'shares the estimated budget with nested rule-generation calls and stops before another call',
  ],
  [
    'cost-unknown',
    'cost',
    'keeps missing provider token usage and settlement unknown instead of recording zero cost',
  ],
  [
    'cost-unpriced',
    'cost-budget',
    'stops an unpriced provider before its first request when an estimated limit is required',
  ],
  [
    'cost-settled',
    'cost',
    'retains the reported token source and settlement currency without converting them to estimates',
  ],
];
repairEvaluationCases.push(
  ...additional.map(([id, category, name]) => ({
    id: id!,
    category: category!,
    name: name!,
    file: agentFile,
    metric: 'AGENT_CASE_METRICS',
  })),
);
repairEvaluationCases.push(
  ...[
    [
      'cost-http',
      'cost-budget',
      'persists an HTTP estimate budget, stops before a tool and restores accounting after SQLite reopen',
    ],
    [
      'cost-invalid-policy',
      'cost-budget',
      'rejects an invalid HTTP budget before queuing work or changing the active turn',
    ],
    [
      'cost-failed-retry',
      'cost-budget',
      'preserves accounting after a provider failure and carries the budget into an HTTP retry',
    ],
    [
      'cost-queued',
      'cost-budget',
      'shares the cost limit with an independently queued browser tool and stops its second generation call',
    ],
    [
      'cost-queued-json',
      'cost-budget',
      'shares the cost limit with an independently queued browser tool and stops its second generation call for JSON',
    ],
    [
      'cost-queued-embedded-json',
      'cost-budget',
      'shares the cost limit with an independently queued browser tool and stops its second generation call for embedded JSON',
    ],
  ].map(([id, category, name]) => ({
    id: id!,
    category: category!,
    name: name!,
    file: 'desktop/packages/runtime/test/assistant.integration.test.ts',
    metric: 'COST_CASE_METRICS',
  })),
);
repairEvaluationCases.push(
  ...[
    [
      'cost-ui-unknown',
      'cost-ui',
      'shows missing and historical zero placeholders as unknown and not settled',
    ],
    [
      'cost-ui-sources',
      'cost-ui',
      'separates Mock values, estimates and settlement with their currencies',
    ],
    ['cost-ui-stop', 'cost-ui', 'shows the stopped estimate budget and supports English'],
    [
      'cost-ui-offline',
      'cost-ui',
      'retains an offline turn budget without inventing usage or a zero estimate',
    ],
  ].map(([id, category, name]) => ({
    id: id!,
    category: category!,
    name: name!,
    file: 'desktop/packages/ui/test/assistant-cost.test.ts',
    metric: 'UI_CASE_METRICS',
  })),
);
repairEvaluationSources.push(
  'desktop/packages/runtime/test/assistant.integration.test.ts',
  'desktop/packages/ui/test/assistant-cost.test.ts',
  'desktop/packages/ui/src/components/assistant/AssistantCostPanel.tsx',
  'desktop/packages/ui/src/styles.css',
  'desktop/packages/ui/src/components/assistant/AssistantWorkspace.tsx',
  'desktop/packages/plugins/ai-assistance/src/application/cost-accounting.ts',
  'desktop/packages/plugins/ai-assistance/src/application/provider.ts',
  'desktop/packages/plugins/ai-assistance/src/application/assistant.ts',
  'desktop/packages/plugins/ai-assistance/src/application/crawler-assistant.ts',
  'desktop/packages/plugins/ai-assistance/src/migrations/sqlite/005-cost-accounting.ts',
  'desktop/packages/plugins/ai-assistance/src/http/assistant.ts',
  'desktop/packages/shared/src/assistant.ts',
  'desktop/packages/client/src/index.ts',
);
