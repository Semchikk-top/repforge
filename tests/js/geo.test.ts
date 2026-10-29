import { describe, expect, it } from 'vitest';
import { Tracker, bestEffort, bestEfforts, decodePoint, encodeTrack, formatHMS, formatPace, haversine, simplify, type Fix } from '../../src/cardio/geo';

const LAT0 = 55.75, LON0 = 37.6;
const M_PER_DEG_LAT = 111195;
const north = (m: number) => LAT0 + m / M_PER_DEG_LAT;

// детерминированный «шум»: псевдослучайные числа с зерном
function rng(seed: number) { let x = seed; return () => ((x = (x * 1664525 + 1013904223) % 4294967296) / 4294967296) - 0.5; }

function run(tracker: Tracker, speed: number, seconds: number, opts: { t0?: number; m0?: number; acc?: number; noise?: number; seed?: number } = {}) {
  const { t0 = 0, m0 = 0, acc = 5, noise = 0, seed = 1 } = opts;
  const r = rng(seed);
  for (let i = 0; i <= seconds; i++) {
    const m = m0 + speed * i;
    const f: Fix = { t: t0 + i * 1000, lat: north(m) + (noise * r()) / M_PER_DEG_LAT, lon: LON0 + (noise * r()) / 62000, acc, ele: null };
    tracker.push(f);
  }
}

describe('haversine', () => {
  it('градус широты около 111 км', () => { expect(haversine(0, 0, 1, 0)).toBeGreaterThan(111000); expect(haversine(0, 0, 1, 0)).toBeLessThan(111400); });
  it('одинаковые точки дают ноль', () => expect(haversine(LAT0, LON0, LAT0, LON0)).toBe(0));
});

describe('Tracker', () => {
  it('считает дистанцию и километровые отрезки при беге', () => {
    const t = new Tracker('run');
    run(t, 3, 400); // 1200 м
    const s = t.stats();
    expect(s.distanceM).toBeGreaterThan(1180); expect(s.distanceM).toBeLessThan(1220);
    expect(s.splits).toHaveLength(1);
    expect(s.splits[0]).toBeGreaterThan(325); expect(s.splits[0]).toBeLessThan(342); // 1000 м при 3 м/с ≈ 333 с
    expect(s.paceSecPerKm!).toBeGreaterThan(320); expect(s.paceSecPerKm!).toBeLessThan(346);
  });

  it('на месте шум GPS не превращается в километры', () => {
    const t = new Tracker('run');
    run(t, 0, 600, { noise: 4, acc: 6 }); // 10 минут стоим, разброс ±2 м
    expect(t.stats().distanceM).toBeLessThan(30);
  });

  it('отбрасывает скачки GPS и плохую точность', () => {
    const t = new Tracker('run');
    run(t, 3, 30);
    const before = t.stats().distanceM;
    expect(t.push({ t: 31000, lat: north(90 + 500), lon: LON0, acc: 5, ele: null })).toBe(false); // +500 м за секунду
    expect(t.push({ t: 32000, lat: north(96), lon: LON0, acc: 80, ele: null })).toBe(false);      // точность 80 м
    expect(t.stats().distanceM).toBe(before);
  });

  it('расстояние через паузу не засчитывается', () => {
    const t = new Tracker('run');
    run(t, 3, 100);
    const before = t.stats().distanceM;
    t.breakSegment();
    run(t, 3, 100, { t0: 5_000_000, m0: 5000 }); // другой участок, далеко
    const after = t.stats().distanceM;
    expect(after - before).toBeGreaterThan(280); expect(after - before).toBeLessThan(310); // только вторые 300 м
  });

  it('стояние на месте не попадает во время движения', () => {
    const t = new Tracker('run');
    run(t, 3, 100);                                         // 300 м за 100 с
    run(t, 0, 100, { t0: 100_000, m0: 300, noise: 3 });      // 100 с стоим на светофоре
    run(t, 3, 100, { t0: 200_000, m0: 300 });                // и снова 300 м за 100 с
    const st = t.stats();
    expect(st.distanceM).toBeGreaterThan(560);
    expect(st.movingSec).toBeLessThan(235);                   // честные 200 с, а не 300
    expect(st.movingSec).toBeGreaterThan(190);
  });

  it('ходьба: быстрый «бег» считается скачком', () => {
    const t = new Tracker('walk');
    t.push({ t: 0, lat: north(0), lon: LON0, acc: 5, ele: null });
    expect(t.push({ t: 1000, lat: north(10), lon: LON0, acc: 5, ele: null })).toBe(false); // 10 м/с пешком — скачок
  });

  it('набор высоты не реагирует на шум высотомера', () => {
    const t = new Tracker('run');
    for (let i = 0; i <= 120; i++) t.push({ t: i * 1000, lat: north(i * 3), lon: LON0, acc: 5, ele: 100 + (i % 2 ? 0.8 : -0.8) });
    expect(t.stats().elevGainM).toBe(0);
    const u = new Tracker('run');
    for (let i = 0; i <= 120; i++) u.push({ t: i * 1000, lat: north(i * 3), lon: LON0, acc: 5, ele: 100 + i * 0.5 });
    expect(u.stats().elevGainM).toBeGreaterThan(50); expect(u.stats().elevGainM).toBeLessThan(62);
  });

  it('состояние переживает сериализацию (перезагрузка страницы)', () => {
    const t = new Tracker('run');
    run(t, 3, 200);
    const restored = new Tracker('run', JSON.parse(JSON.stringify(t.state)));
    restored.breakSegment();
    run(restored, 3, 100, { t0: 9_000_000, m0: 600 });
    expect(restored.stats().distanceM).toBeGreaterThan(880);
  });
});

