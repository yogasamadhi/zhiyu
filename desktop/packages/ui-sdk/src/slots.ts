import { Service, type Context } from '@deepseek-ai/cordis';
import type { ComponentType, LazyExoticComponent, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { QueryClient } from '@tanstack/react-query';
import type { runtimeClient, IdentityPermission } from '@zhiyun/client';
import type { i18n } from 'i18next';

export type ShellNavigationGroup = 'collection' | 'data' | 'automation' | 'system';
export interface ShellRouteContribution {
  id: string;
  order: number;
  routes: Array<{ path: string; component: LazyExoticComponent<ComponentType> }>;
}
export interface ShellNavigationContribution {
  id: string;
  order: number;
  to: string;
  labelKey: string;
  requiredPermission?: IdentityPermission;
  group: ShellNavigationGroup;
  icon: LucideIcon;
}
export interface ShellPanelContribution {
  id: string;
  order: number;
  component: ComponentType;
}
export interface ShellWrapperContribution {
  id: string;
  order: number;
  component: ComponentType<{ children: ReactNode }>;
}
export interface UiSnapshot {
  routes: readonly ShellRouteContribution[];
  navigation: readonly ShellNavigationContribution[];
  panels: readonly ShellPanelContribution[];
  wrappers: readonly ShellWrapperContribution[];
}
export const emptyUiSnapshot: UiSnapshot = Object.freeze({
  routes: [],
  navigation: [],
  panels: [],
  wrappers: [],
});

/** DSH-style registration surface; every registration returns its disposer. */
export class UiSlots extends Service {
  private readonly routes = new Map<string, ShellRouteContribution>();
  private readonly navigation = new Map<string, ShellNavigationContribution>();
  private readonly panels = new Map<string, ShellPanelContribution>();
  private readonly wrappers = new Map<string, ShellWrapperContribution>();
  private readonly claimed = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private snapshot: UiSnapshot = emptyUiSnapshot;
  constructor(
    ctx: Context,
    private readonly enabledIds: ReadonlySet<string>,
  ) {
    super(ctx, 'slots');
    ctx.effect(
      () => () => {
        this.routes.clear();
        this.navigation.clear();
        this.panels.clear();
        this.wrappers.clear();
        this.claimed.clear();
        this.publish();
        this.listeners.clear();
      },
      'ui-slots',
    );
  }
  private publish() {
    const ordered = <T extends { order: number }>(items: Map<string, T>): readonly T[] =>
      Object.freeze([...items.values()].sort((a, b) => a.order - b.order));
    this.snapshot = Object.freeze({
      routes: ordered(this.routes),
      navigation: ordered(this.navigation),
      panels: ordered(this.panels),
      wrappers: ordered(this.wrappers),
    });
    for (const listener of this.listeners) listener();
  }
  private register<T extends { id: string }>(map: Map<string, T>, value: T): () => void {
    if (!this.enabledIds.has(value.id)) return () => {};
    if (this.claimed.has(value.id)) throw new Error(`Duplicate UI contribution: ${value.id}`);
    this.claimed.add(value.id);
    map.set(value.id, value);
    this.publish();
    return () => {
      if (map.delete(value.id)) {
        this.claimed.delete(value.id);
        this.publish();
      }
    };
  }
  registerRoute(value: ShellRouteContribution) {
    return this.register(this.routes, value);
  }
  registerNavigation(value: ShellNavigationContribution) {
    return this.register(this.navigation, value);
  }
  registerPanel(value: ShellPanelContribution) {
    return this.register(this.panels, value);
  }
  registerWrapper(value: ShellWrapperContribution) {
    return this.register(this.wrappers, value);
  }
  getSnapshot = (): UiSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: UiSlots;
    runtimeClient: typeof runtimeClient;
    queryClient: QueryClient;
    locale: i18n;
  }
}
