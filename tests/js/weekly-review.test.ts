import { describe, expect, it } from 'vitest';
import { previousWeek, reviewPrompt, shouldShowWeeklyReview, weeklyReview } from '../../src/domain/weeklyReview';
import type { CheckIn, Exercise, Rating, SetEntry, Workout } from '../../src/domain/types';

const meta = (id: string) => ({ id, createdAt: 0, updatedAt: 0, deviceId: 'test' });
const ex = (id: string, name: string, muscle: Exercise['muscle']): Exercise => ({ ...meta(id), name, muscle, equipment: '', custom: false });
const exMap = new Map([ex('bench', 'Жим лёжа', 'chest'), ex('row', 'Тяга', 'back'), ex('squat', 'Присед', 'legs')].map((e) => [e.id, e]));
const set = (weight: number, reps: number): SetEntry => ({ id: Math.random().toString(36).slice(2), weight, reps, done: true });
const wk = (date: string, parts: [string, SetEntry[]][], extra: Partial<Workout> = {}): Workout => ({
  ...meta('w-' + date + parts.map(([e]) => e).join('')), date, title: 't', status: 'done', exercises: parts.map(([exerciseId, sets], i) => ({ id: `${date}-${i}`, exerciseId, sets })), ...extra
});
const R = (n: number) => n as Rating;
const ci = (date: string, energy: number, mood = energy): CheckIn => ({ ...meta('c' + date), id: `ci:${date}:morning`, date, slot: 'morning', energy: R(energy), mood: R(mood), soreness: R(6 - energy), stress: R(6 - energy) });

// сегодня суббота 31 октября 2026: прошлая полная неделя — 19–25 октября
const now = new Date(2026, 9, 31, 12, 0);

describe('прошлая неделя', () => {
  it('понедельник и воскресенье предыдущей полной недели, на любой день', () => {
    expect(previousWeek(now)).toEqual({ start: '2026-10-19', end: '2026-10-25' });
    expect(previousWeek(new Date(2026, 9, 26, 8, 0))).toEqual({ start: '2026-10-19', end: '2026-10-25' }); // понедельник
    expect(previousWeek(new Date(2026, 9, 25, 23, 0))).toEqual({ start: '2026-10-12', end: '2026-10-18' }); // воскресенье
  });
});

