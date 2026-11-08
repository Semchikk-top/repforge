import { describe, expect, it } from 'vitest';
import {
  COUNTDOWN_SEC, eventPhrase, expandPlan, finalLaps, GRACE_SEC, initialIntervalState, intervalStep, OFF_GAP_SEC, planSummary, skipStep, startPhrase, stepProgress, validatePlan,
  type IntervalSample, type IntervalState, type Step
} from '../../src/cardio/intervals';
import type { IntervalPlan } from '../../src/domain/types';

const plan: IntervalPlan = { warmup: { by: 'time', sec: 60 }, reps: 3, work: { length: { by: 'time', sec: 40 }, target: { kind: 'pace', secPerKm: 300 } }, rest: { length: { by: 'time', sec: 20 } }, cooldown: { by: 'distance', m: 500 } };
const sm = (activeSec: number, distanceM = 0, extra: Partial<IntervalSample> = {}): IntervalSample => ({ activeSec, distanceM, paceSecPerKm: null, hrBpm: null, maxHr: null, ...extra });

/** Прогоняет движок секунда за секундой; скорость v м/с задаёт дистанцию. */
function run(steps: Step[], seconds: number, v = 3, from: { st: IntervalState; t: number; d: number } = { st: initialIntervalState(), t: 0, d: 0 }) {
  let { st, t, d } = from;
  const log: { t: number; ev: ReturnType<typeof intervalStep>['events'][number] }[] = [];
  for (let i = 0; i < seconds; i++) {
    const r = intervalStep(steps, st, sm(t, d));
    st = r.state;
    r.events.forEach((ev) => log.push({ t, ev }));
    t += 1; d += v;
  }
  return { st, t, d, log };
}

describe('expandPlan', () => {
  it('разминка, работа и отдых по кругу без отдыха после последней работы, заминка', () => {
    const s = expandPlan(plan);
    expect(s.map((x) => x.role)).toEqual(['warmup', 'work', 'rest', 'work', 'rest', 'work', 'cooldown']);
    expect(s[1]).toMatchObject({ rep: 1, reps: 3 });
    expect(s[5]).toMatchObject({ rep: 3, reps: 3 });
  });
  it('минимальный план: только работа', () => {
    expect(expandPlan({ reps: 1, work: { length: { by: 'time', sec: 30 } } }).map((x) => x.role)).toEqual(['work']);
  });
});

describe('validatePlan: границы', () => {
  const ok = (p: Partial<IntervalPlan>) => validatePlan({ ...plan, ...p });
  it('корректный план проходит', () => expect(validatePlan(plan)).toBeNull());
  it('повторы 1..50', () => { expect(ok({ reps: 0 })).not.toBeNull(); expect(ok({ reps: 51 })).not.toBeNull(); expect(ok({ reps: 50 })).toBeNull(); expect(ok({ reps: 2.5 })).not.toBeNull(); });
  it('время от 5 секунд, дистанция от 20 м', () => {
    expect(ok({ work: { length: { by: 'time', sec: 4 } } })).not.toBeNull();
    expect(ok({ work: { length: { by: 'time', sec: 5 } } })).toBeNull();
    expect(ok({ work: { length: { by: 'distance', m: 19 } } })).not.toBeNull();
    expect(ok({ cooldown: { by: 'distance', m: 60_000 } })).not.toBeNull();
  });
  it('цель: темп в допустимых пределах и зона 1–5', () => {
    expect(ok({ work: { length: { by: 'time', sec: 30 }, target: { kind: 'pace', secPerKm: 100 } } })).not.toBeNull();
    expect(ok({ work: { length: { by: 'time', sec: 30 }, target: { kind: 'zone', zone: 6 as 5 } } })).not.toBeNull();
    expect(ok({ work: { length: { by: 'time', sec: 30 }, target: { kind: 'zone', zone: 4 } } })).toBeNull();
  });
  it('мусор вместо плана отвергается', () => { expect(validatePlan(null)).not.toBeNull(); expect(validatePlan({ reps: 3 })).not.toBeNull(); });
});

