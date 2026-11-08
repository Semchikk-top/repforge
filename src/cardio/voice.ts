// Тексты голосовых подсказок и правила тренировочной обратной связи. Чистые функции: без озвучки и времени (время приходит параметром).
// Принципы против спама: пульсовая зона только при живом датчике и заданном maxHr, гистерезис и пауза между сообщениями;
// темп только при заданной цели и только если отклонение держится; одинаковые подсказки не чаще заданной паузы.

import type { NavManeuver, PlannedRoute } from '../domain/types';
import { plural } from './geo';
import { ZONES, zoneFor } from './hr';
import { compassWord } from './nav';

// ---------- слова ----------

const comma = (n: number, digits = 1): string => n.toFixed(digits).replace(/\.0+$/, '').replace('.', ',');

/** «5,2 километра», «3 километра», «1 километр». */
export function kmWords(m: number): string {
  const km = Math.round(m / 100) / 10;
  if (Number.isInteger(km)) return `${km} ${plural(km, 'километр', 'километра', 'километров')}`;
  return `${comma(km)} километра`;
}

/** «120 метров» до километра, дальше километры. Метры округляются до 10 (до 100 — до 5). */
export function distanceWords(m: number): string {
  if (m >= 950) return kmWords(m);
  const r = m < 100 ? Math.max(5, Math.round(m / 5) * 5) : Math.round(m / 10) * 10;
  return `${r} ${plural(r, 'метр', 'метра', 'метров')}`;
}

