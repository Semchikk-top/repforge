import { describe, expect, it } from 'vitest';
import { alternativesFor, familyOf, historyHint, movementOf } from '../../src/domain/movements';
import { swapExercise } from '../../src/domain/swap';
import { SEED_EXERCISES } from '../../src/domain/seed';
import type { Exercise, SetEntry, Workout, WorkoutExercise } from '../../src/domain/types';

const meta = (id: string) => ({ id, createdAt: 0, updatedAt: 0, deviceId: 'test' });
const seedEx = (name: string): Exercise => { const s = SEED_EXERCISES.find((e) => e.name === name)!; return { ...s, createdAt: 0, updatedAt: 0, deviceId: 'seed', custom: false }; };
const custom = (id: string, name: string, muscle: Exercise['muscle']): Exercise => ({ ...meta(id), name, muscle, equipment: '', custom: true });
const all: Exercise[] = SEED_EXERCISES.map((s) => ({ ...s, createdAt: 0, updatedAt: 0, deviceId: 'seed', custom: false }));
const exMap = new Map(all.map((e) => [e.id, e]));
const bench = seedEx('Жим штанги лёжа');
const incline = seedEx('Жим гантелей на наклонной скамье');

const set = (weight: number, reps: number, extra: Partial<SetEntry> = {}): SetEntry => ({ id: Math.random().toString(36).slice(2), weight, reps, done: true, ...extra });
const done = (id: string, date: string, exerciseId: string, sets: SetEntry[]): Workout => ({ ...meta(id), date, title: id, status: 'done', exercises: [{ id: `${id}-e`, exerciseId, sets }] });

describe('движения', () => {
  it('у каждого стартового силового упражнения есть движение, у кардио нет', () => {
    for (const e of all) {
      if (e.muscle === 'cardio') expect(movementOf(e)).toBeNull();
      else expect(movementOf(e), e.name).not.toBeNull();
    }
  });

  it('названия своих упражнений распознаются по смыслу, частные случаи раньше общих', () => {
    const m = (name: string, muscle: Exercise['muscle'] = 'chest') => movementOf(custom('x', name, muscle));
    expect(m('Жим штанги на наклонной скамье')).toBe('incline-press');
    expect(m('Bench Press (Smith Machine)')).toBe('horizontal-press');
    expect(m('Жим лёжа узким хватом')).toBe('horizontal-press');
    expect(m('Жим ногами в наклонном тренажёре', 'legs')).toBe('leg-press');
    expect(m('Тяга к лицу на канате', 'shoulders')).toBe('rear-delt');
    expect(m('Тяга Т-грифа', 'back')).toBe('horizontal-pull');
    expect(m('Подтягивания обратным хватом', 'back')).toBe('vertical-pull');
    expect(m('Румынская тяга на одной ноге', 'glutes')).toBe('hinge');
    expect(m('Разгибание ног сидя', 'legs')).toBe('knee-extension');
    expect(m('Zercher Squat', 'legs')).toBe('squat');
    expect(m('Что-то неведомое', 'back')).toBeNull();
  });

  it('семейства объединяют близкие движения', () => {
    expect(familyOf('horizontal-press')).toBe(familyOf('incline-press'));
    expect(familyOf('squat')).toBe(familyOf('leg-press'));
    expect(familyOf('vertical-pull')).not.toBe(familyOf('horizontal-pull'));
  });
});

describe('варианты замены', () => {
  it('порядок: то же движение, похожее, та же мышца; сама, кардио, удалённые и уже стоящие не предлагаются', () => {
    const twin = custom('twin', 'Жим лёжа в Смите', 'chest');
    const deleted = { ...custom('dead', 'Жим лёжа старый', 'chest'), deletedAt: 1 };
    const alts = alternativesFor(bench, [...all, twin, deleted], [], new Set([incline.id]));
    const ids = alts.map((a) => a.exercise.id);
    // то же движение — первыми: свой «жим в Смите» и стартовый «жим гантелей лёжа» (добавлен в 1.5.0)
    const same = alts.filter((a) => a.relation === 'same-movement').map((a) => a.exercise.id);
    expect(same).toEqual(expect.arrayContaining(['twin', 'seed-033']));
    expect(alts.slice(0, same.length).every((a) => a.relation === 'same-movement')).toBe(true);
    expect(ids).not.toContain(bench.id);
    expect(ids).not.toContain('dead');
    expect(ids).not.toContain(incline.id);
    expect(alts.every((a) => a.exercise.muscle === 'chest')).toBe(true);
    const rel = alts.map((a) => a.relation);
    expect(rel).toEqual([...rel].sort((a, b) => ['same-movement', 'same-family', 'same-muscle'].indexOf(a) - ['same-movement', 'same-family', 'same-muscle'].indexOf(b)));
  });

  it('семейство «жим» включает наклонный жим и отжимания, но не упражнения других мышц', () => {
    const push = custom('pu', 'Отжимания от пола', 'chest');
    const alts = alternativesFor(bench, [...all, push], []);
    const fam = alts.filter((a) => a.relation === 'same-family').map((a) => a.exercise.id);
    expect(fam).toContain(incline.id);
    expect(fam).toContain('pu');
    expect(alts.some((a) => a.exercise.muscle === 'legs')).toBe(false);
  });

  it('при равной близости привычные упражнения идут раньше редких, у варианта виден свой последний результат', () => {
    const a = custom('a', 'Жим в Смите А', 'chest'), b = custom('b', 'Жим в Смите Б', 'chest');
    const hist = [done('h1', '2026-10-01', 'b', [set(60, 8)]), done('h2', '2026-10-08', 'b', [set(62.5, 8)])];
    const alts = alternativesFor(bench, [bench, a, b], hist);
    expect(alts.map((x) => x.exercise.id)).toEqual(['b', 'a']);
    expect(alts[0].own).toMatchObject({ date: '2026-10-08' });
    expect(alts[1].own).toBeNull();
  });

  it('для кардио замен нет', () => {
    expect(alternativesFor(all.find((e) => e.muscle === 'cardio')!, all, [])).toEqual([]);
  });
});

