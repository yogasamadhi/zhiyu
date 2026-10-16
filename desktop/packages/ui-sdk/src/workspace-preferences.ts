import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { runtimeClient } from '@zhiyun/client';
import { useWorkspaceAuth } from './auth.js';
export function useWorkspacePreference<T>(name: string, fallback: T): [T, (value: T) => void] {
  const auth = useWorkspaceAuth();
  const metadata = useQuery({
    queryKey: ['workspace-identity'],
    queryFn: () => runtimeClient.request<{ workspaceId: string }>('/api/v2/workspace'),
  });
  const key = metadata.data
    ? `zhiyun:${metadata.data.workspaceId}:${auth.user?.id ?? 'local'}:${name}`
    : null;
  const [value, setValue] = useState(fallback);
  useEffect(() => {
    if (!key) return;
    const read = () => {
      try {
        const stored = localStorage.getItem(key);
        setValue(stored ? (JSON.parse(stored) as T) : fallback);
      } catch {
        setValue(fallback);
      }
    };
    read();
    window.addEventListener('storage', read);
    window.addEventListener('workspace-preferences', read);
    return () => {
      window.removeEventListener('storage', read);
      window.removeEventListener('workspace-preferences', read);
    };
  }, [key]);
  return [
    value,
    (next: T) => {
      if (!key) return;
      localStorage.setItem(key, JSON.stringify(next));
      setValue(next);
      window.dispatchEvent(new Event('workspace-preferences'));
    },
  ];
}
