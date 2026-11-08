// Прогноз времени тренировки: оставшиеся подходы по их среднему времени плюс отдых между ними.
// Чистая функция: настройки и история приходят параметрами.

import { exerciseTimeStats, averageSetSec } from './setTiming';
import { groupInfo, restAfter } from './superset';
import type { Workout, WorkoutExercise } from './types';

/** Время подхода, пока ничего не измерено. */
export const DEFAULT_SET_SEC = 40;

export interface Forecast {
  sec: number;
  /** Хотя бы для части подходов использовано измеренное время; иначе оценка грубая. */
  measured: boolean;
}

/**
 * skip: упражнения без подходов по времени (кардио). Выполненные подходы не считаются:
 * в идущей тренировке это остаток, в плановой — вся тренировка. Нет оставшихся подходов — null.
 */
export function forecastSec(
  exercises: WorkoutExercise[], history: Workout[], restSec: number, skip: (we: WorkoutExercise) => boolean = () => false,
  restFor?: (we: WorkoutExercise) => number // отдых конкретного упражнения; без него для всех restSec
): Forecast | null {
  const perEx = new Map(exerciseTimeStats(history).map((x) => [x.exerciseId, x.avgSetSec]));
  const overall = averageSetSec(history)?.avgSec;
  const info = groupInfo(exercises);
  let work = 0, rest = 0, lastRest = 0, n = 0, measured = false;
  exercises.forEach((we, i) => {
    if (skip(we)) return;
    const own = perEx.get(we.exerciseId);
    const per = own ?? overall ?? DEFAULT_SET_SEC;
    we.sets.forEach((s, j) => {
      if (s.done) return;
      work += per; n++;
      if (own !== undefined || overall !== undefined) measured = true;
      lastRest = restAfter({ superset: info[i], nextSetKind: we.sets[j + 1]?.kind, restSec: restFor ? restFor(we) : restSec }) ?? 0;
      rest += lastRest;
    });
  });
  if (n === 0) return null;
  return { sec: work + rest - lastRest, measured }; // после самого последнего подхода отдыхать не нужно
}

/** «около 65 мин» округляем до пяти минут: точность в секундах тут была бы ложной. */
export function formatForecast(sec: number): string {
  const min = Math.max(5, Math.round(sec / 300) * 5);
  if (min < 60) return `${min} мин`;
  return `${Math.floor(min / 60)} ч ${String(min % 60).padStart(2, '0')} мин`;
}
