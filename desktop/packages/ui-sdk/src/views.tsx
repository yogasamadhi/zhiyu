import { createContext, useContext, type ReactNode } from 'react';
import { emptyUiSnapshot, type UiSnapshot } from './slots.js';
const Contributions = createContext<UiSnapshot>(emptyUiSnapshot);
export function UiContributionsProvider({
  value,
  children,
}: {
  value: UiSnapshot;
  children: ReactNode;
}) {
  return <Contributions.Provider value={value}>{children}</Contributions.Provider>;
}
/** Render another feature through its registered slot, without importing it. */
export function PluginRoute({ id, path }: { id: string; path: string }) {
  const route = useContext(Contributions)
    .routes.find((row) => row.id === id)
    ?.routes.find((row) => row.path === path);
  if (!route) return <p role="alert">此功能未在当前工作区启用。</p>;
  const Page = route.component;
  return <Page />;
}
