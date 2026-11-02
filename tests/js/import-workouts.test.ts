import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildImportPlan, guessMuscle, importedExerciseId, parseCsv, parseDateTime, parseDuration, parseWorkoutImport, suggestResolutions, toKg,
  workoutFingerprint, type Resolution
} from '../../src/domain/importWorkouts';
import type { Exercise, Workout } from '../../src/domain/types';
import { SEED_EXERCISES } from '../../src/domain/seed';
import { db } from '../../src/db/db';
import { applyImportPlan, duplicateWorkout } from '../../src/db/repo';

const HEVY_HEADER = 'title,start_time,end_time,description,exercise_title,superset_id,exercise_notes,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe';
const HEVY = [
  HEVY_HEADER,
  '"Push день","15 Jan 2024, 10:30","15 Jan 2024, 11:35","Хорошо пошло","Bench Press (Barbell)",,"",0,warmup,40,10,,,',
  '"Push день","15 Jan 2024, 10:30","15 Jan 2024, 11:35","Хорошо пошло","Bench Press (Barbell)",,"",1,normal,80,5,,,8',
  '"Push день","15 Jan 2024, 10:30","15 Jan 2024, 11:35","Хорошо пошло","Bench Press (Barbell)",,"",2,normal,80,5,,,9.5',
  '"Push день","15 Jan 2024, 10:30","15 Jan 2024, 11:35","Хорошо пошло","Lateral Raise (Dumbbell)",1,"",0,normal,10,12,,,',
  '"Push день","15 Jan 2024, 10:30","15 Jan 2024, 11:35","Хорошо пошло","Triceps Pushdown (Cable)",1,"",0,dropset,30,15,,,',
  '"Push день","15 Jan 2024, 10:30","15 Jan 2024, 11:35","Хорошо пошло","Plank",,"",0,normal,,,,60,',
  '"Push день","15 Jan 2024, 10:30","15 Jan 2024, 11:35","Хорошо пошло","Treadmill",,"",0,normal,,,2.5,900,',
  '"Ноги","17 Jan 2024, 18:00","17 Jan 2024, 19:00","","Squat (Barbell)",,"",0,normal,100,5,,,',
  '"Ноги","17 Jan 2024, 18:00","17 Jan 2024, 19:00","","Squat (Barbell)",,"",1,normal,100,5,,,'
].join('\r\n');

const STRONG_HEADER = 'Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE';
const STRONG = [
  STRONG_HEADER,
  '2024-01-15 10:30:00,Push,1h 5m,Bench Press (Barbell),W,40,10,0,0,,,',
  '2024-01-15 10:30:00,Push,1h 5m,Bench Press (Barbell),1,135,5,0,0,"тяжело, но ок",,8',
  '2024-01-15 10:30:00,Push,1h 5m,Bench Press (Barbell),2,135,5,0,0,,,',
  '2024-01-15 10:30:00,Push,1h 5m,Bench Press (Barbell),Rest Timer,0,0,0,90,,,',
  '2024-01-15 10:30:00,Push,1h 5m,Overhead Press (Barbell),D,95,6,0,0,,,',
  '2024-01-17 18:00:00,Legs,45m,Squat (Barbell),1,225,5,0,0,,,'
].join('\n');

const seedMap = (): Exercise[] => SEED_EXERCISES.map((e) => ({ ...e, createdAt: 0, updatedAt: 0, deviceId: 'seed', custom: false }));
const idOfSeed = (name: string) => SEED_EXERCISES.find((e) => e.name === name)!.id;

