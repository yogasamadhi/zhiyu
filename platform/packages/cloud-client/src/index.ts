import createClient from 'openapi-fetch';
import type { paths } from './generated.js';
import {
  cloudPrefix,
  type CloudListInput,
  type CloudListPage,
  type CloudListPath,
} from '@zhiyun/cloud-contracts';
export type { paths } from './generated.js';
export * from '@zhiyun/cloud-contracts';
export const client = createClient<paths>({
  baseUrl: '',
  credentials: 'include',
  cache: 'no-store',
});
export type ApiPath = keyof paths;
export async function request<T = unknown>(
  path: ApiPath,
  body?: unknown,
  csrf?: string,
  options: { query?: Record<string, string | number | undefined>; signal?: AbortSignal } = {},
): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(options.query ?? {}))
    if (value !== undefined && value !== '') query.set(key, String(value));
  const response = await fetch(`${path}${query.size ? `?${query}` : ''}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'include',
    cache: 'no-store',
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(csrf ? { 'x-csrf-token': csrf } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json()) as { data: T; error?: { code: string } };
  if (!response.ok) throw new Error(data.error?.code ?? `HTTP_${response.status}`);
  return data.data;
}

export function requestList<T = Record<string, unknown>>(
  path: CloudListPath,
  query: CloudListInput = {},
  signal?: AbortSignal,
): Promise<CloudListPage<T>> {
  return request<CloudListPage<T>>(`${cloudPrefix}${path}` as ApiPath, undefined, undefined, {
    query: { ...query },
    ...(signal ? { signal } : {}),
  });
}
