// Замена упражнения внутри текущей тренировки. Чистая функция: возвращает новую тренировку и не трогает вход.
// Выполненные подходы остаются у исходного упражнения (его история не меняется), в замену уходят только оставшиеся.

import { lastPerformance } from './analytics';
import { makeSet } from './ops';
import { isCardio, type Exercise, type Workout, type WorkoutExercise } from './types';
import { uid } from '../lib';

export type SwapResult =
  | { ok: true; workout: Workout; mode: 'replaced' | 'split'; moved: number }
  | { ok: false; reason: 'not-found' | 'cardio' | 'same' | 'nothing-left' };

/** Что останется делать после замены: невыполненные рабочие подходы. Разминка исходного упражнения в замену не переносится. */
const remaining = (we: WorkoutExercise) => we.sets.filter((s) => !s.done && !s.warmup);

/**
 * Заменяет упражнение `weId` на `next`:
 * - если ни один подход ещё не выполнен, упражнение подменяется на месте;
 * - если часть подходов выполнена, они остаются у исходного упражнения, а невыполненные уходят в новую запись сразу после него.
 * Вес подставляется из последнего результата по новому упражнению, иначе 0: вес другого упражнения сюда не подходит.
 * Число повторов в подходах сохраняется. Кардио не заменяется.
 */
export function swapExercise(workout: Workout, weId: string, next: Exercise, history: Workout[], exMap: Map<string, Exercise>): SwapResult {
  const idx = workout.exercises.findIndex((x) => x.id === weId);
  if (idx < 0) return { ok: false, reason: 'not-found' };
  const we = workout.exercises[idx];
  if (isCardio(next) || isCardio(exMap.get(we.exerciseId)) || we.cardio) return { ok: false, reason: 'cardio' };
  if (we.exerciseId === next.id) return { ok: false, reason: 'same' };
  const todo = remaining(we);
  if (todo.length === 0) return { ok: false, reason: 'nothing-left' };

  const last = lastPerformance(history, next.id, workout.id);
  const weight = last ? last.sets[last.sets.length - 1].weight : 0;
  const sets = todo.map((s) => makeSet(weight, s.reps));

  const hasDone = we.sets.some((s) => s.done);
  const exercises = [...workout.exercises];
  if (!hasDone) {
    // ни одного выполненного подхода: подменяем на месте, id записи и суперсет сохраняются; разминка исходного уходит вместе с ним
    exercises[idx] = { ...we, exerciseId: next.id, sets, note: undefined };
    return { ok: true, workout: { ...workout, exercises }, mode: 'replaced', moved: sets.length };
  }
  // часть выполнена: у исходного остаётся то, что уже сделано, остальное переезжает
  exercises[idx] = { ...we, sets: we.sets.filter((s) => s.done) };
  exercises.splice(idx + 1, 0, { id: uid(), exerciseId: next.id, sets, group: we.group });
  return { ok: true, workout: { ...workout, exercises }, mode: 'split', moved: sets.length };
}
