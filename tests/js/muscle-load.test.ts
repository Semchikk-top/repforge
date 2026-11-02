import { describe, expect, it } from 'vitest';
import { LOAD_PERIODS, muscleLoad, percentShares, STRENGTH_MUSCLES } from '../../src/domain/analytics';
import type { Exercise, SetEntry, Workout } from '../../src/domain/types';

const meta = (id: string) => ({ id, createdAt: 0, updatedAt: 0, deviceId: 'test' });
const ex = (id: string, muscle: Exercise['muscle']): Exercise => ({ ...meta(id), name: id, muscle, equipment: '', custom: false });
const exMap = new Map([ex('bench', 'chest'), ex('row', 'back'), ex('squat', 'legs'), ex('run', 'cardio')].map((e) => [e.id, e]));

const set = (weight: number, reps: number, extra: Partial<SetEntry> = {}): SetEntry => ({ id: Math.random().toString(36).slice(2), weight, reps, done: true, ...extra });
const workout = (id: string, date: string, parts: [string, SetEntry[]][], extra: Partial<Workout> = {}): Workout => ({
  ...meta(id), date, title: id, status: 'done',
  exercises: parts.map(([exerciseId, sets], i) => ({ id: `${id}-${i}`, exerciseId, sets })), ...extra
});

const now = new Date(2026, 9, 31, 12, 0); // 31 октября 2026
const by = (r: ReturnType<typeof muscleLoad>) => Object.fromEntries(r.map((m) => [m.muscle, m]));

describe('доли с суммой ровно 100', () => {
  it('метод наибольших остатков: одна треть на три группы даёт 34/33/33', () => {
    expect(percentShares([1, 1, 1])).toEqual([34, 33, 33]);
    expect(percentShares([1, 1, 1]).reduce((a, v) => a + v, 0)).toBe(100);
  });

  it('сумма равна 100 для произвольных значений', () => {
    for (const v of [[7, 3, 11, 5], [1, 2, 3, 4, 5, 6, 7], [0, 0, 5], [1, 1000, 1], [3, 3, 3, 3, 3, 3, 3]]) {
      expect(percentShares(v).reduce((a, x) => a + x, 0)).toBe(100);
    }
  });

  it('нулевая сумма — все нули, нулевые значения остаются нулями', () => {
    expect(percentShares([0, 0, 0])).toEqual([0, 0, 0]);
    expect(percentShares([0, 4, 0])).toEqual([0, 100, 0]);
    expect(percentShares([])).toEqual([]);
  });
});

