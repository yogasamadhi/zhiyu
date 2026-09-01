import { describe, expect, it } from 'vitest';
import {
  aiProviderCatalog,
  inferAiProviderId,
  resolveAiProviderSelection,
} from '../src/application/provider-catalog.js';

describe('AI provider catalog', () => {
  it('contains unique HTTPS providers with valid default models', () => {
    expect(aiProviderCatalog.length).toBeGreaterThanOrEqual(10);
    expect(new Set(aiProviderCatalog.map((provider) => provider.id)).size).toBe(
      aiProviderCatalog.length,
    );
    expect(new Set(aiProviderCatalog.map((provider) => provider.baseUrl)).size).toBe(
      aiProviderCatalog.length,
    );

    for (const provider of aiProviderCatalog) {
      expect(provider.baseUrl).toMatch(/^https:\/\//);
      expect(provider.models.length).toBeGreaterThan(0);
      expect(provider.models.some((model) => model.id === provider.defaultModel)).toBe(true);
      expect(new Set(provider.models.map((model) => model.id)).size).toBe(provider.models.length);
    }
  });

  it('resolves only model IDs belonging to the selected provider', () => {
    expect(resolveAiProviderSelection('deepseek', 'deepseek-v4-pro')).toEqual({
      providerId: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',
    });
    expect(() => resolveAiProviderSelection('deepseek', 'gpt-5.6-terra')).toThrow(
      'is not available for DeepSeek',
    );
    expect(() => resolveAiProviderSelection('custom', 'anything')).toThrow(
      'Unsupported AI model provider',
    );
  });

  it('infers catalog providers from persisted endpoints', () => {
    expect(inferAiProviderId('https://api.openai.com/v1/')).toBe('openai');
    expect(inferAiProviderId('https://example.com/v1')).toBeNull();
  });
});
