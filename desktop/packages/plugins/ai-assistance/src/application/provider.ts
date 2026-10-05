import { validateAiProviderBaseUrl } from '@zhiyun/ai-runtime';
import type { AiChatEvent, AiChatRequest, AiProvider } from '@zhiyun/contracts';
import { trackedAiProvider } from './cost-accounting.js';

export class MutableAiProvider implements AiProvider {
  readonly name = 'mutable';

  constructor(
    private provider: AiProvider,
    private readonly override?: () => AiProvider | undefined,
  ) {}

  configured(): boolean {
    return !['mock'].includes(this.current().name ?? '');
  }

  current(): AiProvider {
    return trackedAiProvider(this.override?.() ?? this.provider);
  }

  get cacheIdentity(): AiProvider['cacheIdentity'] {
    return this.current().cacheIdentity;
  }
  get repairBrowserAction(): AiProvider['repairBrowserAction'] {
    const current = this.current();
    return current.repairBrowserAction?.bind(current);
  }

  replace(provider: AiProvider): void {
    this.provider = provider;
  }

  streamChat(input: AiChatRequest): AsyncIterable<AiChatEvent> {
    return this.current().streamChat(input);
  }

  generateSchema(input: Parameters<AiProvider['generateSchema']>[0]) {
    return this.current().generateSchema(input);
  }
  generateRule(input: Parameters<AiProvider['generateRule']>[0]) {
    return this.current().generateRule(input);
  }
  extract(input: Parameters<AiProvider['extract']>[0]) {
    return this.current().extract(input);
  }
  suggestRepair(input: Parameters<AiProvider['suggestRepair']>[0]) {
    return this.current().suggestRepair(input);
  }
  explainFailure(input: Parameters<AiProvider['explainFailure']>[0]) {
    return this.current().explainFailure(input);
  }
}

export function validateProviderBaseUrl(value: string): string {
  return validateAiProviderBaseUrl(value);
}

export async function testAiProvider(provider: AiProvider, signal?: AbortSignal): Promise<void> {
  let completed = false;
  for await (const event of provider.streamChat({
    messages: [
      { role: 'system', content: 'Reply with exactly OK.' },
      { role: 'user', content: 'Connection test.' },
    ],
    toolChoice: 'none',
    temperature: 0,
    ...(signal ? { signal } : {}),
  })) {
    if (event.type === 'done') completed = true;
  }
  if (!completed) throw new Error('Provider connection test did not complete');
}
