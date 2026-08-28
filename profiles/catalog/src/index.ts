import {
  resolveGraph,
  type BundleDescriptor,
  type PluginDescriptor,
  type ProductProfile,
} from '@zhiyun/kernel';
import { aiAssistancePlugin } from '@zhiyun/plugin-ai-assistance';
import { analyticsPlugin } from '@zhiyun/plugin-analytics';
import { collectionPlugin } from '@zhiyun/plugin-collection';
import { corpusPlugin } from '@zhiyun/plugin-corpus';
import { datasetsPlugin } from '@zhiyun/plugin-datasets';
import { legacyRuntimePlugin } from '@zhiyun/plugin-legacy-runtime';
import { outputsPlugin } from '@zhiyun/plugin-outputs';
import { platformPlugin } from '@zhiyun/plugin-platform';
import { preferencesPlugin } from '@zhiyun/plugin-preferences';

export const productPlugins: readonly PluginDescriptor[] = [
  legacyRuntimePlugin,
  platformPlugin,
  datasetsPlugin,
  collectionPlugin,
  outputsPlugin,
  preferencesPlugin,
  analyticsPlugin,
  corpusPlugin,
  aiAssistancePlugin,
];

export const productBundles: readonly BundleDescriptor[] = [
  { id: 'legacy', version: '0.2.0', pluginIds: ['legacy.runtime'] },
  {
    id: 'core-data',
    version: '1.0.0',
    pluginIds: ['platform', 'datasets', 'collection', 'outputs', 'preferences'],
  },
  {
    id: 'intelligence',
    version: '1.0.0',
    pluginIds: ['analytics', 'corpus', 'ai-assistance'],
  },
  {
    id: 'safe-core',
    version: '1.0.0',
    pluginIds: ['platform', 'datasets', 'collection', 'preferences'],
  },
];

export const productProfiles: readonly ProductProfile[] = [
  { id: 'legacy', version: '0.2.0', bundleIds: ['legacy'] },
  { id: 'level2-preview', version: '1.0.0', bundleIds: ['core-data', 'intelligence'] },
  { id: 'desktop-studio', version: '1.0.0', bundleIds: ['core-data', 'intelligence'] },
  { id: 'headless-server', version: '1.0.0', bundleIds: ['core-data', 'intelligence'] },
  { id: 'safe', version: '1.0.0', bundleIds: ['safe-core'] },
  {
    id: 'test',
    version: '1.0.0',
    bundleIds: ['core-data', 'intelligence'],
    configuration: { deterministic: true },
  },
  {
    id: 'e2e',
    version: '1.0.0',
    bundleIds: ['core-data', 'intelligence'],
    configuration: { deterministic: true, fixtures: true },
  },
];

export function getProductProfile(id: string): ProductProfile {
  const profile = productProfiles.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`Unknown product profile ${id}`);
  return profile;
}

export function resolveProductGraph(profileId: string) {
  return resolveGraph({
    profile: getProductProfile(profileId),
    bundles: productBundles,
    plugins: productPlugins,
  });
}
