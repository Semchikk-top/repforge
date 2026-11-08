import { describe, expect, it } from 'vitest';
import { blocksOf, dropIndex, moveBlock, stepBlock } from '../../src/domain/reorder';
import { groupInfo } from '../../src/domain/superset';
import {
  averageSetSec, exerciseTimeStats, formatSetTime, latestDoneAt, MAX_SET_SEC, needsManualStart, resolveSetStart, workSecBetween
} from '../../src/domain/setTiming';
import type { SetEntry, Workout, WorkoutExercise } from '../../src/domain/types';

const mkSet = (id: string, over: Partial<SetEntry> = {}): SetEntry => ({ id, weight: 50, reps: 10, done: false, ...over });
const we = (id: string, group?: string, sets: SetEntry[] = [mkSet(id + '-1'), mkSet(id + '-2')]): WorkoutExercise => ({ id, exerciseId: 'ex-' + id, sets, group });
const names = (xs: WorkoutExercise[]) => xs.map((x) => x.id).join('');

describe('перестановка упражнений', () => {
  it('блок — одиночное упражнение или суперсет целиком', () => {
    const ex = [we('a'), we('b', 'g'), we('c', 'g'), we('d')];
    expect(blocksOf(ex)).toEqual([{ start: 0, end: 1 }, { start: 1, end: 3 }, { start: 3, end: 4 }]);
  });

  it('двигает одиночное упражнение через суперсет целиком, не разрывая его', () => {
    const ex = [we('a'), we('b', 'g'), we('c', 'g'), we('d')];
    const moved = stepBlock(ex, 0, 1); // a вниз: встаёт после суперсета b+c
    expect(names(moved)).toBe('bcad');
    expect(groupInfo(moved).map((i) => i.label)).toEqual(['A1', 'A2', null, null]);
  });

  it('двигает суперсет вместе, а крайние позиции ничего не ломают', () => {
    const ex = [we('a'), we('b', 'g'), we('c', 'g'), we('d')];
    expect(names(stepBlock(ex, 2, 1))).toBe('adbc'); // любое упражнение связки двигает всю связку
    expect(stepBlock(ex, 0, -1)).toBe(ex);           // выше первого некуда
    expect(stepBlock(ex, 3, 1)).toBe(ex);            // ниже последнего некуда
  });

  it('не склеивает случайно два блока со старым одинаковым group', () => {
    // у a и c остался один и тот же group от прежней связки, но они не рядом
    const ex = [we('a', 'g'), we('b'), we('c', 'g')];
    const moved = moveBlock(ex, 1, 0); // b наверх: a и c по-прежнему не соседи
    expect(groupInfo(moved).map((i) => i.label)).toEqual([null, null, null]);
    const moved2 = moveBlock(ex, 1, 2); // b вниз: теперь a и c оказались рядом
    expect(groupInfo(moved2).map((i) => i.label)).toEqual([null, null, null]);
  });

  it('куда встанет блок при перетаскивании', () => {
    const mids = [100, 300, 500]; // середины трёх блоков
    expect(dropIndex(mids, 0, 100)).toBe(0);  // не сдвинулся
    expect(dropIndex(mids, 0, 350)).toBe(1);  // перешёл середину второго
    expect(dropIndex(mids, 0, 900)).toBe(2);  // в самый низ
    expect(dropIndex(mids, 2, 50)).toBe(0);   // в самый верх
    expect(dropIndex(mids, 1, 300)).toBe(1);
  });
});

describe('время подхода', () => {
  it('кнопка «Начать» нужна первому подходу упражнения, но не продолжению суперсета', () => {
    const ex = [we('a', 'g'), we('b', 'g'), we('c')];
    expect(needsManualStart(ex, 0, 'a-1')).toBe(true);
    expect(needsManualStart(ex, 0, 'a-2')).toBe(false); // не первый подход
    expect(needsManualStart(ex, 1, 'b-1')).toBe(false); // следует за a в суперсете
    expect(needsManualStart(ex, 2, 'c-1')).toBe(true);
  });

  it('первый подход без «Начать» времени не получает, с «Начать» получает', () => {
    const ex = [we('a')];
    expect(resolveSetStart(ex, 0, ex[0].sets[0], null, false)).toBeNull();
    const started = { ...ex[0].sets[0], startedAt: 1_000 };
    expect(resolveSetStart(ex, 0, started, null, false)).toBe(1_000);
    expect(workSecBetween(1_000, 41_000)).toBe(40);
  });

  it('следующий подход стартует с конца отдыха, а без отдыха — с галочки предыдущего', () => {
    const ex = [we('a', undefined, [mkSet('a-1', { done: true, completedAt: 100_000 }), mkSet('a-2')])];
    const next = ex[0].sets[1];
    expect(resolveSetStart(ex, 0, next, 190_000, false)).toBe(190_000); // отдых закончился в 190 с
    expect(resolveSetStart(ex, 0, next, 50_000, false)).toBe(100_000);  // конец старого отдыха игнорируется
    expect(resolveSetStart(ex, 0, next, null, false)).toBe(100_000);    // дроп-сет, суперсет: отдыха не было
  });

  it('галочка во время идущего отдыха времени не даёт', () => {
    const ex = [we('a', undefined, [mkSet('a-1', { done: true, completedAt: 100_000 }), mkSet('a-2')])];
    expect(resolveSetStart(ex, 0, ex[0].sets[1], null, true)).toBeNull();
  });

  it('суперсет: второе упражнение стартует от галочки первого', () => {
    const ex = [
      we('a', 'g', [mkSet('a-1', { done: true, completedAt: 100_000 })]),
      we('b', 'g', [mkSet('b-1')])
    ];
    expect(resolveSetStart(ex, 1, ex[1].sets[0], null, false)).toBe(100_000);
    expect(latestDoneAt(ex)).toBe(100_000);
    expect(latestDoneAt(ex, 'a-1')).toBeNull();
  });

  it('нелепые значения отбрасываются', () => {
    expect(workSecBetween(null, 5_000)).toBeUndefined();
    expect(workSecBetween(5_000, 5_100)).toBeUndefined();                       // меньше секунды
    expect(workSecBetween(0, (MAX_SET_SEC + 1) * 1000)).toBeUndefined();        // забытый подход
    expect(workSecBetween(0, MAX_SET_SEC * 1000)).toBe(MAX_SET_SEC);
  });

  it('форматирует время', () => {
    expect(formatSetTime(42)).toBe('0:42');
    expect(formatSetTime(65.4)).toBe('1:05');
  });
});

