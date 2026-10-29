import { describe, expect, it } from 'vitest';
import { platesPerSide } from '../../src/domain/plates';
import { suggestNext } from '../../src/domain/progression';
import { escapeXml, toGpx, trimRoute } from '../../src/cardio/gpx';
import { haversine } from '../../src/cardio/geo';
import { weekProgress } from '../../src/domain/analytics';
import type { Exercise, Workout } from '../../src/domain/types';

const set = (weight: number, reps: number, done = true) => ({ id: Math.random().toString(36), weight, reps, done });
const w = (id: string, date: string, ex: string, sets: ReturnType<typeof set>[], extra: object = {}): Workout =>
  ({ id, date, title: 't', status: 'done', exercises: [{ id: 'a' + id, exerciseId: ex, sets, ...extra }], createdAt: 0, updatedAt: 0, deviceId: 'd' } as unknown as Workout);

describe('подсказка прогрессии', () => {
  it('сначала добавляет повтор', () => {
    const s = suggestNext([w('1', '2026-10-01', 'bench', [set(80, 8), set(80, 9), set(80, 8)])], 'bench', 2.5)!;
    expect(s).toMatchObject({ weight: 80, reps: 9 });
  });
  it('в верху диапазона прибавляет вес и начинает с 8', () => {
    const s = suggestNext([w('1', '2026-10-01', 'bench', [set(80, 12), set(80, 12), set(80, 13)])], 'bench', 2.5)!;
    expect(s).toMatchObject({ weight: 82.5, reps: 8 });
  });
  it('ориентируется на рабочий вес, а не на разминку', () => {
    const s = suggestNext([w('1', '2026-10-01', 'bench', [set(40, 12), set(80, 8), set(80, 8)])], 'bench', 2.5)!;
    expect(s).toMatchObject({ weight: 80, reps: 9 });
  });
  it('без веса (подтягивания) только растут повторы, без потолка', () => {
    expect(suggestNext([w('1', '2026-10-01', 'pull', [set(0, 15)])], 'pull', 2.5)).toMatchObject({ weight: 0, reps: 16 });
  });
  it('нет истории или нули: подсказки нет', () => {
    expect(suggestNext([], 'x', 2.5)).toBeNull();
    expect(suggestNext([w('1', '2026-10-01', 'x', [set(50, 0)])], 'x', 2.5)).toBeNull();
    expect(suggestNext([w('1', '2026-10-01', 'x', [set(50, 8, false)])], 'x', 2.5)).toBeNull();
  });
  it('не учитывает текущую тренировку', () => {
    const hist = [w('1', '2026-10-01', 'x', [set(50, 8)]), w('2', '2026-10-05', 'x', [set(60, 12)])];
    expect(suggestNext(hist, 'x', 2.5, '2')).toMatchObject({ weight: 50, reps: 9 });
  });
});

describe('калькулятор блинов', () => {
  it('100 кг на штанге 20 кг: по 40 кг на сторону', () => {
    const r = platesPerSide(100, 20);
    expect(r.perSide).toEqual([25, 15]); expect(r.achieved).toBe(100); expect(r.missing).toBe(0);
  });
  it('дробные блины считаются без ошибок округления', () => expect(platesPerSide(62.5, 20).perSide).toEqual([20, 1.25]));
  it('если нужного блина нет, показывает недобор', () => {
    const r = platesPerSide(61, 20, [20, 10, 5]);
    expect(r.achieved).toBe(60); expect(r.missing).toBe(1);
  });
  it('цель меньше грифа', () => expect(platesPerSide(15, 20)).toMatchObject({ perSide: [], belowBar: true }));
  it('мусор не ломает', () => expect(platesPerSide(NaN, 20).perSide).toEqual([]));
});

