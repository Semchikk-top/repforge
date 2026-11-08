// Недельный разбор: карточка раз в неделю про прошлую полную неделю (пн–вс). Только правила и арифметика на устройстве,
// без языковой модели и без отправки данных наружу. Текст предложений короткий, без диагнозов и без давления.

import { addDays, parseDate, toDateStr } from '../lib';
import { dailyStats, detectPlateaus, doneSets, e1rm, finished, muscleLoad, type MuscleLoad } from './analytics';
import { HIGH_LOAD_RATIO, reliableLoadRatio } from './autoregulation';
import { readiness } from './checkin';
import { MUSCLE_LABELS, type CheckIn, type Exercise, type Workout } from './types';

/** `days` — тренировочные дни (несколько тренировок за день считаются одним), `sessions` — фактическое число тренировок. */
export interface WeekTotals { days: number; sessions: number; sets: number; volume: number }
export interface Growth { exerciseId: string; name: string; before: number; after: number; pct: number }
export interface Plateau { exerciseId: string; name: string; sessions: number }

export interface WeeklyReview {
  /** Понедельник и воскресенье разбираемой недели. */
  weekStart: string;
  weekEnd: string;
  totals: WeekTotals;
  previous: WeekTotals;
  /** До трёх упражнений, где расчётный максимум за неделю заметно выше прежнего лучшего. */
  growth: Growth[];
  /** До двух упражнений недели, где вес давно не растёт. */
  plateaus: Plateau[];
  /** Доли по группам мышц за неделю (по подходам) и отличие от собственного среднего за 8 недель. */
  load: MuscleLoad[];
  /** Группы, которых на неделе заметно меньше обычного. */
  gaps: MuscleLoad[];
  /** Среднее по утренним чек-инам недели, если их было хотя бы два. */
  readiness: { avg: number; days: number } | null;
  /** Отношение объёма разбираемой недели к привычному недельному (за 4 недели до неё); null, если истории мало. */
  loadRatio: number | null;
  /** Одно-два предложения на следующую неделю. */
  suggestions: string[];
}

/** Порог «заметно меньше обычного»: группа обычно занимает не меньше 8% и на неделе просела минимум на 8 п. п. */
export const GAP_MIN_BASELINE = 8;
export const GAP_MIN_DELTA = -8;
const GROWTH_MIN = 0.01; // рост расчётного максимума от 1%

/** Прошлая полная неделя относительно даты: понедельник и воскресенье. */
export function previousWeek(now: Date): { start: string; end: string } {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const monday = addDays(d, -((d.getDay() + 6) % 7));
  return { start: toDateStr(addDays(monday, -7)), end: toDateStr(addDays(monday, -1)) };
}

const totalsIn = (ws: Workout[], from: string, to: string): WeekTotals => {
  const days = dailyStats(ws).filter((d) => d.date >= from && d.date <= to);
  return { days: days.length, sessions: days.reduce((a, d) => a + d.sessions, 0), sets: days.reduce((a, d) => a + d.sets, 0), volume: days.reduce((a, d) => a + d.volumeKg, 0) };
};

function bestE1rm(ws: Workout[], from: string | null, to: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of ws) {
    if ((from && w.date < from) || w.date > to) continue;
    for (const { exerciseId, set } of doneSets(w)) m.set(exerciseId, Math.max(m.get(exerciseId) ?? 0, e1rm(set.weight, set.reps)));
  }
  return m;
}