describe('недельный разбор', () => {
  const history = [
    wk('2026-09-20', [['bench', [set(80, 5), set(80, 5)]], ['row', [set(60, 8), set(60, 8)]]]),
    wk('2026-10-05', [['bench', [set(80, 5), set(80, 5)]], ['row', [set(60, 8), set(60, 8)]]]),
    wk('2026-10-13', [['bench', [set(80, 5)]], ['row', [set(60, 8)]], ['squat', [set(100, 5), set(100, 5)]]]),
    wk('2026-10-20', [['bench', [set(85, 5), set(85, 5)]], ['squat', [set(100, 5), set(100, 5), set(100, 5)]]]),
    wk('2026-10-23', [['bench', [set(85, 5)]], ['squat', [set(100, 5)]]]),
    wk('2026-10-28', [['bench', [set(90, 5)]]]) // текущая неделя в разбор не входит
  ];

  it('итоги недели и прошлой недели считаются по выполненным рабочим подходам', () => {
    const r = weeklyReview(history, exMap, [], now);
    expect([r.weekStart, r.weekEnd]).toEqual(['2026-10-19', '2026-10-25']);
    expect(r.totals).toEqual({ days: 2, sessions: 2, sets: 7, volume: 85 * 5 * 3 + 100 * 5 * 4 });
    expect(r.previous.days).toBe(1);
  });

  it('рост: лучший расчётный максимум недели выше прежнего, сортировка по приросту', () => {
    const r = weeklyReview(history, exMap, [], now);
    expect(r.growth.map((g) => g.exerciseId)).toEqual(['bench']);
    expect(r.growth[0].pct).toBeGreaterThan(0.05);
    expect(r.growth[0].name).toBe('Жим лёжа');
  });

  it('упражнение без прежней истории ростом не считается', () => {
    const r = weeklyReview([wk('2026-10-20', [['bench', [set(80, 5)]]])], exMap, [], now);
    expect(r.growth).toEqual([]);
  });

  it('недопустимо учитывать тренировки после недели: текущая неделя не влияет', () => {
    const a = weeklyReview(history, exMap, [], now);
    const b = weeklyReview(history.filter((w) => w.date <= '2026-10-25'), exMap, [], now);
    expect(a).toEqual(b);
  });

  it('просевшая группа: жим и тяга обычно занимали заметную долю, а на неделе тяги нет', () => {
    const r = weeklyReview(history, exMap, [], now);
    expect(r.gaps.map((g) => g.muscle)).toEqual(['back']);
    expect(r.gaps[0].delta).toBeLessThanOrEqual(-8);
    expect(r.suggestions[0]).toContain('Спина');
  });

  it('удалённые и незавершённые тренировки не считаются', () => {
    const r = weeklyReview([...history, wk('2026-10-21', [['squat', [set(200, 5)]]], { deletedAt: 1 }), wk('2026-10-22', [['squat', [set(200, 5)]]], { status: 'active' })], exMap, [], now);
    expect(r.totals.days).toBe(2);
  });

  it('не больше двух предложений, застой идёт первым', () => {
    // жим «стоит»: пять тренировок, в последних трёх максимум не выше прежнего, и неделя без тяги
    const flat = [
      wk('2026-09-01', [['bench', [set(90, 5)]], ['row', [set(60, 8), set(60, 8)]]]),
      wk('2026-09-08', [['bench', [set(80, 5)]], ['row', [set(60, 8), set(60, 8)]]]),
      wk('2026-09-15', [['bench', [set(80, 5)]], ['row', [set(60, 8), set(60, 8)]]]),
      wk('2026-10-06', [['bench', [set(80, 5)]], ['row', [set(60, 8), set(60, 8)]]]),
      wk('2026-10-20', [['bench', [set(80, 5)]], ['squat', [set(100, 5), set(100, 5)]]])
    ];
    const r = weeklyReview(flat, exMap, [ci('2026-10-20', 1), ci('2026-10-21', 1)], now);
    expect(r.plateaus.map((p) => p.exerciseId)).toEqual(['bench']);
    expect(r.suggestions.length).toBe(2);
    expect(r.suggestions[0]).toContain('Жим лёжа');
  });

  it('самочувствие: нужно хотя бы два утренних чек-ина, низкая готовность даёт мягкое предложение', () => {
    const base = [wk('2026-10-20', [['bench', [set(80, 5)]]])];
    expect(weeklyReview(base, exMap, [ci('2026-10-20', 1)], now).readiness).toBeNull();
    const low = weeklyReview(base, exMap, [ci('2026-10-20', 1), ci('2026-10-22', 1)], now);
    expect(low.readiness).toEqual({ avg: 0, days: 2 });
    expect(low.suggestions.join(' ')).toContain('запас');
    const high = weeklyReview(base, exMap, [ci('2026-10-20', 5), ci('2026-10-22', 5)], now);
    expect(high.readiness!.avg).toBe(100);
    expect(high.suggestions.join(' ')).not.toContain('запас');
    // чек-ины вне недели и вечерние не учитываются
    expect(weeklyReview(base, exMap, [ci('2026-10-10', 1), ci('2026-10-12', 1), { ...ci('2026-10-21', 1), slot: 'evening' }, { ...ci('2026-10-22', 1), slot: 'evening' }], now).readiness).toBeNull();
  });

  it('если больше нечего сказать: меньше тренировок — про планирование, рост — похвала', () => {
    const fewer = weeklyReview([wk('2026-10-14', [['bench', [set(80, 5)]]]), wk('2026-10-15', [['bench', [set(80, 5)]]]), wk('2026-10-21', [['bench', [set(80, 5)]]])], exMap, [], now);
    expect(fewer.suggestions[0]).toContain('дни заранее');
    const good = weeklyReview([wk('2026-10-14', [['bench', [set(80, 5)]]]), wk('2026-10-21', [['bench', [set(90, 5)]]])], exMap, [], now);
    expect(good.suggestions[0]).toContain('Хорошая неделя');
  });
});

describe('когда показывать карточку', () => {
  const r = weeklyReview([wk('2026-10-20', [['bench', [set(80, 5)]]])], exMap, [], now);
  const empty = weeklyReview([], exMap, [], now);

  it('только по включённой функции, для недели с тренировками и если её ещё не закрывали', () => {
    expect(shouldShowWeeklyReview({ enabled: true, review: r, seenWeek: null })).toBe(true);
    expect(shouldShowWeeklyReview({ enabled: false, review: r, seenWeek: null })).toBe(false);
    expect(shouldShowWeeklyReview({ enabled: true, review: empty, seenWeek: null })).toBe(false);
    expect(shouldShowWeeklyReview({ enabled: true, review: r, seenWeek: r.weekStart })).toBe(false);
    expect(shouldShowWeeklyReview({ enabled: true, review: r, seenWeek: '2026-10-12' })).toBe(true);
  });

  it('текст для ассистента содержит только то, что показано в карточке', () => {
    const text = reviewPrompt(weeklyReview([wk('2026-10-14', [['bench', [set(80, 5)]]]), wk('2026-10-21', [['bench', [set(90, 5)]]])], exMap, [], now));
    expect(text).toContain('2026-10-19');
    expect(text).toContain('Жим лёжа');
    expect(text).not.toMatch(/самочувств|настроени|вес тела|талия/i);
  });
});
