import type { BodyEntry, Exercise, Workout } from '../domain/types';
import { workSecCell } from '../domain/exportData';

export function toCSV(workouts: Workout[], exMap: Map<string, Exercise>): string {
  const rows = ['date,exercise,muscle,weight,reps,sets_done,rpe,warmup,work_sec'];
  for (const w of workouts) {
    for (const we of w.exercises) {
      const ex = exMap.get(we.exerciseId);
      if (!ex) continue;
      for (const s of we.sets) {
        rows.push([w.date, `"${ex.name.replace(/"/g, '""')}"`, ex.muscle, s.weight, s.reps, s.done ? 1 : 0, s.rpe ?? '', s.warmup ? 1 : 0, workSecCell(s.workSec)].join(','));
      }
    }
  }
  return rows.join('\n');
}

export function toHevy(workouts: Workout[], exMap: Map<string, Exercise>): string {
  const out: any = { version: 1, workouts: [] as any[] };
  for (const w of workouts) {
    const exercises = [];
    for (const we of w.exercises) {
      const ex = exMap.get(we.exerciseId);
      if (!ex) continue;
      const sets = we.sets.filter(s => s.done).map(s => ({ weight_kg: s.weight, reps: s.reps, rpe: s.rpe, notes: s.note }));
      if (sets.length) exercises.push({ title: ex.name, notes: we.note, sets });
    }
    if (exercises.length) out.workouts.push({ title: w.title, start_time: new Date(w.startedAt ?? w.createdAt).toISOString(), end_time: w.finishedAt ? new Date(w.finishedAt).toISOString() : null, exercises });
  }
  return JSON.stringify(out, null, 2);
}

export function bodyToCSV(body: BodyEntry[]): string {
  const rows = ['date,weight_kg,waist_cm'];
  for (const b of body.sort((a,b)=>a.date.localeCompare(b.date))) rows.push([b.date, b.weightKg ?? '', b.waistCm ?? ''].join(','));
  return rows.join('\n');
}