export function durationWords(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h} ${plural(h, 'час', 'часа', 'часов')}`);
  if (m) parts.push(`${m} ${plural(m, 'минута', 'минуты', 'минут')}`);
  if (r || !parts.length) parts.push(`${r} ${plural(r, 'секунда', 'секунды', 'секунд')}`);
  return parts.join(' ');
}

const paceWords = (secPerKm: number): string => {
  const s = Math.round(secPerKm), m = Math.floor(s / 60), r = s % 60;
  return `${m} ${plural(m, 'минута', 'минуты', 'минут')} ${r} ${plural(r, 'секунда', 'секунды', 'секунд')} на километр`;
};

const sentence = (s: string): string => { const t = s.trim(); return /[.!?]$/.test(t) ? t : t + '.'; };
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

// ---------- навигация ----------

/**
 * Фраза о манёвре. Дальний и средний пороги: «Через 120 метров, поверните налево.»;
 * самый ближний (последний в списке): полная фраза у поворота («Поверните налево на улицу Ленина.»).
 */
export function maneuverText(m: NavManeuver, thresholdM: number, thresholds: number[]): string {
  const closest = thresholdM === Math.min(...thresholds);
  const full = m.verbal ?? m.alert ?? m.instruction;
  if (closest) return sentence(full);
  const brief = m.alert ?? m.verbal ?? m.instruction;
  return sentence(`Через ${distanceWords(thresholdM)}, ${lowerFirst(brief.trim().replace(/[.!?]+$/, ''))}`);
}

export const offRouteText = (distM: number, bearing: number): string =>
  `Вы сошли с маршрута. Он в ${distanceWords(distM)} на ${compassWord(bearing)}.`;
export const reroutingText = (): string => 'Перестраиваю маршрут.';
export const rerouteOkText = (): string => 'Маршрут перестроен.';
export const rerouteFailText = (offline: boolean): string =>
  offline ? 'Нет сети, маршрут не перестроить. Вернитесь на прежний маршрут.' : 'Не удалось перестроить маршрут. Вернитесь на прежний маршрут.';
export const backOnRouteText = (): string => 'Вы снова на маршруте.';
export const arrivedText = (): string => 'Вы пришли в конечную точку маршрута.';

// ---------- старт, километры, итоги ----------

export const startText = (plan: Pick<PlannedRoute, 'distanceM'> | null): string =>
  plan ? `Маршрут ${kmWords(plan.distanceM)}. Вперёд.` : 'Запись началась. Вперёд.';

export const halfText = (distanceM: number, totalM: number): string =>
  `Половина дистанции. Осталось ${kmWords(Math.max(0, totalM - distanceM))}.`;

export function finishText(r: { distanceM: number; durationSec: number; hrAvg?: number }, bike: boolean): string {
  const parts = ['Тренировка завершена.', `Дистанция ${kmWords(r.distanceM)}.`, `Время ${durationWords(r.durationSec)}.`];
  if (r.distanceM > 0 && r.durationSec > 0) {
    if (bike) parts.push(`Средняя скорость ${comma((r.distanceM / r.durationSec) * 3.6)} километра в час.`);
    else parts.push(`Средний темп ${paceWords((r.durationSec / r.distanceM) * 1000)}.`);
  }
  if (r.hrAvg) parts.push(`Средний пульс ${r.hrAvg}.`);
  return parts.join(' ');
}

// ---------- тренировочные подсказки ----------

export const HR_STABLE_MS = 10_000;     // зона должна продержаться столько, чтобы о ней сказали
export const HR_MIN_GAP_MS = 60_000;    // между сообщениями о зоне
export const HR_MARGIN_BPM = 3;         // гистерезис на границе зон
export const PACE_TOLERANCE = 0.10;     // отклонение от цели, при котором есть о чём говорить
export const PACE_OK = 0.05;            // вернулся ближе — отклонение закончилось
export const PACE_SUSTAIN_MS = 30_000;  // отклонение должно держаться, а не быть всплеском
export const PACE_MIN_GAP_MS = 90_000;
export const PACE_WARMUP_SEC = 60;
export const PACE_WARMUP_M = 200;
export const HALF_MIN_TOTAL_M = 3000;   // на коротких дистанциях «половина» не нужна

export interface CoachConfig {
  maxHr: number;                         // 0 — не задан: подсказок о пульсе нет
  targetPaceSecPerKm: number | null;     // null — цель не задана: подсказок о темпе нет
  plannedM: number | null;               // длина маршрута, если построен
  bike: boolean;
}
export interface CoachSample {
  t: number; distanceM: number; movingSec: number;
  paceSecPerKm: number | null;           // текущий темп (для велосипеда тоже в с/км)
  hrBpm: number | null;                  // null — нет живого датчика/контакта
}
export interface CoachState {
  halfDone: boolean;
  zone: number | null;                   // озвученная (или принятая молча при первом замере) зона: 0 — ниже первой
  zoneSince: number | null;              // с какого момента держится другая зона
  zoneCand: number | null;
  lastZoneAt: number | null;
  paceDir: 'slow' | 'fast' | null;
  paceSince: number | null;
  lastPaceAt: number | null;
  paceAnnounced: boolean;
}
export const initialCoachState = (): CoachState => ({ halfDone: false, zone: null, zoneSince: null, zoneCand: null, lastZoneAt: null, paceDir: null, paceSince: null, lastPaceAt: null, paceAnnounced: false });

/** Зона с гистерезисом: пока пульс не вышел за границу текущей зоны больше чем на margin, зона прежняя. 0 — ниже первой. */
export function zoneWithHysteresis(prev: number | null, hr: number, maxHr: number, margin: number = HR_MARGIN_BPM): number {
  if (prev && prev >= 1 && prev <= 5) {
    const z = ZONES[prev - 1];
    if (hr >= z.from * maxHr - margin && hr < z.to * maxHr + margin) return prev;
  }
  return zoneFor(hr, maxHr)?.n ?? 0;
}

/** Шаг тренировочных подсказок. Возвращает новое состояние и фразы (в порядке важности). */
export function coachStep(cfg: CoachConfig, prev: CoachState, s: CoachSample): { state: CoachState; say: string[] } {
  const st: CoachState = { ...prev };
  const say: string[] = [];

  // половина дистанции
  if (!st.halfDone && cfg.plannedM && cfg.plannedM >= HALF_MIN_TOTAL_M && s.distanceM >= cfg.plannedM / 2) {
    st.halfDone = true;
    if (s.distanceM < cfg.plannedM * 0.9) say.push(halfText(s.distanceM, cfg.plannedM));
  }

  // пульсовая зона: только с живым датчиком и заданным maxHr
  if (cfg.maxHr >= 100 && s.hrBpm) {
    const z = zoneWithHysteresis(st.zone, s.hrBpm, cfg.maxHr);
    if (st.zone === null) { st.zone = z; }                                   // первая зона принимается молча
    else if (z === st.zone) { st.zoneCand = null; st.zoneSince = null; }
    else {
      if (st.zoneCand !== z) { st.zoneCand = z; st.zoneSince = s.t; }
      if (st.zoneSince !== null && s.t - st.zoneSince >= HR_STABLE_MS && (st.lastZoneAt === null || s.t - st.lastZoneAt >= HR_MIN_GAP_MS)) {
        st.zone = z; st.zoneCand = null; st.zoneSince = null; st.lastZoneAt = s.t;
        say.push(z >= 1 ? `Пульсовая зона ${z}, ${ZONES[z - 1].name.toLowerCase()}.` : 'Пульс ниже первой зоны.');
      }
    }
  } else { st.zoneCand = null; st.zoneSince = null; }                          // датчик пропал: ждём заново

  // темп: только при цели и после разминки
  const target = cfg.targetPaceSecPerKm;
  if (target && target > 0 && s.paceSecPerKm && s.movingSec >= PACE_WARMUP_SEC && s.distanceM >= PACE_WARMUP_M) {
    const dev = s.paceSecPerKm / target - 1;       // > 0: медленнее цели
    const dir: 'slow' | 'fast' | null = dev > PACE_TOLERANCE ? 'slow' : dev < -PACE_TOLERANCE ? 'fast' : null;
    if (dir) {
      if (st.paceDir !== dir) { st.paceDir = dir; st.paceSince = s.t; }
      const held = st.paceSince !== null && s.t - st.paceSince >= PACE_SUSTAIN_MS;
      if (held && (st.lastPaceAt === null || s.t - st.lastPaceAt >= PACE_MIN_GAP_MS)) {
        st.lastPaceAt = s.t; st.paceAnnounced = true; st.paceSince = s.t; // следующее напоминание — не раньше паузы
        const word = cfg.bike ? (dir === 'slow' ? 'Скорость ниже цели' : 'Скорость выше цели') : (dir === 'slow' ? 'Темп медленнее цели' : 'Темп быстрее цели');
        say.push(cfg.bike ? `${word}.` : `${word}. Сейчас ${paceWords(s.paceSecPerKm)}.`);
      }
    } else if (Math.abs(dev) <= PACE_OK) {
      if (st.paceAnnounced && (st.lastPaceAt === null || s.t - st.lastPaceAt >= 30_000)) { say.push('Темп в норме.'); st.lastPaceAt = s.t; }
      st.paceDir = null; st.paceSince = null; st.paceAnnounced = false;
    }
  }
  return { state: st, say };
}
