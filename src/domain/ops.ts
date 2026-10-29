import { isCardio, type Exercise, type SetEntry, type Template, type Workout, type WorkoutExercise } from './types';
import { uid } from '../lib';
import { lastPerformance } from './analytics';

export const makeSet = (weight = 0, reps = 10): SetEntry => ({ id: uid(), weight, reps, done: false });

// Новое упражнение в тренировке: подставляем прошлый результат, если он есть
export function makeWorkoutExercise(exerciseId: string, history: Workout[], excludeId?: string, exercise?: Exercise): WorkoutExercise {
  if (isCardio(exercise)) return { id: uid(), exerciseId, sets: [] }; // у кардио вместо подходов дистанция и время
  const last = lastPerformance(history, exerciseId, excludeId);
  const sets = last
    ? last.sets.map((s) => makeSet(s.weight, s.reps))
    : [makeSet(0, 10), makeSet(0, 10), makeSet(0, 10)];
  return { id: uid(), exerciseId, sets };
}

export function exercisesFromTemplate(t: Template, history: Workout[], exMap: Map<string, Exercise>): WorkoutExercise[] {
  return t.exercises
    .filter((te) => exMap.has(te.exerciseId) && !exMap.get(te.exerciseId)!.deletedAt)
    .map((te) => {
      if (isCardio(exMap.get(te.exerciseId))) return { id: uid(), exerciseId: te.exerciseId, sets: [], group: te.group };
      const last = lastPerformance(history, te.exerciseId);
      const w = last ? last.sets[last.sets.length - 1].weight : te.weight;
      return {
        id: uid(),
        exerciseId: te.exerciseId,
        group: te.group,
        sets: Array.from({ length: te.sets }, () => makeSet(w, te.reps))
      };
    });
}
