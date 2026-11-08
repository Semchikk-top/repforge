// Ядро навигации по готовому маршруту. Чистые функции: без React, DOM и MapLibre, работает без сети.
// Вход: построенный маршрут (PlannedRoute) и принятые GPS-точки. Выход: прогресс, ближайший манёвр,
// сход с маршрута и события для озвучки. Всё состояние — обычный объект (его можно сохранить и продолжить после перезапуска).

import type { LatLon, NavManeuver, PlannedRoute, RouteProfile } from '../domain/types';
import { haversine } from './geo';

// ---------- polyline6 ----------

/** Декодирует строку polyline с точностью 6 знаков (формат Valhalla). Бросает Error, если строка оборвана или содержит чужие символы. */
export function decodePolyline6(str: string): LatLon[] {
  const out: LatLon[] = [];
  let i = 0, lat = 0, lon = 0;
  const next = (): number => {
    let result = 0, shift = 0, b: number;
    do {
      if (i >= str.length) throw new Error('Обрыв в строке маршрута');
      b = str.charCodeAt(i++) - 63;
      if (b < 0 || b > 63) throw new Error('Недопустимый символ в строке маршрута');
      result += (b & 0x1f) * 2 ** shift; // без побитовых сдвигов: длинные числа не должны переполнять 32 бита
      shift += 5;
      if (shift > 40) throw new Error('Слишком длинное число в строке маршрута');
    } while (b >= 0x20);
    return result % 2 === 1 ? -(result + 1) / 2 : result / 2;
  };
  while (i < str.length) {
    lat += next();
    lon += next();
    out.push({ lat: lat / 1e6, lon: lon / 1e6 });
  }
  return out;
}

/** Обратное преобразование; нужно тестам и сохранению простых маршрутов. */
export function encodePolyline6(points: LatLon[]): string {
  let out = '', pLat = 0, pLon = 0;
  const put = (delta: number) => {
    let v = delta < 0 ? -2 * delta - 1 : 2 * delta;
    while (v >= 0x20) { out += String.fromCharCode(((v % 32) | 0x20) + 63); v = Math.floor(v / 32); }
    out += String.fromCharCode(v + 63);
  };
  for (const p of points) {
    const la = Math.round(p.lat * 1e6), lo = Math.round(p.lon * 1e6);
    put(la - pLat); put(lo - pLon);
    pLat = la; pLon = lo;
  }
  return out;
}

// ---------- геометрия ----------

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON_EQ = 111_320;

export interface RouteIndex { shape: LatLon[]; cum: number[]; totalM: number }

/** Накопленные расстояния вдоль линии: cum[i] — метров от начала до точки i. */
export function indexRoute(shape: LatLon[]): RouteIndex {
  const cum = new Array<number>(shape.length).fill(0);
  for (let i = 1; i < shape.length; i++) cum[i] = cum[i - 1] + haversine(shape[i - 1].lat, shape[i - 1].lon, shape[i].lat, shape[i].lon);
  return { shape, cum, totalM: shape.length ? cum[shape.length - 1] : 0 };
}

export interface Projection {
  segment: number;   // номер отрезка (от точки segment до segment+1)
  alongM: number;    // положение проекции вдоль маршрута, м
  distM: number;     // расстояние от точки до маршрута, м
  snapped: LatLon;
}