describe('подсказка истории по похожему упражнению', () => {
  it('у упражнения без истории показывается результат ближайшего похожего', () => {
    const hist = [done('h1', '2026-10-01', bench.id, [set(80, 5)])];
    const h = historyHint(incline, all, hist)!;
    expect(h.from.id).toBe(bench.id);
    expect(h.relation).toBe('same-family');
    expect(h.sets[0]).toMatchObject({ weight: 80, reps: 5 });
  });

  it('то же движение важнее более свежего результата по другому', () => {
    const twin = custom('twin', 'Жим лёжа в Смите', 'chest');
    const hist = [done('h1', '2026-09-01', twin.id, [set(70, 5)]), done('h2', '2026-10-20', incline.id, [set(30, 10)])];
    const h = historyHint(bench, [...all, twin], hist)!;
    expect(h.from.id).toBe('twin');
    expect(h.relation).toBe('same-movement');
  });

  it('если собственная история есть, подсказка не нужна; без подходящих результатов её нет', () => {
    const hist = [done('h1', '2026-10-01', bench.id, [set(80, 5)]), done('h2', '2026-10-02', incline.id, [set(30, 10)])];
    expect(historyHint(incline, all, hist)).toBeNull();
    expect(historyHint(bench, all, [])).toBeNull();
    expect(historyHint(seedEx('Планка'), all, hist)).toBeNull();
  });
});

describe('замена в текущей тренировке', () => {
  const we = (id: string, exerciseId: string, sets: SetEntry[], extra: Partial<WorkoutExercise> = {}): WorkoutExercise => ({ id, exerciseId, sets, ...extra });
  const workout = (exercises: WorkoutExercise[]): Workout => ({ ...meta('w'), date: '2026-10-31', title: 'Т', status: 'active', exercises });
  const todo = (reps: number, extra: Partial<SetEntry> = {}) => set(0, reps, { done: false, ...extra });

  it('ни одного выполненного подхода: упражнение подменяется на месте, повторы сохраняются, вес — из истории нового', () => {
    const w = workout([we('e1', bench.id, [todo(8), todo(8), todo(6)], { group: 'g', note: 'про штангу' }), we('e2', 'x', [])]);
    const hist = [done('h', '2026-10-01', incline.id, [set(24, 10), set(26, 8)])];
    const r = swapExercise(w, 'e1', incline, hist, exMap);
    expect(r.ok && r.mode).toBe('replaced');
    if (!r.ok) return;
    const e = r.workout.exercises[0];
    expect(e).toMatchObject({ id: 'e1', exerciseId: incline.id, group: 'g' });
    expect(e.note).toBeUndefined();
    expect(e.sets.map((s) => [s.weight, s.reps, s.done])).toEqual([[26, 8, false], [26, 8, false], [26, 6, false]]);
    expect(r.workout.exercises).toHaveLength(2);
  });

  it('есть выполненные подходы: они остаются у исходного, остальное уходит в новую запись следом', () => {
    const d1 = set(80, 5), d2 = set(80, 5);
    const w = workout([we('e1', bench.id, [d1, d2, todo(5), todo(5)], { group: 'g' })]);
    const r = swapExercise(w, 'e1', incline, [], exMap);
    expect(r.ok && r.mode).toBe('split');
    if (!r.ok) return;
    expect(r.workout.exercises).toHaveLength(2);
    expect(r.workout.exercises[0]).toMatchObject({ id: 'e1', exerciseId: bench.id });
    expect(r.workout.exercises[0].sets.map((s) => s.id)).toEqual([d1.id, d2.id]);
    expect(r.workout.exercises[1]).toMatchObject({ exerciseId: incline.id, group: 'g' });
    expect(r.workout.exercises[1].sets.map((s) => [s.weight, s.reps, s.done])).toEqual([[0, 5, false], [0, 5, false]]);
    expect(r.moved).toBe(2);
  });

  it('разминка исходного упражнения в замену не переносится', () => {
    const w = workout([we('e1', bench.id, [todo(10, { warmup: true }), todo(5), todo(5)])]);
    const r = swapExercise(w, 'e1', incline, [], exMap);
    expect(r.ok && r.workout.exercises[0].sets).toHaveLength(2);
  });

  it('вход не меняется', () => {
    const w = workout([we('e1', bench.id, [todo(5)])]);
    const snap = JSON.stringify(w);
    swapExercise(w, 'e1', incline, [], exMap);
    expect(JSON.stringify(w)).toBe(snap);
  });

  it('отказы: нет такой записи, то же упражнение, кардио, нечего менять', () => {
    const run = all.find((e) => e.muscle === 'cardio')!;
    const w = workout([we('e1', bench.id, [todo(5)]), we('e3', bench.id, [set(80, 5)]), { id: 'e4', exerciseId: run.id, sets: [] }]);
    expect(swapExercise(w, 'nope', incline, [], exMap)).toEqual({ ok: false, reason: 'not-found' });
    expect(swapExercise(w, 'e1', bench, [], exMap)).toEqual({ ok: false, reason: 'same' });
    expect(swapExercise(w, 'e1', run, [], exMap)).toEqual({ ok: false, reason: 'cardio' });
    expect(swapExercise(w, 'e4', incline, [], exMap)).toEqual({ ok: false, reason: 'cardio' });
    expect(swapExercise(w, 'e3', incline, [], exMap)).toEqual({ ok: false, reason: 'nothing-left' });
  });
});
