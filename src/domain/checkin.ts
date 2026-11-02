// Чек-ин самочувствия: чистая логика без React и базы. Её проверяют тесты.
// Готовность это подсказка на сегодня, а не медицинский показатель: формула простая, а каждая составляющая видна отдельно.

import { addDays, toDateStr } from '../lib';
import type { CheckIn, CheckInSlot, Rating } from './types';

export const SLOT_LABEL: Record<CheckInSlot, string> = { morning: 'Утро', evening: 'Вечер' };

/** Ядро метрик, общее для утра и вечера: только оно сравнивается между слотами. */
export const CORE_METRICS = ['energy', 'mood', 'soreness', 'stress'] as const;
export type CoreMetric = (typeof CORE_METRICS)[number];

export const METRIC_LABEL: Record<CoreMetric, string> = { energy: 'Энергия', mood: 'Настроение', soreness: 'Болезненность мышц', stress: 'Стресс' };
/** Для болезненности и стресса меньше значит лучше. */
export const LOWER_IS_BETTER: Record<CoreMetric, boolean> = { energy: false, mood: false, soreness: true, stress: true };

/**
 * Id записи зависит только от даты и слота. Так «один слот на дату» держится по построению:
 * два устройства, заполнившие один и тот же слот офлайн, пишут одну запись, а не две, и дальше решает обычная синхронизация.
 */
export const checkInId = (date: string, slot: CheckInSlot): string => `ci:${date}:${slot}`;

export const isRating = (v: unknown): v is Rating => v === 1 || v === 2 || v === 3 || v === 4 || v === 5;

export interface CheckInDraft {
  date: string;
  slot: CheckInSlot;
  energy: Rating;
  mood: Rating;
  soreness: Rating;
  stress: Rating;
  sleepHours?: number;
  sleepQuality?: Rating;
  sleepiness?: Rating;
  note?: string;
}

/**
 * Приводит черновик к виду, который можно хранить: поля чужого слота отбрасываются
 * (утром нет «сонливости», вечером нет сна), часы сна ограничиваются 0–24, пустая заметка убирается.
 * Если ядро метрик заполнено неправильно, возвращает null.
 */
export function normalizeCheckIn(d: CheckInDraft): CheckInDraft | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || (d.slot !== 'morning' && d.slot !== 'evening')) return null;
  if (!CORE_METRICS.every((k) => isRating(d[k]))) return null;
  const out: CheckInDraft = { date: d.date, slot: d.slot, energy: d.energy, mood: d.mood, soreness: d.soreness, stress: d.stress };
  if (d.slot === 'morning') {
    if (typeof d.sleepHours === 'number' && Number.isFinite(d.sleepHours)) out.sleepHours = Math.round(Math.min(24, Math.max(0, d.sleepHours)) * 2) / 2;
    if (isRating(d.sleepQuality)) out.sleepQuality = d.sleepQuality;
  } else if (isRating(d.sleepiness)) out.sleepiness = d.sleepiness;
  const note = d.note?.trim();
  if (note) out.note = note.slice(0, 500);
  return out;
}

// ---------- готовность ----------

export interface ReadinessPart {
  key: 'energy' | 'mood' | 'soreness' | 'stress' | 'sleepQuality' | 'sleepHours';
  label: string;
  /** Вклад составляющей, 0–100: чем больше, тем лучше для тренировки (для болезненности и стресса шкала уже перевёрнута). */
  value: number;
}
export type ReadinessLevel = 'low' | 'normal' | 'high';
export interface Readiness {
  score: number; // 0–100
  level: ReadinessLevel;
  parts: ReadinessPart[];
}

export const READINESS_TEXT: Record<ReadinessLevel, string> = {
  low: 'Сегодня лучше полегче',
  normal: 'Обычный день',
  high: 'Хороший день для нагрузки'
};

const fromRating = (r: number, invert = false): number => Math.round(((invert ? 5 - r : r - 1) / 4) * 100);
/** Сон: 4 часа и меньше — 0, 8 и больше — 100, между ними линейно. */
const fromSleepHours = (h: number): number => Math.round(Math.min(1, Math.max(0, (h - 4) / 4)) * 100);

