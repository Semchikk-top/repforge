import { db } from '../db/db';
import { newWorkout, putExercise } from '../db/repo';
import { lastPerformance } from '../domain/analytics';
import { makeSet } from '../domain/ops';
import type { WorkoutExercise } from '../domain/types';
import { uid } from '../lib';
import type { Proposal } from './api';

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').trim();
const words = (s: string) => norm(s).split(/\s+/).filter(Boolean);

// Превращает предложение ассистента в запланированную тренировку.
// Упражнения ищем в справочнике по названию; неизвестные создаём как свои.
export async function createWorkoutFromProposal(p: Proposal): Promise<string> {
  const [all, history] = await Promise.all([db.exercises.toArray(), db.workouts.toArray()]);
  const live = all.filter((e) => !e.deletedAt);
  const exercises: WorkoutExercise[] = [];

  for (const pe of p.exercises) {
    const n = norm(pe.name);
    const ws = words(pe.name);
    let ex = live.find((e) => norm(e.name) === n) ?? live.find((e) => ws.every((w) => norm(e.name).includes(w)));
    if (!ex) {
      const now = Date.now();
      ex = await putExercise({
        id: uid(), createdAt: now, name: pe.name, muscle: pe.muscle ?? 'core', equipment: 'Свой вес', custom: true
      });
      live.push(ex);
    }
    const last = lastPerformance(history, ex.id);
    const weight = pe.weight ?? last?.sets[last.sets.length - 1]?.weight ?? 0;
    exercises.push({ id: uid(), exerciseId: ex.id, sets: Array.from({ length: pe.sets }, () => makeSet(weight, pe.reps)) });
  }

  const w = await newWorkout({ date: p.date, title: p.title, status: 'planned', exercises });
  return w.id;
}
