import { describe, expect, it } from 'vitest';
import {
  ANNOUNCE_THRESHOLDS, bearingDeg, compassWord, decodePolyline6, encodePolyline6, indexRoute, initialNavState, markRerouteAttempt, navStep,
  nextManeuverIndex, offThresholdM, projectOnRoute, remainingWaypoints, rerouteDue, resetForNewRoute, REROUTE_MIN_INTERVAL_MS, type NavEvent, type NavState
} from '../../src/cardio/nav';
import type { LatLon, NavManeuver, PlannedRoute } from '../../src/domain/types';

// Прямая линия на восток от (55, 37): 1 м ≈ 1/(111320·cos55°) градуса долготы
const LAT = 55, LON0 = 37;
const mPerDegLon = 111_320 * Math.cos((LAT * Math.PI) / 180);
const east = (m: number, north = 0): LatLon => ({ lat: LAT + north / 110_574, lon: LON0 + m / mPerDegLon });

/** Маршрут: 0 → 500 м на восток, потом 500 м на север-восток условно; здесь просто две прямые части с поворотом на 300 и 700 м. */
function makeRoute(profile: 'pedestrian' | 'bicycle' = 'pedestrian'): PlannedRoute {
  const shape = [east(0), east(300), east(300, 0.0001), east(700), east(1000)];
  shape[2] = east(300); // без изломов: проверяем расстояния вдоль, а не геометрию поворота
  const idx = indexRoute(shape);
  const man = (type: number, i: number, text: string): NavManeuver => ({ type, instruction: text, alert: `${text}.`, verbal: `${text} сейчас.`, lengthM: 0, timeSec: 0, shapeIndex: i });
  void idx;
  return {
    profile, waypoints: [shape[0], shape[4]], shape, distanceM: 1000, durationSec: 700,
    maneuvers: [man(1, 0, 'Идите на восток'), man(15, 1, 'Поверните налево'), man(10, 3, 'Поверните направо'), man(4, 4, 'Вы пришли')]
  };
}
const fix = (m: number, north = 0, t = 0, acc = 5) => ({ t, acc, ...east(m, north) });

function run(route: PlannedRoute, points: { m: number; north?: number; t?: number; acc?: number }[], start: NavState = initialNavState()) {
  const idx = indexRoute(route.shape);
  let st = start;
  const events: NavEvent[] = [];
  let status = navStep(route, idx, st, fix(0, 0, 0)).status;
  for (const p of points) {
    const r = navStep(route, idx, st, fix(p.m, p.north ?? 0, p.t ?? 0, p.acc ?? 5));
    st = r.state; status = r.status; events.push(...r.events);
  }
  return { st, status, events, idx };
}

describe('polyline6', () => {
  it('кодирует и декодирует без потерь в шестом знаке', () => {
    const pts = [{ lat: 55.751244, lon: 37.618423 }, { lat: 55.752, lon: 37.62 }, { lat: -33.8688, lon: 151.2093 }, { lat: 0, lon: -179.999999 }];
    const back = decodePolyline6(encodePolyline6(pts));
    expect(back).toHaveLength(4);
    back.forEach((p, i) => { expect(p.lat).toBeCloseTo(pts[i].lat, 6); expect(p.lon).toBeCloseTo(pts[i].lon, 6); });
  });
  it('известная строка из документации (точность 6)', () => {
    // 38.5,-120.2 → 40.7,-120.95 → 43.252,-126.453 с точностью 5 даёт _p~iF~ps|U_ulLnnqC_mqNvxq`@; с точностью 6 строка другая, но обратимая
    const pts = decodePolyline6(encodePolyline6([{ lat: 38.5, lon: -120.2 }, { lat: 40.7, lon: -120.95 }, { lat: 43.252, lon: -126.453 }]));
    expect(pts[2]).toEqual({ lat: 43.252, lon: -126.453 });
  });
  it('пустая строка — пустая линия; обрыв и мусор — ошибка', () => {
    expect(decodePolyline6('')).toEqual([]);
    expect(() => decodePolyline6('_p~iF~ps|U_')).toThrow();
    expect(() => decodePolyline6('\u0001\u0002')).toThrow();
  });
});