function projectOnSegment(index: RouteIndex, i: number, p: LatLon): Projection {
  const A = index.shape[i], B = index.shape[i + 1];
  const kx = M_PER_DEG_LON_EQ * Math.cos((p.lat * Math.PI) / 180), ky = M_PER_DEG_LAT;
  // плоские координаты в метрах с началом в точке p
  const ax = (A.lon - p.lon) * kx, ay = (A.lat - p.lat) * ky;
  const bx = (B.lon - p.lon) * kx, by = (B.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  const cx = ax + t * dx, cy = ay + t * dy;
  const segLen = index.cum[i + 1] - index.cum[i];
  return {
    segment: i,
    alongM: index.cum[i] + t * segLen,
    distM: Math.hypot(cx, cy),
    snapped: { lat: A.lat + t * (B.lat - A.lat), lon: A.lon + t * (B.lon - A.lon) }
  };
}

/** Ближайшая к точке позиция на маршруте. from/to ограничивают отрезки диапазоном «вдоль маршрута» (метры). */
export function projectOnRoute(index: RouteIndex, p: LatLon, range?: { fromM: number; toM: number }): Projection | null {
  const n = index.shape.length;
  if (n === 0) return null;
  if (n === 1) return { segment: 0, alongM: 0, distM: haversine(index.shape[0].lat, index.shape[0].lon, p.lat, p.lon), snapped: index.shape[0] };
  let best: Projection | null = null;
  for (let i = 0; i < n - 1; i++) {
    if (range && (index.cum[i + 1] < range.fromM || index.cum[i] > range.toM)) continue;
    let pr = projectOnSegment(index, i, p);
    if (range && (pr.alongM < range.fromM || pr.alongM > range.toM)) {
      // отрезок вошёл в диапазон лишь частью: берём ближайшую точку внутри диапазона, а не всю проекцию
      const along = Math.max(range.fromM, Math.min(range.toM, pr.alongM));
      const segLen = index.cum[i + 1] - index.cum[i];
      const t = segLen > 0 ? (along - index.cum[i]) / segLen : 0;
      const A = index.shape[i], B = index.shape[i + 1];
      const snapped = { lat: A.lat + t * (B.lat - A.lat), lon: A.lon + t * (B.lon - A.lon) };
      pr = { segment: i, alongM: along, distM: haversine(snapped.lat, snapped.lon, p.lat, p.lon), snapped };
    }
    if (!best || pr.distM < best.distM) best = pr;
  }
  return best;
}

/** Направление от a к b, градусы по часовой от севера (0–360). */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = (a.lat * Math.PI) / 180, φ2 = (b.lat * Math.PI) / 180, dλ = ((b.lon - a.lon) * Math.PI) / 180;
  const y = Math.sin(dλ) * Math.cos(φ2), x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

const COMPASS = ['севере', 'северо-востоке', 'востоке', 'юго-востоке', 'юге', 'юго-западе', 'западе', 'северо-западе'];
/** «на севере», «на юго-западе»: куда смотреть, чтобы вернуться на маршрут. */
export const compassWord = (deg: number): string => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

// ---------- пороги и состояние ----------

/** Расстояния до манёвра, на которых его озвучивают, от дальнего к ближнему. */
export const ANNOUNCE_THRESHOLDS: Record<RouteProfile, number[]> = { pedestrian: [120, 40, 15], bicycle: [300, 100, 30] };
const OFF_BASE_M: Record<RouteProfile, number> = { pedestrian: 35, bicycle: 50 };
const OFF_CONFIRM_MS = 6000;      // дольше этого вне маршрута — считаем сходом
const OFF_CONFIRM_FIXES = 3;
const BACK_RATIO = 0.6;           // вернулся на маршрут: ближе этой доли порога (гистерезис)
const BAD_ACCURACY_M = 60;        // точки хуже этого не используем для сход/поворотов
const ARRIVE_M = 20;
export const REROUTE_MIN_INTERVAL_MS = 30_000;

export interface NavState {
  alongM: number;                // дальше всего пройденное вдоль маршрута
  off: boolean;
  offSince: number | null;
  offFixes: number;
  fired: Record<string, 1>;      // «номер манёвра:номер порога» — уже озвучено
  lastRerouteAt: number | null;
  arrived: boolean;
}

export const initialNavState = (): NavState => ({ alongM: 0, off: false, offSince: null, offFixes: 0, fired: {}, lastRerouteAt: null, arrived: false });

export interface NavFix { t: number; lat: number; lon: number; acc: number }

export interface NavStatus {
  alongM: number;
  remainingM: number;
  offRouteM: number | null;       // расстояние до маршрута по последней принятой точке
  off: boolean;
  nextIndex: number | null;       // номер ближайшего манёвра в route.maneuvers
  distToNextM: number | null;
  arrived: boolean;
}

export type NavEvent =
  | { kind: 'maneuver'; index: number; thresholdM: number; maneuver: NavManeuver }
  | { kind: 'off-route'; distM: number; bearing: number }
  | { kind: 'back-on-route' }
  | { kind: 'arrived' };

const isStart = (m: NavManeuver) => m.type >= 1 && m.type <= 3;
const isDestination = (m: NavManeuver) => m.type >= 4 && m.type <= 6;

/** Порог схода с учётом точности GPS: слабый сигнал не должен считаться «сходом». */
export const offThresholdM = (profile: RouteProfile, acc: number): number => Math.max(OFF_BASE_M[profile], Math.min(100, (Number.isFinite(acc) ? acc : 0) * 1.5));

/** Положение манёвра вдоль маршрута, м. */
export const maneuverAlongM = (idx: RouteIndex, m: NavManeuver): number => idx.cum[Math.min(Math.max(0, m.shapeIndex), idx.cum.length - 1)] ?? 0;

/** Ближайший непройденный манёвр (старт пропускается). null — манёвров впереди нет. */
export function nextManeuverIndex(route: PlannedRoute, idx: RouteIndex, alongM: number): number | null {
  for (let k = 0; k < route.maneuvers.length; k++) {
    const m = route.maneuvers[k];
    if (isStart(m)) continue;
    if (maneuverAlongM(idx, m) > alongM - 3) return k;
  }
  return null;
}

function statusOf(route: PlannedRoute, idx: RouteIndex, st: NavState, offRouteM: number | null): NavStatus {
  const next = nextManeuverIndex(route, idx, st.alongM);
  return {
    alongM: st.alongM,
    remainingM: Math.max(0, idx.totalM - st.alongM),
    offRouteM,
    off: st.off,
    nextIndex: next,
    distToNextM: next === null ? null : Math.max(0, maneuverAlongM(idx, route.maneuvers[next]) - st.alongM),
    arrived: st.arrived
  };
}

/**
 * Один шаг навигации по новой GPS-точке. Не меняет переданное состояние.
 * Точки с плохой точностью пропускаются: статус остаётся прежним, событий нет.
 */
export function navStep(route: PlannedRoute, idx: RouteIndex, prev: NavState, fix: NavFix): { state: NavState; status: NavStatus; events: NavEvent[] } {
  const events: NavEvent[] = [];
  if (idx.shape.length < 2 || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lon) || fix.acc > BAD_ACCURACY_M) {
    return { state: prev, status: statusOf(route, idx, prev, null), events };
  }
  const st: NavState = { ...prev, fired: { ...prev.fired } };
  const p: LatLon = { lat: fix.lat, lon: fix.lon };
  const thr = offThresholdM(route.profile, fix.acc);

  // сначала ищем рядом с уже пройденным (маршрут может пересекать сам себя), потом по всему маршруту
  const near = projectOnRoute(idx, p, { fromM: st.alongM - 60, toM: st.alongM + 800 });
  let proj = near;
  if (!near || near.distM > thr) {
    const far = projectOnRoute(idx, p);
    if (far && (!near || far.distM < near.distM - 15)) proj = far;
  }
  if (!proj) return { state: prev, status: statusOf(route, idx, prev, null), events };

  if (proj.distM > thr) {
    st.offFixes += 1;
    if (st.offSince === null) st.offSince = fix.t;
    if (!st.off && st.offFixes >= OFF_CONFIRM_FIXES && fix.t - st.offSince >= OFF_CONFIRM_MS) {
      st.off = true;
      events.push({ kind: 'off-route', distM: Math.round(proj.distM), bearing: bearingDeg(p, proj.snapped) });
    }
    // вне маршрута прогресс не двигаем: иначе «срезанный» участок засчитался бы пройденным
    return { state: st, status: statusOf(route, idx, st, proj.distM), events };
  }

  if (proj.distM <= thr * BACK_RATIO) {
    if (st.off) events.push({ kind: 'back-on-route' });
    st.off = false; st.offSince = null; st.offFixes = 0;
  } else if (!st.off) {
    st.offSince = null; st.offFixes = 0; // пограничная зона: не накапливаем «сход»
  }
  if (st.off) return { state: st, status: statusOf(route, idx, st, proj.distM), events }; // пока не вернулся уверенно, прогресс стоит

  st.alongM = Math.max(st.alongM, proj.alongM);

  // озвучка манёвров: только ближайший, и только самый близкий из пересечённых порогов (без очереди из трёх сообщений подряд)
  const next = nextManeuverIndex(route, idx, st.alongM);
  if (next !== null) {
    const m = route.maneuvers[next];
    const d = maneuverAlongM(idx, m) - st.alongM;
    const ths = ANNOUNCE_THRESHOLDS[route.profile];
    const crossed = ths.map((th, j) => (d <= th ? j : -1)).filter((j) => j >= 0);
    if (crossed.length && (!isDestination(m) || m.via)) {
      const tight = Math.max(...crossed);
      if (!st.fired[`${next}:${tight}`]) {
        for (let j = 0; j <= tight; j++) st.fired[`${next}:${j}`] = 1;
        events.push({ kind: 'maneuver', index: next, thresholdM: ths[tight], maneuver: m });
      }
    }
  }

  // финиш
  const remaining = idx.totalM - st.alongM;
  if (!st.arrived && remaining <= Math.max(ARRIVE_M, Math.min(40, fix.acc))) {
    st.arrived = true;
    events.push({ kind: 'arrived' });
  }
  return { state: st, status: statusOf(route, idx, st, proj.distM), events };
}