describe('CSV', () => {
  it('кавычки, запятые и переносы внутри ячеек, BOM, CRLF', () => {
    const rows = parseCsv('\uFEFFa,b,c\r\n"x, y","он сказал ""да""","1\n2"\r\n\r\n');
    expect(rows).toEqual([['a', 'b', 'c'], ['x, y', 'он сказал "да"', '1\n2']]);
  });
  it('разделитель «;» и табуляция определяются сами', () => {
    expect(parseCsv('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('даты и длительность', () => {
  it('понимает обе записи даты и не двигает часовой пояс', () => {
    expect(parseDateTime('2024-01-15 10:30:00')!.date).toBe('2024-01-15');
    expect(parseDateTime('15 Jan 2024, 10:30')!.date).toBe('2024-01-15');
    expect(parseDateTime('2024-01-15T23:59:00Z')!.date).toBe('2024-01-15');
    expect(new Date(parseDateTime('15 Jan 2024, 10:30')!.ms).getHours()).toBe(10);
    expect(parseDateTime('31 Feb 2024, 10:30')).toBeNull();
    expect(parseDateTime('вчера')).toBeNull();
  });
  it('длительность в разных записях', () => {
    expect(parseDuration('1h 5m')).toBe(3900);
    expect(parseDuration('45m')).toBe(2700);
    expect(parseDuration('1h')).toBe(3600);
    expect(parseDuration('1:05:00')).toBe(3900);
    expect(parseDuration('3900')).toBe(3900);
    expect(parseDuration('')).toBeNull();
  });
});

describe('Hevy', () => {
  const r = parseWorkoutImport(HEVY);
  it('формат и единица определяются по заголовку', () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.format).toBe('hevy');
    expect(r.data.detectedUnit).toBe('kg');
    expect(r.data.workouts.map((w) => [w.date, w.title])).toEqual([['2024-01-15', 'Push день'], ['2024-01-17', 'Ноги']]);
  });
  it('подходы: разминка, дроп-сет, RPE; время и дистанция не переносятся, но считаются', () => {
    if (!r.ok) throw new Error();
    const push = r.data.workouts[0];
    const bench = push.exercises.find((e) => e.name === 'Bench Press (Barbell)')!;
    expect(bench.sets.map((s) => [s.weight, s.reps, s.warmup, s.rpe])).toEqual([[40, 10, true, undefined], [80, 5, false, 8], [80, 5, false, 9.5]]);
    expect(push.exercises.find((e) => e.name === 'Triceps Pushdown (Cable)')!.sets[0].kind).toBe('drop');
    expect(push.exercises.map((e) => e.name)).not.toContain('Plank');
    expect(push.exercises.map((e) => e.name)).not.toContain('Treadmill');
    expect(r.data.skippedSets).toBe(2);
  });
  it('длительность берётся из времени окончания, заметка тренировки сохраняется', () => {
    if (!r.ok) throw new Error();
    const w = r.data.workouts[0];
    expect((w.finishedAt! - w.startedAt!) / 60000).toBe(65);
    expect(w.note).toBe('Хорошо пошло');
  });
  it('килограммы в файле с фунтами не путаются: заголовок weight_lbs', () => {
    const lbs = parseWorkoutImport(HEVY_HEADER.replace('weight_kg', 'weight_lbs') + '\n"T","15 Jan 2024, 10:30","","","Squat (Barbell)",,"",0,normal,225,5,,,');
    expect(lbs.ok && lbs.data.detectedUnit).toBe('lb');
  });
});

describe('Strong', () => {
  const r = parseWorkoutImport(STRONG);
  it('формат определён, единицы в заголовке нет: нужно спросить', () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.format).toBe('strong');
    expect(r.data.detectedUnit).toBeNull();
  });
  it('W — разминка, D — дроп-сет, строки таймера отдыха пропускаются молча, заметка к подходу сохраняется', () => {
    if (!r.ok) throw new Error();
    const push = r.data.workouts[0];
    const bench = push.exercises[0];
    expect(bench.sets).toHaveLength(3);
    expect(bench.sets[0].warmup).toBe(true);
    expect(bench.sets[1]).toMatchObject({ weight: 135, reps: 5, rpe: 8, note: 'тяжело, но ок' });
    expect(push.exercises[1].sets[0].kind).toBe('drop');
    expect(r.data.badRows).toBe(0);
    expect(r.data.skippedSets).toBe(0);
  });
  it('длительность из колонки Duration', () => {
    if (!r.ok) throw new Error();
    const w = r.data.workouts[0];
    expect((w.finishedAt! - w.startedAt!) / 60000).toBe(65);
  });
  it('заголовок с единицей и «;» тоже читается', () => {
    const f = 'Date;Workout Name;Duration;Exercise Name;Set Order;Weight (lbs);Reps\n2024-01-15 10:30:00;Push;45m;Bench Press (Barbell);1;135;5';
    const x = parseWorkoutImport(f);
    expect(x.ok && x.data.detectedUnit).toBe('lb');
  });
});

