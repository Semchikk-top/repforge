// Интервальные тренировки: разворачивание плана в отрезки и их выполнение. Чистая логика без React и GPS.
// Время считается «активными» секундами: рекордер добавляет их только пока запись идёт, поэтому пауза замораживает отрезок.
// Дистанция берётся от трекера. Движок ничего не произносит сам, он отдаёт события, а озвучка идёт через speechQueue.

import { INTERVAL_ROLE_LABELS, type IntervalLap, type IntervalLength, type IntervalPhase, type IntervalPlan, type IntervalRole, type IntervalTarget } from '../domain/types';
import { zoneFor } from './hr';
import { PACE_MAX_SEC, PACE_MIN_SEC } from './target';
import { durationWords, distanceWords } from './voice';
import { formatHMS, formatPace } from './geo';

export const MAX_REPS = 50;
export const TIME_MIN_SEC = 5;
export const TIME_MAX_SEC = 3 * 3600;
export const DIST_MIN_M = 20;
export const DIST_MAX_M = 50_000;
/** Предупреждение за столько секунд (или метров) до конца отрезка. */
export const COUNTDOWN_SEC = 10;
export const COUNTDOWN_M = 100;
/** Подсказки о цели не звучат в первые секунды отрезка и не чаще, чем раз в OFF_GAP_SEC. */
export const GRACE_SEC = 15;
export const OFF_GAP_SEC = 30;
export const PACE_TOLERANCE = 0.1;

export interface Step { role: IntervalRole; length: IntervalLength; target?: IntervalTarget; rep?: number; reps?: number }

export function expandPlan(p: IntervalPlan): Step[] {
  const out: Step[] = [];
  if (p.warmup) out.push({ role: 'warmup', length: p.warmup });
  for (let i = 1; i <= p.reps; i++) {
    out.push({ role: 'work', length: p.work.length, target: p.work.target, rep: i, reps: p.reps });
    if (p.rest && i < p.reps) out.push({ role: 'rest', length: p.rest.length, target: p.rest.target, rep: i, reps: p.reps });
  }
  if (p.cooldown) out.push({ role: 'cooldown', length: p.cooldown });
  return out;
}

// ---------- проверка ----------

export function validLength(l: unknown): l is IntervalLength {
  if (!l || typeof l !== 'object') return false;
  const v = l as Record<string, unknown>;
  if (v.by === 'time') return typeof v.sec === 'number' && Number.isFinite(v.sec) && v.sec >= TIME_MIN_SEC && v.sec <= TIME_MAX_SEC;
  if (v.by === 'distance') return typeof v.m === 'number' && Number.isFinite(v.m) && v.m >= DIST_MIN_M && v.m <= DIST_MAX_M;
  return false;
}

export function validTarget(t: unknown): t is IntervalTarget {
  if (!t || typeof t !== 'object') return false;
  const v = t as Record<string, unknown>;
  if (v.kind === 'pace') return typeof v.secPerKm === 'number' && v.secPerKm >= PACE_MIN_SEC && v.secPerKm <= PACE_MAX_SEC;
  if (v.kind === 'zone') return v.zone === 1 || v.zone === 2 || v.zone === 3 || v.zone === 4 || v.zone === 5;
  return false;
}

const validPhase = (ph: unknown): ph is IntervalPhase => !!ph && typeof ph === 'object' && validLength((ph as IntervalPhase).length) && ((ph as IntervalPhase).target === undefined || validTarget((ph as IntervalPhase).target));

/** Возвращает текст ошибки или null, если план можно выполнять. */
export function validatePlan(p: unknown): string | null {
  if (!p || typeof p !== 'object') return 'План не задан';
  const v = p as IntervalPlan;
  if (!Number.isInteger(v.reps) || v.reps < 1 || v.reps > MAX_REPS) return `Повторов от 1 до ${MAX_REPS}`;
  if (!validPhase(v.work)) return 'Проверь длину и цель рабочего отрезка';
  if (v.rest !== undefined && !validPhase(v.rest)) return 'Проверь длину и цель отдыха';
  if (v.warmup !== undefined && !validLength(v.warmup)) return 'Проверь длину разминки';
  if (v.cooldown !== undefined && !validLength(v.cooldown)) return 'Проверь длину заминки';
  return null;
}

// ---------- выполнение ----------

export interface IntervalState {
  started: boolean;
  done: boolean;
  index: number;
  startSec: number;
  startM: number;
  countdownSaid: boolean;
  lastOffSec: number | null;
  laps: IntervalLap[];
}
export const initialIntervalState = (): IntervalState => ({ started: false, done: false, index: 0, startSec: 0, startM: 0, countdownSaid: false, lastOffSec: null, laps: [] });

export interface IntervalSample { activeSec: number; distanceM: number; paceSecPerKm: number | null; hrBpm: number | null; maxHr: number | null }
export type OffDirection = 'slow' | 'fast' | 'high' | 'low';
export type IntervalEvent =
  | { kind: 'start'; step: Step; index: number }
  | { kind: 'countdown'; step: Step; next: Step | null }
  | { kind: 'off-target'; dir: OffDirection; step: Step }
  | { kind: 'done' };

