/** Wire-only contracts: no Cordis context declarations cross this boundary. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}
export interface InvokeInput {
  workspaceId: string;
  operationId: string;
  path?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  body?: Json;
  headers?: Record<string, string>;
}
export interface ApiResult {
  status: number;
  headers: Record<string, string>;
  body: Json;
}
export interface EventFrame {
  channel: 'domain' | 'realtime' | 'runtime';
  data: Json;
}
export interface RuntimeReady {
  url: string;
  token: string;
  generation: number;
  routes: Array<{ operationId: string; method: string; path: string; ownerPluginId: string }>;
}
export interface RuntimeStatus {
  workspaceId: string;
  status: 'ready' | 'degraded';
  generation: number;
  worker: string;
  model: ModelSelection | null;
}
export interface Bootstrap {
  dataDirectory: string;
  workspaceDirectory: string;
  resources: string;
  generation: number;
  model: ModelSelection | null;
}
export interface RpcMessage {
  type: 'call' | 'reply' | 'cancel' | 'ready' | 'fatal';
  id: number;
  method?: string;
  value?: unknown;
  error?: string;
}