describe('отказы', () => {
  it('неизвестный формат, пустой файл, файл без подходов', () => {
    expect(parseWorkoutImport('a,b\n1,2')).toMatchObject({ ok: false });
    expect(parseWorkoutImport('')).toMatchObject({ ok: false });
    expect(parseWorkoutImport(STRONG_HEADER)).toMatchObject({ ok: false });
    expect(parseWorkoutImport(STRONG_HEADER + '\n2024-01-15 10:30:00,Plank,5m,Plank,1,0,0,0,60,,,')).toMatchObject({ ok: false });
  });
  it('строки с нераспознанной датой считаются как битые, остальные читаются', () => {
    const x = parseWorkoutImport(STRONG_HEADER + '\nвчера,Push,45m,Bench Press (Barbell),1,100,5,0,0,,,\n2024-01-15 10:30:00,Push,45m,Bench Press (Barbell),1,100,5,0,0,,,');
    expect(x.ok && x.data.badRows).toBe(1);
    expect(x.ok && x.data.workouts).toHaveLength(1);
  });
});

describe('сопоставление упражнений', () => {
  const ex = seedMap();
  it('известные английские названия находят стартовые упражнения', () => {
    const s = suggestResolutions(['Bench Press (Barbell)', 'Squat (Barbell)', 'Lat Pulldown (Cable)', 'Pull Up'], ex);
    expect(s.get('Bench Press (Barbell)')).toEqual({ resolution: { kind: 'existing', exerciseId: idOfSeed('Жим штанги лёжа') }, reason: 'alias' });
    expect((s.get('Squat (Barbell)')!.resolution as { exerciseId: string }).exerciseId).toBe(idOfSeed('Приседания со штангой'));
    expect((s.get('Lat Pulldown (Cable)')!.resolution as { exerciseId: string }).exerciseId).toBe(idOfSeed('Тяга верхнего блока'));
    expect((s.get('Pull Up')!.resolution as { exerciseId: string }).exerciseId).toBe(idOfSeed('Подтягивания'));
  });
  it('регистр и знаки не важны, точное имя побеждает', () => {
    const custom: Exercise = { id: 'c1', name: 'Bench Press (Smith Machine)', muscle: 'chest', equipment: '', custom: true, createdAt: 0, updatedAt: 0, deviceId: 'd' };
    const s = suggestResolutions(['bench press  (smith machine)'], [...ex, custom]);
    expect(s.get('bench press  (smith machine)')).toMatchObject({ reason: 'exact', resolution: { exerciseId: 'c1' } });
  });
  it('незнакомое упражнение предлагается новым с догаданной мышцей, неясное — без группы, кардио — пропуск', () => {
    const s = suggestResolutions(['Cable Crossover', 'Zercher Squat', 'Mystery Move', 'Treadmill'], ex);
    expect(s.get('Zercher Squat')!.resolution).toEqual({ kind: 'new', name: 'Zercher Squat', muscle: 'legs' });
    expect(s.get('Mystery Move')!.resolution).toEqual({ kind: 'new', name: 'Mystery Move', muscle: null });
    expect(s.get('Treadmill')).toEqual({ resolution: { kind: 'skip' }, reason: 'cardio' });
  });
  it('удалённые упражнения не подставляются', () => {
    const gone = ex.map((e) => (e.name === 'Жим штанги лёжа' ? { ...e, deletedAt: 1 } : e));
    expect(suggestResolutions(['Bench Press (Barbell)'], gone).get('Bench Press (Barbell)')!.resolution.kind).toBe('new');
  });
  it('догадки о мышцах по названиям', () => {
    const g = guessMuscle;
    expect([g('Leg Curl'), g('Hammer Curl (Dumbbell)'), g('Chest Dip'), g('Triceps Dip'), g('Standing Calf Raise'), g('Hip Thrust'), g('Seated Row'), g('Shrug (Dumbbell)'), g('Cable Crunch')])
      .toEqual(['legs', 'biceps', 'chest', 'triceps', 'calves', 'glutes', 'back', 'shoulders', 'core']);
  });
});

