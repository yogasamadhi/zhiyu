import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as yaml from 'js-yaml';
import {
  applyEntryPatches,
  entryListSchema,
  type PatchOptions,
} from '@deepseek-ai/cordis-plugin-include';
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader';
import {
  resolveGraph,
  type BundleDescriptor,
  type PluginManifest,
  type ProductProfile,
} from '@zhiyun/plugin-runtime';
import { aiAssistancePlugin } from '@zhiyun/plugin-ai-assistance/manifest';
import { analyticsPlugin } from '@zhiyun/plugin-analytics/manifest';
import { collectionPlugin } from '@zhiyun/plugin-collection/manifest';
import { corpusPlugin } from '@zhiyun/plugin-corpus/manifest';
import { datasetsPlugin } from '@zhiyun/plugin-datasets/manifest';
import { identityPlugin } from '@zhiyun/plugin-identity/manifest';
import { outputsPlugin } from '@zhiyun/plugin-outputs/manifest';
import { monitoringPlugin } from '@zhiyun/plugin-monitoring/manifest';
import { platformPlugin } from '@zhiyun/plugin-platform/manifest';
import { preferencesPlugin } from '@zhiyun/plugin-preferences/manifest';
import { recruitmentPlugin } from '@zhiyun/plugin-recruitment/manifest';
import { templatesPlugin } from '@zhiyun/plugin-templates/manifest';

export const productPlugins: readonly PluginManifest[] = [
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

const configRoot = [
  resolve(import.meta.dirname, '../config'),
  resolve(import.meta.dirname, 'profiles'),
  resolve(import.meta.dirname, 'config'),
].find((directory) => existsSync(resolve(directory, 'profiles/desktop-studio/cordis.yml')));
if (!configRoot) throw new Error('Packaged Cordis profiles are missing');
const profileIds = ['desktop-studio', 'identity-test', 'safe', 'test', 'e2e'];
const bundleIds = ['core-data', 'intelligence', 'identity-fixture', 'safe-core'];
function readYaml(path: string): EntryOptions[] | PatchOptions[] {
  const rows = yaml.load(readFileSync(path, 'utf8'), { schema: entryListSchema });
  if (!Array.isArray(rows)) throw new Error(`Cordis configuration must be an entry array: ${path}`);
  return rows;
}
export const productProfiles: readonly ProductProfile[] = profileIds.map((id) => {
  const profile = JSON.parse(
    readFileSync(resolve(configRoot!, 'profiles', id, 'profile.json'), 'utf8'),
  ) as { id: string; version: string; bundles: string[]; configuration: Record<string, unknown> };
  return {
    id: profile.id,
    version: profile.version,
    bundleIds: profile.bundles,
    configuration: profile.configuration,
  };
});
export const productBundles: readonly BundleDescriptor[] = bundleIds.map((id) => ({
  id,
  version: '1.0.0',
  pluginIds: applyEntryPatches(
    [],
    readYaml(resolve(configRoot!, 'bundles', id, 'cordis.patch.yml')) as PatchOptions[],
    (warning) => {
      throw new Error(warning);
    },
  )
    .filter((entry) => productPlugins.some(({ id }) => id === entry.id))
    .map((entry) => entry.id!),
}));
export function getProductProfile(id: string): ProductProfile {
  const profile = productProfiles.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`Unknown product profile ${id}`);
  return profile;
}
/** The runtime Include and offline catalog use the same DSH patch algorithm. */
export function composeProductProfile(profileId: string) {
  const profile = getProductProfile(profileId);
  const path = resolve(configRoot!, 'profiles', profileId, 'cordis.yml');
  const patches = profile.bundleIds.flatMap((id) => {
    if (!bundleIds.includes(id)) throw new Error(`Unknown Cordis bundle ${id}`);
    return readYaml(resolve(configRoot!, 'bundles', id, 'cordis.patch.yml')) as PatchOptions[];
  });
  const profilePatch = resolve(configRoot!, 'profiles', profileId, 'cordis.patch.yml');
  if (existsSync(profilePatch)) patches.push(...(readYaml(profilePatch) as PatchOptions[]));
  const entries = applyEntryPatches(readYaml(path) as EntryOptions[], patches, (warning) => {
    throw new Error(warning);
  });
  const known = new Set([...productPlugins.map(({ id }) => id), 'timer', 'logger']);
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.id || ids.has(entry.id))
      throw new Error(`Duplicate or missing Cordis entry id: ${entry.id}`);
    ids.add(entry.id);
    if (entry.name !== `cordis:${entry.id}` || !known.has(entry.id))
      throw new Error(`Unknown packaged plugin: ${entry.name}`);
  }
  return { path, patches, entries };
}
export function resolveProductGraph(profileId: string) {
  const { entries } = composeProductProfile(profileId);
  return resolveGraph({
    profile: getProductProfile(profileId),
    bundles: productBundles,
    plugins: productPlugins,
    selectedPluginIds: entries
      .filter((entry) => !entry.disabled)
      .filter((entry) => productPlugins.some(({ id }) => id === entry.id))
      .map((entry) => entry.id!),
    entries,
  });
}
function clientData(value: unknown): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  if (Array.isArray(value)) return value.map(clientData);
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clientData(item)]));
  throw new Error(
    'Client Cordis configuration must contain only plain data; host expressions cannot be sent to the renderer',
  );
}
export function clientManifest(profileId: string) {
  const clientIds = new Set(
    resolveProductGraph(profileId)
      .plugins.filter(({ descriptor }) => descriptor.uiContributions?.length)
      .map(({ descriptor }) => descriptor.id),
  );
  return composeProductProfile(profileId)
    .entries.filter((entry) => !entry.disabled && clientIds.has(entry.id!))
    .map((entry) => ({
      id: entry.id!,
      name: entry.name,
      ...(entry.config === undefined ? {} : { config: clientData(entry.config) }),
    }));
}