/** Пора ли перестроить маршрут: человек сошёл с него и с прошлой попытки прошло достаточно времени. */
export function rerouteDue(st: NavState, now: number, minIntervalMs: number = REROUTE_MIN_INTERVAL_MS): boolean {
  return st.off && !st.arrived && (st.lastRerouteAt === null || now - st.lastRerouteAt >= minIntervalMs);
}

/** Запомнить попытку перестроения (успешную или нет): ограничение частоты считается от неё. */
export const markRerouteAttempt = (st: NavState, now: number): NavState => ({ ...st, lastRerouteAt: now });

/** После успешного перестроения новый маршрут начинается с текущей позиции: прогресс и озвученные манёвры обнуляются. */
export const resetForNewRoute = (st: NavState): NavState => ({ ...initialNavState(), lastRerouteAt: st.lastRerouteAt });

/**
 * Точки, через которые ещё предстоит пройти: промежуточные (если не пройдены) и финиш.
 * Нужны для перестроения: новый маршрут строится от текущей позиции через них.
 */
export function remainingWaypoints(route: PlannedRoute, idx: RouteIndex, st: NavState): LatLon[] {
  const wps = route.waypoints.slice(1);
  if (!wps.length) return [];
  const out = wps.filter((w, i) => {
    if (i === wps.length - 1) return true; // финиш всегда впереди
    const pr = projectOnRoute(idx, w);
    return !pr || pr.alongM > st.alongM + ARRIVE_M;
  });
  return out;
}