describe('GPX и зона приватности', () => {
  const line = Array.from({ length: 101 }, (_, i) => ({ lat: 55 + i * 0.0001, lon: 37 }));   // ≈1.1 км, точка каждые 11 м
  const dist = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => haversine(a.lat, a.lon, b.lat, b.lon);
  it('срезает ровно зону с начала и с конца', () => {
    const t = trimRoute(line, 200);
    expect(Math.abs(dist(line[0], t[0]) - 200)).toBeLessThan(2);
    expect(Math.abs(dist(line[line.length - 1], t[t.length - 1]) - 200)).toBeLessThan(2);
    expect(t.length).toBeLessThan(line.length - 30);
  });
  it('упрощённый маршрут из двух далёких точек тоже обрезается', () => {
    const t = trimRoute([{ lat: 55, lon: 37, t: 0 }, { lat: 55.018, lon: 37, t: 600 }], 200);   // ≈2 км
    expect(t).toHaveLength(2);
    expect(Math.abs(dist({ lat: 55, lon: 37 }, t[0]) - 200)).toBeLessThan(2);
    expect(t[0].t).toBeGreaterThan(55); expect(t[0].t).toBeLessThan(65);                          // время тоже сдвинулось
  });
  it('короткий маршрут скрывается целиком', () => expect(trimRoute(line.slice(0, 30), 200)).toEqual([]));
  it('нулевая зона ничего не меняет', () => expect(trimRoute(line, 0)).toBe(line));
  it('GPX корректен и экранирует название', () => {
    const gpx = toGpx('Бег <утро> & "кофе"', Date.UTC(2026, 9, 24, 6, 0, 0), [[0, 5500000, 3700000, 1500], [10, 5500100, 3700000, null]]);
    expect(gpx).toContain('<trkpt lat="55.00000" lon="37.00000"><ele>150.0</ele><time>2026-10-24T06:00:00.000Z</time>');
    expect(gpx).toContain('<time>2026-10-24T06:00:10.000Z</time>');
    expect(gpx).toContain('Бег &lt;утро&gt; &amp; &quot;кофе&quot;');
    expect(gpx).not.toContain('<утро>');
    expect(escapeXml("a'b")).toBe('a&apos;b');
  });
  it('зона приватности применяется к экспорту', () => {
    const track: [number, number, number, number | null][] = line.map((p, i) => [i * 4, Math.round(p.lat * 1e5), Math.round(p.lon * 1e5), null]);
    expect((toGpx('x', 0, track, 200).match(/<trkpt/g) ?? []).length).toBeLessThan(line.length - 30);
  });
});

describe('цели недели', () => {
  const ex = new Map<string, Exercise>([['run', { id: 'run', name: 'Бег', muscle: 'cardio' } as Exercise], ['bike', { id: 'bike', name: 'Велосипед', muscle: 'cardio' } as Exercise]]);
  it('считает тренировки и километры текущей недели, велосипед в километры не входит', () => {
    const now = new Date(2026, 9, 24); // суббота; неделя с 19.10
    const all = [
      w('1', '2026-10-19', 'run', [], { cardio: { source: 'gps', distanceM: 5000, durationSec: 1500 } }),
      w('2', '2026-10-21', 'bike', [], { cardio: { source: 'manual', distanceM: 20000, durationSec: 3600 } }),
      w('3', '2026-10-18', 'run', [], { cardio: { source: 'gps', distanceM: 9000, durationSec: 3000 } }), // прошлая неделя
      w('4', '2026-10-22', 'bench', [set(80, 8)]),
    ];
    expect(weekProgress(all, ex, now)).toEqual({ workouts: 3, km: 5 });
  });
});

import { plural, voiceText } from '../../src/cardio/geo';
describe('голосовые подсказки', () => {
  it('склонение', () => {
    expect([1, 2, 5, 11, 12, 21, 22, 25].map((n) => plural(n, 'км', 'кма', 'кмов'))).toEqual(['км', 'кма', 'кмов', 'кмов', 'кмов', 'км', 'кма', 'кмов']);
  });
  it('текст после километра', () => {
    expect(voiceText(3, 333, false)).toBe('3 километра. Темп 5 минут 33 секунды на километр.');
    expect(voiceText(1, 301, false)).toBe('1 километр. Темп 5 минут 1 секунда на километр.');
    expect(voiceText(5, 240, false)).toBe('5 километров. Темп 4 минуты 0 секунд на километр.');
    expect(voiceText(2, 150, true)).toBe('2 километра. Скорость 24,0 километра в час.');
  });
});
