// Слияние тренировки по подходам: чистая логика.
import { describe, expect, it } from 'vitest';
import { mergeWorkout, sameWorkout } from '../../src/sync/merge';
import type { SetEntry, Workout, WorkoutExercise } from '../../src/domain/types';

const set = (id: string, weight: number, reps = 8, done = false): SetEntry => ({ id, weight, reps, done });
const ex = (id: string, sets: SetEntry[], extra: Partial<WorkoutExercise> = {}): WorkoutExercise => ({ id, exerciseId: 'seed-001', sets, ...extra });
const wk = (exercises: WorkoutExercise[], extra: Partial<Workout> = {}): Workout =>
  ({ id: 'w1', createdAt: 100, updatedAt: 1000, deviceId: 'a', date: '2026-10-30', title: 'Грудь', status: 'active', exercises, ...extra }) as Workout;

const BASE = wk([ex('e1', [set('s1', 60), set('s2', 60), set('s3', 60)])]);
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

describe('слияние тренировок по подходам', () => {
  it('разные подходы правили на разных устройствах: остаются обе правки', () => {
    const local = clone(BASE); local.exercises[0].sets[0].weight = 62.5;                    // телефон: вес первого подхода
    const remote = clone(BASE); remote.exercises[0].sets[2].done = true;                    // ПК: третий выполнен
    const { merged, lostLocal } = mergeWorkout(BASE, local, remote, false);
    expect(merged.exercises[0].sets.map((s) => [s.weight, s.done])).toEqual([[62.5, false], [60, false], [60, true]]);
    expect(lostLocal).toBe(false);
  });

  it('разные поля одного подхода сливаются в одно', () => {
    const local = clone(BASE); local.exercises[0].sets[1].weight = 65;
    const remote = clone(BASE); remote.exercises[0].sets[1].reps = 10;
    const s = mergeWorkout(BASE, local, remote, false).merged.exercises[0].sets[1];
    expect([s.weight, s.reps]).toEqual([65, 10]);
  });

  it('одно и то же поле с двух сторон: побеждает более новая запись, проигрыш нашей правки замечен', () => {
    const local = clone(BASE); local.exercises[0].sets[0].weight = 70;
    const remote = clone(BASE); remote.exercises[0].sets[0].weight = 72.5;
    const r = mergeWorkout(BASE, local, remote, false);
    expect(r.merged.exercises[0].sets[0].weight).toBe(72.5);
    expect(r.lostLocal).toBe(true);
    const l = mergeWorkout(BASE, local, remote, true);
    expect(l.merged.exercises[0].sets[0].weight).toBe(70);
    expect(l.lostLocal).toBe(false);
  });

  it('подходы, добавленные на обоих устройствах, остаются оба', () => {
    const local = clone(BASE); local.exercises[0].sets.push(set('s4-local', 60));
    const remote = clone(BASE); remote.exercises[0].sets.push(set('s4-remote', 62.5));
    const ids = mergeWorkout(BASE, local, remote, false).merged.exercises[0].sets.map((s) => s.id);
    expect(ids).toEqual(['s1', 's2', 's3', 's4-local', 's4-remote']);
  });

  it('удаление подхода на одном устройстве применяется, если другое его не правило', () => {
    const local = clone(BASE); local.exercises[0].sets.splice(1, 1);                         // удалили s2
    const remote = clone(BASE); remote.exercises[0].sets[2].done = true;
    const m = mergeWorkout(BASE, local, remote, false);
    expect(m.merged.exercises[0].sets.map((s) => s.id)).toEqual(['s1', 's3']);
    expect(m.merged.exercises[0].sets[1].done).toBe(true);
    expect(m.lostLocal).toBe(false);
  });

  it('правка важнее удаления: подход, который с другой стороны изменили, не пропадает', () => {
    const local = clone(BASE); local.exercises[0].sets.splice(1, 1);                         // мы удалили s2
    const remote = clone(BASE); remote.exercises[0].sets[1].weight = 80;                    // там его изменили
    const m = mergeWorkout(BASE, local, remote, false);
    expect(m.merged.exercises[0].sets.map((s) => [s.id, s.weight])).toEqual([['s1', 60], ['s2', 80], ['s3', 60]]);
    expect(m.lostLocal).toBe(true);
    // наоборот: мы правили, они удалили — наша правка остаётся, и терять нечего
    const m2 = mergeWorkout(BASE, remote, local, false);
    expect(m2.merged.exercises[0].sets.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(m2.lostLocal).toBe(false);
  });

  it('упражнения: добавленные с обеих сторон остаются, поля упражнения сливаются', () => {
    const local = clone(BASE); local.exercises.push(ex('e2', [set('x1', 40)])); local.exercises[0].note = 'болит плечо';
    const remote = clone(BASE); remote.exercises.push(ex('e3', [set('y1', 30)])); remote.exercises[0].group = 'g1';
    const { merged } = mergeWorkout(BASE, local, remote, false);
    expect(merged.exercises.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
    expect(merged.exercises[0]).toMatchObject({ note: 'болит плечо', group: 'g1' });
  });

  it('поля тренировки: заголовок с одной стороны, заметка с другой', () => {
    const local = clone(BASE); local.title = 'Грудь и трицепс';
    const remote = clone(BASE); remote.note = 'зал закрывается в 22';
    expect(mergeWorkout(BASE, local, remote, false).merged).toMatchObject({ title: 'Грудь и трицепс', note: 'зал закрывается в 22' });
  });

  it('статус: побеждает самый продвинутый, а не самый новый', () => {
    const local = clone(BASE); local.status = 'done'; local.finishedAt = 5000;
    const remote = clone(BASE); remote.status = 'planned';
    const r = mergeWorkout(BASE, local, remote, false).merged;
    expect(r.status).toBe('done');
    expect(r.finishedAt).toBe(5000);
    const l2 = clone(BASE); l2.status = 'planned';
    const r2 = clone(BASE); r2.status = 'done';
    expect(mergeWorkout(BASE, l2, r2, true).merged.status).toBe('done');
  });

  it('слияние идемпотентно и не зависит от того, кто «наш»: тот же результат при тех же победителях', () => {
    const a = clone(BASE); a.exercises[0].sets[0].weight = 62.5; a.exercises[0].sets.push(set('sa', 50));
    const b = clone(BASE); b.exercises[0].sets[2].done = true; b.title = 'Новое';
    const ab = mergeWorkout(BASE, a, b, false).merged;
    const ba = mergeWorkout(BASE, b, a, true).merged;
    // порядок добавленных подходов зависит от победителя, но содержимое одинаково
    const norm = (w: Workout) => ({ ...w, exercises: w.exercises.map((e) => ({ ...e, sets: [...e.sets].sort((x, y) => x.id.localeCompare(y.id)) })) });
    expect(norm(ab)).toEqual(norm(ba));
    // повторное слияние результата с одной из сторон ничего не меняет
    const again = mergeWorkout(BASE, ab, b, true).merged;
    expect(sameWorkout(norm(again) as never, norm(ab) as never)).toBe(true);
  });

  it('sameWorkout не учитывает метки времени и устройство, но учитывает id подходов', () => {
    expect(sameWorkout(BASE, { ...clone(BASE), updatedAt: 9, deviceId: 'z' })).toBe(true);
    const other = clone(BASE); other.exercises[0].sets[0].id = 'другой';
    expect(sameWorkout(BASE, other)).toBe(false);
  });
});

// ---------- остальные таблицы ----------
import { MERGE_SPECS, mergeEntity } from '../../src/sync/merge';

const merge = (table: string, base: Record<string, unknown> | undefined, local: Record<string, unknown>, remote: Record<string, unknown>, localWins = false) =>
  mergeEntity(base, local, remote, localWins, MERGE_SPECS[table]);

describe('упражнения, замеры, чек-ины: слияние по полям', () => {
  const EX = { id: 'x1', createdAt: 1, updatedAt: 10, deviceId: 'a', name: 'Жим лёжа', muscle: 'chest', equipment: 'штанга', custom: true };
  it('название правили на телефоне, заметку и отдых на ПК', () => {
    const r = merge('exercises', EX, { ...EX, name: 'Жим штанги лёжа' }, { ...EX, note: 'узкий хват', restSec: 150 });
    expect(r.merged).toMatchObject({ name: 'Жим штанги лёжа', note: 'узкий хват', restSec: 150 });
    expect(r.lostLocal).toBe(false);
  });
  it('одно поле с двух сторон: побеждает более новая запись, проигрыш замечен', () => {
    const r = merge('exercises', EX, { ...EX, restSec: 90 }, { ...EX, restSec: 180 });
    expect(r.merged.restSec).toBe(180);
    expect(r.lostLocal).toBe(true);
    expect(merge('exercises', EX, { ...EX, restSec: 90 }, { ...EX, restSec: 180 }, true).merged.restSec).toBe(90);
  });
  it('замер тела: вес с одного устройства, талия с другого', () => {
    const B = { id: 'b1', createdAt: 1, updatedAt: 1, deviceId: 'a', date: '2026-10-30', weightKg: 80 };
    const r = merge('body', B, { ...B, weightKg: 79.4 }, { ...B, waistCm: 84 });
    expect(r.merged).toMatchObject({ weightKg: 79.4, waistCm: 84 });
  });
  it('чек-ин без общего предка: поля, заполненные на разных устройствах, объединяются', () => {
    const C = { id: 'ci:2026-10-30:morning', createdAt: 1, updatedAt: 1, deviceId: 'a', date: '2026-10-30', slot: 'morning' };
    const r = merge('checkins', undefined, { ...C, energy: 4, mood: 3 }, { ...C, energy: 4, sleepHours: 7.5 });
    expect(r.merged).toMatchObject({ energy: 4, mood: 3, sleepHours: 7.5 });
    expect(r.lostLocal).toBe(false);
  });
});

describe('шаблоны и программы: списки без id', () => {
  const T = (exercises: unknown[]) => ({ id: 't1', createdAt: 1, updatedAt: 10, deviceId: 'a', title: 'Грудь', exercises });
  const e = (exerciseId: string, sets = 3, reps = 8, weight = 60) => ({ exerciseId, sets, reps, weight });
  const BASE_T = T([e('bench'), e('fly'), e('dips')]);

  it('в одном упражнении шаблона поменяли вес, в другом подходы: остаются обе правки', () => {
    const r = merge('templates', BASE_T, T([e('bench', 3, 8, 65), e('fly'), e('dips')]), T([e('bench'), e('fly', 4), e('dips')]));
    expect((r.merged.exercises as Array<Record<string, number>>).map((x) => [x.weight, x.sets])).toEqual([[65, 3], [60, 4], [60, 3]]);
  });
  it('упражнения, добавленные на разных устройствах, остаются; удалённое не правили: пропадает', () => {
    const r = merge('templates', BASE_T, T([e('bench'), e('fly'), e('dips'), e('pushup')]), T([e('bench'), e('dips'), e('cable')]));
    const ids = (r.merged.exercises as Array<{ exerciseId: string }>).map((x) => x.exerciseId);
    expect(ids).toContain('pushup');
    expect(ids).toContain('cable');
    expect(ids).not.toContain('fly');
  });
  it('название шаблона и состав сливаются независимо', () => {
    const r = merge('templates', BASE_T, { ...BASE_T, title: 'Грудь и трицепс' }, T([e('bench'), e('fly'), e('dips'), e('pushup')]));
    expect(r.merged.title).toBe('Грудь и трицепс');
    expect((r.merged.exercises as unknown[]).length).toBe(4);
  });
  it('одно упражнение дважды в шаблоне узнаётся по порядковому номеру', () => {
    const base = T([e('squat', 3, 5, 100), e('squat', 2, 12, 60)]);
    const r = merge('templates', base, T([e('squat', 3, 5, 105), e('squat', 2, 12, 60)]), T([e('squat', 3, 5, 100), e('squat', 2, 12, 65)]));
    expect((r.merged.exercises as Array<Record<string, number>>).map((x) => x.weight)).toEqual([105, 65]);
  });

  const P = (days: Array<{ weekday: number; templateId: string }>, extra: Record<string, unknown> = {}) =>
    ({ id: 'p1', createdAt: 1, updatedAt: 10, deviceId: 'a', title: 'Сила', startDate: '2026-11-02', weeks: 8, days, ...extra });
  it('программа: день недели переназначили на одном устройстве, продлили на другом', () => {
    const base = P([{ weekday: 1, templateId: 'A' }, { weekday: 3, templateId: 'B' }, { weekday: 5, templateId: 'A' }]);
    const r = merge('programs', base,
      P([{ weekday: 1, templateId: 'A' }, { weekday: 3, templateId: 'C' }, { weekday: 5, templateId: 'A' }]),
      { ...base, weeks: 12 });
    expect(r.merged.weeks).toBe(12);
    expect((r.merged.days as Array<{ weekday: number; templateId: string }>).find((d) => d.weekday === 3)!.templateId).toBe('C');
  });
});

describe('игровые настройки', () => {
  it('«надето» сливается по слотам, ник — по полям', () => {
    const S = { id: 'state', createdAt: 1, updatedAt: 1, deviceId: 'a', kind: 'state', equipped: { avatar: 'av-1', frame: 'fr-1' } };
    const r = merge('game', undefined, { ...S, equipped: { avatar: 'av-2' } }, { ...S, equipped: { frame: 'fr-2' }, nickname: 'Лев' });
    expect(r.merged).toMatchObject({ equipped: { avatar: 'av-2', frame: 'fr-2' }, nickname: 'Лев' });
  });
});
