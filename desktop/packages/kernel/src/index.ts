import { createHash } from 'node:crypto';

export type MaybePromise<T> = T | Promise<T>;
export type EffectDisposer = () => MaybePromise<void>;

export interface ServiceToken<T> {
  readonly id: string;
  readonly version: string;
  readonly owner?: string;
  readonly __serviceType?: T;
}

export function createServiceToken<T>(
  id: string,
  version: string,
  owner?: string,
): ServiceToken<T> {
  if (!id.trim()) throw new Error('Service token id is required');
  if (!version.trim()) throw new Error(`Service token ${id} requires a version`);
  return Object.freeze({ id, version, ...(owner ? { owner } : {}) });
}

export interface PluginDependency {
  readonly id: string;
  readonly range?: string;
}

export interface RouteContribution {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  /** Permission required by the workspace gateway; null marks an intentionally public route. */
  readonly requiredPermission: string | null;
}

export interface EventContribution {
  readonly type: string;
  readonly durable: boolean;
}

export interface MigrationContribution {
  readonly id: string;
  readonly tables: readonly string[];
  readonly checksum?: string;
}

export type UiContributionKind = 'route' | 'navigation' | 'panel' | 'command';

export interface UiContribution {
  readonly id: string;
  readonly kind: UiContributionKind;
}

export interface BackgroundHandlerContribution {
  readonly type: string;
  readonly resourceClass: 'browser-heavy' | 'python-heavy' | 'io' | 'delivery';
}

export interface AcquiredEffect<T> {
  readonly value: T;
  readonly dispose: EffectDisposer;
}

export interface PluginServices {
  provide<T>(token: ServiceToken<T>, implementation: T): void;
  require<T>(token: ServiceToken<T>): T;
  optional<T>(token: ServiceToken<T>): T | undefined;
}

export interface PluginContext {
  readonly pluginId: string;
  readonly graphRevision: string;
  readonly services: PluginServices;
  effect(label: string, acquire: () => MaybePromise<EffectDisposer>): Promise<void>;
  effect<T>(label: string, acquire: () => MaybePromise<AcquiredEffect<T>>): Promise<T>;
}

export interface PluginDescriptor {
  readonly id: string;
  readonly version: string;
  readonly dependencies?: readonly PluginDependency[];
  readonly optionalCapabilities?: readonly string[];
  readonly providedServices?: readonly ServiceToken<unknown>[];
  readonly routes?: readonly RouteContribution[];
  readonly events?: readonly EventContribution[];
  readonly migrations?: readonly MigrationContribution[];
  readonly uiContributions?: readonly UiContribution[];
  readonly backgroundHandlers?: readonly BackgroundHandlerContribution[];
  activate(context: PluginContext): MaybePromise<void>;
}

export interface BundleDescriptor {
  readonly id: string;
  readonly version: string;
  readonly pluginIds: readonly string[];
  readonly defaults?: Readonly<Record<string, unknown>>;
}

export interface ProductProfile {
  readonly id: string;
  readonly version: string;
  readonly bundleIds: readonly string[];
  readonly configuration?: Readonly<Record<string, unknown>>;
}

export interface ResolvedPlugin {
  readonly descriptor: PluginDescriptor;
  readonly order: number;
}

export interface ResolvedGraph {
  readonly profile: ProductProfile;
  readonly bundles: readonly BundleDescriptor[];
  readonly plugins: readonly ResolvedPlugin[];
  readonly revision: string;
}

export interface ArchitectureOwner {
  readonly id: string;
  readonly owner: string;
}

export interface ArchitectureCatalog {
  readonly graphRevision: string;
  readonly profileId: string;
  readonly plugins: readonly {
    id: string;
    version: string;
    dependencies: readonly string[];
  }[];
  readonly services: readonly ArchitectureOwner[];
  readonly routes: readonly (ArchitectureOwner & {
    method: string;
    path: string;
    requiredPermission: string | null;
  })[];
  readonly events: readonly ArchitectureOwner[];
  readonly tables: readonly ArchitectureOwner[];
  readonly migrations: readonly ArchitectureOwner[];
  readonly uiContributions: readonly ArchitectureOwner[];
  readonly backgroundHandlers: readonly ArchitectureOwner[];
}

interface RegisteredService {
  readonly token: ServiceToken<unknown>;
  readonly implementation: unknown;
  readonly provider: string;
}

