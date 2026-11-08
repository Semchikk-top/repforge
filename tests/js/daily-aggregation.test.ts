import { describe, expect, it } from 'vitest';
import { averageDayDurationMs, dailyStats, dayStat, daySummaryText, trainingDays, weekProgress, weeklyStats } from '../../src/domain/analytics';
import { weeklyReview, shouldShowWeeklyReview, reviewPrompt } from '../../src/domain/weeklyReview';
import { computeStats, ACHIEVEMENTS, earnedNow } from '../../src/game/achievements';
import { buildStats } from '../../src/social/leaderboard';
import { todayAdvice } from '../../src/domain/today';
import type { Exercise, Workout } from '../../src/domain/types';

const H = 3600_000;
const set = (weight: number, reps: number, done = true) => ({ id: Math.random().toString(36).slice(2), weight, reps, done });
let n = 0;
const wk = (date: string, sets: ReturnType<typeof set>[], extra: Partial<Workout> = {}, exerciseId = 'seed-001'): Workout =>
  ({ id: 'w' + ++n, date, title: 'Т' + n, status: 'done', exercises: [{ id: 'e' + n, exerciseId, sets }], createdAt: n, updatedAt: n, deviceId: 'd', ...extra } as unknown as Workout);
const at = (date: string, h: number, durH: number) => ({ startedAt: new Date(`${date}T${String(h).padStart(2, '0')}:00:00`).getTime(), finishedAt: new Date(`${date}T${String(h).padStart(2, '0')}:00:00`).getTime() + durH * H });

const exercises = [{ id: 'seed-001', name: 'Жим', muscle: 'chest' } as Exercise];
const exMap = new Map(exercises.map((e) => [e.id, e]));

// два тренировочных дня: 27.10 — две тренировки, 28.10 — одна
const morning = wk('2026-10-27', [set(100, 10), set(100, 10)], at('2026-10-27', 8, 1));        // 2000 кг, 1 ч
const evening = wk('2026-10-27', [set(50, 10, true), set(20, 10, false)], at('2026-10-27', 19, 0.5)); // 500 кг, 0,5 ч
const next = wk('2026-10-28', [set(60, 10)], at('2026-10-28', 9, 1));                             // 600 кг, 1 ч
const all = [morning, evening, next];

describe('dailyStats', () => {
  it('две тренировки за день: один день, время и тоннаж суммируются', () => {
    const d = dayStat(all, '2026-10-27')!;
    expect(d.sessions).toBe(2);
    expect(d.sets).toBe(3);
    expect(d.volumeKg).toBe(2500);
    expect(d.durationMs).toBe(1.5 * H);
    expect(d.timedSessions).toBe(2);
    expect(dailyStats(all).map((x) => x.date)).toEqual(['2026-10-27', '2026-10-28']);
    expect(trainingDays(all)).toBe(2);
    expect(trainingDays(all, '2026-10-28')).toBe(1);
    expect(trainingDays(all, '2026-10-01', '2026-10-27')).toBe(1);
  });

  it('разминки не входят в подходы и объём', () => {
    const w = wk('2026-10-30', [{ ...set(20, 10), warmup: true } as never, set(80, 5)]);
    expect(dayStat([w], '2026-10-30')).toMatchObject({ sets: 1, volumeKg: 400 });
  });

  it('тренировка без startedAt/finishedAt: время не ломается, timedSessions меньше sessions', () => {
    const noTime = wk('2026-10-27', [set(40, 10)]);
    const d = dayStat([morning, noTime], '2026-10-27')!;
    expect(d.sessions).toBe(2);
    expect(d.timedSessions).toBe(1);
    expect(d.durationMs).toBe(H);
    expect(daySummaryText(d)).toContain('≥ 1 ч');
    expect(daySummaryText(dayStat([morning, evening], '2026-10-27')!)).toBe('2 тренировки · 3 подх. · 2\u00a0500 кг · 1 ч 30 мин');
  });

  it('невалидная длительность не учитывается: конец раньше начала и больше суток', () => {
    const back = wk('2026-10-27', [set(40, 10)], { startedAt: 5000, finishedAt: 1000 });
    const huge = wk('2026-10-27', [set(40, 10)], { startedAt: 0 + 1, finishedAt: 30 * H });
    const d = dayStat([back, huge], '2026-10-27')!;
    expect(d.timedSessions).toBe(0);
    expect(d.durationMs).toBe(0);
  });

  it('удалённые, запланированные и активные тренировки не попадают', () => {
    const junk = [
      wk('2026-10-27', [set(100, 10)], { deletedAt: 1 }),
      wk('2026-10-27', [set(100, 10)], { status: 'planned' }),
      wk('2026-10-27', [set(100, 10)], { status: 'active' })
    ];
    expect(dailyStats(junk)).toEqual([]);
    expect(dayStat(junk, '2026-10-27')).toBeNull();
    expect(dayStat([...junk, morning], '2026-10-27')!.sessions).toBe(1);
  });

  it('кардио считается отдельно от килограммов', () => {
    const run = wk('2026-10-27', [], {
      exercises: [{ id: 'r', exerciseId: 'run', sets: [], cardio: { source: 'gps', distanceM: 5000, durationSec: 1500 } }]
    } as never);
    const d = dayStat([morning, run], '2026-10-27')!;
    expect(d.cardioKm).toBe(5);
    expect(d.cardioSec).toBe(1500);
    expect(d.volumeKg).toBe(2000);
  });

  it('средняя длительность — по тренировочным дням, неполные дни пропускаются', () => {
    expect(averageDayDurationMs(all)).toBe((1.5 * H + H) / 2);
    expect(averageDayDurationMs([wk('2026-10-27', [set(1, 1)])])).toBeNull();
    const partial = [morning, wk('2026-10-27', [set(1, 1)]), next];
    expect(averageDayDurationMs(partial)).toBe(H);
  });
});

