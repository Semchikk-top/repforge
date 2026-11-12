import { finished } from './analytics';
import type { Why } from './explain';
import type { Workout } from './types';

export type SuggestionKind = 'add-reps' | 'add-weight' | 'hold' | 'deload' | 'comeback';
export interface Suggestion { weight: number; reps: number; reason: string; kind: SuggestionKind }

const TOP_REPS = 12;        // верх диапазона 8–12: достигнут во всех подходах — прибавляем вес
const RESET_REPS = 8;       // с новым весом начинаем с нижней границы
const COMEBACK_DAYS = 21;   // после такого перерыва начинаем мягче
const round = (n: number) => Math.round(n * 100) / 100;
const toStep = (w: number, step: number) => round(step > 0 ? Math.round(w / step) * step : w);

interface Session { date: string; work: number; minReps: number; avgRpe: number | null }

// Итоги каждой завершённой тренировки по упражнению. Дроп-сеты и rest-pause идут «на отказ» и исказили бы рабочий вес и повторы.
function sessionsOf(history: Workout[], exerciseId: string, excludeId?: string): Session[] {
  const out: Session[] = [];
  for (const w of finished(history)) {
    if (w.id === excludeId) continue;
    const we = w.exercises.find((x) => x.exerciseId === exerciseId);
    const sets = (we?.sets ?? []).filter((s) => s.done && s.reps > 0 && (!s.kind || s.kind === 'normal') && !s.warmup);
    if (!sets.length) continue;
    const work = Math.max(...sets.map((s) => s.weight));
    const top = sets.filter((s) => s.weight === work);
    const rpes = top.map((s) => s.rpe).filter((r): r is number => typeof r === 'number' && r >= 1 && r <= 10);
    out.push({ date: w.date, work, minReps: Math.min(...top.map((s) => s.reps)), avgRpe: rpes.length ? rpes.reduce((a, b) => a + b, 0) / rpes.length : null });
  }
  return out;
}

const daysBetween = (a: string, b: Date) => Math.floor((b.getTime() - new Date(a + 'T00:00:00').getTime()) / 86400000);

interface Decision { suggestion: Suggestion; why: Why }

function decide(history: Workout[], exerciseId: string, step: number, excludeId?: string, today?: Date): Decision | null {
  const sessions = sessionsOf(history, exerciseId, excludeId);
  const last = sessions[sessions.length - 1];
  if (!last || !Number.isFinite(last.minReps) || last.minReps <= 0) return null;
  const { work, minReps, avgRpe } = last;

  if (today && work > 0) {
    const gap = daysBetween(last.date, today);
    if (gap > COMEBACK_DAYS) {
      const weight = toStep(work * 0.9, step);
      return { suggestion: { weight, reps: minReps, kind: 'comeback', reason: `Перерыв ${Math.round(gap / 7)} нед.: начни с ~90% веса и вернись к рабочему за одну-две тренировки` }, why: { code: 'next-comeback', weeks: Math.round(gap / 7), weight } };
    }
  }

  const [s2, s1] = [sessions[sessions.length - 3], sessions[sessions.length - 2]];
  if (work > 0 && s1 && s2 && s1.work === work && s2.work === work && minReps < s1.minReps && s1.minReps < s2.minReps) {
    const weight = toStep(work * 0.9, step);
    return { suggestion: { weight, reps: s2.minReps, kind: 'deload', reason: 'Повторы падают две тренировки подряд при том же весе: возьми разгрузку, −10% веса' }, why: { code: 'next-deload', weight: work, reps: s2.minReps } };
  }

  if (avgRpe !== null && avgRpe >= 9.5) {
    return { suggestion: { weight: work, reps: minReps, kind: 'hold', reason: 'Прошлый раз было на пределе (RPE 9,5+): повтори тот же результат, не прибавляй' }, why: { code: 'next-hold-rpe', rpe: avgRpe } };
  }

  const easy = avgRpe !== null && avgRpe <= 7;
  if (work > 0 && minReps >= TOP_REPS) {
    return easy
      ? { suggestion: { weight: round(work + 2 * step), reps: RESET_REPS, kind: 'add-weight', reason: `Было легко (RPE ${round(avgRpe!)}) и ${minReps}+ повторений: можно прибавить сразу два шага` }, why: { code: 'next-add-weight', reps: minReps, steps: 2, rpe: avgRpe } }
      : { suggestion: { weight: round(work + step), reps: RESET_REPS, kind: 'add-weight', reason: `Во всех подходах было ${minReps}+ повторений: пора прибавить вес` }, why: { code: 'next-add-weight', reps: minReps, steps: 1, rpe: avgRpe } };
  }
  if (easy && work > 0 && minReps + 2 <= TOP_REPS) return { suggestion: { weight: work, reps: minReps + 2, kind: 'add-reps', reason: `Было легко (RPE ${round(avgRpe!)}): добавь два повтора` }, why: { code: 'next-add-reps', add: 2, rpe: avgRpe } };
  return { suggestion: { weight: work, reps: minReps + 1, kind: 'add-reps', reason: 'Добавь один повтор к прошлому разу' }, why: { code: 'next-add-reps', add: 1, rpe: avgRpe } };
}

/** Подсказка по прошлым тренировкам: двойная прогрессия с поправкой на RPE, перерыв и усталость. Это идея, а не требование.
 *  today нужен только для правила «после перерыва»: без него оно не применяется. */
export function suggestNext(history: Workout[], exerciseId: string, step: number, excludeId?: string, today?: Date): Suggestion | null {
  return decide(history, exerciseId, step, excludeId, today)?.suggestion ?? null;
}

/** Почему предложено именно это: причина из того же вычисления, что и сама подсказка (слой «факт»). */
export function explainNext(history: Workout[], exerciseId: string, step: number, excludeId?: string, today?: Date): Why | null {
  return decide(history, exerciseId, step, excludeId, today)?.why ?? null;
}
