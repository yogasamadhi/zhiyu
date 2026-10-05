import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  runtimeClient,
  type AssistantCapabilities,
  type AssistantContext,
  type AssistantDetail,
} from '@zhiyun/client';
import { useWorkspaceAuth } from '../../auth.js';
import { useWorkspacePreference } from '../../workspace-preferences.js';

interface AssistantState {
  selectedId: string | null;
  select(id: string | null): void;
  open: boolean;
  setOpen(value: boolean): void;
  detail: AssistantDetail | undefined;
  capabilities: AssistantCapabilities | undefined;
  busy: boolean;
  pending: boolean;
  error: string;
  streaming: string;
  tool: string;
  perform<T>(work: () => Promise<T>): Promise<T | undefined>;
  start(
    intent?: AssistantContext['intent'],
    resource?: AssistantContext['resource'],
  ): Promise<AssistantDetail>;
  askHere(): Promise<void>;
  refresh(): Promise<void>;
}
const Context = createContext<AssistantState | null>(null);
export function useAssistant() {
  const value = useContext(Context);
  if (!value) throw new Error('Assistant provider is unavailable');
  return value;
}
export function AssistantProvider({ children }: { children: ReactNode }) {
  const auth = useWorkspaceAuth();
  const { i18n } = useTranslation();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [selectedId, select] = useWorkspacePreference<string | null>(
    'assistant-conversation',
    null,
  );
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [streaming, setStreaming] = useState('');
  const [tool, setTool] = useState('');
  const createRef = useRef<Promise<AssistantDetail> | null>(null);
  const owner = auth.user?.id ?? 'local-workspace';
  const graph = useQuery({
    queryKey: ['runtime', 'graph'],
    queryFn: () => runtimeClient.getRuntimeGraph(),
  });
  const enabled =
    graph.data?.routes.some((route) => route.operationId === 'getAssistantCapabilities') ?? false;
  const capabilities = useQuery({
    queryKey: ['assistant', owner, 'capabilities'],
    queryFn: () => runtimeClient.getAssistantCapabilities(),
    enabled,
  });
  useEffect(() => {
    if (enabled)
      void queryClient.invalidateQueries({ queryKey: ['assistant', owner, 'capabilities'] });
  }, [location.pathname, enabled, owner, queryClient]);
  const detail = useQuery({
    queryKey: ['assistant', owner, 'conversation', selectedId],
    queryFn: () => runtimeClient.getAssistantConversation(selectedId!),
    enabled: enabled && Boolean(selectedId),
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.conversation.activeTurnId ||
      query.state.data?.actions.some((action) => action.status === 'running')
        ? 1500
        : false,
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['assistant', owner] });
    await queryClient.invalidateQueries({ queryKey: ['collection-drafts'] });
  };
  useEffect(() => {
    setStreaming('');
    setTool('');
    setError('');
  }, [selectedId, owner]);
  useEffect(
    () =>
      runtimeClient.onRealtimeEvent((event) => {
        if (event.payload.conversationId !== selectedId) return;
        if (event.type === 'assistant.delta')
          setStreaming((text) => text + String(event.payload.delta ?? ''));
        if (event.type === 'assistant.tool') setTool(String(event.payload.name ?? ''));
        if (event.type === 'assistant.updated')
          void queryClient.invalidateQueries({
            queryKey: ['assistant', owner, 'conversation', selectedId],
          });
      }),
    [owner, queryClient, selectedId],
  );
  useEffect(() => {
    if (detail.data && !detail.data.conversation.activeTurnId) {
      setStreaming('');
      setTool('');
    }
  }, [detail.data]);
  const perform = async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    setPending(true);
    setError('');
    try {
      return await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setPending(false);
      await refresh();
    }
  };
  const start = async (
    intent: AssistantContext['intent'] = 'explore',
    resource: AssistantContext['resource'] = null,
  ) => {
    if (!createRef.current)
      createRef.current = runtimeClient
        .createAssistantConversation(
          {
            language: i18n.language.startsWith('zh') ? 'zh' : 'en',
            mode: intent === 'learn' ? 'teach' : 'guide',
            context: { intent, resource, goal: '', question: '', revision: 1 },
          },
          crypto.randomUUID(),
        )
        .then((value) => {
          select(value.conversation.id);
          queryClient.setQueryData(
            ['assistant', owner, 'conversation', value.conversation.id],
            value,
          );
          return value;
        })
        .finally(() => {
          createRef.current = null;
        });
    return createRef.current;
  };
  const askHere = async () => {
    const resource = pageResource(location.pathname, location.search);
    setOpen(true);
    await perform(async () => {
      const current = selectedId
        ? await runtimeClient.getAssistantConversation(selectedId)
        : await start(resource?.kind === 'run' ? 'diagnose' : 'explore', resource);
      const question = i18n.language.startsWith('zh')
        ? '解释当前页面并建议下一步'
        : 'Explain this page and suggest the next step';
      if (resource)
        await runtimeClient.updateAssistantContext(
          current.conversation.id,
          current.conversation.context.revision,
          {
            ...current.conversation.context,
            resource,
            question,
            intent: resource.kind === 'run' ? 'diagnose' : 'explore',
          },
        );
      await runtimeClient.postAssistantMessage(current.conversation.id, question);
    });
  };
  return (
    <Context.Provider
      value={{
        selectedId,
        select,
        open,
        setOpen,
        detail: detail.data,
        capabilities: capabilities.data,
        busy: Boolean(detail.data?.conversation.activeTurnId),
        pending,
        error: error || (detail.error instanceof Error ? detail.error.message : ''),
        streaming,
        tool,
        perform,
        start,
        askHere,
        refresh,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function pageResource(path: string, search: string): AssistantContext['resource'] {
  const draft = new URLSearchParams(search).get('draft');
  if (draft && path.startsWith('/tasks/')) return { kind: 'draft', id: draft };
  const match = path.match(/^\/(tasks|runs|datasets)\/([^/]+)/);
  if (!match || match[2] === 'new') return null;
  return {
    kind: match[1] === 'tasks' ? 'task' : match[1] === 'runs' ? 'run' : 'dataset',
    id: decodeURIComponent(match[2]!),
  };
}