describe('границы отрезков по времени', () => {
  const steps = expandPlan(plan);
  it('первый вызов запускает разминку; отрезок кончается ровно на своей секунде', () => {
    const { log } = run(steps, 62);
    const starts = log.filter((l) => l.ev.kind === 'start');
    expect(starts[0].t).toBe(0);
    expect(starts[1].t).toBe(60); // разминка 60 с, работа 1 начинается на 60-й секунде
    expect(starts[1].ev).toMatchObject({ kind: 'start', index: 1 });
  });
  it('весь план: начала отрезков в 0, 60, 100, 120, 160, 180, 220 с, потом дистанционная заминка', () => {
    const { log, st } = run(steps, 240, 3);
    expect(log.filter((l) => l.ev.kind === 'start').map((l) => l.t)).toEqual([0, 60, 100, 120, 160, 180, 220]);
    expect(st.done).toBe(false); // заминка 500 м при 3 м/с идёт ещё ~167 с
  });
  it('заминка по дистанции заканчивается на 500 м и план завершается событием done', () => {
    const { log, st } = run(steps, 220 + 170, 3);
    expect(st.done).toBe(true);
    expect(log[log.length - 1].ev.kind).toBe('done');
    expect(st.laps.map((l) => l.role)).toEqual(['warmup', 'work', 'rest', 'work', 'rest', 'work', 'cooldown']);
    expect(st.laps[1]).toMatchObject({ sec: 40, distanceM: 120 });
    expect(st.laps[6].distanceM).toBeGreaterThanOrEqual(500);
  });
  it('после завершения движок молчит', () => {
    const done = run(steps, 400, 3);
    expect(intervalStep(steps, done.st, sm(500, 2000)).events).toEqual([]);
  });
});

describe('пауза: активное время не идёт', () => {
  it('если рекордер не передаёт секунды, отрезок не заканчивается', () => {
    const steps = expandPlan({ reps: 1, work: { length: { by: 'time', sec: 30 } } });
    const a = run(steps, 10);
    // пауза: тот же activeSec много раз подряд
    let st = a.st;
    for (let i = 0; i < 100; i++) st = intervalStep(steps, st, sm(a.t, a.d)).state;
    expect(st.index).toBe(0);
    const resumed = run(steps, 25, 3, { st, t: a.t, d: a.d });
    expect(resumed.st.done).toBe(true);
  });
});

describe('предупреждение о конце отрезка', () => {
  const steps = expandPlan({ reps: 2, work: { length: { by: 'time', sec: 60 } }, rest: { length: { by: 'time', sec: 30 } } });
  it('звучит один раз за 10 секунд до конца длинного отрезка', () => {
    const { log } = run(steps, 60);
    const cd = log.filter((l) => l.ev.kind === 'countdown');
    expect(cd).toHaveLength(1);
    expect(cd[0].t).toBe(60 - COUNTDOWN_SEC);
    expect(eventPhrase(cd[0].ev, false)).toBe('Через 10 секунд: отдых.');
  });
  it('короткий отрезок (меньше 30 с) без предупреждения', () => {
    const short = expandPlan({ reps: 1, work: { length: { by: 'time', sec: 20 } } });
    expect(run(short, 25).log.some((l) => l.ev.kind === 'countdown')).toBe(false);
  });
  it('по дистанции: за 100 м до конца, перед концом плана звучит «конец»', () => {
    const d = expandPlan({ reps: 1, work: { length: { by: 'distance', m: 500 } } });
    const { log } = run(d, 200, 3);
    const cd = log.find((l) => l.ev.kind === 'countdown')!;
    expect(eventPhrase(cd.ev, false)).toBe('Осталось 100 метров, дальше конец.');
  });
});

describe('пропуск отрезка', () => {
  const steps = expandPlan({ reps: 2, work: { length: { by: 'time', sec: 60 } }, rest: { length: { by: 'time', sec: 30 } } });
  it('помечает отрезок пропущенным и сразу начинает следующий', () => {
    const a = run(steps, 20);
    const r = skipStep(steps, a.st, sm(a.t, a.d));
    expect(r.state.index).toBe(1);
    expect(r.state.laps[0]).toMatchObject({ role: 'work', skipped: true, sec: 20 });
    expect(r.events[0]).toMatchObject({ kind: 'start', index: 1 });
    expect(r.state.startSec).toBe(a.t);
  });
  it('пропуск последнего отрезка завершает план; до старта и после конца ничего не делает', () => {
    const fresh = initialIntervalState();
    expect(skipStep(steps, fresh, sm(0)).events).toEqual([]);
    let st = run(steps, 1).st;
    for (let i = 0; i < steps.length; i++) st = skipStep(steps, st, sm(5)).state;
    expect(st.done).toBe(true);
    expect(skipStep(steps, st, sm(6)).events).toEqual([]);
  });
});

