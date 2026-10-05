const MAX_WARNINGS = 128;
const MAX_WARNING_JSON_BYTES = 512;
const encoder = new TextEncoder();
const states = new WeakMap<string[], { total: number; omitted: number }>();

function boundedText(value: string): string {
  let bytes = 0;
  let text = '';
  for (const character of value) {
    const size = encoder.encode(JSON.stringify(character)).byteLength - 2;
    if (bytes + size > MAX_WARNING_JSON_BYTES - 5) return `${text}...`;
    text += character;
    bytes += size;
  }
  return text;
}

function omit(target: string[], count: number): void {
  const state = states.get(target)!;
  state.total += count;
  state.omitted += count;
  target[MAX_WARNINGS - 1] = `Additional warnings omitted: ${state.omitted}`;
}

/** At most 127 messages plus an explicit omission count, under 64 KiB as JSON. */
export function createWarningBuffer(): string[] {
  const warnings: string[] = [];
  const state = { total: 0, omitted: 0 };
  states.set(warnings, state);
  Object.defineProperty(warnings, 'push', {
    value: (...values: string[]) => {
      for (const value of values) {
        if (warnings.length < MAX_WARNINGS - 1) {
          Array.prototype.push.call(warnings, boundedText(value));
          state.total++;
        } else omit(warnings, 1);
      }
      return warnings.length;
    },
  });
  return warnings;
}

/** Transfer omitted counts without treating the summary as another warning. */
export function appendWarnings(
  target: string[],
  incoming: string[],
  transform: (value: string) => string = (value) => value,
): void {
  if (target === incoming) return;
  const source = states.get(incoming);
  const retained = source?.omitted ? incoming.slice(0, MAX_WARNINGS - 1) : incoming;
  for (const warning of retained) target.push(transform(warning));
  if (source?.omitted) {
    if (states.has(target)) omit(target, source.omitted);
    else target.push(`Additional warnings omitted: ${source.omitted}`);
  }
}

export function warningTotal(warnings: string[]): number {
  return states.get(warnings)?.total ?? warnings.length;
}
