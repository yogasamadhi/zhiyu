import type { CrawlPlanDefinition, TaskTemplate } from '@zhiyun/shared';

export function templateParameterDefaults(template: TaskTemplate): Record<string, string> {
  return Object.fromEntries(
    template.parameters.map((parameter) => [
      parameter.key,
      parameter.defaultValue === undefined ? '' : String(parameter.defaultValue),
    ]),
  );
}

export function applyTemplateParameters(
  template: TaskTemplate,
  parameters: Record<string, string>,
): CrawlPlanDefinition {
  return replace(template.ruleDefinition, parameters) as CrawlPlanDefinition;
}

export function missingTemplateParameters(
  template: TaskTemplate,
  parameters: Record<string, string>,
): string[] {
  return template.parameters
    .filter((parameter) => parameter.required && !parameters[parameter.key]?.trim())
    .map((parameter) => parameter.label);
}

function replace(value: unknown, parameters: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\{\{([^}]+)}}/g, (placeholder, key: string) => {
      const replacement = parameters[key];
      return replacement?.trim() ? replacement : placeholder;
    });
  }
  if (Array.isArray(value)) return value.map((item) => replace(item, parameters));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replace(item, parameters)]),
    );
  }
  return value;
}
