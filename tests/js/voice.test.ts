import { describe, expect, it } from 'vitest';
import { SpeechQueue, type QueueClock, type SpeechEngine } from '../../src/cardio/speechQueue';
import {
  arrivedText, coachStep, distanceWords, durationWords, finishText, halfText, initialCoachState, kmWords, maneuverText, offRouteText,
  rerouteFailText, startText, zoneWithHysteresis, type CoachConfig, type CoachSample, type CoachState
} from '../../src/cardio/voice';
import type { NavManeuver } from '../../src/domain/types';

describe('слова', () => {
  it('километры и метры со склонением', () => {
    expect(kmWords(5200)).toBe('5,2 километра');
    expect(kmWords(3000)).toBe('3 километра');
    expect(kmWords(1000)).toBe('1 километр');
    expect(kmWords(5000)).toBe('5 километров');
    expect(distanceWords(120)).toBe('120 метров');
    expect(distanceWords(41)).toBe('40 метров');
    expect(distanceWords(21)).toBe('20 метров');
    expect(distanceWords(1500)).toBe('1,5 километра');
    expect(durationWords(3725)).toBe('1 час 2 минуты 5 секунд');
    expect(durationWords(60)).toBe('1 минута');
  });
  it('старт, итоги, финиш', () => {
    expect(startText({ distanceM: 5200 })).toBe('Маршрут 5,2 километра. Вперёд.');
    expect(startText(null)).toBe('Запись началась. Вперёд.');
    expect(finishText({ distanceM: 5000, durationSec: 1800, hrAvg: 148 }, false)).toBe('Тренировка завершена. Дистанция 5 километров. Время 30 минут. Средний темп 6 минут 0 секунд на километр. Средний пульс 148.');
    expect(finishText({ distanceM: 20000, durationSec: 3600 }, true)).toContain('Средняя скорость 20 километра в час.');
    expect(arrivedText()).toContain('конечную');
    expect(offRouteText(80, 90)).toBe('Вы сошли с маршрута. Он в 80 метров на востоке.');
    expect(rerouteFailText(true)).toContain('Нет сети');
    expect(halfText(2600, 5200)).toBe('Половина дистанции. Осталось 2,6 километра.');
  });
  it('фраза о манёвре: заранее с расстоянием, у поворота полная', () => {
    const m: NavManeuver = { type: 15, instruction: 'Поверните налево на улицу Ленина.', alert: 'Поверните налево.', verbal: 'Поверните налево на улицу Ленина.', lengthM: 0, timeSec: 0, shapeIndex: 1 };
    const th = [120, 40, 15];
    expect(maneuverText(m, 120, th)).toBe('Через 120 метров, поверните налево.');
    expect(maneuverText(m, 40, th)).toBe('Через 40 метров, поверните налево.');
    expect(maneuverText(m, 15, th)).toBe('Поверните налево на улицу Ленина.');
  });
});

// ---------- тренировочные подсказки ----------
const cfg = (over: Partial<CoachConfig> = {}): CoachConfig => ({ maxHr: 190, targetPaceSecPerKm: null, plannedM: null, bike: false, ...over });
const sample = (t: number, over: Partial<CoachSample> = {}): CoachSample => ({ t, distanceM: 1000, movingSec: 300, paceSecPerKm: 360, hrBpm: null, ...over });
function drive(c: CoachConfig, samples: CoachSample[], st: CoachState = initialCoachState()) {
  const said: { t: number; text: string }[] = [];
  for (const s of samples) { const r = coachStep(c, st, s); st = r.state; r.say.forEach((text) => said.push({ t: s.t, text })); }
  return { said, st };
}
const every = (from: number, to: number, step: number, mk: (t: number) => CoachSample) => { const a: CoachSample[] = []; for (let t = from; t <= to; t += step) a.push(mk(t)); return a; };