/**
 * Готовность по утреннему чек-ину: простое среднее составляющих без весов.
 * Часы и качество сна учитываются, только если заполнены. Уровни: меньше 40 — «полегче», от 70 — «хороший день».
 */
export function readiness(c: Pick<CheckIn, 'energy' | 'mood' | 'soreness' | 'stress' | 'sleepHours' | 'sleepQuality'>): Readiness {
  const parts: ReadinessPart[] = [
    { key: 'energy', label: METRIC_LABEL.energy, value: fromRating(c.energy) },
    { key: 'mood', label: METRIC_LABEL.mood, value: fromRating(c.mood) },
    { key: 'soreness', label: METRIC_LABEL.soreness, value: fromRating(c.soreness, true) },
    { key: 'stress', label: METRIC_LABEL.stress, value: fromRating(c.stress, true) }
  ];
  if (isRating(c.sleepQuality)) parts.push({ key: 'sleepQuality', label: 'Качество сна', value: fromRating(c.sleepQuality) });
  if (typeof c.sleepHours === 'number' && Number.isFinite(c.sleepHours)) parts.push({ key: 'sleepHours', label: 'Длительность сна', value: fromSleepHours(c.sleepHours) });
  const score = Math.round(parts.reduce((a, p) => a + p.value, 0) / parts.length);
  return { score, level: score < 40 ? 'low' : score >= 70 ? 'high' : 'normal', parts };
}

// ---------- утро и вечер ----------

export interface MetricDelta {
  metric: CoreMetric;
  morning: number;
  evening: number;
  /** вечер − утро */
  delta: number;
  /** better — вечером лучше, чем утром (с учётом направления шкалы), worse — хуже, same — без изменений */
  trend: 'better' | 'worse' | 'same';
}

/** Как изменилось состояние за день: сравнивается только общее ядро. Без причинных выводов. */
export function compareDay(morning: CheckIn | null | undefined, evening: CheckIn | null | undefined): MetricDelta[] | null {
  if (!morning || !evening) return null;
  return CORE_METRICS.map((metric) => {
    const delta = evening[metric] - morning[metric];
    const good = LOWER_IS_BETTER[metric] ? -delta : delta;
    return { metric, morning: morning[metric], evening: evening[metric], delta, trend: good > 0 ? 'better' : good < 0 ? 'worse' : 'same' };
  });
}

// ---------- выборки ----------

const alive = (list: CheckIn[]) => list.filter((c) => !c.deletedAt);

export function findCheckIn(list: CheckIn[], date: string, slot: CheckInSlot): CheckIn | null {
  return alive(list).find((c) => c.date === date && c.slot === slot) ?? null;
}

/** Какие слоты за дату уже заполнены. */
export function filledSlots(list: CheckIn[], date: string): Set<CheckInSlot> {
  return new Set(alive(list).filter((c) => c.date === date).map((c) => c.slot));
}

export type SeriesMetric = CoreMetric | 'sleepHours' | 'sleepQuality';
export interface CheckInPoint { date: string; value: number }

/**
 * Ряд значений за последние `days` дней по возрастанию даты. Пропущенные дни в ряд не попадают:
 * пропуск не наказывается и не заполняется нулями. Если за дату есть оба слота, берётся их среднее.
 */
export function checkInSeries(list: CheckIn[], metric: SeriesMetric, days: number, now: Date = new Date(), slot?: CheckInSlot): CheckInPoint[] {
  const from = toDateStr(addDays(now, -(days - 1)));
  const to = toDateStr(now);
  const byDate = new Map<string, number[]>();
  for (const c of alive(list)) {
    if (c.date < from || c.date > to || (slot && c.slot !== slot)) continue;
    const v = c[metric];
    if (typeof v !== 'number') continue;
    const arr = byDate.get(c.date) ?? [];
    arr.push(v);
    byDate.set(c.date, arr);
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, vals]) => ({ date, value: vals.reduce((a, v) => a + v, 0) / vals.length }));
}

/** Среднее значение ряда или null, если точек нет. */
export const seriesAverage = (points: CheckInPoint[]): number | null =>
  points.length ? points.reduce((a, p) => a + p.value, 0) / points.length : null;
