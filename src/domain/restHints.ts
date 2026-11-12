// Подсказки по отдыху. Чистая логика: история приходит параметром, ничего не меняется само.
//  - «В прошлый раз отдыхал 2:10»: средний отдых этого упражнения в последней завершённой тренировке;
//  - предложение изменить отдых упражнения: только когда несколько тренировок подряд он стабильно
//    короче или длиннее настроенного. Решает человек: функция ничего не записывает.
// Учитывается только одно и то же упражнение (exerciseId) и только отдых, измеренный по таймеру.

import type { Why } from './explain';
import { finished } from './analytics';
import { restSamplesOf } from './setTiming';
import { REST_MAX_SEC, REST_MIN_SEC } from './rest';
import type { ID, Workout } from './types';

/** Сколько последних тренировок должны согласиться, чтобы появилось предложение. На первых тренировках его нет. */
export const SUGGEST_MIN_WORKOUTS = 3;
/** Отклонение, меньше которого предлагать нечего: и по секундам, и по доле от настроенного отдыха. */
export const SUGGEST_MIN_DIFF_SEC = 20;
export const SUGGEST_MIN_DIFF_RATIO = 0.2;
const STEP_SEC = 15;

export interface WorkoutRest { workoutId: ID; date: string; finishedAt: number; avgSec: number; samples: number }

/** Средний отдых упражнения по завершённым тренировкам, от старых к новым. Тренировки без измеренного отдыха пропускаются. */
export function restByWorkout(all: Workout[], exerciseId: ID, excludeWorkoutId?: ID): WorkoutRest[] {
  const out: WorkoutRest[] = [];
  for (const w of finished(all)) {
    if (w.id === excludeWorkoutId) continue;
    const samples: number[] = [];
    for (const we of w.exercises) if (we.exerciseId === exerciseId) samples.push(...restSamplesOf(we));
    if (!samples.length) continue;
    out.push({ workoutId: w.id, date: w.date, finishedAt: w.finishedAt ?? 0, avgSec: samples.reduce((a, x) => a + x, 0) / samples.length, samples: samples.length });
  }
  // finished() сортирует по дате; в один день порядок задаёт время завершения
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.finishedAt - b.finishedAt);
}

/** Отдых в последней тренировке, где он измерен; null, если истории нет. */
export function lastRest(all: Workout[], exerciseId: ID, excludeWorkoutId?: ID): WorkoutRest | null {
  const xs = restByWorkout(all, exerciseId, excludeWorkoutId);
  return xs.length ? xs[xs.length - 1] : null;
}

export interface RestSuggestion {
  sec: number;                      // предлагаемый отдых, кратный 15 с
  direction: 'longer' | 'shorter';  // относительно текущего
  currentSec: number;
  avgsSec: number[];                // средний отдых в тех тренировках, на которых основано предложение
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Предложить новый отдых для упражнения или null.
 * dismissedAfter — момент, когда предложение отклонили: в расчёт идут только более поздние тренировки,
 * поэтому после «Не сейчас» оно вернётся не раньше, чем накопится ещё SUGGEST_MIN_WORKOUTS тренировок.
 */
export function suggestRestChange(
  all: Workout[], exerciseId: ID, currentSec: number, opts: { excludeWorkoutId?: ID; dismissedAfter?: number } = {}
): RestSuggestion | null {
  if (!Number.isFinite(currentSec) || currentSec <= 0) return null;
  const after = opts.dismissedAfter ?? 0;
  const recent = restByWorkout(all, exerciseId, opts.excludeWorkoutId).filter((x) => x.finishedAt > after).slice(-SUGGEST_MIN_WORKOUTS);
  if (recent.length < SUGGEST_MIN_WORKOUTS) return null;
  const threshold = Math.max(SUGGEST_MIN_DIFF_SEC, currentSec * SUGGEST_MIN_DIFF_RATIO);
  const diffs = recent.map((x) => x.avgSec - currentSec);
  const longer = diffs.every((d) => d >= threshold);
  const shorter = diffs.every((d) => d <= -threshold);
  if (!longer && !shorter) return null; // то длиннее, то короче: это случайность, а не привычка
  const avgs = recent.map((x) => x.avgSec);
  const sec = Math.min(REST_MAX_SEC, Math.max(REST_MIN_SEC, Math.round(median(avgs) / STEP_SEC) * STEP_SEC));
  if (Math.abs(sec - currentSec) < STEP_SEC) return null;
  return { sec, direction: sec > currentSec ? 'longer' : 'shorter', currentSec, avgsSec: avgs.map((x) => Math.round(x)) };
}

/** Почему предложен другой отдых (слой «факт»). */
export function explainRestSuggestion(s: RestSuggestion): Why {
  const avg = s.avgsSec.reduce((a, x) => a + x, 0) / s.avgsSec.length;
  return { code: 'rest-suggest', direction: s.direction, currentSec: s.currentSec, avgSec: avg, workouts: s.avgsSec.length, sec: s.sec };
}

/** Ключ в kv, где хранится время отказа от предложения (только на этом устройстве). */
export const restDismissKey = (exerciseId: ID): string => `rest.dismiss.${exerciseId}`;