describe('тренировочные подсказки: пульс', () => {
  it('без датчика или без maxHr — тишина', () => {
    expect(drive(cfg(), every(0, 120_000, 1000, (t) => sample(t, { hrBpm: null }))).said).toEqual([]);
    expect(drive(cfg({ maxHr: 0 }), every(0, 120_000, 1000, (t) => sample(t, { hrBpm: 170 }))).said).toEqual([]);
  });
  it('первая зона принимается молча, смена — только после устойчивого удержания', () => {
    const hr = (t: number) => (t < 20_000 ? 120 : 165); // зона 2 → зона 4
    const { said } = drive(cfg(), every(0, 60_000, 1000, (t) => sample(t, { hrBpm: hr(t) })));
    expect(said).toHaveLength(1);
    expect(said[0].text).toContain('зона 4');
    expect(said[0].t).toBeGreaterThanOrEqual(30_000); // 20 с + 10 с устойчивости
  });
  it('короткий всплеск пульса не озвучивается', () => {
    const hr = (t: number) => (t >= 20_000 && t < 25_000 ? 170 : 120);
    expect(drive(cfg(), every(0, 60_000, 1000, (t) => sample(t, { hrBpm: hr(t) }))).said).toEqual([]);
  });
  it('пауза между сообщениями о зоне не короче минуты', () => {
    const hr = (t: number) => (Math.floor(t / 15_000) % 2 === 0 ? 120 : 165); // качается каждые 15 с
    const { said } = drive(cfg(), every(0, 180_000, 1000, (t) => sample(t, { hrBpm: hr(t) })));
    for (let i = 1; i < said.length; i++) expect(said[i].t - said[i - 1].t).toBeGreaterThanOrEqual(60_000);
  });
  it('гистерезис: на границе зоны пульс «дрожит» без смены', () => {
    // зона 3 — 70–80% от 190 = 133–152
    expect(zoneWithHysteresis(3, 131, 190)).toBe(3);
    expect(zoneWithHysteresis(3, 153, 190)).toBe(3);
    expect(zoneWithHysteresis(3, 160, 190)).toBe(4);
    expect(zoneWithHysteresis(3, 100, 190)).toBe(1);
  });
});

describe('тренировочные подсказки: темп и половина', () => {
  it('без цели темп молчит', () => {
    expect(drive(cfg(), every(0, 300_000, 1000, (t) => sample(t, { paceSecPerKm: 500 }))).said).toEqual([]);
  });
  it('кратковременный всплеск не считается, устойчивое отклонение — да', () => {
    const c = cfg({ targetPaceSecPerKm: 360 });
    const spike = (t: number) => sample(t, { paceSecPerKm: t >= 10_000 && t < 20_000 ? 420 : 360 });
    expect(drive(c, every(0, 120_000, 1000, spike)).said).toEqual([]);
    const { said } = drive(c, every(0, 100_000, 1000, (t) => sample(t, { paceSecPerKm: 420 })));
    expect(said).toHaveLength(1);
    expect(said[0].text).toContain('медленнее цели');
    expect(said[0].t).toBeGreaterThanOrEqual(30_000);
  });
  it('повтор того же отклонения не чаще 90 секунд', () => {
    const { said } = drive(cfg({ targetPaceSecPerKm: 360 }), every(0, 400_000, 1000, (t) => sample(t, { paceSecPerKm: 300 })));
    expect(said.length).toBeGreaterThan(1);
    for (let i = 1; i < said.length; i++) expect(said[i].t - said[i - 1].t).toBeGreaterThanOrEqual(90_000);
    expect(said[0].text).toContain('быстрее');
  });
  it('разминка: в первую минуту и первые 200 м не говорит', () => {
    const c = cfg({ targetPaceSecPerKm: 360 });
    expect(drive(c, every(0, 100_000, 1000, (t) => sample(t, { paceSecPerKm: 500, movingSec: 30, distanceM: 100 }))).said).toEqual([]);
  });
  it('половина дистанции: один раз и только на длинных маршрутах', () => {
    const c = cfg({ plannedM: 6000 });
    const { said } = drive(c, [sample(0, { distanceM: 2900 }), sample(1, { distanceM: 3010 }), sample(2, { distanceM: 3100 })]);
    expect(said.map((x) => x.text)).toEqual(['Половина дистанции. Осталось 3 километра.']);
    expect(drive(cfg({ plannedM: 2000 }), [sample(0, { distanceM: 1100 })]).said).toEqual([]);
  });
});