class ServiceRegistry {
  private readonly registrations = new Map<string, RegisteredService>();

  provide<T>(plugin: PluginDescriptor, token: ServiceToken<T>, implementation: T): void {
    const declared = plugin.providedServices?.some(
      (candidate) => candidate.id === token.id && candidate.version === token.version,
    );
    if (!declared) {
      throw new Error(`Plugin ${plugin.id} attempted to provide undeclared service ${token.id}`);
    }
    const current = this.registrations.get(token.id);
    if (current) {
      throw new Error(
        `Service ${token.id} is already provided by ${current.provider}; ${plugin.id} cannot replace it`,
      );
    }
    this.registrations.set(token.id, { token, implementation, provider: plugin.id });
  }

  require<T>(plugin: PluginDescriptor, token: ServiceToken<T>): T {
    const registration = this.registrations.get(token.id);
    if (!registration) throw new Error(`Plugin ${plugin.id} requires missing service ${token.id}`);
    if (!satisfiesVersion(registration.token.version, `^${major(token.version)}.0.0`)) {
      throw new Error(
        `Plugin ${plugin.id} requires incompatible service ${token.id}@${token.version}; provider has ${registration.token.version}`,
      );
    }
    return registration.implementation as T;
  }

  optional<T>(plugin: PluginDescriptor, token: ServiceToken<T>): T | undefined {
    if (!this.registrations.has(token.id)) return undefined;
    return this.require(plugin, token);
  }
}

interface EffectRecord {
  readonly key: string;
  readonly pluginId: string;
  readonly label: string;
  readonly dispose: EffectDisposer;
}

export class EffectRegistry {
  private readonly effects: EffectRecord[] = [];
  private readonly keys = new Set<string>();

  async acquire<T>(
    pluginId: string,
    label: string,
    acquire: () => MaybePromise<EffectDisposer | AcquiredEffect<T>>,
  ): Promise<T | undefined> {
    if (!label.trim()) throw new Error(`Plugin ${pluginId} registered an empty effect label`);
    const key = `${pluginId}:${label}`;
    if (this.keys.has(key)) throw new Error(`Duplicate effect ${key}`);
    const acquired = await acquire();
    const record =
      typeof acquired === 'function'
        ? { key, pluginId, label, dispose: acquired }
        : { key, pluginId, label, dispose: acquired.dispose };
    this.effects.push(record);
    this.keys.add(key);
    return typeof acquired === 'function' ? undefined : acquired.value;
  }

  list(): readonly { pluginId: string; label: string }[] {
    return this.effects.map(({ pluginId, label }) => ({ pluginId, label }));
  }

