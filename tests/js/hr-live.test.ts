import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseHeartRate } from '../../src/cardio/hrParse';
import { addHr, newHrAcc, summarizeHr, type HrAcc } from '../../src/cardio/hrAcc';
import { startHrSession, type HrState } from '../../src/cardio/hrSession';
import type { HeartRateApi, HrSample } from '../../src/platform/types';

const dv = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);

describe('разбор Heart Rate Measurement (0x2A37)', () => {
  it('пульс в 8 и в 16 бит', () => {
    expect(parseHeartRate(dv(0x00, 72))).toEqual({ bpm: 72, contact: null, rr: [] });
    expect(parseHeartRate(dv(0x01, 0xb4, 0x00))?.bpm).toBe(180);
    expect(parseHeartRate(dv(0x01, 0x2c, 0x01))?.bpm).toBe(300);
  });

  it('контакт с кожей: не поддерживается, нет контакта, есть контакт', () => {
    expect(parseHeartRate(dv(0x00, 70))?.contact).toBeNull();
    expect(parseHeartRate(dv(0x04, 70))?.contact).toBe(false);
    expect(parseHeartRate(dv(0x06, 70))?.contact).toBe(true);
  });

  it('энергозатраты пропускаются, RR-интервалы переводятся из 1/1024 с в миллисекунды', () => {
    // флаги 0x18: энергозатраты + RR; пульс 80; энергия 2 байта; RR 1024 (=1000 мс) и 512 (=500 мс)
    const s = parseHeartRate(dv(0x18, 80, 0xaa, 0xbb, 0x00, 0x04, 0x00, 0x02));
    expect(s).toEqual({ bpm: 80, contact: null, rr: [1000, 500] });
  });

  it('обрезанные пакеты не ломают разбор', () => {
    expect(parseHeartRate(dv())).toBeNull();
    expect(parseHeartRate(dv(0x00))).toBeNull();
    expect(parseHeartRate(dv(0x01, 0xb4))).toBeNull();
    expect(parseHeartRate(dv(0x10, 70, 0x00))?.rr).toEqual([]); // половина RR-значения
  });
});

describe('накопитель пульса', () => {
  const feed = (acc: HrAcc, bpms: number[], t0 = 0, stepMs = 1000) => bpms.reduce((a, b, i) => addHr(a, b, t0 + i * stepMs, 200), acc);

  it('среднее взвешено по времени, максимум и время по зонам', () => {
    const acc = feed(newHrAcc(), [140, 140, 140, 160, 160, 160]);
    // между отсчётами 5 интервалов по секунде: 140×2 + 160×3 (интервал относится к новому значению)
    expect(summarizeHr(acc)).toEqual({ hrAvg: Math.round((140 * 2 + 160 * 3) / 5), hrMax: 160 });
    expect(acc.zoneSec[2]).toBe(2); // 140 из 200 = 70 %: зона 3
    expect(acc.zoneSec[3]).toBe(3); // 160 из 200 = 80 %: зона 4
  });

  it('нули и мусор от датчика без контакта не учитываются', () => {
    const acc = feed(newHrAcc(), [0, 0, 150, 255, 150, 150, 150, 150, 150]);
    expect(acc.n).toBe(6);
    expect(summarizeHr(acc)).toEqual({ hrAvg: 150, hrMax: 150 });
  });

  it('разрыв дольше 5 секунд (пауза, потеря связи) во время не засчитывается', () => {
    let acc = feed(newHrAcc(), [150, 150, 150]);
    const before = acc.sec;
    acc = addHr(acc, 150, 2000 + 60_000, 200);
    expect(acc.sec).toBe(before);
    expect(acc.n).toBe(4);
  });

  it('меньше пяти отсчётов — итога нет', () => {
    expect(summarizeHr(feed(newHrAcc(), [150, 150, 150, 150]))).toBeNull();
    expect(summarizeHr(feed(newHrAcc(), [150, 150, 150, 150, 150]))).not.toBeNull();
  });
});

