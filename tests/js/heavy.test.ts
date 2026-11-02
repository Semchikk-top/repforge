import { describe, expect, it } from 'vitest';
import { heavyThreshold, isHeavySet, recordMap, templateHeaviness, toPlanTemplates } from '../../src/domain/heavy';
import { planWeek } from '../../src/domain/schedule';
import type { Exercise, Template, TemplateExercise, Workout } from '../../src/domain/types';

const meta = (id: string) => ({ id, createdAt: 0, updatedAt: 0, deviceId: 'test' });
const ex = (id: string, muscle: Exercise['muscle'] = 'chest', extra: Partial<Exercise> = {}): Exercise =>
  ({ ...meta(id), name: id, muscle, equipment: '', custom: false, ...extra });
const te = (exerciseId: string, sets: number, reps: number, weight: number): TemplateExercise => ({ exerciseId, sets, reps, weight });
const tpl = (id: string, exercises: TemplateExercise[]): Template => ({ ...meta(id), title: id, exercises });
const workout = (id: string, date: string, exerciseId: string, sets: [number, number][]): Workout => ({
  ...meta(id), date, title: id, status: 'done',
  exercises: [{ id: `${id}-e`, exerciseId, sets: sets.map(([weight, reps], i) => ({ id: `${id}-s${i}`, weight, reps, done: true })) }]
});

const bench = ex('bench');
const curl = ex('curl', 'biceps');
const run = ex('run', 'cardio');
const exMap = new Map([bench, curl, run].map((e) => [e.id, e]));

describe('порог тяжёлого подхода', () => {
  it('для жима лёжа: 0.85 от рекорда с допуском 5 кг', () => {
    expect(heavyThreshold(100)).toBe(80);
    expect(heavyThreshold(120)).toBeCloseTo(97, 10); // 102 − 5
  });

  it('допуск не больше 5% рекорда: у лёгких упражнений 5 кг не съедают половину веса', () => {
    expect(heavyThreshold(40)).toBeCloseTo(32, 10); // 34 − 2
  });

  it('тяжёлый подход: вес от порога и не больше 6 повторений', () => {
    expect(isHeavySet(80, 5, 100)).toBe(true);
    expect(isHeavySet(79, 5, 100)).toBe(false);
    expect(isHeavySet(90, 6, 100)).toBe(true);
    expect(isHeavySet(90, 7, 100)).toBe(false);
  });

  it('без рекорда, без веса или без повторов — не тяжёлый', () => {
    expect(isHeavySet(80, 5, 0)).toBe(false);
    expect(isHeavySet(0, 5, 100)).toBe(false);
    expect(isHeavySet(80, 0, 100)).toBe(false);
  });
});

describe('тяжёлый ли шаблон', () => {
  const pr = workout('w0', '2026-09-01', 'bench', [[100, 1]]); // расчётный максимум 100

  it('рекорд берётся из расчётного максимума по истории', () => {
    expect(recordMap([pr]).get('bench')).toBe(100);
  });

  it('жим 4×5 около 85% рекорда — тяжёлая тренировка', () => {
    const t = tpl('T1', [te('bench', 4, 5, 85)]);
    const r = templateHeaviness(t, [pr], exMap);
    expect(r.heavy).toBe(true);
    expect(r.heavySets).toBe(4);
    expect(r.exercises[0]).toMatchObject({ record: 100, threshold: 80, heavy: true });
  });

  it('тот же вес, но 12 повторений — не тяжёлая', () => {
    expect(templateHeaviness(tpl('T1', [te('bench', 4, 12, 85)]), [pr], exMap).heavy).toBe(false);
  });

  it('лёгкий вес — не тяжёлая', () => {
    const light = workout('w1', '2026-09-10', 'bench', [[60, 5]]);
    expect(templateHeaviness(tpl('T1', [te('bench', 4, 5, 60)]), [pr, light], exMap).heavy).toBe(false);
  });

  it('вес в шаблоне ниже, но последний результат тяжёлый: тренировка стартует тяжёлой', () => {
    // pr — подход 100×1, он же последний факт по жиму
    expect(templateHeaviness(tpl('T1', [te('bench', 4, 5, 60)]), [pr], exMap).heavy).toBe(true);
  });

  it('вес берётся как в приложении: прошлый результат важнее веса в шаблоне', () => {
    const lighter = workout('w1', '2026-09-10', 'bench', [[60, 10]]);
    // в шаблоне 85, но тренировка стартует с 60 (последний факт), и тренировка не тяжёлая
    const t = tpl('T1', [te('bench', 4, 5, 85)]);
    expect(templateHeaviness(t, [pr, lighter], exMap).heavy).toBe(false);
  });

  it('один тяжёлый подход тренировку тяжёлой не делает, два делают', () => {
    expect(templateHeaviness(tpl('T1', [te('bench', 1, 3, 90)]), [pr], exMap).heavy).toBe(false);
    expect(templateHeaviness(tpl('T1', [te('bench', 2, 3, 90)]), [pr], exMap).heavy).toBe(true);
    expect(templateHeaviness(tpl('T1', [te('bench', 1, 3, 90)]), [pr], exMap, { share: 0.85, toleranceKg: 5, toleranceShare: 0.05, maxReps: 6, minHeavySets: 1 }).heavy).toBe(true);
  });

  it('новое упражнение без истории и кардио не делают тренировку тяжёлой', () => {
    const t = tpl('T1', [te('curl', 4, 5, 100), te('run', 1, 1, 0)]);
    const r = templateHeaviness(t, [pr], exMap);
    expect(r.heavy).toBe(false);
    expect(r.exercises.map((e) => e.exerciseId)).toEqual(['curl']); // кардио пропущено
    expect(r.exercises[0].record).toBeNull();
  });

  it('удалённые и неизвестные упражнения пропускаются', () => {
    const gone = new Map(exMap).set('bench', { ...bench, deletedAt: 1 });
    expect(templateHeaviness(tpl('T1', [te('bench', 4, 5, 85), te('ghost', 3, 5, 100)]), [pr], gone).exercises).toEqual([]);
  });
});

describe('шаблоны для планировщика', () => {
  const pr = workout('w0', '2026-09-01', 'bench', [[100, 1]]);

  it('передаются id, флаг heavy и группы мышц', () => {
    const t1 = tpl('T1', [te('bench', 4, 5, 85), te('curl', 3, 10, 15)]);
    const t2 = tpl('T2', [te('curl', 3, 12, 10)]);
    expect(toPlanTemplates([t1, t2], [pr], exMap)).toEqual([
      { id: 'T1', heavy: true, tags: ['chest', 'biceps'] },
      { id: 'T2', heavy: false, tags: ['biceps'] }
    ]);
  });

  it('сквозная проверка: тяжёлые тренировки планировщик разводит по краям цепочки', () => {
    const t = [
      tpl('T1', [te('curl', 3, 10, 15)]),
      tpl('T2', [te('bench', 4, 5, 85)]),
      tpl('T3', [te('bench', 4, 3, 90)])
    ];
    const plan = toPlanTemplates(t, [pr], exMap);
    expect(plan.map((p) => p.heavy)).toEqual([false, true, true]);
    // свободны только вт, ср, чт: подряд неизбежно, но тяжёлые не должны стоять рядом
    const r = planWeek(plan, { mon: true, fri: true, sat: true }, { mon: 'T1', wed: 'T2', fri: 'T3' });
    expect(r.assignment.wed).toBe('T1');
    expect(r.warnings.every((w) => !w.startsWith('Тяжёлые'))).toBe(true);
  });
});