describe('план импорта', () => {
  const ex = seedMap();
  const parsed = (() => { const r = parseWorkoutImport(HEVY); if (!r.ok) throw new Error(); return r.data; })();
  const names = [...new Set(parsed.workouts.flatMap((w) => w.exercises.map((e) => e.name)))];
  const auto = (exs: Exercise[] = ex) => new Map<string, Resolution>([...suggestResolutions(names, exs)].map(([n, s]) => [n, s.resolution]));

  it('пока не для всех названий решение, импортировать нельзя', () => {
    const p = buildImportPlan(parsed, new Map(), 'kg', { workouts: [], exercises: ex });
    expect(p.unresolved.sort()).toEqual([...names].sort());
    expect(p.workouts).toEqual([]);
  });

  it('новое упражнение без группы мышц остаётся неразрешённым', () => {
    const res = auto();
    res.set('Lateral Raise (Dumbbell)', { kind: 'new', name: 'Lateral Raise (Dumbbell)', muscle: null });
    expect(buildImportPlan(parsed, res, 'kg', { workouts: [], exercises: ex }).unresolved).toEqual(['Lateral Raise (Dumbbell)']);
  });

  it('тренировки и новые упражнения собираются, единицы переводятся', () => {
    const res = auto();
    res.set('Triceps Pushdown (Cable)', { kind: 'new', name: 'Triceps Pushdown (Cable)', muscle: 'triceps' });
    const p = buildImportPlan(parsed, res, 'kg', { workouts: [], exercises: ex });
    expect(p.unresolved).toEqual([]);
    expect(p.workouts).toHaveLength(2);
    expect(p.sets).toBe(7); // 3 жим + 1 махи + 1 разгибание + 2 присед; планка и бег не переносятся
    expect([p.from, p.to]).toEqual(['2024-01-15', '2024-01-17']);
    const bench = p.workouts[0].exercises.find((e) => e.exerciseId === idOfSeed('Жим штанги лёжа'))!;
    expect(bench.sets.map((s) => [s.weight, s.reps, s.done, s.warmup ?? false])).toEqual([[40, 10, true, true], [80, 5, true, false], [80, 5, true, false]]);
    expect(toKg(135, 'lb')).toBe(61.23);
    expect(toKg(80, 'kg')).toBe(80);
  });

  it('все импортированные тренировки помечены: за них не начисляются опыт, монеты и достижения', () => {
    const p = buildImportPlan(parsed, auto(), 'kg', { workouts: [], exercises: ex });
    expect(p.workouts.length).toBeGreaterThan(0);
    expect(p.workouts.every((w) => w.imported === true)).toBe(true);
  });

  it('суперсет Hevy: два упражнения с общим superset_id получают общую группу', () => {
    const p = buildImportPlan(parsed, auto(), 'kg', { workouts: [], exercises: ex });
    const push = p.workouts[0];
    const withGroup = push.exercises.filter((e) => e.group);
    expect(withGroup).toHaveLength(2);
    expect(withGroup[0].group).toBe(withGroup[1].group);
    expect(push.exercises.find((e) => e.exerciseId === idOfSeed('Жим штанги лёжа'))!.group).toBeUndefined();
  });

  it('выбранный пропуск убирает упражнение и считается', () => {
    const res = auto();
    res.set('Lateral Raise (Dumbbell)', { kind: 'skip' });
    const p = buildImportPlan(parsed, res, 'kg', { workouts: [], exercises: ex });
    expect(p.skippedByChoice).toBe(1);
    expect(p.workouts[0].exercises.some((e) => e.sets.some((s) => s.weight === 10 && s.reps === 12))).toBe(false);
  });

  it('тот же файл второй раз: все тренировки определяются как дубли', () => {
    const first = buildImportPlan(parsed, auto(), 'kg', { workouts: [], exercises: ex });
    const asExisting: Workout[] = first.workouts.map((w) => ({ ...w, createdAt: 1, updatedAt: 1, deviceId: 'd' }));
    const again = buildImportPlan(parsed, auto(), 'kg', { workouts: asExisting, exercises: ex });
    expect(again.workouts).toEqual([]);
    expect(again.duplicates).toBe(2);
  });

  it('те же подходы в тот же день, внесённые вручную, тоже считаются дублем (другой id)', () => {
    const first = buildImportPlan(parsed, auto(), 'kg', { workouts: [], exercises: ex });
    const manual: Workout = { ...first.workouts[1], id: 'manual-1', createdAt: 1, updatedAt: 1, deviceId: 'd' };
    const p = buildImportPlan(parsed, auto(), 'kg', { workouts: [manual], exercises: ex });
    expect(p.duplicates).toBe(1);
    expect(p.workouts).toHaveLength(1);
  });

  it('отпечаток не зависит от порядка упражнений и игнорирует разминку', () => {
    const a = workoutFingerprint({ date: 'd', exercises: [{ exerciseId: 'x', sets: [{ weight: 1, reps: 1, warmup: true }, { weight: 5, reps: 5 }] }, { exerciseId: 'y', sets: [{ weight: 2, reps: 2 }] }] });
    const b = workoutFingerprint({ date: 'd', exercises: [{ exerciseId: 'y', sets: [{ weight: 2, reps: 2 }] }, { exerciseId: 'x', sets: [{ weight: 5, reps: 5 }] }] });
    expect(a).toBe(b);
  });

  it('id новых упражнений детерминированы по названию', () => {
    expect(importedExerciseId('Zercher Squat')).toBe(importedExerciseId('  zercher   squat '));
    expect(importedExerciseId('Zercher Squat')).not.toBe(importedExerciseId('Front Squat'));
  });
});

