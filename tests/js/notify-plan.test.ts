import { describe, expect, it } from 'vitest';
import { planReminders, planRestNotification, staleReminderIds } from '../../src/state/notifyPlan';
import { pauseState, startState } from '../../src/state/timerCore';

describe('уведомление об окончании отдыха', () => {
  const now = 1_000_000;
  const running = startState(90, now);

  it('в фоне планируется ровно на момент окончания', () => {
    expect(planRestNotification(running, false, now + 10_000)).toEqual({ kind: 'schedule', at: now + 90_000 });
  });

  it('на экране не планируется: сигнал подаёт само приложение', () => {
    expect(planRestNotification(running, true, now + 10_000)).toEqual({ kind: 'cancel' });
  });

  it('пауза, пропуск и уже закончившийся отдых уведомления не требуют', () => {
    expect(planRestNotification(pauseState(running, now + 5_000), false, now + 5_000)).toEqual({ kind: 'cancel' });
    expect(planRestNotification(null, false, now)).toEqual({ kind: 'cancel' });
    expect(planRestNotification(running, false, now + 90_000)).toEqual({ kind: 'cancel' });
    expect(planRestNotification(running, false, now + 120_000)).toEqual({ kind: 'cancel' });
  });
});

describe('напоминания о плановых тренировках', () => {
  // 2026-10-30 08:00 по местному времени
  const now = new Date(2026, 9, 30, 8, 0).getTime();
  const w = (id: string, date: string, title = 'Ноги') => ({ id, date, title });

  it('по одному на тренировку, в выбранное локальное время, по возрастанию', () => {
    const plan = planReminders([w('b', '2026-11-02'), w('a', '2026-10-30', 'Грудь')], '18:30', now);
    expect(plan.map((p) => p.id)).toEqual(['workout-reminder:a', 'workout-reminder:b']);
    expect(plan[0].at).toBe(new Date(2026, 9, 30, 18, 30).getTime());
    expect(plan[0]).toMatchObject({ title: 'Пора тренироваться', body: 'Сегодня по плану: Грудь' });
  });

  it('время, которое уже прошло, и тренировки за горизонтом пропускаются', () => {
    expect(planReminders([w('a', '2026-10-30')], '07:59', now)).toEqual([]);
    expect(planReminders([w('a', '2026-10-30')], '08:00', now)).toEqual([]); // ровно сейчас — уже не будущее
    expect(planReminders([w('a', '2026-11-10')], '09:00', now)).toEqual([]);
    expect(planReminders([w('a', '2026-11-05')], '09:00', now)).toHaveLength(1);
    expect(planReminders([w('a', '2026-11-06')], '07:59', now)).toHaveLength(1); // ровно в пределах 7 суток от «сейчас»
    expect(planReminders([w('a', '2026-11-06')], '09:00', now)).toEqual([]);
  });

  it('мусор во времени и датах не ломает расчёт', () => {
    expect(planReminders([w('a', '2026-10-31')], '25:00', now)).toEqual([]);
    expect(planReminders([w('a', '2026-10-31')], '9:00', now)).toEqual([]);
    expect(planReminders([w('a', 'завтра'), w('b', '2026-13-45')], '09:00', now)).toEqual([]);
  });

  it('устаревшие напоминания отменяются, нужные остаются', () => {
    const wanted = planReminders([w('keep', '2026-10-31')], '09:00', now);
    expect(staleReminderIds(['workout-reminder:keep', 'workout-reminder:gone'], wanted)).toEqual(['workout-reminder:gone']);
    expect(staleReminderIds([], wanted)).toEqual([]);
  });
});