/** Сколько всего осталось по маршруту и сколько займёт при заданной средней скорости (м/с); null, если скорость неизвестна. */
export function etaSec(remainingM: number, speedMps: number | null): number | null {
  return speedMps && speedMps > 0.3 ? remainingM / speedMps : null;
}

/** Часть маршрута между двумя положениями вдоль линии (метры): для окраски пройденного участка. */
export function routePart(idx: RouteIndex, fromM: number, toM: number): LatLon[] {
  const n = idx.shape.length;
  if (n < 2 || toM <= fromM) return [];
  const at = (m: number): LatLon => {
    const x = Math.max(0, Math.min(idx.totalM, m));
    let i = 0;
    while (i < n - 2 && idx.cum[i + 1] < x) i++;
    const seg = idx.cum[i + 1] - idx.cum[i];
    const t = seg > 0 ? (x - idx.cum[i]) / seg : 0;
    return { lat: idx.shape[i].lat + t * (idx.shape[i + 1].lat - idx.shape[i].lat), lon: idx.shape[i].lon + t * (idx.shape[i + 1].lon - idx.shape[i].lon) };
  };
  const out: LatLon[] = [at(fromM)];
  for (let i = 0; i < n; i++) if (idx.cum[i] > fromM && idx.cum[i] < toM) out.push(idx.shape[i]);
  out.push(at(toM));
  return out;
}
