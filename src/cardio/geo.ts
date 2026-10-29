// Ядро GPS-трекинга: без React и без обращения к браузеру, поэтому его можно проверять отдельными тестами.
import type { Sport } from '../domain/types';

export interface Fix { t: number; lat: number; lon: number; acc: number; ele: number | null }
// Точка маршрута: [секунды движения, широта×1e5, долгота×1e5, высота в дециметрах или null]. Целые числа вдвое экономят место.
export type TrackPoint = [number, number, number, number | null];

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Предельная правдоподобная скорость, м/с: быстрее — это скачок GPS, а не движение
export const MAX_SPEED: Record<Sport, number> = { run: 9, walk: 4, bike: 25 };
const MAX_ACCURACY = 30;      // м: менее точные фиксы отбрасываем
const START_ACCURACY = 25;    // м: с такой точности можно начинать запись
const MIN_SPEED = 0.5;        // м/с: ниже — стоим, дрейф GPS не считаем движением
const ELE_STEP = 3;           // м: порог набора высоты (отсекает шум высотомера)
const PACE_WINDOW = 30;       // с: окно для текущего темпа
const TYPICAL_SPEED: Record<Sport, number> = { run: 2.8, walk: 1.3, bike: 5.5 };

export interface Stats {
  distanceM: number;
  movingSec: number;
  elevGainM: number;
  splits: number[];            // секунды на каждый пройденный полный километр
  paceSecPerKm: number | null; // текущий темп (окно ~30 с)
  speedMps: number | null;
}

export interface TrackerState {
  sport: Sport;
  points: { t: number; lat: number; lon: number; ele: number | null; seg?: number }[]; // t — секунды движения, seg — номер непрерывного отрезка
  seg?: number;
  last: { t: number; lat: number; lon: number } | null;                  // последний принятый фикс (мс, реальное время)
  distanceM: number;
  movingSec: number;
  elevGainM: number;
  eleRef: number | null;
  splits: number[];
  window: { s: number; d: number }[];
  vEma?: number;               // недавняя скорость движения, м/с: по ней отличаем движение от стояния
}

export class Tracker {
  state: TrackerState;
  constructor(sport: Sport, state?: TrackerState) {
    this.state = state ?? { sport, points: [], last: null, distanceM: 0, movingSec: 0, elevGainM: 0, eleRef: null, splits: [], window: [] };
  }

  /** Можно ли начинать запись по этому фиксу (достаточно точный сигнал) */
  static goodStart(f: Fix): boolean { return f.acc <= START_ACCURACY; }

  /** После паузы или потери сигнала: следующая точка станет началом нового отрезка, расстояние через разрыв не считается */
  breakSegment() { this.state.last = null; this.state.window = []; this.state.seg = (this.state.seg ?? 0) + 1; }

