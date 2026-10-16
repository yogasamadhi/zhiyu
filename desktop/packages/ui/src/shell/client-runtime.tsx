import { useEffect, useRef, useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { bootClientPlugins } from '@zhiyun/plugin-runtime/client';
import { UiSlots, emptyUiSnapshot, type UiSnapshot } from '@zhiyun/ui-sdk';
import { runtimeClient, type RuntimeGraph } from '@zhiyun/client';
import type { QueryClient } from '@tanstack/react-query';
import i18n from '@zhiyun/ui-sdk/i18n';
import profiles from '../generated/client-profiles.json';
import platform from '@zhiyun/plugin-platform/client';
import datasets from '@zhiyun/plugin-datasets/client';
import collection from '@zhiyun/plugin-collection/client';
import outputs from '@zhiyun/plugin-outputs/client';
import preferences from '@zhiyun/plugin-preferences/client';
import recruitment from '@zhiyun/plugin-recruitment/client';
import analytics from '@zhiyun/plugin-analytics/client';
import corpus from '@zhiyun/plugin-corpus/client';
import aiAssistance from '@zhiyun/plugin-ai-assistance/client';
import identity from '@zhiyun/plugin-identity/client';

const builtins = {
  platform,
  datasets,
  collection,
  outputs,
  preferences,
  recruitment,
  analytics,
  corpus,
  'ai-assistance': aiAssistance,
  identity,
};
export async function createClientRuntime(
  graph: RuntimeGraph,
  queryClient: QueryClient,
): Promise<Context> {
  const entries = profiles[graph.profileId as keyof typeof profiles];
  if (!entries) throw new Error(`Unknown packaged client profile: ${graph.profileId}`);
  const enabledPlugins = new Set(graph.plugins.map(({ id }) => id));
  if (entries.some(({ id }) => !enabledPlugins.has(id)))
    throw new Error(`Runtime and client plugin composition disagree: ${graph.profileId}`);
  return bootClientPlugins({
    entries,
    builtins,
    async prepare(ctx) {
      ctx.provide('runtimeClient', runtimeClient);
      ctx.provide('queryClient', queryClient);
      ctx.provide('locale', i18n);
      await ctx.plugin(UiSlots, new Set(graph.uiContributions.map(({ id }) => id))).await();
    },
  });
}

/** Serialize replacement so old subscriptions finish before the next tree mounts. */
export function useClientRuntime(graph: RuntimeGraph | undefined, queryClient: QueryClient) {
  const [epoch, setEpoch] = useState(0);
  const [state, setState] = useState<{
    snapshot: UiSnapshot;
    pending: boolean;
    error: Error | undefined;
  }>({ snapshot: emptyUiSnapshot, pending: true, error: undefined });
  const queue = useRef(Promise.resolve());
  const active = useRef<Context | undefined>(undefined);
  useEffect(
    () =>
      runtimeClient.onRuntimeReset(() => {
        setState({ snapshot: emptyUiSnapshot, pending: true, error: undefined });
        void queryClient.cancelQueries();
        setEpoch((value) => value + 1);
      }),
    [queryClient],
  );
  useEffect(() => {
    let cancelled = false;
    setState({ snapshot: emptyUiSnapshot, pending: true, error: undefined });
    queue.current = queue.current
      .catch(() => {})
      .then(async () => {
        await active.current?.fiber.dispose();
        active.current = undefined;
        if (cancelled || !graph) return;
        try {
          const ctx = await createClientRuntime(graph, queryClient);
          if (cancelled) {
            await ctx.fiber.dispose();
            return;
          }
          active.current = ctx;
          ctx.effect(
            () =>
              ctx.slots.subscribe(() => {
                if (!cancelled)
                  setState({ snapshot: ctx.slots.getSnapshot(), pending: false, error: undefined });
              }),
            'react-slot-subscription',
          );
          setState({ snapshot: ctx.slots.getSnapshot(), pending: false, error: undefined });
        } catch (cause) {
          if (!cancelled)
            setState({
              snapshot: emptyUiSnapshot,
              pending: false,
              error: cause instanceof Error ? cause : new Error(String(cause)),
            });
        }
      });
    return () => {
      cancelled = true;
      queue.current = queue.current
        .catch(() => {})
        .then(async () => {
          await active.current?.fiber.dispose();
          active.current = undefined;
        });
    };
  }, [graph?.profileId, graph?.graphRevision, epoch, queryClient]);
  return state;
}
