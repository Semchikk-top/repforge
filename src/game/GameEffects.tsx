// Невидимый компонент: держит журнал в актуальном состоянии и применяет выбранный цвет приложения.
import { useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { useSettings } from '../state/settings';
import { resolveTheme } from '../state/theme';
import { useToast } from '../ui/Toast';
import { ITEM_BY_ID, type AccentItem } from './catalog';
import { useGame } from './hooks';
import { reconcileGame } from './store';

export function GameEffects() {
  const toast = useToast();
  const { settings } = useSettings();
  const { equipped } = useGame();

  // Подпись завершённых тренировок: меняется, когда тренировку завершили, правили или она пришла синхронизацией
  const sig = useLiveQuery(async () => {
    const done = await db.workouts.where('status').equals('done').toArray();
    return done.length + ':' + done.reduce((m, w) => Math.max(m, w.updatedAt), 0);
  }, [], '');
  const first = useRef(true);
  useEffect(() => {
    if (sig === '' || sig === undefined) return;
    const t = window.setTimeout(() => {
      void reconcileGame().then((r) => {
        const n = r.newAchievements.length;
        if (n === 1) toast(`Достижение: ${r.newAchievements[0].title} (+${r.newAchievements[0].reward} монет)`);
        else if (n > 1) toast(first.current ? `Засчитано достижений за прошлые тренировки: ${n}` : `Новых достижений: ${n}`);
      }).catch(() => { /* журнал досчитается при следующей сверке */ });
      first.current = false;
    }, 700);
    return () => window.clearTimeout(t);
  }, [sig, toast]);

  // Цвет приложения: перекрывает переменные темы, у светлой темы свой оттенок
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const it = ITEM_BY_ID.get(equipped.accent) as AccentItem | undefined;
      if (!it || it.id === 'ac-default') { root.style.removeProperty('--accent'); root.style.removeProperty('--accent-ink'); return; }
      const light = resolveTheme(settings.theme) === 'light';
      root.style.setProperty('--accent', light ? it.light : it.dark);
      root.style.setProperty('--accent-ink', light ? '#ffffff' : '#111418');
    };
    apply();
    if (settings.theme !== 'auto') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [equipped.accent, settings.theme]);

  return null;
}
