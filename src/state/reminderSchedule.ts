import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { addDays, toDateStr, todayStr } from '../lib';
import { platform } from '../platform';
import { planReminders, REMINDER_HORIZON_DAYS, staleReminderIds, type PlannedWorkoutLite } from './notifyPlan';
import { useSettings } from './settings';

const SCHEDULED = 'reminder.scheduled';

/**
 * Нативная оболочка: напоминания о плановых тренировках планируются заранее системой (без сервера и без открытого
 * приложения). Список пересчитывается при изменении плана, настроек и при каждом возврате в приложение;
 * то, что перестало быть нужным (тренировка выполнена, удалена, перенесена, напоминание выключено), отменяется.
 */
export function useScheduledReminders(): void {
  const { settings, ready } = useSettings();
  const today = todayStr();
  const planned = useLiveQuery(async (): Promise<PlannedWorkoutLite[]> => {
    const to = toDateStr(addDays(new Date(), REMINDER_HORIZON_DAYS));
    const rows = await db.workouts.where('date').between(today, to, true, true).toArray();
    return rows.filter((w) => !w.deletedAt && w.status === 'planned').map((w) => ({ id: w.id, date: w.date, title: w.title }));
  }, [today]);

  useEffect(() => {
    if (!platform.notifications.background || !ready || !planned) return;
    let alive = true;
    const sync = async () => {
      const wanted = settings.reminderEnabled ? planReminders(planned, settings.reminderTime, Date.now()) : [];
      const raw = (await db.kv.get(SCHEDULED))?.value;
      const previous = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
      if (!alive) return;
      for (const id of staleReminderIds(previous, wanted)) await platform.notifications.cancel(id);
      for (const r of wanted) await platform.notifications.schedule(r.id, r.at, { title: r.title, body: r.body, tag: 'workout-reminder', channel: 'reminders' });
      await db.kv.put({ key: SCHEDULED, value: wanted.map((r) => r.id) });
    };
    void sync();
    const offResume = platform.lifecycle.onResume(() => void sync());
    return () => { alive = false; offResume(); };
  }, [ready, planned, settings.reminderEnabled, settings.reminderTime]);
}