  /** Принять фикс. Возвращает true, если он учтён. */
  push(f: Fix): boolean {
    const s = this.state;
    if (!Number.isFinite(f.lat) || !Number.isFinite(f.lon) || Math.abs(f.lat) > 90 || Math.abs(f.lon) > 180) return false;
    if (f.acc > MAX_ACCURACY) return false;

    if (!s.last) {
      if (!Tracker.goodStart(f) && s.points.length === 0) return false;
      s.last = { t: f.t, lat: f.lat, lon: f.lon };
      s.points.push({ t: s.movingSec, lat: f.lat, lon: f.lon, ele: f.ele, seg: s.seg ?? 0 });
      if (f.ele !== null) s.eleRef = s.eleRef ?? f.ele;
      return true;
    }

    const dt = (f.t - s.last.t) / 1000;
    if (dt <= 0) return false;
    const d = haversine(s.last.lat, s.last.lon, f.lat, f.lon);
    const speed = d / dt;
    // Сдвиг меньше заявленной точности — это шум, а не движение. Последнюю точку не обновляем: при реальном
    // движении расстояние накопится и пройдёт порог, а на месте шум не превращается в километры.
    if (d < Math.min(12, Math.max(3, f.acc))) return false;
    if (speed > MAX_SPEED[s.sport]) return false;      // скачок
    if (speed < MIN_SPEED) return false;               // почти стоим

    // Время стояния (светофор, шнурки) не должно попадать в «время движения»: если за интервал пройдено мало,
    // считаем только столько времени, сколько на это расстояние нужно при недавней скорости (с запасом: не меньше 60% её).
    const vRef = s.vEma ?? TYPICAL_SPEED[s.sport];
    const dtMove = Math.min(dt, d / (0.6 * vRef));
    s.vEma = vRef * 0.8 + 0.2 * (d / dtMove);
    const prevDist = s.distanceM;
    const prevSec = s.movingSec;
    s.distanceM += d;
    s.movingSec += dtMove;
    s.last = { t: f.t, lat: f.lat, lon: f.lon };

    // километровые отрезки: время пересечения границы считаем линейной интерполяцией внутри шага
    let k = s.splits.length + 1;
    let lastBoundarySec = s.splits.reduce((a, b) => a + b, 0);
    while (s.distanceM >= k * 1000) {
      const frac = (k * 1000 - prevDist) / d;
      const crossSec = prevSec + frac * dtMove;
      s.splits.push(crossSec - lastBoundarySec);
      lastBoundarySec = crossSec;
      k++;
    }

    if (f.ele !== null) {
      if (s.eleRef === null) s.eleRef = f.ele;
      else if (f.ele - s.eleRef >= ELE_STEP) { s.elevGainM += f.ele - s.eleRef; s.eleRef = f.ele; }
      else if (s.eleRef - f.ele >= ELE_STEP) s.eleRef = f.ele;
    }

    s.points.push({ t: s.movingSec, lat: f.lat, lon: f.lon, ele: f.ele, seg: s.seg ?? 0 });
    s.window.push({ s: s.movingSec, d: s.distanceM });
    while (s.window.length > 2 && s.movingSec - s.window[0].s > PACE_WINDOW) s.window.shift();
    return true;
  }

  stats(): Stats {
    const s = this.state;
    let pace: number | null = null, speed: number | null = null;
    const w = s.window;
    if (w.length >= 2) {
      const ds = w[w.length - 1].s - w[0].s, dd = w[w.length - 1].d - w[0].d;
      if (ds >= 8 && dd >= 10) { pace = (ds / dd) * 1000; speed = dd / ds; }
    }
    return { distanceM: s.distanceM, movingSec: s.movingSec, elevGainM: s.elevGainM, splits: s.splits.slice(), paceSecPerKm: pace, speedMps: speed };
  }
}

// ---------- упрощение и кодирование маршрута ----------

function project(points: { lat: number; lon: number }[]) {
  const lat0 = points.reduce((a, p) => a + p.lat, 0) / Math.max(1, points.length);
  const kx = Math.cos(rad(lat0)) * R * (Math.PI / 180), ky = R * (Math.PI / 180);
  return points.map((p) => ({ x: p.lon * kx, y: p.lat * ky }));
}

