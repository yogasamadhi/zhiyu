import { useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const storageKey = 'zhiyun-theme';
const changeEvent = 'zhiyun-theme-change';
const darkQuery = '(prefers-color-scheme: dark)';

export function readThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(storageKey);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

/** Applies the stored preference before React renders, so the first paint uses the right palette. */
export function applyThemePreference(preference = readThemePreference()) {
  if (typeof document === 'undefined') return;
  if (preference === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = preference;
}

export function setThemePreference(preference: ThemePreference) {
  try {
    if (preference === 'system') localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, preference);
  } catch {
    /* Storage can be unavailable; the choice still applies to this window. */
  }
  applyThemePreference(preference);
  window.dispatchEvent(new Event(changeEvent));
}

function resolveTheme(): ResolvedTheme {
  const preference = readThemePreference();
  if (preference !== 'system') return preference;
  return typeof matchMedia === 'function' && matchMedia(darkQuery).matches ? 'dark' : 'light';
}

/** The palette currently on screen, following both the stored preference and the system setting. */
export function useResolvedTheme(): ResolvedTheme {
  const [theme, setTheme] = useState(resolveTheme);
  useEffect(() => {
    const update = () => setTheme(resolveTheme());
    const media = typeof matchMedia === 'function' ? matchMedia(darkQuery) : undefined;
    media?.addEventListener('change', update);
    window.addEventListener(changeEvent, update);
    return () => {
      media?.removeEventListener('change', update);
      window.removeEventListener(changeEvent, update);
    };
  }, []);
  return theme;
}
