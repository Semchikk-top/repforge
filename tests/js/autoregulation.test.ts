import { describe, expect, it } from 'vitest';
import { autoregulate, easeWorkout, HIGH_LOAD_RATIO, reliableLoadRatio, SEVERE_READINESS } from '../../src/domain/autoregulation';
import { readiness, type Readiness } from '../../src/domain/checkin';
import { weeklyReview } from '../../src/domain/weeklyReview';
import type { Exercise, Rating, SetEntry, Workout } from '../../src/domain/types';

const R = (n: number) => n as Rating;
const ready = (energy: number, sleepHours?: number): Readiness => readiness({ energy: R(energy), mood: R(energy), soreness: R(6 - energy), stress: R(6 - energy), sleepHours });
const low = ready(1, 5);      // 0 из 100: низкая
const normal = ready(3, 7.5); // 50 из 100: нормальная

describe('autoregulate: когда предлагать снизить нагрузку', () => {
  it('нормальная готовность, нагрузка привычная, застоя нет: обычный прогресс без кнопки', () => {
    const a = autoregulate({ readiness: normal, loadRatio: 1.0 });
    expect(a.mode).toBe('normal');
    expect(a.plan).toBeNull();
    expect(a.reasons).toEqual([]);
    expect(a.known).toBe(true);
  });

  it('низкая готовность: поправка и причины «сон» и «готовность»', () => {
    const a = autoregulate({ readiness: low, sleepHours: 5, loadRatio: 1.0 });
    expect(a.mode).toBe('ease');
    expect(a.plan).toEqual({ pct: 10 }); // готовность 0 < порога сильной поправки
    expect(a.reasons.map((r) => r.text)).toContain('сон 5 ч');
    expect(a.reasons.map((r) => r.key)).toEqual(['sleep', 'readiness']);
  });

  it('граница готовности: 39 даёт поправку, 40 нет', () => {
    const at = (score: number): Readiness => ({ score, level: score < 40 ? 'low' : 'normal', parts: [] });
    expect(autoregulate({ readiness: at(39), loadRatio: null }).mode).toBe('ease');
    expect(autoregulate({ readiness: at(40), loadRatio: null }).mode).toBe('normal');
  });

  it('мягкая поправка −5%: готовность низкая, но не ниже порога сильной', () => {
    const mild: Readiness = { score: SEVERE_READINESS, level: 'low', parts: [] };
    expect(autoregulate({ readiness: mild, loadRatio: 1.1 }).plan).toEqual({ pct: 5 });
  });

  it('граница нагрузки: 1,49 обычный день, 1,5 поправка −5%, 2 — −10%', () => {
    expect(autoregulate({ readiness: normal, loadRatio: HIGH_LOAD_RATIO - 0.01 }).mode).toBe('normal');
    const high = autoregulate({ readiness: normal, loadRatio: HIGH_LOAD_RATIO });
    expect(high.mode).toBe('ease');
    expect(high.plan).toEqual({ pct: 5 });
    expect(autoregulate({ readiness: normal, loadRatio: 2 }).plan).toEqual({ pct: 10 });
  });

  it('причина нагрузки пишется по-русски с запятой: «нагрузка 1,6× обычной»', () => {
    const a = autoregulate({ readiness: normal, loadRatio: 1.6 });
    expect(a.reasons.map((r) => r.text)).toEqual(['нагрузка 1,6× обычной']);
  });

  it('низкая готовность вместе с высокой нагрузкой: сильная поправка −10%', () => {
    const mild: Readiness = { score: 35, level: 'low', parts: [] };
    expect(autoregulate({ readiness: mild, loadRatio: 1.6 }).plan).toEqual({ pct: 10 });
  });

  it('сон меньше 6 часов называется причиной, только когда готовность низкая', () => {
    expect(autoregulate({ readiness: normal, sleepHours: 5, loadRatio: 1 }).reasons).toEqual([]);
    const mild: Readiness = { score: 35, level: 'low', parts: [] };
    expect(autoregulate({ readiness: mild, sleepHours: 6, loadRatio: 1 }).reasons.map((r) => r.key)).toEqual(['readiness']);
  });

  it('застой: в обычный день только подсказка, при поправке добавляется причиной', () => {
    const p = autoregulate({ readiness: normal, loadRatio: 1, plateauNames: ['Жим лёжа'] });
    expect(p.mode).toBe('normal');
    expect(p.plan).toBeNull();
    expect(p.reasons[0].text).toBe('вес не растёт три тренировки: Жим лёжа');
    const e = autoregulate({ readiness: low, loadRatio: 1, plateauNames: ['Жим лёжа'] });
    expect(e.reasons.map((r) => r.key)).toEqual(['readiness', 'plateau']);
  });

  it('нет чек-ина и мало истории: данных для вывода нет, карточку не показываем', () => {
    const a = autoregulate({ readiness: null, loadRatio: null });
    expect(a.known).toBe(false);
    expect(a.mode).toBe('normal');
  });

  it('только нагрузка без чек-ина тоже работает', () => {
    const a = autoregulate({ readiness: null, loadRatio: 1.7 });
    expect(a.known).toBe(true);
    expect(a.mode).toBe('ease');
  });
});

