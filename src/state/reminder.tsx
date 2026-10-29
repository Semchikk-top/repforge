import { useCallback, useEffect, useState } from 'react';
import { db } from '../db/db';
import type { Workout } from '../domain/types';
import { todayStr } from '../lib';
import { useSettings } from './settings';

const NOTIFIED = 'reminder.notified';
const DISMISSED = 'reminder.dismissed';

async function notify(w: Workout) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const body = `Сегодня по плану: ${w.title}`;
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg) await reg.showNotification('Пора тренироваться', { body, tag: 'workout-reminder', icon: 'icon-192.png' });
    else new Notification('Пора тренироваться', { body });
  } catch { /* уведомление необязательно */ }
}

/** Напоминание о тренировке по плану. Фоновых push-уведомлений нет: сообщение появляется, пока приложение открыто или свёрнуто. */
export function useReminder(): { due: Workout | null; dismiss: () => void } {
  const { settings, ready } = useSettings();
  const [due, setDue] = useState<Workout | null>(null);

  useEffect(() => {
    if (!ready || !settings.reminderEnabled) { setDue(null); return; }
    let timer = 0, alive = true;
    const check = async () => {
      const now = new Date();
      const [h, m] = settings.reminderTime.split(':').map(Number);
      const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
      const today = todayStr();
      const planned = (await db.workouts.where('date').equals(today).toArray()).find((w) => !w.deletedAt && w.status === 'planned');
      const dismissed = (await db.kv.get(DISMISSED))?.value === today;
      if (!alive) return;
      if (now >= at && planned && !dismissed) {
        setDue(planned);
        if ((await db.kv.get(NOTIFIED))?.value !== today) { await db.kv.put({ key: NOTIFIED, value: today }); void notify(planned); }
      } else setDue(null);
      timer = window.setTimeout(() => void check(), now < at ? Math.min(60000, at.getTime() - now.getTime() + 500) : 60000);
    };
    void check();
    const onVis = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); };
  }, [ready, settings.reminderEnabled, settings.reminderTime]);

  const dismiss = useCallback(() => { setDue(null); void db.kv.put({ key: DISMISSED, value: todayStr() }); }, []);
  return { due, dismiss };
}
