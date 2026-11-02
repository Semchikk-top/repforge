import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { addDays, toDateStr, todayStr } from '../lib';
import { platform } from '../platform';
import { go } from './router';
import { staleReminderIds } from './notifyPlan';
import { CHECKIN_HORIZON_DAYS, planCheckInReminders, slotFromTag } from './checkinPlan';
import { useSettings } from './settings';

const SCHEDULED = 'checkin.scheduled';

/**
 * Нативная оболочка: напоминания о чек-инах планируются заранее системой, как и напоминания о тренировках.
 * Список пересчитывается при изменении настроек и чек-инов и при каждом возврате в приложение; заполненный слот напоминание снимает.
 * Нажатие на уведомление открывает нужный слот.
 */
export function useCheckInReminders(): void {
  const { settings, ready } = useSettings();
  const today = todayStr();
  const filled = useLiveQuery(async () => {
    const to = toDateStr(addDays(new Date(), CHECKIN_HORIZON_DAYS));
    const rows = await db.checkins.where('date').between(today, to, true, true).toArray();
    return rows.filter((c) => !c.deletedAt).map((c) => `${c.date}:${c.slot}`);
  }, [today]);

  useEffect(() => {
    if (!platform.notifications.background || !ready || !filled) return;
    let alive = true;
    const have = new Set(filled);
    const sync = async () => {
      const wanted = planCheckInReminders({ settings, isFilled: (d, s) => have.has(`${d}:${s}`), now: Date.now() });
      const raw = (await db.kv.get(SCHEDULED))?.value;
      const previous = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
      if (!alive) return;
      for (const id of staleReminderIds(previous, wanted)) await platform.notifications.cancel(id);
      for (const r of wanted) await platform.notifications.schedule(r.id, r.at, { title: r.title, body: r.body, tag: r.tag, channel: 'reminders' });
      await db.kv.put({ key: SCHEDULED, value: wanted.map((r) => r.id) });
    };
    void sync();
    const offResume = platform.lifecycle.onResume(() => void sync());
    return () => { alive = false; offResume(); };
  }, [ready, filled, settings.checkinMorningEnabled, settings.checkinMorningTime, settings.checkinEveningEnabled, settings.checkinEveningTime]);

  // нажатие на само уведомление (не на кнопку под ним) ведёт сразу в нужный слот
  useEffect(() => platform.notifications.onAction((_actionId, tag) => {
    const slot = slotFromTag(tag);
    if (slot) go(`checkin/${slot}`);
  }), []);
}