describe('роза нагрузки', () => {
  const history = [
    workout('w1', '2026-10-30', [['bench', [set(100, 5), set(100, 5), set(100, 5)]], ['row', [set(60, 10)]]]),
    workout('w2', '2026-10-28', [['squat', [set(120, 5)]]])
  ];

  it('все десять силовых групп присутствуют всегда, пустые видны нулями', () => {
    const r = muscleLoad(history, exMap, { days: 7, now });
    expect(r.map((m) => m.muscle)).toEqual(STRENGTH_MUSCLES);
    expect(r).toHaveLength(10);
    expect(by(r).biceps).toMatchObject({ sets: 0, volume: 0, share: 0 });
    expect(by(r).chest.sets).toBe(3);
  });

  it('без тренировок все доли нули, но группы на месте', () => {
    const r = muscleLoad([], exMap, { now });
    expect(r).toHaveLength(10);
    expect(r.every((m) => m.share === 0 && m.delta === 0)).toBe(true);
  });

  it('подходы и тоннаж дают разные, но корректные картины', () => {
    const sets = by(muscleLoad(history, exMap, { days: 7, metric: 'sets', now }));
    const vol = by(muscleLoad(history, exMap, { days: 7, metric: 'volume', now }));
    // подходы: грудь 3, спина 1, ноги 1 → 60/20/20
    expect([sets.chest.share, sets.back.share, sets.legs.share]).toEqual([60, 20, 20]);
    // тоннаж: грудь 1500, спина 600, ноги 600 → доли 55/22/22 с суммой 100
    expect(vol.chest.volume).toBe(1500);
    expect(vol.back.volume).toBe(600);
    expect(vol.chest.share + vol.back.share + vol.legs.share).toBe(100);
    expect(vol.chest.share).toBeGreaterThan(sets.chest.share - 10);
    expect(vol.legs.share).toBe(vol.back.share);
  });

  it('разминка, невыполненные подходы, незавершённые и удалённые тренировки не учитываются', () => {
    const noisy = [
      workout('a', '2026-10-30', [['bench', [set(40, 10, { warmup: true }), set(100, 5, { done: false }), set(100, 5)]]]),
      workout('b', '2026-10-30', [['bench', [set(100, 5)]]], { status: 'active' }),
      workout('c', '2026-10-30', [['bench', [set(100, 5)]]], { status: 'planned' }),
      workout('d', '2026-10-30', [['bench', [set(100, 5)]]], { deletedAt: 1 })
    ];
    const chest = by(muscleLoad(noisy, exMap, { days: 7, now })).chest;
    expect(chest.sets).toBe(1);
    expect(chest.volume).toBe(500);
    expect(chest.share).toBe(100);
  });

  it('кардио и неизвестные упражнения в силовую розу не попадают', () => {
    const w = workout('r', '2026-10-30', [['run', [set(0, 1)]], ['ghost', [set(50, 5)]], ['bench', [set(100, 5)]]]);
    const r = muscleLoad([w], exMap, { days: 7, now });
    expect(r.reduce((a, m) => a + m.sets, 0)).toBe(1);
    expect(r.some((m) => (m.muscle as string) === 'cardio')).toBe(false);
  });

  it('периоды 7/30/90 дней: граница включает ровно N дней, считая сегодня', () => {
    expect([...LOAD_PERIODS]).toEqual([7, 30, 90]);
    const ws = [
      workout('t0', '2026-10-31', [['bench', [set(100, 5)]]]),  // сегодня
      workout('t6', '2026-10-25', [['row', [set(60, 10)]]]),    // 6 дней назад: последний день семидневного окна
      workout('t7', '2026-10-24', [['squat', [set(100, 5)]]]),  // 7 дней назад: вне окна 7, в окне 30
      workout('t40', '2026-09-21', [['squat', [set(100, 5)]]]), // 40 дней назад: вне окна 30, в окне 90
      workout('t100', '2026-07-23', [['squat', [set(100, 5)]]]) // 100 дней назад: вне всех окон
    ];
    const total = (days: number) => muscleLoad(ws, exMap, { days, now }).reduce((a, m) => a + m.sets, 0);
    expect(total(7)).toBe(2);
    expect(total(30)).toBe(3);
    expect(total(90)).toBe(4);
  });

  it('будущие тренировки в период не попадают', () => {
    const r = muscleLoad([workout('f', '2026-11-05', [['bench', [set(100, 5)]]])], exMap, { days: 7, now });
    expect(r.every((m) => m.sets === 0)).toBe(true);
  });

  it('отклонение от собственного среднего за 8 недель', () => {
    // 8 недель назад и позже: грудь и спина поровну, а за последние 7 дней только грудь
    const ws = [
      workout('o1', '2026-09-10', [['bench', [set(100, 5), set(100, 5)]], ['row', [set(60, 10), set(60, 10)]]]),
      workout('o2', '2026-10-29', [['bench', [set(100, 5), set(100, 5)]]])
    ];
    const r = by(muscleLoad(ws, exMap, { days: 7, now }));
    expect(r.chest.share).toBe(100);
    expect(r.chest.baselineShare).toBe(67);          // 4 из 6 подходов за 8 недель
    expect(r.chest.delta).toBe(33);
    expect(r.back.share).toBe(0);
    expect(r.back.delta).toBe(-33);
    const sum = Object.values(r).reduce((a, m) => a + m.delta, 0);
    expect(sum).toBe(0);
  });
});