export interface Progress { elapsed: number; remaining: number; unit: 'sec' | 'm'; fraction: number }

export function stepProgress(step: Step, st: IntervalState, s: Pick<IntervalSample, 'activeSec' | 'distanceM'>): Progress {
  const l = step.length;
  const elapsed = l.by === 'time' ? s.activeSec - st.startSec : s.distanceM - st.startM;
  const total = l.by === 'time' ? l.sec : l.m;
  const e = Math.max(0, elapsed);
  return { elapsed: e, remaining: Math.max(0, total - e), unit: l.by === 'time' ? 'sec' : 'm', fraction: Math.min(1, e / total) };
}

function closeLap(st: IntervalState, step: Step, s: IntervalSample, flag?: 'skipped' | 'partial'): IntervalLap[] {
  const lap: IntervalLap = { role: step.role, sec: Math.max(0, Math.round(s.activeSec - st.startSec)), distanceM: Math.max(0, Math.round(s.distanceM - st.startM)), ...(flag ? { [flag]: true } : {}) };
  return [...st.laps, lap];
}

function advance(steps: Step[], st: IntervalState, s: IntervalSample, flag?: 'skipped'): { state: IntervalState; events: IntervalEvent[] } {
  const laps = closeLap(st, steps[st.index], s, flag);
  const index = st.index + 1;
  if (index >= steps.length) return { state: { ...st, laps, index, done: true }, events: [{ kind: 'done' }] };
  return {
    state: { ...st, laps, index, startSec: s.activeSec, startM: s.distanceM, countdownSaid: false, lastOffSec: null },
    events: [{ kind: 'start', step: steps[index], index }]
  };
}

/** Один шаг движка: вызывается раз в секунду, пока идёт запись. Не более одного перехода за вызов. */
export function intervalStep(steps: Step[], st: IntervalState, s: IntervalSample): { state: IntervalState; events: IntervalEvent[] } {
  if (st.done || steps.length === 0) return { state: st, events: [] };
  if (!st.started) {
    const state = { ...st, started: true, index: 0, startSec: s.activeSec, startM: s.distanceM };
    return { state, events: [{ kind: 'start', step: steps[0], index: 0 }] };
  }
  const step = steps[st.index];
  if (!step) return { state: { ...st, done: true }, events: [] }; // сохранённое состояние не сходится с планом: считаем план законченным
  const p = stepProgress(step, st, s);
  if (p.remaining <= 0) return advance(steps, st, s);

  const events: IntervalEvent[] = [];
  let state = st;
  const long = step.length.by === 'time' ? step.length.sec >= 30 : step.length.m >= 400;
  const near = p.unit === 'sec' ? p.remaining <= COUNTDOWN_SEC : p.remaining <= COUNTDOWN_M;
  if (long && near && !st.countdownSaid) {
    state = { ...state, countdownSaid: true };
    events.push({ kind: 'countdown', step, next: steps[st.index + 1] ?? null });
  }
  const sinceStart = s.activeSec - st.startSec;
  const gapOk = st.lastOffSec === null || s.activeSec - st.lastOffSec >= OFF_GAP_SEC;
  if (step.target && sinceStart >= GRACE_SEC && gapOk && !events.length) {
    const dir = offDirection(step.target, s);
    if (dir) { state = { ...state, lastOffSec: s.activeSec }; events.push({ kind: 'off-target', dir, step }); }
  }
  return { state, events };
}

/** Кнопка «Пропустить отрезок»: лап помечается пропущенным, начинается следующий. */
export function skipStep(steps: Step[], st: IntervalState, s: IntervalSample): { state: IntervalState; events: IntervalEvent[] } {
  if (!st.started || st.done || !steps[st.index]) return { state: st, events: [] };
  return advance(steps, st, s, 'skipped');
}

/** Результаты для записи: завершённые отрезки и, если запись остановили посреди отрезка, его начатая часть. */
export function finalLaps(steps: Step[], st: IntervalState, s: IntervalSample): IntervalLap[] {
  if (!st.started || st.done || !steps[st.index]) return st.laps;
  const cur = closeLap(st, steps[st.index], s, 'partial');
  const last = cur[cur.length - 1];
  return last.sec > 0 || last.distanceM > 0 ? cur : st.laps;
}

function offDirection(t: IntervalTarget, s: IntervalSample): OffDirection | null {
  if (t.kind === 'pace') {
    if (s.paceSecPerKm === null) return null;
    if (s.paceSecPerKm > t.secPerKm * (1 + PACE_TOLERANCE)) return 'slow';
    if (s.paceSecPerKm < t.secPerKm * (1 - PACE_TOLERANCE)) return 'fast';
    return null;
  }
  if (s.hrBpm === null || !s.maxHr) return null;
  const z = zoneFor(s.hrBpm, s.maxHr);
  if (!z) return null;
  return z.n > t.zone ? 'high' : z.n < t.zone ? 'low' : null;
}