describe('среднее время в аналитике', () => {
  const workout = (id: string, status: Workout['status'], exs: WorkoutExercise[]): Workout =>
    ({ id, date: '2026-11-0' + id, title: 't', status, createdAt: 1, updatedAt: 1, deviceId: 'd', exercises: exs }) as Workout;
  const timed = (id: string, sec: number, over: Partial<SetEntry> = {}) => mkSet(id, { done: true, workSec: sec, ...over });

  it('считает среднее по подходу и по упражнению, без разминки и подходов без времени', () => {
    const w1 = workout('1', 'done', [we('a', undefined, [timed('1', 30), timed('2', 50), timed('3', 5, { warmup: true }), mkSet('4', { done: true })])]);
    const w2 = workout('2', 'done', [we('a', undefined, [timed('5', 40)])]);
    const stats = exerciseTimeStats([w1, w2]);
    expect(stats).toHaveLength(1);
    expect(stats[0].sets).toBe(3);
    expect(stats[0].sessions).toBe(2);
    expect(stats[0].avgSetSec).toBeCloseTo(40);        // (30+50+40)/3
    expect(stats[0].avgExerciseSec).toBeCloseTo(60);   // (80+40)/2
    expect(averageSetSec([w1, w2])).toEqual({ avgSec: 40, sets: 3 });
  });

  it('незавершённые тренировки и пустые данные не считаются', () => {
    const active = workout('1', 'active', [we('a', undefined, [timed('1', 30)])]);
    expect(averageSetSec([active])).toBeNull();
    expect(exerciseTimeStats([])).toEqual([]);
  });
});

// ---------- прогноз, отдых, темп, отмена, порядок в шаблоне ----------
import { DEFAULT_SET_SEC, forecastSec, formatForecast } from '../../src/domain/forecast';
import { averageRestSec, exerciseRestStats, exerciseTempoStats } from '../../src/domain/setTiming';
import { insertAt, restoreLayout, templateWithWorkoutOrder } from '../../src/domain/reorder';
import type { Template } from '../../src/domain/types';

const wk = (id: string, exs: WorkoutExercise[], status: Workout['status'] = 'done'): Workout =>
  ({ id, date: '2026-11-0' + id, title: 't', status, createdAt: 1, updatedAt: 1, deviceId: 'd', exercises: exs }) as Workout;

describe('прогноз времени', () => {
  it('без истории считает по 40 с на подход плюс отдых, после последнего подхода отдыха нет', () => {
    const ex = [we('a', undefined, [mkSet('1'), mkSet('2'), mkSet('3')])];
    const f = forecastSec(ex, [], 90)!;
    expect(f.sec).toBe(3 * DEFAULT_SET_SEC + 2 * 90);
    expect(f.measured).toBe(false);
  });

  it('использует измеренное время упражнения и не считает выполненные подходы', () => {
    const hist = [wk('1', [we('a', undefined, [mkSet('h1', { done: true, workSec: 30 }), mkSet('h2', { done: true, workSec: 50 })])])];
    const ex = [we('a', undefined, [mkSet('1', { done: true }), mkSet('2'), mkSet('3')])];
    const f = forecastSec(ex, hist, 60)!;
    expect(f.sec).toBe(2 * 40 + 60); // два оставшихся по 40 с и один отдых между ними
    expect(f.measured).toBe(true);
  });

  it('в суперсете отдыхаем только после последнего упражнения связки; кардио пропускается', () => {
    const ex = [we('a', 'g', [mkSet('1')]), we('b', 'g', [mkSet('2')]), we('c', undefined, [mkSet('3')])];
    const f = forecastSec(ex, [], 100, (x) => x.id === 'c')!;
    expect(f.sec).toBe(2 * 40); // отдых был бы после b, но это последний подход, и c исключено
    expect(forecastSec([we('a', undefined, [mkSet('1', { done: true })])], [], 60)).toBeNull();
  });

  it('округляет до пяти минут', () => {
    expect(formatForecast(60)).toBe('5 мин');
    expect(formatForecast(62 * 60)).toBe('1 ч 00 мин');
    expect(formatForecast(66 * 60)).toBe('1 ч 05 мин');
    expect(formatForecast(23 * 60)).toBe('25 мин');
  });
});