describe('сессия пульсометра: подключение и переподключение', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const sample = (bpm: number): HrSample => ({ bpm, contact: true, rr: [] });

  function fake() {
    const links: Array<{ close: ReturnType<typeof vi.fn>; h: Parameters<HeartRateApi['connect']>[1] }> = [];
    let failNext = 0;
    const api: HeartRateApi = {
      unsupportedReason: () => null,
      pick: async () => ({ id: 'dev', name: 'Polar' }),
      connect: vi.fn(async (_id, h) => {
        if (failNext > 0) { failNext--; throw new Error('timeout'); }
        const close = vi.fn(async () => {});
        links.push({ close, h });
        return { close };
      })
    };
    return { api, links, failNext: (n: number) => { failNext = n; } };
  }

  const run = (api: HeartRateApi, opts?: Parameters<typeof startHrSession>[3]) => {
    const states: HrState[] = [], samples: number[] = [];
    const s = startHrSession(api, 'dev', { sample: (x) => samples.push(x.bpm), state: (st) => states.push(st) }, opts);
    return { s, states, samples };
  };

  it('подключается и передаёт отсчёты', async () => {
    const { api, links } = fake();
    const { states, samples } = run(api);
    await vi.advanceTimersByTimeAsync(0);
    expect(states).toEqual(['connecting', 'live']);
    links[0].h.onSample(sample(120));
    links[0].h.onSample(sample(125));
    expect(samples).toEqual([120, 125]);
  });

  it('потеря связи: закрывает старое подключение и подключается заново после паузы', async () => {
    const { api, links } = fake();
    const { states, samples } = run(api, { retryDelaysMs: [1000, 2000] });
    await vi.advanceTimersByTimeAsync(0);
    links[0].h.onLost();
    await vi.advanceTimersByTimeAsync(0);
    expect(links[0].close).toHaveBeenCalled();
    expect(states.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(999);
    expect(links).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(links).toHaveLength(2);
    expect(states.at(-1)).toBe('live');
    links[0].h.onSample(sample(99)); // запоздавшее событие старого подключения игнорируется
    links[1].h.onSample(sample(130));
    expect(samples).toEqual([130]);
  });

  it('неудачные попытки идут с нарастающей паузой, затем «failed»; успех с отсчётом сбрасывает счётчик', async () => {
    const { api, links, failNext } = fake();
    failNext(3);
    const { states } = run(api, { retryDelaysMs: [100, 200, 400] });
    await vi.advanceTimersByTimeAsync(0);   // попытка 1 — отказ
    await vi.advanceTimersByTimeAsync(100); // попытка 2 — отказ
    await vi.advanceTimersByTimeAsync(200); // попытка 3 — отказ
    await vi.advanceTimersByTimeAsync(400); // попытка 4 — успех
    expect(states.filter((s) => s === 'reconnecting')).toHaveLength(3);
    expect(states.at(-1)).toBe('live');
    links[0].h.onSample(sample(100)); // счётчик попыток обнулён
    links[0].h.onLost();
    await vi.advanceTimersByTimeAsync(100);
    expect(links).toHaveLength(2);

    const f2 = fake();
    f2.failNext(99);
    const r2 = run(f2.api, { retryDelaysMs: [10, 10] });
    await vi.advanceTimersByTimeAsync(100);
    expect(r2.states.at(-1)).toBe('failed');
    expect(f2.api.connect).toHaveBeenCalledTimes(3);
  });

  it('молчащий датчик: нет отсчётов дольше срока — переподключение', async () => {
    const { api, links } = fake();
    const { states } = run(api, { staleMs: 5000, retryDelaysMs: [100] });
    await vi.advanceTimersByTimeAsync(0);
    links[0].h.onSample(sample(110));
    await vi.advanceTimersByTimeAsync(4900);
    expect(links).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(links[0].close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(links).toHaveLength(2);
    expect(states).toContain('reconnecting');
  });

  it('stop: закрывает связь и больше ничего не вызывает, даже если подключение ещё шло', async () => {
    const { api, links } = fake();
    const { s, states, samples } = run(api);
    await vi.advanceTimersByTimeAsync(0);
    const h = links[0].h;
    await s.stop();
    expect(links[0].close).toHaveBeenCalled();
    h.onSample(sample(150)); h.onLost();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(samples).toEqual([]);
    expect(states.at(-1)).toBe('stopped');
    expect(links).toHaveLength(1);

    // остановка до завершения connect: поздно пришедшее подключение закрывается
    let resolve!: (l: { close: () => Promise<void> }) => void;
    const lateClose = vi.fn(async () => {});
    const slow: HeartRateApi = { unsupportedReason: () => null, pick: async () => null, connect: () => new Promise((r) => { resolve = r; }) };
    const r2 = run(slow);
    await r2.s.stop();
    resolve({ close: lateClose });
    await vi.advanceTimersByTimeAsync(0);
    expect(lateClose).toHaveBeenCalled();
    expect(r2.states).not.toContain('live');
  });
});
