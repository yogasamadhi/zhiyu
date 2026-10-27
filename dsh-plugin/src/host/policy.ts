import { resolve, relative, isAbsolute } from 'node:path';
import { realpath, mkdir } from 'node:fs/promises';
import type { InvokeInput, RuntimeReady } from '../shared/protocol.js';

const excluded =
  /^(createSession|.*(?:Auth|Password|Invitation|Member|Audit|Cloud|AssistantConversation|AssistantMessage|ProviderSettings|ProviderCatalog|ApiToken|Backup|Restore|Restart|DataToken).*)$/i;
export function allowedRoute(route: RuntimeReady['routes'][number]): boolean {
  return (
    route.ownerPluginId !== 'preferences' &&
    route.path.startsWith('/api/v2/') &&
    !excluded.test(route.operationId) &&
    !route.path.match(
      /\/(?:auth|identity|cloud|assistant|crawler-assistant|ai\/providers|database|data-tokens|api-tokens)(?:\/|$)/,
    )
  );
}
export function apiRequest(
  routes: RuntimeReady['routes'],
  input: InvokeInput,
): { method: string; path: string; headers: Record<string, string>; body?: string } {
  const route = routes.find(
    (route) => route.operationId === input.operationId && allowedRoute(route),
  );
  if (!route) throw new Error('Unsupported business operation');
  const used = new Set<string>();
  const path = route.path.replace(/\{([^}]+)\}/g, (_, key: string) => {
    const value = input.path?.[key];
    if (!value || value === '.' || value === '..' || /[\u0000-\u001f/\\]/.test(value))
      throw new Error('Invalid path parameter');
    used.add(key);
    return encodeURIComponent(value);
  });
  if (Object.keys(input.path ?? {}).some((key) => !used.has(key)))
    throw new Error('Unexpected path parameter');
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(input.query ?? {})) query.set(key, String(value));
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (
      !['if-match', 'idempotency-key', 'if-none-match'].includes(key.toLowerCase()) ||
      /[\r\n]/.test(value)
    )
      throw new Error('Unsupported request header');
    headers[key.toLowerCase()] = value;
  }
  if (!['GET', 'HEAD'].includes(route.method)) headers['idempotency-key'] ??= crypto.randomUUID();
  return {
    method: route.method,
    path: path + (query.size ? `?${query}` : ''),
    headers,
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  };
}
export async function containedFile(root: string, name: string): Promise<string> {
  if (
    !name ||
    isAbsolute(name) ||
    name.includes('\\') ||
    name.split('/').some((part) => !part || part === '.' || part === '..') ||
    /[\u0000-\u001f]/.test(name)
  )
    throw new Error('Invalid export name');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const actual = await realpath(root);
  const target = resolve(actual, name);
  let parent = actual;
  for (const segment of name.split('/').slice(0, -1)) {
    parent = resolve(parent, segment);
    await mkdir(parent, { mode: 0o700 }).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const rel = relative(actual, await realpath(parent));
    if (rel.startsWith('..') || isAbsolute(rel))
      throw new Error('Export path escapes its selected directory');
  }
  try {
    const existing = await realpath(target);
    if (existing !== target) throw new Error('Export target must not be a symbolic link');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return target;
}

/** Model arguments may reference credentials but may never supply secret values. */
export function assertToolInput(value: unknown, path: string[] = []): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(authorization|cookie|password|api[-_]?key|secret|token)$/i.test(key) && child)
      throw new Error('Configure secrets through the workbench; use credential references');
    if (key === 'cookies' && Array.isArray(child) && child.length)
      throw new Error('Use a saved login session');
    if (
      path.includes('requestSettings') &&
      ['headers', 'proxy'].includes(key) &&
      child &&
      Object.keys(child).length
    )
      throw new Error('Store request credentials in DSH and use references');
    assertToolInput(child, [...path, key]);
  }
}