export function weeklyReview(all: Workout[], exMap: Map<string, Exercise>, checkins: CheckIn[], now: Date = new Date()): WeeklyReview {
  const { start, end } = previousWeek(now);
  const prevStart = toDateStr(addDays(parseDate(start), -7));
  const prevEnd = toDateStr(addDays(parseDate(start), -1));
  const history = finished(all).filter((w) => w.date <= end);
  const name = (id: string) => exMap.get(id)?.name ?? 'упражнение';

  const totals = totalsIn(history, start, end);
  const previous = totalsIn(history, prevStart, prevEnd);

  // рост: лучший расчётный максимум недели против лучшего до неё
  const week = bestE1rm(history, start, end);
  const before = bestE1rm(history, null, toDateStr(addDays(parseDate(start), -1)));
  const growth: Growth[] = [...week.entries()]
    .flatMap(([exerciseId, after]) => { const b = before.get(exerciseId); return b && after >= b * (1 + GROWTH_MIN) ? [{ exerciseId, name: name(exerciseId), before: Math.round(b * 10) / 10, after: Math.round(after * 10) / 10, pct: (after - b) / b }] : []; })
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 3);

  const plateaus: Plateau[] = detectPlateaus(history)
    .filter((p) => week.has(p.exerciseId) && !growth.some((g) => g.exerciseId === p.exerciseId))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 2)
    .map((p) => ({ exerciseId: p.exerciseId, name: name(p.exerciseId), sessions: p.sessions }));

  const load = muscleLoad(history, exMap, { days: 7, metric: 'sets', now: parseDate(end) });
  const gaps = totals.days > 0 ? load.filter((m) => m.baselineShare >= GAP_MIN_BASELINE && m.delta <= GAP_MIN_DELTA).sort((a, b) => a.delta - b.delta) : [];

  const mornings = checkins.filter((c) => !c.deletedAt && c.slot === 'morning' && c.date >= start && c.date <= end);
  const ready = mornings.length >= 2 ? { avg: Math.round(mornings.reduce((a, c) => a + readiness(c).score, 0) / mornings.length), days: mornings.length } : null;

  const ratio = reliableLoadRatio(history, parseDate(end));

  const suggestions: string[] = [];
  if (ratio !== null && ratio >= HIGH_LOAD_RATIO) suggestions.push(`Нагрузка была ${(Math.round(ratio * 10) / 10).toFixed(1).replace('.', ',')}× обычной. На следующей неделе вернись к привычному объёму или добавь день отдыха.`);
  if (plateaus[0]) suggestions.push(`«${plateaus[0].name}»: вес давно не растёт. Попробуй добавить по повторению в каждом подходе или заменить упражнение на похожее.`);
  if (gaps[0]) suggestions.push(`${MUSCLE_LABELS[gaps[0].muscle]}: на неделе заметно меньше обычного (${gaps[0].delta} п. п.). Добавь 2–3 подхода на эту группу на следующей неделе.`);
  if (ready && ready.avg < 40) suggestions.push('Самочувствие на неделе было ниже обычного. Оставь запас в последних подходах и не гонись за рекордами.');
  if (suggestions.length === 0 && totals.days < previous.days) suggestions.push('Тренировок меньше, чем неделей раньше. Выбери на следующую неделю дни заранее.');
  if (suggestions.length === 0 && growth.length > 0) suggestions.push('Хорошая неделя. Продолжай в том же ритме.');

  return { weekStart: start, weekEnd: end, totals, previous, growth, plateaus, load, gaps, readiness: ready, loadRatio: ratio, suggestions: suggestions.slice(0, 2) };
}

/** Показывать ли карточку: функция включена, на неделе были тренировки и эту неделю ещё не закрывали. Пустую неделю не разбираем. */
export function shouldShowWeeklyReview(opts: { enabled: boolean; review: WeeklyReview; seenWeek: string | null }): boolean {
  return opts.enabled && opts.review.totals.days > 0 && opts.seenWeek !== opts.review.weekStart;
}

/** Текст для ассистента: пользователь видит его в поле ввода и отправляет сам. Только то, что показано в карточке. */
export function reviewPrompt(r: WeeklyReview): string {
  const lines = [
    `Разбери мою прошлую неделю тренировок (${r.weekStart} — ${r.weekEnd}).`,
    `Тренировочных дней: ${r.totals.days} (неделей раньше ${r.previous.days}), подходов: ${r.totals.sets}, тоннаж: ${Math.round(r.totals.volume)} кг.`
  ];
  if (r.growth.length) lines.push('Рост: ' + r.growth.map((g) => `${g.name} ${g.before}→${g.after}`).join('; ') + '.');
  if (r.plateaus.length) lines.push('Застой: ' + r.plateaus.map((p) => p.name).join(', ') + '.');
  if (r.loadRatio !== null && r.loadRatio >= HIGH_LOAD_RATIO) lines.push(`Нагрузка была ${(Math.round(r.loadRatio * 10) / 10).toFixed(1).replace('.', ',')}× обычной.`);
  if (r.gaps.length) lines.push('Просело: ' + r.gaps.map((g) => `${MUSCLE_LABELS[g.muscle]} ${g.delta} п. п.`).join(', ') + '.');
  lines.push('Что поменять на следующей неделе?');
  return lines.join('\n');
}
