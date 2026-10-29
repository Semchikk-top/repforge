import { describe, expect, it } from 'vitest';
import { groupInfo, linkWithNext, restAfter, splitAfter } from '../../src/domain/superset';
import { exerciseRecords } from '../../src/domain/analytics';
import { suggestNext } from '../../src/domain/progression';
import { exercisesFromTemplate } from '../../src/domain/ops';
import type { Exercise, SetEntry, Template, Workout, WorkoutExercise } from '../../src/domain/types';

const we = (id: string, group?: string): WorkoutExercise => ({ id, exerciseId: 'ex-' + id, sets: [], group });
const set = (weight: number, reps: number, kind?: SetEntry['kind']): SetEntry => ({ id: Math.random().toString(36).slice(2), weight, reps, done: true, kind });
const workout = (id: string, date: string, exs: { exerciseId: string; sets: SetEntry[] }[]): Workout =>
  ({ id, date, title: 't', status: 'done', createdAt: 1, updatedAt: 1, deviceId: 'd', exercises: exs.map((e, i) => ({ id: `${id}-${i}`, ...e })) }) as Workout;

describe('суперсеты', () => {
  it('подписывает связки A1, A2, B1, B2 и не считает одиночные группой', () => {
    const info = groupInfo([we('a', 'g1'), we('b', 'g1'), we('c'), we('d', 'g2'), we('e', 'g2'), we('f', 'g3')]);
    expect(info.map((i) => i.label)).toEqual(['A1', 'A2', null, 'B1', 'B2', null]);
    expect(info.map((i) => i.isLast)).toEqual([false, true, true, false, true, true]);
    expect(info[0].nextIndex).toBe(1);
  });

  it('связывает соседние упражнения и объединяет связки', () => {
    let ex = [we('a'), we('b'), we('c'), we('d')];
    ex = linkWithNext(ex, 0);
    expect(groupInfo(ex).map((i) => i.label)).toEqual(['A1', 'A2', null, null]);
    ex = linkWithNext(ex, 1); // присоединяем c к связке a+b
    expect(groupInfo(ex).map((i) => i.label)).toEqual(['A1', 'A2', 'A3', null]);
    ex = linkWithNext(ex, 3);  // у последнего нет следующего: ничего не меняется
    expect(ex[3].group).toBeUndefined();
  });

  it('разрывает связку; одинокий остаток перестаёт быть суперсетом', () => {
    let ex = linkWithNext(linkWithNext([we('a'), we('b'), we('c')], 0), 1);
    ex = splitAfter(ex, 1);               // a+b | c
    expect(groupInfo(ex).map((i) => i.label)).toEqual(['A1', 'A2', null]);
    ex = splitAfter(ex, 0);
    expect(groupInfo(ex).every((i) => i.label === null)).toBe(true);
    expect(ex.every((x) => !x.group)).toBe(true);
  });

  it('связка не «склеивается» через чужое упражнение с тем же group', () => {
    const info = groupInfo([we('a', 'g'), we('b'), we('c', 'g')]);
    expect(info.every((i) => i.label === null)).toBe(true);
  });

  it('отдых: после суперсета только в конце связки, без отдыха перед дроп-сетом', () => {
    const [a, b] = groupInfo(linkWithNext([we('a'), we('b')], 0));
    expect(restAfter({ superset: a, nextSetKind: undefined, restSec: 90 })).toBeNull();
    expect(restAfter({ superset: b, nextSetKind: undefined, restSec: 90 })).toBe(90);
    expect(restAfter({ superset: undefined, nextSetKind: 'drop', restSec: 90 })).toBeNull();
    expect(restAfter({ superset: undefined, nextSetKind: 'restpause', restSec: 90 })).toBe(15);
    expect(restAfter({ superset: undefined, nextSetKind: 'normal', restSec: 90 })).toBe(90);
  });
});

describe('прогрессия и типы подходов', () => {
  it('дроп-сеты и rest-pause не сбивают рабочий вес и повторы', () => {
    const h = [workout('w1', '2026-10-01', [{ exerciseId: 'bench', sets: [set(80, 12), set(80, 12), set(60, 20, 'drop'), set(80, 4, 'restpause')] }])];
    expect(suggestNext(h, 'bench', 2.5)).toMatchObject({ weight: 82.5 }); // по обычным подходам: 12 повторов, пора прибавлять
  });
  it('если были только дроп-сеты, подсказки нет', () => {
    const h = [workout('w1', '2026-10-01', [{ exerciseId: 'bench', sets: [set(60, 10, 'drop')] }])];
    expect(suggestNext(h, 'bench', 2.5)).toBeNull();
  });
});

describe('шаблоны', () => {
  it('сохраняют суперсеты при создании тренировки', () => {
    const exMap = new Map<string, Exercise>([['a', { id: 'a', name: 'A', muscle: 'chest' } as Exercise], ['b', { id: 'b', name: 'B', muscle: 'back' } as Exercise]]);
    const t = { id: 't', title: 't', exercises: [{ exerciseId: 'a', sets: 3, reps: 10, weight: 50, group: 'g' }, { exerciseId: 'b', sets: 3, reps: 10, weight: 40, group: 'g' }] } as Template;
    const out = exercisesFromTemplate(t, [], exMap);
    expect(groupInfo(out).map((i) => i.label)).toEqual(['A1', 'A2']);
  });
});

describe('рекорды', () => {
  const hist = [
    workout('w1', '2026-09-01', [{ exerciseId: 'bench', sets: [set(80, 5), set(80, 5)] }, { exerciseId: 'pull', sets: [set(0, 8), set(0, 10)] }]),
    workout('w2', '2026-09-10', [{ exerciseId: 'bench', sets: [set(85, 3), set(70, 12)] }]),
    workout('w3', '2026-09-20', [{ exerciseId: 'bench', sets: [set(85, 3)] }]),
  ];
  const r = Object.fromEntries(exerciseRecords(hist).map((x) => [x.exerciseId, x]));

  it('максимумы по весу, 1ПМ, объёму подхода и тренировки', () => {
    expect(r.bench.maxWeight).toMatchObject({ value: 85, reps: 3, date: '2026-09-10' });      // повтор значения не считается новым рекордом
    expect(r.bench.maxE1rm!.value).toBeCloseTo(70 * (1 + 12 / 30), 5);                        // 98 > 85×3 → 93.5 и 80×5 → 93.3
    expect(r.bench.maxSetVolume).toMatchObject({ value: 840, weight: 70, reps: 12 });
    expect(r.bench.maxSessionVolume).toMatchObject({ value: 85 * 3 + 70 * 12, date: '2026-09-10' });
    expect(r.bench.latest).toBe('2026-09-10');
  });
  it('упражнения без веса считаются по повторениям', () => {
    expect(r.pull.maxWeight).toBeNull();
    expect(r.pull.maxReps).toEqual({ value: 10, date: '2026-09-01' });
  });
  it('незавершённые, удалённые и невыполненные подходы не считаются', () => {
    const open = { ...workout('w4', '2026-10-01', [{ exerciseId: 'bench', sets: [set(200, 5)] }]), status: 'active' } as Workout;
    const gone = { ...workout('w5', '2026-10-02', [{ exerciseId: 'bench', sets: [set(300, 5)] }]), deletedAt: 1 } as Workout;
    const notDone = workout('w6', '2026-10-03', [{ exerciseId: 'bench', sets: [{ ...set(400, 5), done: false }] }]);
    expect(exerciseRecords([...hist, open, gone, notDone]).find((x) => x.exerciseId === 'bench')!.maxWeight!.value).toBe(85);
  });
});