/** Дугласа–Пейкера без рекурсии. epsilon в метрах. */
export function simplify<T extends { lat: number; lon: number }>(pts: T[], epsilon: number): T[] {
  if (pts.length <= 2) return pts.slice();
  const xy = project(pts);
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0, idx = -1;
    const dx = xy[b].x - xy[a].x, dy = xy[b].y - xy[a].y, len = Math.hypot(dx, dy);
    for (let i = a + 1; i < b; i++) {
      const dist = len === 0 ? Math.hypot(xy[i].x - xy[a].x, xy[i].y - xy[a].y) : Math.abs(dy * xy[i].x - dx * xy[i].y + xy[b].x * xy[a].y - xy[b].y * xy[a].x) / len;
      if (dist > maxD) { maxD = dist; idx = i; }
    }
    if (idx !== -1 && maxD > epsilon) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export const MAX_TRACK_POINTS = 4000; // с запасом укладывается в лимит размера записи на сервере
const KEEP_EVERY_S = 20;               // на прямых участках всё равно оставляем точку раз в 20 с: иначе пропадут высота и темп

/** Упрощает маршрут (форма по Дугласу–Пейкеру, плюс редкие точки на прямых для высоты и темпа) и кодирует в целые числа */
export function encodeTrack(points: TrackerState['points']): TrackPoint[] {
  let eps = 3, step = KEEP_EVERY_S, out: TrackerState['points'] = points;
  const build = () => {
    const shape = new Set(simplify(points, eps));
    let lastT = -Infinity;
    return points.filter((p, i) => {
      const keep = shape.has(p) || i === 0 || i === points.length - 1 || p.t - lastT >= step;
      if (keep) lastT = p.t;
      return keep;
    });
  };
  out = build();
  while (out.length > MAX_TRACK_POINTS && eps < 200) { eps *= 1.6; step *= 1.6; out = build(); }
  return out.map((p) => [Math.round(p.t), Math.round(p.lat * 1e5), Math.round(p.lon * 1e5), p.ele === null ? null : Math.round(p.ele * 10)]);
}

export const decodePoint = (p: TrackPoint) => ({ t: p[0], lat: p[1] / 1e5, lon: p[2] / 1e5, ele: p[3] === null ? null : p[3] / 10 });

// ---------- лучшие отрезки ----------

/** Лучшее время на отрезке заданной длины (м), секунды; null, если маршрут короче.
 *  Считается по полной записи, а не по упрощённой: после упрощения теряется информация о скорости. */
export function bestEffort(pts: { t: number; lat: number; lon: number; seg?: number }[], targetM: number): number | null {
  if (pts.length < 2) return null;
  const cum = [0];
  // через паузу или потерю сигнала расстояние и время не растут: отрезки «склеиваются» как при остановленных часах
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + ((pts[i].seg ?? 0) !== (pts[i - 1].seg ?? 0) ? 0 : haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon)));
  if (cum[cum.length - 1] < targetM) return null;
  let best = Infinity, i = 0;
  for (let j = 1; j < pts.length; j++) {
    const startDist = cum[j] - targetM;
    if (startDist < 0) continue;
    while (i < j - 1 && cum[i + 1] <= startDist) i++;
    const seg = cum[i + 1] - cum[i];
    const frac = seg > 0 ? (startDist - cum[i]) / seg : 0;
    const startT = pts[i].t + frac * (pts[i + 1].t - pts[i].t);
    best = Math.min(best, pts[j].t - startT);
  }
  return Number.isFinite(best) ? best : null;
}

export const BEST_DISTANCES = [1000, 5000, 10000] as const;

export function bestEfforts(pts: { t: number; lat: number; lon: number; seg?: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of BEST_DISTANCES) { const t = bestEffort(pts, d); if (t !== null) out[String(d)] = Math.round(t); }
  return out;
}

// ---------- вывод ----------

