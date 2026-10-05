import type { AgentRuntimeTool } from '../contracts/index.js';

const object = (properties: Record<string, unknown> = {}, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const string = { type: 'string' };

// AssistantService wraps every catalog entry with permission checks, accounting,
// persistence and the actual executor before exposing it to the agent.
export function assistantToolDefinitions(
  crawlerTools: readonly AgentRuntimeTool[],
): AgentRuntimeTool[] {
  return [
    ...crawlerTools,
    {
      name: 'search_help',
      description: 'Search versioned product instructions and concepts.',
      parameters: object({ query: string }, ['query']),
      execute: async () => ({}),
    },
    {
      name: 'read_context',
      description: 'Read current authorized resource and latest draft.',
      parameters: object(),
      execute: async () => ({}),
    },
    {
      name: 'show_lesson',
      description: 'Show a bundled lesson. Does not mark steps complete.',
      parameters: object(
        { lessonId: { enum: ['first-table', 'fields', 'pagination', 'export'] } },
        ['lessonId'],
      ),
      execute: async () => ({}),
    },
    {
      name: 'navigate',
      description: 'Show a link to the current resource, model settings, analysis, or corpus.',
      parameters: object(
        { destination: { enum: ['current', 'settings', 'analysis', 'corpus', 'import'] } },
        ['destination'],
      ),
      execute: async () => ({}),
    },
    {
      name: 'prepare_action',
      description:
        'Prepare a concrete action card; never executes it. Use save or save_and_run only after a valid preview.',
      parameters: object(
        {
          kind: {
            enum: [
              'create_example',
              'save',
              'save_and_run',
              'run',
              'schedule',
              'retry_output',
              'export',
            ],
          },
          parameters: { type: 'object' },
        },
        ['kind'],
      ),
      execute: async () => ({}),
    },
    {
      name: 'diagnose',
      description: 'Read observed failure evidence for the current resource.',
      parameters: object(),
      execute: async () => ({}),
    },
    {
      name: 'prepare_repair',
      description:
        'Generate and test one repair proposal for the current task/run, then show an application card.',
      parameters: object(),
      execute: async () => ({}),
    },
  ];
}