describe('отдых по таймеру и темп', () => {
  it('отдых: от галочки до начала следующего подхода, без суперсетов, дроп-сетов и подходов с «Начать»', () => {
    const sets = [
      mkSet('1', { done: true, completedAt: 100_000 }),
      mkSet('2', { done: true, completedAt: 100_000 + 120_000 + 30_000, workSec: 30 }),       // отдых 120 с
      mkSet('3', { done: true, completedAt: 250_000 + 100_000 + 30_000, workSec: 30, kind: 'drop' }), // не считаем
    ];
    const w = wk('1', [we('a', undefined, sets), we('b', 'g', [mkSet('x', { done: true, completedAt: 1 }), mkSet('y', { done: true, completedAt: 100_000, workSec: 10 })])]);
    const st = exerciseRestStats([w]);
    expect(st).toEqual([{ exerciseId: 'ex-a', avgRestSec: 120, count: 1 }]);
    expect(averageRestSec([w])).toEqual({ avgSec: 120, count: 1 });
  });

  it('темп: секунд на повторение и замедление к последнему подходу', () => {
    const mk = (id: string, secs: number[]) => wk(id, [we('a', undefined, secs.map((s, i) => mkSet(id + i, { done: true, reps: 10, workSec: s })))]);
    const st = exerciseTempoStats([mk('1', [30, 30, 36]), mk('2', [30, 33, 39])]);
    expect(st[0].secPerRep).toBeCloseTo((3 + 3 + 3.6 + 3 + 3.3 + 3.9) / 6);
    expect(st[0].slowdownPct).toBeCloseTo(25, 5); // +20% и +30% в среднем
    expect(exerciseTempoStats([mk('1', [30, 30, 36])])[0].slowdownPct).toBeNull(); // одной тренировки мало
  });
});

describe('отмена и порядок в шаблоне', () => {
  it('отмена перестановки возвращает порядок и связки, не трогая остальное', () => {
    const prev = [we('a'), we('b', 'g'), we('c', 'g')];
    const now = moveBlock(prev, 0, 1).map((x) => (x.id === 'a' ? { ...x, sets: [mkSet('new')] } : x));
    const back = restoreLayout(now, prev);
    expect(names(back)).toBe('abc');
    expect(back[0].sets[0].id).toBe('new'); // правка подхода после перестановки сохранилась
    expect(back[1].group).toBe('g');
  });

  it('возвращает удалённое упражнение на место и не дублирует', () => {
    const ex = [we('a'), we('c')];
    const b = we('b');
    expect(names(insertAt(ex, b, 1))).toBe('abc');
    expect(insertAt([...ex, b], b, 0)).toEqual([...ex, b]);
    expect(names(insertAt(ex, b, 99))).toBe('acb');
  });

  const tpl = (exs: Template['exercises']): Template => ({ id: 't', createdAt: 1, updatedAt: 1, deviceId: 'd', title: 'Push', exercises: exs }) as Template;
  const te = (id: string, group?: string) => ({ exerciseId: 'ex-' + id, sets: 3, reps: 10, weight: 50, group });

  it('предлагает новый порядок шаблона только если состав тот же', () => {
    const t = tpl([te('a'), te('b'), te('c')]);
    const reordered = templateWithWorkoutOrder(t, wk('1', [we('c'), we('a'), we('b')]));
    expect(reordered?.exercises.map((e) => e.exerciseId)).toEqual(['ex-c', 'ex-a', 'ex-b']);
    expect(templateWithWorkoutOrder(t, wk('1', [we('a'), we('b'), we('c')]))).toBeNull(); // порядок тот же
    expect(templateWithWorkoutOrder(t, wk('1', [we('c'), we('a'), we('z')]))).toBeNull(); // состав другой
  });

  it('связка шаблона, распавшаяся при перестановке, перестаёт быть связкой', () => {
    const t = tpl([te('a', 'g'), te('b', 'g'), te('c')]);
    const r = templateWithWorkoutOrder(t, wk('1', [we('a'), we('c'), we('b')]))!;
    expect(r.exercises.map((e) => e.group)).toEqual([undefined, undefined, undefined]);
    const r2 = templateWithWorkoutOrder(t, wk('1', [we('c'), we('a'), we('b')]))!;
    expect(r2.exercises.map((e) => e.group)).toEqual([undefined, 'g', 'g']); // связка уцелела
  });
});