describe('подсказки о цели', () => {
  const steps = expandPlan({ reps: 1, work: { length: { by: 'time', sec: 300 }, target: { kind: 'pace', secPerKm: 300 } } });
  const feed = (st: IntervalState, t: number, extra: Partial<IntervalSample>) => intervalStep(steps, st, sm(t, 0, extra));
  it('в первые 15 секунд молчит, потом говорит «Ускорься» при темпе медленнее цели на 10%+', () => {
    let st = feed(initialIntervalState(), 0, {}).state;
    expect(feed(st, GRACE_SEC - 1, { paceSecPerKm: 400 }).events).toEqual([]);
    const r = feed(st, GRACE_SEC, { paceSecPerKm: 400 });
    expect(r.events).toEqual([{ kind: 'off-target', dir: 'slow', step: steps[0] }]);
    expect(eventPhrase(r.events[0], false)).toBe('Ускорься.');
  });
  it('допуск 10%: 329 с нормально, 331 — медленно; 269 нормально, 269 — быстро на границе', () => {
    const st = feed(initialIntervalState(), 0, {}).state;
    expect(feed(st, 20, { paceSecPerKm: 329 }).events).toEqual([]);
    expect(feed(st, 20, { paceSecPerKm: 331 }).events).toHaveLength(1);
    expect(feed(st, 20, { paceSecPerKm: 271 }).events).toEqual([]);
    expect(feed(st, 20, { paceSecPerKm: 269 }).events[0]).toMatchObject({ dir: 'fast' });
  });
  it('не чаще раза в 30 секунд', () => {
    let st = feed(initialIntervalState(), 0, {}).state;
    const first = feed(st, 20, { paceSecPerKm: 400 }); st = first.state;
    expect(first.events).toHaveLength(1);
    expect(feed(st, 20 + OFF_GAP_SEC - 1, { paceSecPerKm: 400 }).events).toEqual([]);
    expect(feed(st, 20 + OFF_GAP_SEC, { paceSecPerKm: 400 }).events).toHaveLength(1);
  });
  it('нет данных о темпе: молчит', () => {
    const st = feed(initialIntervalState(), 0, {}).state;
    expect(feed(st, 60, { paceSecPerKm: null }).events).toEqual([]);
  });
  it('пульсовая зона: выше и ниже цели', () => {
    const z = expandPlan({ reps: 1, work: { length: { by: 'time', sec: 300 }, target: { kind: 'zone', zone: 3 } } });
    const st = intervalStep(z, initialIntervalState(), sm(0)).state;
    const at = (hr: number | null, maxHr: number | null = 200) => intervalStep(z, st, sm(30, 0, { hrBpm: hr, maxHr })).events;
    expect(at(150)).toEqual([]);               // 75% — зона 3
    expect(at(185)[0]).toMatchObject({ dir: 'high' });
    expect(at(110)[0]).toMatchObject({ dir: 'low' });
    expect(at(null)).toEqual([]);
    expect(at(150, null)).toEqual([]);
  });
});

describe('итоги и тексты', () => {
  const steps = expandPlan(plan);
  it('при остановке посреди отрезка добавляется начатая часть с пометкой partial', () => {
    const a = run(steps, 75, 3);
    const laps = finalLaps(steps, a.st, sm(a.t, a.d));
    expect(laps.map((l) => l.role)).toEqual(['warmup', 'work']);
    expect(laps[1]).toMatchObject({ partial: true, sec: 15 });
  });
  it('если сразу после старта отрезка ничего не набежало, пустой лап не добавляется', () => {
    const a = run(steps, 61, 3);
    expect(finalLaps(steps, a.st, sm(a.t - 1, a.d - 3)).map((l) => l.role)).toEqual(['warmup']);
  });
  it('фразы старта: номер повтора, длина и цель, велосипед говорит скоростью', () => {
    expect(startPhrase(steps[1], false)).toBe('Работа 1 из 3. 40 секунд, темп 5 минут на километр.');
    expect(startPhrase(steps[0], false)).toBe('Разминка. 1 минута.');
    expect(startPhrase({ ...steps[1], target: { kind: 'pace', secPerKm: 144 + 6 } }, true)).toContain('24 километра в час');
    expect(startPhrase(steps[6], false)).toBe('Заминка. 500 метров.');
  });
  it('прогресс и подпись плана', () => {
    const st = run(steps, 10).st;
    expect(stepProgress(steps[0], st, sm(10, 0))).toMatchObject({ elapsed: 10, remaining: 50, unit: 'sec' });
    expect(planSummary(plan)).toBe('разминка 1:00 · 3 × 0:40 / 0:20 · заминка 500 м');
  });
});
