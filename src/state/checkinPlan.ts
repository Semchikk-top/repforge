// Чистая логика планирования напоминаний о чек-инах (без React и системных вызовов): её проверяют тесты.
// Напоминания идут через ту же платформенную инфраструктуру локальных уведомлений, что и напоминания о тренировках:
// второго планировщика нет.

import { addDays, toDateStr } from '../lib';
import type { CheckInSlot } from '../domain/types';

export const CHECKIN_REMINDER_PREFIX = 'checkin-reminder:';
export const CHECKIN_TAG: Record<CheckInSlot, string> = { morning: 'checkin-morning', evening: 'checkin-evening' };
export const CHECKIN_HORIZON_DAYS = 7;

export interface CheckInReminderSettings {
  checkinMorningEnabled: boolean;
  checkinMorningTime: string;
  checkinEveningEnabled: boolean;
  checkinEveningTime: string;
}

export interface CheckInReminderPlan { id: string; at: number; slot: CheckInSlot; date: string; tag: string; title: string; body: string }

const TEXT: Record<CheckInSlot, { title: string; body: string }> = {
  morning: { title: 'Как самочувствие?', body: 'Утренний чек-ин занимает 15 секунд' },
  evening: { title: 'Итог дня', body: 'Вечерний чек-ин занимает 15 секунд' }
};

export const checkInReminderId = (date: string, slot: CheckInSlot) => `${CHECKIN_REMINDER_PREFIX}${date}:${slot}`;

function parseTime(t: string): { h: number; m: number } | null {
  const x = /^(\d{2}):(\d{2})$/.exec(t);
  if (!x) return null;
  const h = Number(x[1]), m = Number(x[2]);
  return h > 23 || m > 59 ? null : { h, m };
}

/**
 * Моменты напоминаний на ближайшие дни: по одному на включённый слот и день, только в будущем, в выбранное локальное время.
 * Слот, уже заполненный за эту дату, пропускается: повторное уведомление не показывается.
 */
export function planCheckInReminders(opts: {
  settings: CheckInReminderSettings;
  /** Есть ли чек-ин за эту дату и слот. */
  isFilled: (date: string, slot: CheckInSlot) => boolean;
  now: number;
  horizonDays?: number;
}): CheckInReminderPlan[] {
  const { settings, isFilled, now } = opts;
  const horizon = opts.horizonDays ?? CHECKIN_HORIZON_DAYS;
  const slots: { slot: CheckInSlot; time: { h: number; m: number } | null }[] = [
    { slot: 'morning', time: settings.checkinMorningEnabled ? parseTime(settings.checkinMorningTime) : null },
    { slot: 'evening', time: settings.checkinEveningEnabled ? parseTime(settings.checkinEveningTime) : null }
  ];
  const start = new Date(now);
  const limit = now + horizon * 86_400_000;
  const out: CheckInReminderPlan[] = [];
  for (let i = 0; i <= horizon; i++) {
    const day = addDays(new Date(start.getFullYear(), start.getMonth(), start.getDate()), i);
    const date = toDateStr(day);
    for (const { slot, time } of slots) {
      if (!time) continue;
      const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.h, time.m).getTime();
      if (!Number.isFinite(at) || at <= now || at > limit) continue;
      if (isFilled(date, slot)) continue;
      out.push({ id: checkInReminderId(date, slot), at, slot, date, tag: CHECKIN_TAG[slot], ...TEXT[slot] });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Слот, который сейчас уместно предложить: до 15:00 утренний, позже вечерний. */
export const currentSlot = (now: Date = new Date()): CheckInSlot => (now.getHours() < 15 ? 'morning' : 'evening');

/** По тегу нажатого уведомления определяет слот; для чужих уведомлений null. */
export function slotFromTag(tag: string): CheckInSlot | null {
  return tag === CHECKIN_TAG.morning ? 'morning' : tag === CHECKIN_TAG.evening ? 'evening' : null;
}