describe('проекция точки на маршрут', () => {
  const idx = indexRoute(makeRoute().shape);
  it('расстояние вдоль маршрута и до него', () => {
    const p = projectOnRoute(idx, east(450, 10))!;
    expect(p.alongM).toBeGreaterThan(445); expect(p.alongM).toBeLessThan(455);
    expect(p.distM).toBeGreaterThan(9); expect(p.distM).toBeLessThan(11);
    expect(idx.totalM).toBeGreaterThan(995); expect(idx.totalM).toBeLessThan(1005);
  });
  it('ограничение диапазона не даёт «перепрыгнуть» на похожий участок', () => {
    const p = projectOnRoute(idx, east(900), { fromM: 0, toM: 400 })!;
    expect(p.alongM).toBeLessThanOrEqual(400);
  });
  it('за концами линии точка прижимается к началу и концу', () => {
    expect(projectOnRoute(idx, east(-50))!.alongM).toBeCloseTo(0, 5);
    expect(projectOnRoute(idx, east(1100))!.alongM).toBeCloseTo(idx.totalM, 0);
  });
  it('направление и слово стороны света', () => {
    expect(Math.round(bearingDeg(east(0), east(100)))).toBe(90);
    expect(compassWord(0)).toBe('севере'); expect(compassWord(225)).toBe('юго-западе'); expect(compassWord(359)).toBe('севере');
  });
});

describe('выбор следующего манёвра', () => {
  const route = makeRoute(), idx = indexRoute(route.shape);
  it('старт пропускается, пройденные отбрасываются', () => {
    expect(nextManeuverIndex(route, idx, 0)).toBe(1);
    expect(nextManeuverIndex(route, idx, 299)).toBe(1);
    expect(nextManeuverIndex(route, idx, 320)).toBe(2);
    expect(nextManeuverIndex(route, idx, 800)).toBe(3); // конец маршрута тоже манёвр
    expect(nextManeuverIndex(route, idx, 1100)).toBeNull();
  });
});

describe('озвучка манёвров', () => {
  it('пороги: пешком 120/40/15, на велосипеде 300/100/30', () => {
    expect(ANNOUNCE_THRESHOLDS.pedestrian).toEqual([120, 40, 15]);
    expect(ANNOUNCE_THRESHOLDS.bicycle).toEqual([300, 100, 30]);
  });
  it('каждый порог срабатывает один раз, по порядку, без повторов при стоянии на месте', () => {
    const pts = [100, 150, 170, 200, 200, 200, 262, 262, 270, 286, 286, 290].map((m, i) => ({ m, t: i * 1000 }));
    const { events } = run(makeRoute(), pts);
    const first = events.filter((e) => e.kind === 'maneuver' && e.index === 1) as Extract<NavEvent, { kind: 'maneuver' }>[];
    expect(first.map((e) => e.thresholdM)).toEqual([120, 40, 15]);
  });
  it('резкий скачок (плохой сигнал) даёт одно сообщение ближайшего порога, а не три подряд', () => {
    const { events } = run(makeRoute(), [{ m: 100 }, { m: 290, t: 1000 }]);
    const mans = events.filter((e) => e.kind === 'maneuver');
    expect(mans).toHaveLength(1);
    expect((mans[0] as { thresholdM: number }).thresholdM).toBe(15);
  });
  it('на велосипеде свои пороги', () => {
    const { events } = run(makeRoute('bicycle'), [{ m: 0 }, { m: 10, t: 1 }, { m: 150, t: 2 }, { m: 230, t: 3 }]);
    const ths = events.filter((e) => e.kind === 'maneuver').map((e) => (e as { thresholdM: number }).thresholdM);
    expect(ths).toEqual([300, 100]);
  });
  it('финиш объявляется один раз', () => {
    const { events, status } = run(makeRoute(), [{ m: 900 }, { m: 990, t: 1 }, { m: 995, t: 2 }, { m: 998, t: 3 }]);
    expect(events.filter((e) => e.kind === 'arrived')).toHaveLength(1);
    expect(status.arrived).toBe(true);
    expect(status.remainingM).toBeLessThan(10);
  });
  it('точки с плохой точностью не двигают прогресс и ничего не озвучивают', () => {
    const { events, status } = run(makeRoute(), [{ m: 285, acc: 120 }]);
    expect(events).toEqual([]);
    expect(status.alongM).toBe(0);
  });
});

