import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_SETTINGS, type Settings } from '../domain/types';
import { loadSettings, saveSettings } from '../db/repo';
import { applyTheme } from './theme';

interface Ctx {
  settings: Settings;
  ready: boolean;
  update: (patch: Partial<Settings>) => void;
}

const SettingsContext = createContext<Ctx>({ settings: DEFAULT_SETTINGS, ready: false, update: () => {} });

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    loadSettings().then((s) => { setSettings(s); setReady(true); });
  }, []);

  // тема следует за настройкой и, в режиме «авто», за системной
  useEffect(() => {
    applyTheme(settings.theme);
    if (settings.theme !== 'auto') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const on = () => applyTheme('auto');
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [settings.theme]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      void saveSettings(next);
      return next;
    });
  }, []);

  return <SettingsContext.Provider value={{ settings, ready, update }}>{children}</SettingsContext.Provider>;
}

export const useSettings = () => useContext(SettingsContext);