  async disposeAll(): Promise<void> {
    const failures: unknown[] = [];
    for (const effect of this.effects.splice(0).reverse()) {
      this.keys.delete(effect.key);
      try {
        await effect.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(failures, 'One or more effects failed to dispose');
  }
}

export interface GraphActivationHooks {
  preflightMigrations?(graph: ResolvedGraph): MaybePromise<void>;
  applyMigrations?(graph: ResolvedGraph): MaybePromise<void>;
  stageContributions?(graph: ResolvedGraph): MaybePromise<void>;
  validateStaged?(graph: ResolvedGraph): MaybePromise<void>;
  publish?(graph: ResolvedGraph): MaybePromise<void>;
  rollbackStage?(graph: ResolvedGraph): MaybePromise<void>;
}

export interface ActiveGraph {
  readonly graph: ResolvedGraph;
  readonly catalog: ArchitectureCatalog;
  readonly effects: EffectRegistry;
  dispose(): Promise<void>;
}

export interface ResolveGraphInput {
  readonly profile: ProductProfile;
  readonly bundles: readonly BundleDescriptor[];
  readonly plugins: readonly PluginDescriptor[];
}

export function resolveGraph(input: ResolveGraphInput): ResolvedGraph {
  const bundleRegistry = uniqueById(input.bundles, 'bundle');
  const pluginRegistry = uniqueById(input.plugins, 'plugin');
  const selectedBundles = input.profile.bundleIds.map((id) => {
    const bundle = bundleRegistry.get(id);
    if (!bundle) throw new Error(`Profile ${input.profile.id} references unknown bundle ${id}`);
    return bundle;
  });

  const selected = new Set<string>();
  const visitSelection = (id: string): void => {
    if (selected.has(id)) return;
    const plugin = pluginRegistry.get(id);
    if (!plugin) throw new Error(`Product graph references unknown plugin ${id}`);
    selected.add(id);
    for (const dependency of plugin.dependencies ?? []) visitSelection(dependency.id);
  };
  for (const bundle of selectedBundles) for (const id of bundle.pluginIds) visitSelection(id);

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: PluginDescriptor[] = [];
  const visit = (id: string, trail: readonly string[]): void => {
    if (visited.has(id)) return;
    if (visiting.has(id))
      throw new Error(`Plugin dependency cycle: ${[...trail, id].join(' -> ')}`);
    visiting.add(id);
    const plugin = pluginRegistry.get(id)!;
    for (const dependency of plugin.dependencies ?? []) {
      const target = pluginRegistry.get(dependency.id);
      if (!target) throw new Error(`Plugin ${id} requires missing plugin ${dependency.id}`);
      if (!satisfiesVersion(target.version, dependency.range ?? '*')) {
        throw new Error(
          `Plugin ${id} requires ${dependency.id}@${dependency.range}; found ${target.version}`,
        );
      }
      visit(dependency.id, [...trail, id]);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(plugin);
  };
  for (const id of [...selected].sort()) visit(id, []);

  validateContributions(ordered);
  const revisionInput = {
    profile: { id: input.profile.id, version: input.profile.version },
    bundles: selectedBundles.map(({ id, version }) => ({ id, version })),
    plugins: ordered.map(({ id, version }) => ({ id, version })),
    configuration: input.profile.configuration ?? {},
  };
  const revision = createHash('sha256').update(stableStringify(revisionInput)).digest('hex');
  return Object.freeze({
    profile: input.profile,
    bundles: Object.freeze(selectedBundles),
    plugins: Object.freeze(
      ordered.map((descriptor, order) => Object.freeze({ descriptor, order })),
    ),
    revision,
  });
}

export async function activateGraph(
  graph: ResolvedGraph,
  hooks: GraphActivationHooks = {},
): Promise<ActiveGraph> {
  const effects = new EffectRegistry();
  const services = new ServiceRegistry();
  let staged = false;
  try {
    await hooks.preflightMigrations?.(graph);
    await hooks.applyMigrations?.(graph);
    await hooks.stageContributions?.(graph);
    staged = true;
    for (const { descriptor } of graph.plugins) {
      const context: PluginContext = {
        pluginId: descriptor.id,
        graphRevision: graph.revision,
        services: {
          provide: (token, implementation) => services.provide(descriptor, token, implementation),
          require: (token) => services.require(descriptor, token),
          optional: (token) => services.optional(descriptor, token),
        },
        effect: async <T>(
          label: string,
          acquire: () => MaybePromise<EffectDisposer | AcquiredEffect<T>>,
        ): Promise<T | void> => effects.acquire(descriptor.id, label, acquire),
      } as PluginContext;
      await descriptor.activate(context);
    }
    await hooks.validateStaged?.(graph);
    await hooks.publish?.(graph);
    const catalog = createArchitectureCatalog(graph);
    return {
      graph,
      catalog,
      effects,
      async dispose() {
        await effects.disposeAll();
      },
    };
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await effects.disposeAll();
    } catch (disposeError) {
      failures.push(disposeError);
    }
    if (staged) {
      try {
        await hooks.rollbackStage?.(graph);
      } catch (rollbackError) {
        failures.push(rollbackError);
      }
    }
    if (failures.length === 1) throw error;
    throw new AggregateError(failures, 'Graph activation and rollback failed', { cause: error });
  }
}

export async function resolveAndActivateGraph(
  input: ResolveGraphInput,
  hooks: GraphActivationHooks = {},
): Promise<ActiveGraph> {
  return activateGraph(resolveGraph(input), hooks);
}

export function createArchitectureCatalog(graph: ResolvedGraph): ArchitectureCatalog {
  const services: ArchitectureOwner[] = [];
  const routes: Array<
    ArchitectureOwner & { method: string; path: string; requiredPermission: string | null }
  > = [];
  const events: ArchitectureOwner[] = [];
  const tables: ArchitectureOwner[] = [];
  const migrations: ArchitectureOwner[] = [];
  const uiContributions: ArchitectureOwner[] = [];
  const backgroundHandlers: ArchitectureOwner[] = [];
  for (const { descriptor } of graph.plugins) {
    for (const service of descriptor.providedServices ?? [])
      services.push({ id: service.id, owner: descriptor.id });
    for (const route of descriptor.routes ?? [])
      routes.push({
        id: route.operationId,
        owner: descriptor.id,
        method: route.method.toUpperCase(),
        path: route.path,
        requiredPermission: route.requiredPermission,
      });
    for (const event of descriptor.events ?? [])
      events.push({ id: event.type, owner: descriptor.id });
    for (const migration of descriptor.migrations ?? []) {
      migrations.push({ id: migration.id, owner: descriptor.id });
      for (const table of migration.tables) tables.push({ id: table, owner: descriptor.id });
    }
    for (const contribution of descriptor.uiContributions ?? [])
      uiContributions.push({ id: contribution.id, owner: descriptor.id });
    for (const handler of descriptor.backgroundHandlers ?? [])
      backgroundHandlers.push({ id: handler.type, owner: descriptor.id });
  }
  const byId = <T extends ArchitectureOwner>(items: T[]): T[] =>
    items.sort((left, right) => left.id.localeCompare(right.id));
  return {
    graphRevision: graph.revision,
    profileId: graph.profile.id,
    plugins: graph.plugins.map(({ descriptor }) => ({
      id: descriptor.id,
      version: descriptor.version,
      dependencies: (descriptor.dependencies ?? []).map(({ id }) => id).sort(),
    })),
    services: byId(services),
    routes: byId(routes),
    events: byId(events),
    tables: byId(tables),
    migrations: byId(migrations),
    uiContributions: byId(uiContributions),
    backgroundHandlers: byId(backgroundHandlers),
  };
}

function validateContributions(plugins: readonly PluginDescriptor[]): void {
  const owners = new Map<string, string>();
  const claim = (kind: string, id: string, owner: string): void => {
    const key = `${kind}:${id}`;
    const current = owners.get(key);
    if (current) throw new Error(`Duplicate ${kind} ${id} owned by ${current} and ${owner}`);
    owners.set(key, owner);
  };
  for (const plugin of plugins) {
    if (!plugin.id.trim()) throw new Error('Plugin id is required');
    if (!plugin.version.trim()) throw new Error(`Plugin ${plugin.id} requires a version`);
    for (const service of plugin.providedServices ?? []) claim('service', service.id, plugin.id);
    for (const route of plugin.routes ?? []) {
      if (!Object.hasOwn(route, 'requiredPermission')) {
        throw new Error(
          `Plugin ${plugin.id} route ${route.operationId} must declare requiredPermission`,
        );
      }
      if (
        route.requiredPermission !== null &&
        (typeof route.requiredPermission !== 'string' || !route.requiredPermission.trim())
      ) {
        throw new Error(
          `Plugin ${plugin.id} route ${route.operationId} has a blank requiredPermission`,
        );
      }
      claim('operation', route.operationId, plugin.id);
    }
    for (const event of plugin.events ?? []) claim('event', event.type, plugin.id);
    for (const migration of plugin.migrations ?? []) {
      claim('migration', `${plugin.id}:${migration.id}`, plugin.id);
      for (const table of migration.tables) claim('table', table, plugin.id);
    }
    for (const contribution of plugin.uiContributions ?? [])
      claim('ui contribution', contribution.id, plugin.id);
    for (const handler of plugin.backgroundHandlers ?? [])
      claim('background handler', handler.type, plugin.id);
  }
}

function uniqueById<T extends { readonly id: string }>(
  items: readonly T[],
  kind: string,
): Map<string, T> {
  const registry = new Map<string, T>();
  for (const item of items) {
    if (registry.has(item.id)) throw new Error(`Duplicate ${kind} id ${item.id}`);
    registry.set(item.id, item);
  }
  return registry;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function major(version: string): number {
  const match = /^(\d+)\./.exec(version);
  if (!match) throw new Error(`Invalid semantic version ${version}`);
  return Number(match[1]);
}

function satisfiesVersion(version: string, range: string): boolean {
  if (range === '*' || range === '') return true;
  if (range.startsWith('^')) return major(version) === major(range.slice(1));
  return version === range;
}
