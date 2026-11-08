// Дублирование тренировки и дополнительные форматы экспорта (0.5.1).
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/db';
import { duplicateWorkout } from '../../src/db/repo';
import { bodyToCSV, toCSV, toHevy } from '../../src/db/exporters';
import type { BodyEntry, Exercise, Workout } from '../../src/domain/types';

const workout = (over: Partial<Workout> = {}): Workout => ({
  id: 'w1', date: '2026-10-20', title: 'Жим', status: 'done', createdAt: 1, updatedAt: 1, deviceId: 'd',
  exercises: [{
    id: 'we1', exerciseId: 'bench', note: 'локти',
    sets: [
      { id: 's1', weight: 80, reps: 8, done: true, rpe: 9 },
      { id: 's2', weight: 82.5, reps: 6, done: true, warmup: true }
    ]
  }],
  ...over
});

const bench: Exercise = { id: 'bench', name: 'Жим лёжа', muscle: 'chest', equipment: 'штанга', custom: false, createdAt: 0, updatedAt: 0, deviceId: 'seed' };

beforeEach(async () => {
  await Promise.all([db.workouts.clear(), db.exercises.clear(), db.body.clear(), db.changes.clear()]);
});

describe('дублирование тренировки', () => {
  it('копирует упражнения и подходы как запланированные, с новыми id', async () => {
    await db.workouts.put(workout());
    const copy = await duplicateWorkout('w1', '2026-11-01');
    expect(copy).toBeTruthy();
    expect(copy!.id).not.toBe('w1');
    expect(copy!.date).toBe('2026-11-01');
    expect(copy!.status).toBe('planned');
    expect(copy!.exercises[0].id).not.toBe('we1');
    expect(copy!.exercises[0].note).toBe('локти');
    expect(copy!.exercises[0].sets.map((s) => [s.weight, s.reps, s.done, s.warmup])).toEqual([[80, 8, false, undefined], [82.5, 6, false, true]]);
    expect(copy!.exercises[0].sets[0].rpe).toBeUndefined();
    expect(await db.changes.where('table').equals('workouts').count()).toBe(1);
  });

  it('несуществующая тренировка — null', async () => {
    expect(await duplicateWorkout('nope')).toBeNull();
  });
});

describe('экспорт CSV и Hevy', () => {
  it('CSV: заголовок и строка на каждый подход, корректные кавычки', () => {
    const csv = toCSV([workout({ exercises: [{ id: 'we', exerciseId: 'bench', sets: [{ id: 's', weight: 100, reps: 5, done: true }] }] })], new Map([['bench', { ...bench, name: 'Жим "узкий"' }]]));
    const lines = csv.split('\n');
    expect(lines[0]).toBe('date,exercise,muscle,weight,reps,sets_done,rpe,warmup,work_sec');
    expect(lines[1]).toBe('2026-10-20,"Жим ""узкий""",chest,100,5,1,,0,');
    expect(lines).toHaveLength(2);
  });

  it('Hevy JSON: только выполненные подходы, даты в ISO', () => {
    const j = JSON.parse(toHevy([workout({ startedAt: Date.UTC(2026, 9, 20, 10), finishedAt: Date.UTC(2026, 9, 20, 11) })], new Map([['bench', bench]])));
    expect(j.workouts).toHaveLength(1);
    expect(j.workouts[0].title).toBe('Жим');
    expect(j.workouts[0].start_time).toBe('2026-10-20T10:00:00.000Z');
    expect(j.workouts[0].exercises[0]).toMatchObject({ title: 'Жим лёжа', sets: [{ weight_kg: 80, reps: 8, rpe: 9 }, { weight_kg: 82.5, reps: 6 }] });
  });

  it('Hevy JSON пропускает тренировки без выполненных подходов', () => {
    const planned = workout({ status: 'planned', exercises: [{ id: 'we', exerciseId: 'bench', sets: [{ id: 's', weight: 50, reps: 5, done: false }] }] });
    expect(JSON.parse(toHevy([planned], new Map([['bench', bench]]))).workouts).toHaveLength(0);
  });

  it('Замеры тела: сортировка по дате и пустые поля', () => {
    const rows: BodyEntry[] = [
      { id: 'b2', date: '2026-10-10', waistCm: 80, createdAt: 2, updatedAt: 2, deviceId: 'd' },
      { id: 'b1', date: '2026-10-01', weightKg: 78.4, createdAt: 1, updatedAt: 1, deviceId: 'd' }
    ];
    expect(bodyToCSV(rows)).toBe('date,weight_kg,waist_cm\n2026-10-01,78.4,\n2026-10-10,,80');
  });
});