describe('сход с маршрута', () => {
  it('короткий выброс в сторону сходом не считается', () => {
    const { st, events } = run(makeRoute(), [{ m: 100, t: 0 }, { m: 110, north: 80, t: 1000 }, { m: 120, t: 2000 }, { m: 130, t: 3000 }]);
    expect(st.off).toBe(false);
    expect(events.some((e) => e.kind === 'off-route')).toBe(false);
  });
  it('устойчивый сход: событие с расстоянием и стороной, прогресс стоит', () => {
    const pts = [{ m: 100, t: 0 }, ...[0, 2, 4, 6, 8].map((s) => ({ m: 120, north: 90, t: 1000 + s * 1000 }))];
    const { st, events, status } = run(makeRoute(), pts);
    const off = events.filter((e) => e.kind === 'off-route');
    expect(off).toHaveLength(1);
    expect((off[0] as { distM: number }).distM).toBeGreaterThan(80);
    expect(st.off).toBe(true);
    expect(status.alongM).toBeLessThan(110);
  });
  it('слабый GPS расширяет порог: 40 м при точности 40 м сходом не считается', () => {
    expect(offThresholdM('pedestrian', 5)).toBe(35);
    expect(offThresholdM('pedestrian', 40)).toBe(60);
    expect(offThresholdM('bicycle', 5)).toBe(50);
    const { st } = run(makeRoute(), [{ m: 100, t: 0 }, ...[1, 3, 5, 8, 10].map((s) => ({ m: 120, north: 40, t: s * 1000, acc: 40 }))]);
    expect(st.off).toBe(false);
  });
  it('возвращение на маршрут снимает сход и сообщает об этом', () => {
    const pts = [{ m: 100, t: 0 }, ...[1, 3, 5, 8].map((s) => ({ m: 120, north: 90, t: s * 1000 })), { m: 130, t: 10_000 }];
    const { st, events } = run(makeRoute(), pts);
    expect(events.map((e) => e.kind)).toContain('back-on-route');
    expect(st.off).toBe(false);
  });
});

describe('перестроение', () => {
  const off = (over: Partial<NavState> = {}): NavState => ({ ...initialNavState(), off: true, ...over });
  it('нужно только при сходе и не чаще раза в 30 секунд', () => {
    expect(rerouteDue(initialNavState(), 1000)).toBe(false);
    expect(rerouteDue(off(), 1000)).toBe(true);
    const tried = markRerouteAttempt(off(), 10_000);
    expect(rerouteDue(tried, 10_000 + REROUTE_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(rerouteDue(tried, 10_000 + REROUTE_MIN_INTERVAL_MS)).toBe(true);
  });
  it('неудачная попытка тоже считается: без сети мы не долбим сервис каждую секунду', () => {
    const t0 = markRerouteAttempt(off(), 5000);
    expect(rerouteDue(t0, 6000)).toBe(false);
  });
  it('после перестроения прогресс обнуляется, ограничение частоты остаётся', () => {
    const r = resetForNewRoute({ ...off({ alongM: 400, fired: { '1:0': 1 } }), lastRerouteAt: 777 });
    expect(r).toMatchObject({ alongM: 0, off: false, fired: {}, lastRerouteAt: 777, arrived: false });
  });
  it('оставшиеся точки: пройденные промежуточные отбрасываются, финиш остаётся', () => {
    const route = { ...makeRoute(), waypoints: [east(0), east(300), east(700), east(1000)] };
    const idx = indexRoute(route.shape);
    expect(remainingWaypoints(route, idx, { ...initialNavState(), alongM: 100 })).toHaveLength(3);
    expect(remainingWaypoints(route, idx, { ...initialNavState(), alongM: 500 })).toHaveLength(2);
    expect(remainingWaypoints(route, idx, { ...initialNavState(), alongM: 990 })).toHaveLength(1);
  });
});

describe('работа без сети', () => {
  it('ядро ничего не запрашивает: прогресс и подсказки считаются по сохранённому маршруту и переживают перезапуск', () => {
    const route = makeRoute();
    const a = run(route, [{ m: 100 }, { m: 200, t: 1000 }]);
    const saved = JSON.parse(JSON.stringify(a.st)) as NavState; // как после сохранения в базу
    const restoredRoute = JSON.parse(JSON.stringify(route)) as PlannedRoute;
    const b = run(restoredRoute, [{ m: 262, t: 2000 }], saved);
    expect(b.events.filter((e) => e.kind === 'maneuver').map((e) => (e as { thresholdM: number }).thresholdM)).toEqual([40]);
    expect(b.status.alongM).toBeGreaterThan(255);
  });
});