describe('запись в базу', () => {
  beforeEach(async () => {
    await db.exercises.clear(); await db.workouts.clear(); await db.changes.clear();
    await db.exercises.bulkPut(seedMap());
  });
  const planFrom = async (text: string) => {
    const r = parseWorkoutImport(text);
    if (!r.ok) throw new Error(r.error);
    const names = [...new Set(r.data.workouts.flatMap((w) => w.exercises.map((e) => e.name)))];
    const sug = suggestResolutions(names, await db.exercises.toArray());
    const res = new Map<string, Resolution>([...sug].map(([n, s]) => [n, s.resolution.kind === 'new' && !s.resolution.muscle ? { ...s.resolution, muscle: 'core' as const } : s.resolution]));
    return buildImportPlan(r.data, res, 'kg', { workouts: await db.workouts.toArray(), exercises: await db.exercises.toArray() });
  };

  it('создаёт тренировки и упражнения и ставит их в очередь синхронизации', async () => {
    const plan = await planFrom(STRONG);
    const res = await applyImportPlan({ ...plan });
    expect(res.workouts).toBe(2);
    const stored = await db.workouts.toArray();
    expect(stored.every((w) => w.status === 'done' && w.deviceId)).toBe(true);
    const ch = await db.changes.toArray();
    expect(ch.filter((c) => c.table === 'workouts')).toHaveLength(2);
    expect(res.exercises).toBe(plan.newExercises.length);
  });

  it('метка сохраняется в базе, а копия импортированной тренировки уже обычная', async () => {
    await applyImportPlan(await planFrom(STRONG));
    const stored = await db.workouts.toArray();
    expect(stored.every((w) => w.imported === true)).toBe(true);
    const copy = (await duplicateWorkout(stored[0].id))!;
    expect(copy.imported).toBeUndefined();
  });

  it('повторный импорт того же файла ничего не добавляет', async () => {
    await applyImportPlan(await planFrom(STRONG));
    const before = await db.workouts.count();
    const second = await planFrom(STRONG);
    expect(second.workouts).toEqual([]);
    expect(second.duplicates).toBe(2);
    await applyImportPlan(second);
    expect(await db.workouts.count()).toBe(before);
  });

  it('существующая запись с тем же id не перезаписывается', async () => {
    const plan = await planFrom(STRONG);
    const w = plan.workouts[0];
    await db.workouts.put({ ...w, title: 'Моя правка', createdAt: 1, updatedAt: 1, deviceId: 'me' });
    const res = await applyImportPlan(plan);
    expect(res.skipped).toBe(1);
    expect((await db.workouts.get(w.id))!.title).toBe('Моя правка');
  });

  it('при неразрешённых упражнениях запись отклоняется целиком', async () => {
    const r = parseWorkoutImport(HEVY);
    if (!r.ok) throw new Error();
    const plan = buildImportPlan(r.data, new Map(), 'kg', { workouts: [], exercises: await db.exercises.toArray() });
    await expect(applyImportPlan(plan)).rejects.toThrow();
    expect(await db.workouts.count()).toBe(0);
  });
});
