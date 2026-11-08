import { describe, expect, it } from 'vitest';
import { cleanupLabel, needsEquipmentCleanup, shouldShowCleanup } from '../../src/domain/cleanup';
import { groupInfo } from '../../src/domain/superset';
import { confirmGate, planAfterSet } from '../../src/state/cleanupCore';
import { DEFAULT_SETTINGS, type Exercise, type SetEntry, type WorkoutExercise } from '../../src/domain/types';

const ex = (id: string, equipment: string, muscle = 'chest', name = id) => ({ id, name, equipment, muscle, custom: false } as unknown as Exercise);
const exerciseMap = new Map([
  ['bar', ex('bar', 'Штанга', 'chest', 'Жим')], ['bar2', ex('bar2', 'Гантели', 'back', 'Тяга')],
  ['body', ex('body', 'Свой вес', 'core', 'Планка')], ['none', ex('none', 'Без оборудования', 'legs')],
  ['blank', ex('blank', '', 'legs', 'Пусто')], ['run', ex('run', 'Улица, дорожка', 'cardio')]
]);
let n = 0;
const st = (done: boolean, extra: Partial<SetEntry> = {}): SetEntry => ({ id: 's' + ++n, weight: 50, reps: 10, done, ...extra });
const we = (exerciseId: string, sets: SetEntry[], group?: string): WorkoutExercise => ({ id: 'we' + ++n, exerciseId, sets, group });
const check = (exercises: WorkoutExercise[], index: number, set: SetEntry) =>
  shouldShowCleanup({ exercises, groupInfo: groupInfo(exercises), index, exerciseMap, set });

describe('needsEquipmentCleanup', () => {
  it('штанга — да; свой вес, без оборудования, кардио, неизвестное упражнение — нет; пустое оборудование — да', () => {
    expect(needsEquipmentCleanup(exerciseMap.get('bar'))).toBe(true);
    expect(needsEquipmentCleanup(exerciseMap.get('body'))).toBe(false);
    expect(needsEquipmentCleanup(exerciseMap.get('none'))).toBe(false);
    expect(needsEquipmentCleanup(exerciseMap.get('run'))).toBe(false);
    expect(needsEquipmentCleanup(exerciseMap.get('blank'))).toBe(true);
    expect(needsEquipmentCleanup(undefined)).toBe(false);
  });
});

describe('shouldShowCleanup', () => {
  it('последний рабочий подход со штангой: да', () => {
    const last = st(false);
    expect(check([we('bar', [st(true), last])], 0, last)).toBe(true);
  });
  it('«Свой вес»: нет', () => {
    const last = st(false);
    expect(check([we('body', [st(true), last])], 0, last)).toBe(false);
  });
  it('разминочный подход: нет', () => {
    const w = st(false, { warmup: true });
    expect(check([we('bar', [w])], 0, w)).toBe(false);
  });
  it('остались рабочие подходы: нет; оставшаяся разминка не мешает', () => {
    const a = st(false), b = st(false);
    expect(check([we('bar', [a, b])], 0, a)).toBe(false);
    const tail = st(false, { warmup: true });
    expect(check([we('bar', [a, tail])], 0, a)).toBe(true);
  });
  it('снятие галочки не открывает плашку', () => {
    const d = st(true);
    expect(check([we('bar', [d])], 0, d)).toBe(false);
  });
  it('суперсет: середина группы — нет; последнее упражнение при закрытых подходах — да', () => {
    const a1 = st(false), b1 = st(false);
    const list = [we('bar', [a1], 'g'), we('bar2', [b1], 'g')];
    expect(check(list, 0, a1)).toBe(false);
    const a2 = st(true);
    expect(check([we('bar', [a2], 'g'), we('bar2', [b1], 'g')], 1, b1)).toBe(true);
    // у первого упражнения ещё есть невыполненный подход
    expect(check(list, 1, b1)).toBe(false);
  });
  it('суперсет: инвентарь есть хотя бы у одного; вся группа на своём весе — нет', () => {
    const a = st(true), b = st(false);
    expect(check([we('body', [a], 'g'), we('bar', [b], 'g')], 1, b)).toBe(true);
    const c = st(true), d = st(false);
    expect(check([we('bar', [c], 'g'), we('body', [d], 'g')], 1, d)).toBe(true); // инвентарь у первого
    const e = st(true), f = st(false);
    expect(check([we('body', [e], 'g'), we('none', [f], 'g')], 1, f)).toBe(false);
  });
  it('кардио: нет', () => {
    const s = st(false);
    expect(check([we('run', [s])], 0, s)).toBe(false);
  });
  it('подпись: названия упражнений с инвентарём', () => {
    const list = [we('body', [st(true)], 'g'), we('bar', [st(true)], 'g'), we('bar2', [st(false)], 'g')];
    expect(cleanupLabel({ exercises: list, groupInfo: groupInfo(list), index: 2, exerciseMap })).toBe('Жим · Тяга');
  });
});

describe('гейт и отдых', () => {
  it('гейт открывается вместо отдыха и хранит рассчитанную длительность', () => {
    expect(planAfterSet({ enabled: true, show: true, rest: 90, label: 'Жим' })).toEqual({ kind: 'gate', gate: { label: 'Жим', restSec: 90 } });
  });
  it('«Свой вес» (show=false): отдых стартует сразу', () => {
    expect(planAfterSet({ enabled: true, show: false, rest: 90, label: '' })).toEqual({ kind: 'rest', sec: 90 });
  });
  it('cleanupEnabled = false: гейта нет, отдых как раньше; по умолчанию включено', () => {
    expect(planAfterSet({ enabled: false, show: true, rest: 60, label: 'Жим' })).toEqual({ kind: 'rest', sec: 60 });
    expect(DEFAULT_SETTINGS.cleanupEnabled).toBe(true);
  });
  it('отдыха нет (суперсет, дроп-сет): none', () => {
    expect(planAfterSet({ enabled: true, show: false, rest: null, label: '' })).toEqual({ kind: 'none' });
  });
  it('подтверждение: стартует отдых с рассчитанной длительностью, гейт закрыт', () => {
    expect(confirmGate({ label: 'Жим', restSec: 120 })).toEqual({ gate: null, startRestSec: 120 });
  });
  it('rest null или ≤ 0: подтверждение просто закрывает плашку', () => {
    expect(confirmGate({ label: 'x', restSec: null }).startRestSec).toBeNull();
    expect(confirmGate({ label: 'x', restSec: 0 }).startRestSec).toBeNull();
    expect(confirmGate(null)).toEqual({ gate: null, startRestSec: null });
  });
});
