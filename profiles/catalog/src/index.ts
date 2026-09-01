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
import { identityPlugin } from '@zhiyun/plugin-identity';
import { outputsPlugin } from '@zhiyun/plugin-outputs';
import { monitoringPlugin } from '@zhiyun/plugin-monitoring';
import { platformPlugin } from '@zhiyun/plugin-platform';
import { preferencesPlugin } from '@zhiyun/plugin-preferences';
import { recruitmentPlugin } from '@zhiyun/plugin-recruitment';
import { templatesPlugin } from '@zhiyun/plugin-templates';

export const productPlugins: readonly PluginDescriptor[] = [
  platformPlugin,
  datasetsPlugin,
  collectionPlugin,
  monitoringPlugin,
  templatesPlugin,
  outputsPlugin,
  preferencesPlugin,
  recruitmentPlugin,
  analyticsPlugin,
  corpusPlugin,
  aiAssistancePlugin,
  identityPlugin,
];

export const productBundles: readonly BundleDescriptor[] = [
  {
    id: 'core-data',
    version: '1.0.0',
    pluginIds: [
      'platform',
      'datasets',
      'collection',
      'monitoring',
      'templates',
      'outputs',
      'preferences',
      'recruitment',
    ],
  },
  {
    id: 'intelligence',
    version: '1.0.0',
    pluginIds: ['analytics', 'corpus', 'ai-assistance'],
  },
  {
    id: 'headless-identity',
    version: '1.0.0',
    pluginIds: ['identity'],
  },
  {
    id: 'safe-core',
    version: '1.0.0',
    pluginIds: ['platform', 'datasets', 'collection', 'preferences'],
  },
];

export const productProfiles: readonly ProductProfile[] = [
  { id: 'desktop-studio', version: '1.0.0', bundleIds: ['core-data', 'intelligence'] },
  {
    id: 'headless-server',
    version: '1.0.0',
    bundleIds: ['core-data', 'intelligence', 'headless-identity'],
  },
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