export function formatPace(secPerKm: number | null): string {
  if (secPerKm === null || !Number.isFinite(secPerKm) || secPerKm <= 0 || secPerKm > 3600) return '—';
  const s = Math.round(secPerKm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export const formatSpeedKmh = (mps: number | null) => (mps === null || !Number.isFinite(mps) ? '—' : (mps * 3.6).toFixed(1));
export const formatKm = (m: number) => (m / 1000).toFixed(m >= 10000 ? 1 : 2);
export function formatHMS(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}
export const avgPace = (distanceM: number, sec: number) => (distanceM > 0 ? (sec / distanceM) * 1000 : null);

// ---------- проекция маршрута для SVG ----------

export function fitRoute(points: { lat: number; lon: number }[], w: number, h: number, pad = 14): { x: number; y: number }[] {
  if (!points.length) return [];
  const xy = project(points);
  const xs = xy.map((p) => p.x), ys = xy.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const sx = (w - 2 * pad) / Math.max(1, maxX - minX), sy = (h - 2 * pad) / Math.max(1, maxY - minY);
  const k = Math.min(sx, sy);
  const ox = (w - (maxX - minX) * k) / 2, oy = (h - (maxY - minY) * k) / 2;
  return xy.map((p) => ({ x: ox + (p.x - minX) * k, y: h - (oy + (p.y - minY) * k) }));
}

// ---------- голосовые подсказки ----------

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/** Текст подсказки после очередного километра: «3 километра. Темп 5 минут 33 секунды на километр.» */
export function voiceText(km: number, splitSec: number, bike: boolean): string {
  const head = `${km} ${plural(km, 'километр', 'километра', 'километров')}.`;
  if (bike) return `${head} Скорость ${(3600 / splitSec).toFixed(1).replace('.', ',')} километра в час.`;
  const s = Math.round(splitSec);
  const m = Math.floor(s / 60), sec = s % 60;
  const minPart = m > 0 ? `${m} ${plural(m, 'минута', 'минуты', 'минут')} ` : '';
  return `${head} Темп ${minPart}${sec} ${plural(sec, 'секунда', 'секунды', 'секунд')} на километр.`;
}


// ---------- анализ темпа по километрам ----------

export interface PaceAnalysis { fastest: number; slowest: number; avgSec: number; spreadSec: number; trend: 'negative' | 'positive' | 'even'; text: string }

export function analyzeSplits(splits: number[]): PaceAnalysis | null {
  if (splits.length < 2) return null;
  const avg = splits.reduce((a, b) => a + b, 0) / splits.length;
  const min = Math.min(...splits), max = Math.max(...splits);
  const half = Math.floor(splits.length / 2);
  const first = splits.slice(0, half), second = splits.slice(splits.length - half);
  const diff = second.reduce((a, b) => a + b, 0) / half - first.reduce((a, b) => a + b, 0) / half;
  const trend = diff < -5 ? 'negative' : diff > 5 ? 'positive' : 'even';
  const parts = [`Быстрее всего км ${splits.indexOf(min) + 1} (${formatHMS(min)}), медленнее всего км ${splits.indexOf(max) + 1} (${formatHMS(max)})`];
  if (trend === 'negative') parts.push(`вторая половина быстрее на ${Math.round(-diff)} с/км: негативный сплит`);
  else if (trend === 'positive') parts.push(`вторая половина медленнее на ${Math.round(diff)} с/км`);
  else parts.push('темп по ходу дистанции ровный');
  if (max - min <= 10) parts.push('разброс между километрами не больше 10 с');
  return { fastest: splits.indexOf(min) + 1, slowest: splits.indexOf(max) + 1, avgSec: avg, spreadSec: max - min, trend, text: parts.join('; ') + '.' };
}

// ---------- профиль высоты ----------

export interface Elevation { dist: number[]; ele: number[]; min: number; max: number; gain: number; loss: number }

export function elevationProfile(track: TrackPoint[], maxPoints = 120): Elevation | null {
  return elevationFromPoints(track.map(decodePoint), maxPoints);
}

export function elevationFromPoints(pts: { lat: number; lon: number; ele: number | null }[], maxPoints = 120): Elevation | null {
  const dist: number[] = [], ele: number[] = [];
  let d = 0, prev: { lat: number; lon: number } | null = null;
  for (const p of pts) {
    if (prev) d += haversine(prev.lat, prev.lon, p.lat, p.lon);
    prev = p;
    if (p.ele !== null) { dist.push(d); ele.push(p.ele); }
  }
  if (ele.length < 5) return null;
  // сглаживаем скользящим средним: высота с GPS «дрожит» на несколько метров
  const k = Math.max(1, Math.round(ele.length / 40));
  const sm = ele.map((_, i) => { const a = Math.max(0, i - k), b = Math.min(ele.length - 1, i + k); let t = 0; for (let j = a; j <= b; j++) t += ele[j]; return t / (b - a + 1); });
  const min = Math.min(...sm), max = Math.max(...sm);
  if (max - min < 3) return null;
  let gain = 0, loss = 0, ref = sm[0];
  for (const v of sm) { if (v - ref >= 3) { gain += v - ref; ref = v; } else if (ref - v >= 3) { loss += ref - v; ref = v; } }
  const step = Math.max(1, Math.ceil(sm.length / maxPoints));
  return { dist: dist.filter((_, i) => i % step === 0), ele: sm.filter((_, i) => i % step === 0), min, max, gain, loss };
}

// ---------- цвет маршрута по темпу ----------

/** Скорость на каждом отрезке маршрута, м/с (по времени движения); где время не идёт — берём соседнюю */
export function segmentSpeeds(pts: { t: number; lat: number; lon: number }[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const dt = pts[i].t - pts[i - 1].t;
    out.push(dt > 0 ? haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon) / dt : out[out.length - 1] ?? 0);
  }
  return out;
}

/** Цвет от синего (медленно) к оранжевому (быстро) по месту скорости между 10-м и 90-м процентилем */
export function speedColor(v: number, lo: number, hi: number): string {
  const f = hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 0.5;
  return `hsl(${Math.round(210 - f * 180)} 80% 58%)`;
}
export function speedRange(speeds: number[]): [number, number] {
  if (!speeds.length) return [0, 1];
  const s = [...speeds].sort((a, b) => a - b);
  return [s[Math.floor(s.length * 0.1)], s[Math.min(s.length - 1, Math.floor(s.length * 0.9))]];
}

// ---------- сравнение маршрутов ----------

type LL = { lat: number; lon: number };
const pathLen = (pts: LL[]) => pts.reduce((a, p, i) => (i ? a + haversine(pts[i - 1].lat, pts[i - 1].lon, p.lat, p.lon) : 0), 0);
export const routeLengthM = pathLen;

/** n точек, равномерно распределённых вдоль маршрута */
export function resample(pts: LL[], n: number): LL[] {
  if (pts.length < 2) return pts.slice();
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon));
  const total = cum[cum.length - 1];
  if (total === 0) return [pts[0]];
  const out: LL[] = [];
  let j = 1;
  for (let k = 0; k < n; k++) {
    const d = (total * k) / (n - 1);
    while (j < pts.length - 1 && cum[j] < d) j++;
    const seg = cum[j] - cum[j - 1], f = seg > 0 ? (d - cum[j - 1]) / seg : 0;
    out.push({ lat: pts[j - 1].lat + (pts[j].lat - pts[j - 1].lat) * f, lon: pts[j - 1].lon + (pts[j].lon - pts[j - 1].lon) * f });
  }
  return out;
}