// ---------- очередь речи ----------
function fakeEngine() {
  const log: string[] = [];
  let release: (() => void) | null = null;
  const engine: SpeechEngine & { log: string[]; finish(): void; failNext: boolean } = {
    log, failNext: false,
    speak(text) {
      log.push('speak:' + text);
      if (engine.failNext) { engine.failNext = false; return Promise.reject(new Error('tts down')); }
      return new Promise<void>((r) => { release = r; });
    },
    async stop() { log.push('stop'); release?.(); release = null; },
    finish() { release?.(); release = null; }
  };
  return engine;
}
function fakeClock(): QueueClock & { t: number } {
  const c = { t: 0, now: () => c.t, setTimeout: () => 0, clearTimeout: () => undefined };
  return c;
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('очередь речи', () => {
  it('навигация не обрывается тренировочной подсказкой', async () => {
    const e = fakeEngine(), q = new SpeechQueue(e, fakeClock());
    q.say({ text: 'поверните', priority: 'nav' });
    await tick();
    q.say({ text: 'километр', priority: 'training' });
    await tick();
    expect(e.log).toEqual(['speak:поверните']); // стоп не вызывался
    e.finish(); await tick();
    expect(e.log).toEqual(['speak:поверните', 'speak:километр']);
    e.finish(); await q.idle();
  });
  it('навигация прерывает тренировочную фразу и идёт раньше остальных тренировочных', async () => {
    const e = fakeEngine(), q = new SpeechQueue(e, fakeClock());
    q.say({ text: 'А', priority: 'training' });
    await tick();
    q.say({ text: 'Б', priority: 'training' });
    q.say({ text: 'поворот', priority: 'nav' });
    await tick(); await tick();
    expect(e.log[1]).toBe('stop');
    expect(e.log[2]).toBe('speak:поворот');
    e.finish(); await tick();
    expect(e.log[3]).toBe('speak:Б');
    e.finish(); await q.idle();
  });
  it('устаревшие тренировочные фразы выбрасываются', async () => {
    const e = fakeEngine(), clock = fakeClock(), q = new SpeechQueue(e, clock);
    q.say({ text: 'поворот', priority: 'nav' });
    await tick();
    q.say({ text: 'старый километр', priority: 'training', ttlMs: 5000 });
    clock.t = 6000;
    e.finish(); await q.idle();
    expect(e.log).toEqual(['speak:поворот']);
    expect(q.dropped).toBe(1);
  });
  it('повтор с тем же ключом не принимается', async () => {
    const e = fakeEngine(), q = new SpeechQueue(e, fakeClock());
    expect(q.say({ text: 'x', priority: 'nav', key: 'm1:0' })).toBe(true);
    expect(q.say({ text: 'x', priority: 'nav', key: 'm1:0' })).toBe(false);
    e.finish(); await q.idle();
  });
  it('сбой движка не ломает очередь', async () => {
    const e = fakeEngine(), q = new SpeechQueue(e, fakeClock());
    e.failNext = true;
    q.say({ text: 'одна', priority: 'nav' });
    q.say({ text: 'две', priority: 'nav' });
    await tick();
    expect(e.log).toEqual(['speak:одна', 'speak:две']);
    e.finish(); await q.idle();
  });
  it('выключение очищает очередь и обрывает речь; пока выключено — ничего не принимает', async () => {
    const e = fakeEngine(), q = new SpeechQueue(e, fakeClock());
    q.say({ text: 'a', priority: 'training' }); q.say({ text: 'b', priority: 'training' });
    await tick();
    q.setEnabled(false);
    await q.idle();
    expect(q.pending).toBe(0);
    expect(q.say({ text: 'c', priority: 'nav' })).toBe(false);
    expect(e.log).toContain('stop');
  });
});
