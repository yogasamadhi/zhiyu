import { createHash } from 'node:crypto';
import { createAiProvider, MockAiProvider, OpenAiCompatibleProvider } from '@zhiyun/ai-runtime';
import type { CredentialStore } from '@zhiyun/contracts';
import type { AiConversationRepository } from '../contracts/index.js';
import type { MutableAiProvider } from './provider.js';
import {
  aiProviderCatalog,
  aiProviderCatalogUpdatedAt,
  inferAiProviderId,
  resolveAiProviderSelection,
} from './provider-catalog.js';
import { testAiProvider, validateProviderBaseUrl } from './provider.js';

export class AiProviderSettingsService {
  private readonly tested = new Map<string, number>();

  constructor(
    private readonly options: {
      repository: AiConversationRepository;
      provider: MutableAiProvider;
      credentials: CredentialStore;
      mode: 'desktop' | 'headless';
      headlessConfigured: boolean;
      promptCredential?: () => Promise<{ reference: string } | { canceled: true }>;
      onUsage?: ConstructorParameters<typeof OpenAiCompatibleProvider>[0]['onUsage'];
    },
  ) {}

  async initialize(): Promise<void> {
    if (this.options.mode === 'headless' || this.options.headlessConfigured) return;
    const settings = await this.options.repository.getProviderSettings();
    if (!settings.baseUrl || !settings.model || !settings.apiKeyRef || !settings.testedAt) return;
    this.options.provider.replace(
      this.provider(settings.baseUrl, settings.model, settings.apiKeyRef),
    );
  }

  async view() {
    const settings = await this.options.repository.getProviderSettings();
    return {
      providerId: this.options.mode === 'headless' ? null : inferAiProviderId(settings.baseUrl),
      baseUrl: this.options.mode === 'headless' ? null : settings.baseUrl,
      model: this.options.mode === 'headless' ? null : settings.model,
      catalog: aiProviderCatalog,
      catalogUpdatedAt: aiProviderCatalogUpdatedAt,
      apiKeyConfigured:
        this.options.mode === 'headless'
          ? this.options.headlessConfigured
          : Boolean(settings.apiKeyRef),
      testedAt: this.options.mode === 'headless' ? null : settings.testedAt,
      revision: settings.revision,
      updatedAt: settings.updatedAt,
      configured: this.options.provider.configured(),
      writable: this.options.mode === 'desktop',
      source:
        this.options.mode === 'headless'
          ? this.options.headlessConfigured
            ? 'headless-environment'
            : 'mock'
          : settings.testedAt
            ? 'desktop-persisted'
            : this.options.provider.configured()
              ? 'desktop-bootstrap'
              : 'mock',
    };
  }

  async promptCredential(expectedRevision: number) {
    this.requireDesktop();
    if (!this.options.promptCredential) throw new Error('Host Credential Prompt is unavailable');
    const prompted = await this.options.promptCredential();
    if ('canceled' in prompted) return prompted;
    const current = await this.options.repository.getProviderSettings();
    if (current.revision !== expectedRevision)
      throw new Error('Provider settings revision is stale');
    if (current.apiKeyRef && current.apiKeyRef !== prompted.reference) {
      await this.options.credentials.delete(current.apiKeyRef).catch(() => undefined);
    }
    const updated = await this.options.repository.updateProviderSettings(
      {
        baseUrl: current.baseUrl,
        model: current.model,
        apiKeyRef: prompted.reference,
        testedAt: null,
      },
      expectedRevision,
    );
    if (!updated) throw new Error('Provider settings revision is stale');
    this.options.provider.replace(new MockAiProvider(this.options.onUsage));
    return { canceled: false as const, apiKeyConfigured: true, revision: updated.revision };
  }

  async test(input: { providerId: string; model: string }, signal?: AbortSignal) {
    this.requireDesktop();
    const settings = await this.options.repository.getProviderSettings();
    if (!settings.apiKeyRef) throw new Error('Configure the API Key before testing');
    const selection = resolveAiProviderSelection(input.providerId, input.model);
    const baseUrl = validateProviderBaseUrl(selection.baseUrl);
    const model = selection.model;
    const provider = this.provider(baseUrl, model, settings.apiKeyRef);
    await testAiProvider(provider, signal);
    const fingerprint = configFingerprint(baseUrl, model, settings.apiKeyRef);
    this.tested.set(fingerprint, Date.now() + 10 * 60_000);
    return {
      ok: true as const,
      providerId: selection.providerId,
      baseUrl,
      model,
      testedAt: new Date().toISOString(),
    };
  }

  async update(input: { providerId: string; model: string }, expectedRevision: number) {
    this.requireDesktop();
    const current = await this.options.repository.getProviderSettings();
    if (current.revision !== expectedRevision)
      throw new Error('Provider settings revision is stale');
    if (!current.apiKeyRef) throw new Error('Configure the API Key before saving');
    const selection = resolveAiProviderSelection(input.providerId, input.model);
    const baseUrl = validateProviderBaseUrl(selection.baseUrl);
    const model = selection.model;
    const fingerprint = configFingerprint(baseUrl, model, current.apiKeyRef);
    const expiry = this.tested.get(fingerprint) ?? 0;
    if (expiry < Date.now()) throw new Error('Provider configuration must pass a connection test');
    const testedAt = new Date().toISOString();
    const updated = await this.options.repository.updateProviderSettings(
      { baseUrl, model, apiKeyRef: current.apiKeyRef, testedAt },
      expectedRevision,
    );
    if (!updated) throw new Error('Provider settings revision is stale');
    this.options.provider.replace(this.provider(baseUrl, model, current.apiKeyRef));
    this.tested.delete(fingerprint);
    return this.view();
  }

  async deleteCredential(expectedRevision: number) {
    this.requireDesktop();
    const current = await this.options.repository.getProviderSettings();
    if (current.revision !== expectedRevision)
      throw new Error('Provider settings revision is stale');
    if (current.apiKeyRef) await this.options.credentials.delete(current.apiKeyRef);
    const updated = await this.options.repository.updateProviderSettings(
      {
        baseUrl: current.baseUrl,
        model: current.model,
        apiKeyRef: null,
        testedAt: null,
      },
      expectedRevision,
    );
    if (!updated) throw new Error('Provider settings revision is stale');
    this.options.provider.replace(
      createAiProvider({ ...(this.options.onUsage ? { onUsage: this.options.onUsage } : {}) }),
    );
    return this.view();
  }

  private provider(baseUrl: string, model: string, reference: string) {
    return new OpenAiCompatibleProvider({
      baseUrl,
      model,
      apiKey: () => this.options.credentials.resolve<string>(reference),
      ...(this.options.onUsage ? { onUsage: this.options.onUsage } : {}),
    });
  }

  private requireDesktop(): void {
    if (this.options.mode !== 'desktop') {
      throw new Error('Headless Provider configuration is read-only; use environment variables');
    }
  }
}

function configFingerprint(baseUrl: string, model: string, reference: string): string {
  return createHash('sha256').update(`${baseUrl}\0${model}\0${reference}`).digest('hex');
}