/** Среднее расстояние (м) между маршрутами: от точек каждого до ближайшей точки другого, в обе стороны */
export function routeDistance(a: LL[], b: LL[]): number {
  const A = resample(a, 40), B = resample(b, 40), dA = resample(a, 200), dB = resample(b, 200);
  const near = (p: LL, set: LL[]) => set.reduce((m, q) => Math.min(m, haversine(p.lat, p.lon, q.lat, q.lon)), Infinity);
  const ab = A.reduce((s, p) => s + near(p, dB), 0) / A.length, ba = B.reduce((s, p) => s + near(p, dA), 0) / B.length;
  return (ab + ba) / 2;
}

/** Один и тот же маршрут: похожая длина, близкие начала и форма (в любом направлении) */
export function isSameRoute(a: LL[], b: LL[]): boolean {
  if (a.length < 2 || b.length < 2) return false;
  const la = pathLen(a), lb = pathLen(b);
  if (la < 300 || lb < 300 || Math.max(la, lb) / Math.min(la, lb) > 1.2) return false;
  const near = Math.min(haversine(a[0].lat, a[0].lon, b[0].lat, b[0].lon), haversine(a[0].lat, a[0].lon, b[b.length - 1].lat, b[b.length - 1].lon));
  return near < 250 && routeDistance(a, b) < 60;
}