// ---------- тексты ----------

const lengthWords = (l: IntervalLength): string => (l.by === 'time' ? durationWords(l.sec) : distanceWords(l.m));

function paceTargetWords(secPerKm: number, bike: boolean): string {
  if (bike) { const kmh = Math.round((3600 / secPerKm) * 10) / 10; return `${String(kmh).replace('.', ',')} километра в час`; }
  return `${durationWords(secPerKm)} на километр`;
}

export const targetWords = (t: IntervalTarget, bike: boolean): string => (t.kind === 'pace' ? `темп ${paceTargetWords(t.secPerKm, bike)}` : `пульсовая зона ${t.zone}`);

export function startPhrase(step: Step, bike: boolean): string {
  const head = step.role === 'work' || step.role === 'rest' ? `${INTERVAL_ROLE_LABELS[step.role]} ${step.rep} из ${step.reps}` : INTERVAL_ROLE_LABELS[step.role];
  return `${head}. ${lengthWords(step.length)}${step.target ? `, ${targetWords(step.target, bike)}` : ''}.`;
}

export function countdownPhrase(step: Step, next: Step | null): string {
  const nextWord = next ? INTERVAL_ROLE_LABELS[next.role].toLowerCase() : 'конец';
  return step.length.by === 'time' ? `Через ${COUNTDOWN_SEC} секунд: ${nextWord}.` : `Осталось ${COUNTDOWN_M} метров, дальше ${nextWord}.`;
}

export const OFF_PHRASE: Record<OffDirection, string> = { slow: 'Ускорься.', fast: 'Сбавь темп.', high: 'Пульс выше зоны, сбавь.', low: 'Пульс ниже зоны, добавь.' };
export const donePhrase = (): string => 'Интервальная тренировка закончена. Отличная работа.';

export function eventPhrase(ev: IntervalEvent, bike: boolean): string {
  switch (ev.kind) {
    case 'start': return startPhrase(ev.step, bike);
    case 'countdown': return countdownPhrase(ev.step, ev.next);
    case 'off-target': return OFF_PHRASE[ev.dir];
    case 'done': return donePhrase();
  }
}

// ---------- тексты для экрана ----------

export const lengthLabel = (l: IntervalLength): string => (l.by === 'time' ? formatHMS(l.sec).replace(/^00:/, '').replace(/^0(\d:)/, '$1') : l.m >= 1000 ? `${(l.m / 1000).toFixed(l.m % 1000 ? 1 : 0).replace('.', ',')} км` : `${l.m} м`);

export function targetLabel(t: IntervalTarget | undefined, bike: boolean): string {
  if (!t) return '';
  if (t.kind === 'zone') return `зона ${t.zone}`;
  return bike ? `${(3600 / t.secPerKm).toFixed(1).replace('.', ',')} км/ч` : `${formatPace(t.secPerKm)} /км`;
}

/** Краткое описание плана для списка шаблонов: «6 × (1:00 / 0:30)». */
export function planSummary(p: IntervalPlan): string {
  const base = `${p.reps} × ${lengthLabel(p.work.length)}${p.rest ? ` / ${lengthLabel(p.rest.length)}` : ''}`;
  return [p.warmup ? `разминка ${lengthLabel(p.warmup)}` : '', base, p.cooldown ? `заминка ${lengthLabel(p.cooldown)}` : ''].filter(Boolean).join(' · ');
}

// ---------- ввод длины в форме ----------

export type LengthUnit = 'min' | 'sec' | 'm' | 'km';
export const LENGTH_UNITS: { id: LengthUnit; label: string }[] = [{ id: 'min', label: 'мин' }, { id: 'sec', label: 'сек' }, { id: 'm', label: 'м' }, { id: 'km', label: 'км' }];

/** «1,5» + «мин» → 90 секунд. Пустая или неверная строка и значения вне границ дают null. */
export function lengthFromInput(text: string, unit: LengthUnit): IntervalLength | null {
  const t = text.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const v = Number(t);
  const l: IntervalLength = unit === 'min' ? { by: 'time', sec: Math.round(v * 60) } : unit === 'sec' ? { by: 'time', sec: Math.round(v) } : unit === 'm' ? { by: 'distance', m: Math.round(v) } : { by: 'distance', m: Math.round(v * 1000) };
  return validLength(l) ? l : null;
}

/** Обратно: длина в удобные для поля значение и единицу. */
export function lengthToInput(l: IntervalLength): { text: string; unit: LengthUnit } {
  const c = (n: number): string => String(Math.round(n * 100) / 100).replace('.', ',');
  if (l.by === 'time') return l.sec % 60 === 0 || l.sec >= 600 ? { text: c(l.sec / 60), unit: 'min' } : { text: String(l.sec), unit: 'sec' };
  return l.m % 1000 === 0 ? { text: String(l.m / 1000), unit: 'km' } : { text: String(l.m), unit: 'm' };
}