describe('маршрут', () => {
  it('упрощение сохраняет форму и уменьшает число точек', () => {
    const t = new Tracker('run');
    run(t, 3, 1200); // прямая в 3.6 км
    const enc = encodeTrack(t.state.points);
    expect(enc.length).toBeLessThan(80);           // не 3600 точек, но и не 2: раз в 20 с остаются для высоты и темпа
    expect(enc.length).toBeGreaterThan(30);
    const first = decodePoint(enc[0]), last = decodePoint(enc[enc.length - 1]);
    expect(haversine(first.lat, first.lon, last.lat, last.lon)).toBeGreaterThan(3500);
  });
  it('число точек ограничено', () => {
    const pts = Array.from({ length: 20000 }, (_, i) => ({ t: i, lat: LAT0 + Math.sin(i / 7) * 0.002 + i * 1e-6, lon: LON0 + Math.cos(i / 11) * 0.002, ele: null }));
    expect(encodeTrack(pts).length).toBeLessThanOrEqual(4000);
  });
  it('simplify оставляет концы', () => {
    const pts = [{ lat: 0, lon: 0 }, { lat: 0.0001, lon: 0.00001 }, { lat: 0.0002, lon: 0 }];
    const out = simplify(pts, 50);
    expect(out[0]).toBe(pts[0]); expect(out[out.length - 1]).toBe(pts[2]);
  });
});

describe('лучшие отрезки', () => {
  it('находит самый быстрый километр по неровному темпу', () => {
    const t = new Tracker('run');
    run(t, 3, 400);                                  // 1200 м медленно
    run(t, 5, 300, { t0: 401_000, m0: 1200 });        // 1500 м быстро (5 м/с): км за ≈200 с
    run(t, 3, 100, { t0: 702_000, m0: 2700 });
    const best = bestEffort(t.state.points, 1000)!;
    expect(best).toBeGreaterThan(190); expect(best).toBeLessThan(215);
    expect(bestEffort(t.state.points, 10000)).toBeNull();
    expect(bestEfforts(t.state.points)['1000']).toBeDefined();
  });
});

describe('лучшие отрезки через паузу', () => {
  it('«телепорт» на стыке отрезков не даёт нереального рекорда', () => {
    const t = new Tracker('run');
    run(t, 3, 400);                                        // 1200 м
    t.breakSegment();
    run(t, 3, 400, { t0: 9_000_000, m0: 8000 });            // другое место в 6.8 км дальше
    const best = bestEffort(t.state.points, 1000)!;
    expect(best).toBeGreaterThan(320);                      // честные ≈333 с, а не секунды «через телепорт»
    expect(best).toBeLessThan(345);
  });
  it('километр, прерванный паузой, всё равно находится', () => {
    const t = new Tracker('run');
    run(t, 3, 150);                                        // 450 м
    t.breakSegment();
    run(t, 3, 250, { t0: 5_000_000, m0: 450 });             // ещё 750 м
    const best = bestEffort(t.state.points, 1000)!;
    expect(best).toBeGreaterThan(320); expect(best).toBeLessThan(350);
  });
});

describe('форматирование', () => {
  it('темп и время', () => {
    expect(formatPace(332)).toBe('5:32'); expect(formatPace(null)).toBe('—'); expect(formatPace(0)).toBe('—');
    expect(formatHMS(3725)).toBe('1:02:05'); expect(formatHMS(65)).toBe('1:05');
  });
});