describe('недельные счётчики считают дни', () => {
  const now = new Date(2026, 9, 29); // четверг; неделя с 26.10

  it('weeklyStats', () => {
    const last = weeklyStats(all, 2, now).at(-1)!;
    expect(last).toMatchObject({ start: '2026-10-26', days: 2, sessions: 3, sets: 4, volume: 3100 });
  });

  it('weekProgress', () => {
    expect(weekProgress(all, exMap, now)).toEqual({ days: 2, sessions: 3, km: 0 });
  });

  it('weeklyReview', () => {
    const review = weeklyReview(all, exMap, [], new Date(2026, 10, 3)); // разбирается неделя 26.10–01.11
    expect(review.totals).toEqual({ days: 2, sessions: 3, sets: 4, volume: 3100 });
    expect(review.previous.days).toBe(0);
    expect(shouldShowWeeklyReview({ enabled: true, review, seenWeek: null })).toBe(true);
    expect(reviewPrompt(review)).toContain('Тренировочных дней: 2');
  });
});

describe('достижения и рейтинг', () => {
  it('computeStats: день = одна тренировка, дубль сохраняется', () => {
    const s = computeStats(all, exercises);
    expect(s.workouts).toBe(2);
    expect(s.doubleDay).toBe(true);
    expect(s.maxWorkoutVolume).toBe(2500);
    expect(s.longestMs).toBe(1.5 * H);
    expect(s.volumeKg).toBe(3100);
    expect(earnedNow(s).map((a) => a.id)).toContain('double');
    expect(ACHIEVEMENTS.find((a) => a.id === 'double')!.desc).toBe('Две тренировки за один день');
  });

  it('doubleDay не появляется без второй сессии', () => {
    expect(computeStats([morning, next], exercises).doubleDay).toBe(false);
  });

  it('buildStats: totals.workouts считает тренировочные дни', () => {
    const period = { from: '2026-10-26', to: '2026-11-01', tz: 'UTC' };
    const out = buildStats(all, exercises, period);
    expect(out.totals.workouts).toBe(2);
    expect(out.totals.workSets).toBe(4);
    expect(out.totals.volumeKg).toBe(3100);
  });
});

describe('TodayCard: состояние «выполнено»', () => {
  const today = '2026-10-27';
  const input = (workouts: Workout[]) => ({ today, workouts, exercises: [], hasPlan: true, onboardingOffered: false, readiness: null });

  it('одна тренировка: название и итоги', () => {
    const a = todayAdvice(input([morning]));
    expect(a.kind).toBe('done');
    expect(a.detail).toContain('2 подхода, 2000 кг суммарно');
  });

  it('несколько тренировок: сводка по всему дню', () => {
    const a = todayAdvice(input([morning, evening]));
    expect(a.kind).toBe('done');
    expect(a.detail).toContain('2 тренировки · 3 подх. · 2\u00a0500 кг · 1 ч 30 мин');
  });
});