describe('easeWorkout: применение поправки', () => {
  const s = (id: string, weight: number, reps = 8, extra: Partial<SetEntry> = {}): SetEntry => ({ id, weight, reps, done: false, ...extra });
  const mk = (exercises: Workout['exercises']): Workout => ({ id: 'w1', createdAt: 0, updatedAt: 0, deviceId: 'd', date: '2026-11-04', title: 'Т', status: 'planned', exercises });
  const we = (id: string, sets: SetEntry[], extra: object = {}) => ({ id, exerciseId: 'ex-' + id, sets, ...extra });

  it('снижает вес только в невыполненных рабочих подходах', () => {
    const w = mk([we('a', [s('1', 100, 5, { warmup: true }), s('2', 100, 5, { done: true }), s('3', 100), s('4', 100)])]);
    const r = easeWorkout(w, { pct: 5 });
    expect(r.lowered).toBe(2);
    expect(r.workout.exercises[0].sets.map((x) => x.weight)).toEqual([100, 100, 95, 95]);
    expect(w.exercises[0].sets[2].weight).toBe(100); // исходная тренировка не тронута
  });

  it('округляет до 0,5 кг и всегда уменьшает хотя бы на шаг', () => {
    const r = easeWorkout(mk([we('a', [s('1', 40), s('2', 10), s('3', 20)])]), { pct: 5 });
    expect(r.workout.exercises[0].sets.map((x) => x.weight)).toEqual([38, 9.5, 19]);
    const tiny = easeWorkout(mk([we('a', [s('1', 2)])]), { pct: 5 });
    expect(tiny.workout.exercises[0].sets[0].weight).toBe(1.5);
  });

  it('−10% считает от исходного веса', () => {
    const r = easeWorkout(mk([we('a', [s('1', 82.5)])]), { pct: 10 });
    expect(r.workout.exercises[0].sets[0].weight).toBe(74.5);
  });

  it('упражнение с собственным весом: убирает последний невыполненный подход, но оставляет хотя бы один', () => {
    const w = mk([we('p', [s('1', 0, 10), s('2', 0, 10), s('3', 0, 10)]), we('q', [s('4', 0, 10)])]);
    const r = easeWorkout(w, { pct: 5 });
    expect(r.dropped).toBe(1);
    expect(r.workout.exercises[0].sets.map((x) => x.id)).toEqual(['1', '2']);
    expect(r.workout.exercises[1].sets.map((x) => x.id)).toEqual(['4']);
  });

  it('кардио и выполненные упражнения не меняются; если менять нечего, возвращается тот же объект', () => {
    const w = mk([we('c', [], { cardio: { source: 'manual', distanceM: 5000, durationSec: 1800 } }), we('d', [s('1', 60, 5, { done: true })])]);
    const r = easeWorkout(w, { pct: 10 });
    expect(r.workout).toBe(w);
    expect(r.lowered + r.dropped).toBe(0);
  });
});

describe('недельный разбор учитывает loadRatio', () => {
  const meta = (id: string) => ({ id, createdAt: 0, updatedAt: 0, deviceId: 'test' });
  const exMap = new Map<string, Exercise>([['bench', { ...meta('bench'), name: 'Жим лёжа', muscle: 'chest', equipment: '', custom: false }]]);
  const wk = (date: string, weight: number, n = 5): Workout => ({
    ...meta('w-' + date), date, title: 't', status: 'done',
    exercises: [{ id: 'e' + date, exerciseId: 'bench', sets: Array.from({ length: n }, (_, i) => ({ id: `${date}-${i}`, weight, reps: 5, done: true })) }]
  });
  const now = new Date(2026, 9, 31, 12, 0); // разбираем 19–25 октября

  it('неделя заметно тяжелее привычной: предложение снизить объём идёт первым', () => {
    const history = [wk('2026-09-23', 60, 3), wk('2026-09-30', 60, 3), wk('2026-10-07', 60, 3), wk('2026-10-14', 60, 3), wk('2026-10-21', 60, 6), wk('2026-10-23', 60, 6)];
    const r = weeklyReview(history, exMap, [], now);
    expect(r.loadRatio).toBeCloseTo(4, 5);
    expect(r.suggestions[0]).toContain('4,0× обычной');
  });

  it('привычная нагрузка: предложения про нагрузку нет; истории мало: loadRatio равен null', () => {
    const steady = [wk('2026-09-23', 60), wk('2026-09-30', 60), wk('2026-10-07', 60), wk('2026-10-14', 60), wk('2026-10-21', 60)];
    const r = weeklyReview(steady, exMap, [], now);
    expect(r.loadRatio).toBeCloseTo(1, 5);
    expect(r.suggestions.join(' ')).not.toContain('обычной');
    expect(weeklyReview([wk('2026-10-21', 60)], exMap, [], now).loadRatio).toBeNull();
  });
});

describe('reliableLoadRatio: защита от шума на короткой истории', () => {
  const w = (date: string, weight = 60): Workout => ({
    id: 'w-' + date, createdAt: 0, updatedAt: 0, deviceId: 't', date, title: 't', status: 'done',
    exercises: [{ id: 'e' + date, exerciseId: 'x', sets: [{ id: 's' + date, weight, reps: 5, done: true }] }]
  });
  const now = new Date(2026, 10, 4, 12, 0);

  it('меньше трёх тренировок за предыдущие 4 недели: null, даже если отношение огромное', () => {
    const two = [w('2026-10-10'), w('2026-10-15'), w('2026-11-02', 200)];
    expect(reliableLoadRatio(two, now)).toBeNull();
  });

  it('три и больше тренировок: возвращает обычное отношение', () => {
    const three = [w('2026-10-10'), w('2026-10-15'), w('2026-10-20'), w('2026-11-02', 200)];
    expect(reliableLoadRatio(three, now)).toBeGreaterThan(HIGH_LOAD_RATIO);
  });

  it('тренировки за последнюю неделю в базу сравнения не входят', () => {
    const recent = [w('2026-10-31'), w('2026-11-01'), w('2026-11-02')];
    expect(reliableLoadRatio(recent, now)).toBeNull();
  });
});
