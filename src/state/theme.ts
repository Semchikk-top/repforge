import type { Settings } from '../domain/types';

const LS_KEY = 'theme';
const COLORS = { dark: '#12161c', light: '#f6f4ef' };

export function resolveTheme(t: Settings['theme']): 'dark' | 'light' {
  if (t === 'auto') return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  return t === 'light' ? 'light' : 'dark';
}

/** Применяет тему к странице и запоминает выбор в localStorage, чтобы при следующем запуске она встала до отрисовки (без вспышки) */
export function applyTheme(t: Settings['theme']) {
  const r = resolveTheme(t);
  document.documentElement.dataset.theme = r;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', COLORS[r]);
  try { localStorage.setItem(LS_KEY, t); } catch { /* приватный режим */ }
}

export const storedTheme = (): Settings['theme'] => {
  try { const v = localStorage.getItem(LS_KEY); return v === 'light' || v === 'auto' ? v : 'dark'; } catch { return 'dark'; }
};
