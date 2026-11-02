// Чистая логика планирования уведомлений (без React и системных вызовов): её проверяют тесты.
import { isPaused, type TimerState } from './timerCore';

export const REST_TAG = 'rest-timer';
export const REST_ADD_ACTION = 'add15';
export const REST_ADD_SEC = 15;

export type RestPlan = { kind: 'schedule'; at: number } | { kind: 'cancel' };

/**
 * Уведомление об окончании отдыха нужно только пока приложение свёрнуто: на экране приложение само подаёт сигнал,
 * и второе уведомление поверх него было бы лишним. Пауза, завершённый или отсутствующий таймер уведомления не требуют.
 */
export function planRestNotification(state: TimerState | null, appVisible: boolean, now: number): RestPlan {
  if (appVisible || !state || isPaused(state) || state.endsAt <= now) return { kind: 'cancel' };
  return { kind: 'schedule', at: state.endsAt };
}

export interface PlannedWorkoutLite { id: string; date: string; title: string }
export interface ReminderPlan { id: string; at: number; title: string; body: string }

export const REMINDER_PREFIX = 'workout-reminder:';
export const REMINDER_HORIZON_DAYS = 7;

/** Моменты напоминаний на ближайшие дни: по одному на плановую тренировку, только в будущем, в выбранное локальное время. */
export function planReminders(workouts: PlannedWorkoutLite[], reminderTime: string, now: number, horizonDays = REMINDER_HORIZON_DAYS): ReminderPlan[] {
  const m = /^(\d{2}):(\d{2})$/.exec(reminderTime);
  if (!m) return [];
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return [];
  const limit = now + horizonDays * 86_400_000;
  const out: ReminderPlan[] = [];
  for (const w of workouts) {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(w.date);
    if (!d) continue;
    const at = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), h, min).getTime();
    if (!Number.isFinite(at) || at <= now || at > limit) continue;
    out.push({ id: REMINDER_PREFIX + w.id, at, title: 'Пора тренироваться', body: `Сегодня по плану: ${w.title}` });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Какие ранее запланированные напоминания надо отменить: те, что больше не нужны. */
export const staleReminderIds = (previous: string[], wanted: ReminderPlan[]): string[] => {
  const keep = new Set(wanted.map((r) => r.id));
  return previous.filter((id) => !keep.has(id));
};
