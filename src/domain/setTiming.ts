// Время выполнения подхода. Без React и часов, чтобы это проверяли тесты.
//
// Схема:
//  - у первого подхода упражнения отсчёт запускает кнопка «Начать» (set.startedAt);
//  - у остальных подходов отсчёт стартует сам: когда закончился отдых, а если отдыха не было
//    (суперсет, дроп-сет), то в момент галочки предыдущего подхода;
//  - галочка останавливает отсчёт и записывает set.workSec.
// Если начало неизвестно или неоднозначно, время не записывается: в среднее такой подход не попадает.

import { finished } from './analytics';
import type { ID, SetEntry, Workout, WorkoutExercise } from './types';

/** Подход дольше этого считаем забытым (отвлёкся, не нажал галочку) и время не пишем. */
export const MAX_SET_SEC = 15 * 60;

/** Момент последней галочки в тренировке (кроме указанного подхода). */
export function latestDoneAt(exercises: WorkoutExercise[], exceptSetId?: string): number | null {
  let best: number | null = null;
  for (const we of exercises) {
    for (const s of we.sets) {
      if (!s.done || s.id === exceptSetId || typeof s.completedAt !== 'number') continue;
      if (best === null || s.completedAt > best) best = s.completedAt;
    }
  }
  return best;
}

/**
 * Нужна ли кнопка «Начать»: это первый подход упражнения, и он не продолжает суперсет
 * (второе и следующие упражнения связки стартуют от галочки предыдущего).
 */
export function needsManualStart(exercises: WorkoutExercise[], weIdx: number, setId: string): boolean {
  const we = exercises[weIdx];
  if (!we || we.sets[0]?.id !== setId) return false;
  const prev = exercises[weIdx - 1];
  const continuesSuperset = !!we.group && !!prev && prev.group === we.group;
  return !continuesSuperset;
}

/**
 * Когда начался подход. null — неизвестно.
 * restEndedAt: когда закончился последний отдых; restRunning: отдых идёт прямо сейчас
 * (подход отмечен раньше конца отдыха: начало неоднозначно, время не пишем).
 */
export function resolveSetStart(
  exercises: WorkoutExercise[], weIdx: number, set: SetEntry,
  restEndedAt: number | null, restRunning: boolean
): number | null {
  if (typeof set.startedAt === 'number') return set.startedAt;
  if (needsManualStart(exercises, weIdx, set.id)) return null;
  if (restRunning) return null;
  const prev = latestDoneAt(exercises, set.id);
  if (prev === null) return null;
  return restEndedAt !== null && restEndedAt > prev ? restEndedAt : prev;
}

/** Длительность в целых секундах или undefined, если запись не имеет смысла. */
export function workSecBetween(startMs: number | null, endMs: number): number | undefined {
  if (startMs === null) return undefined;
  const sec = Math.round((endMs - startMs) / 1000);
  return sec >= 1 && sec <= MAX_SET_SEC ? sec : undefined;
}

/** «0:42», «1:05» */
export function formatSetTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- аналитика ----------

export interface ExerciseTimeStat {
  exerciseId: ID;
  avgSetSec: number;       // среднее время одного рабочего подхода
  avgExerciseSec: number;  // среднее суммарное время упражнения за тренировку (без отдыха)
  sets: number;            // сколько подходов с временем
  sessions: number;        // в скольких тренировках
}

const timed = (s: SetEntry): boolean => s.done && !s.warmup && typeof s.workSec === 'number' && s.workSec > 0;

/** По упражнениям: больше всего измеренных подходов — выше. Разминка не считается. */
export function exerciseTimeStats(all: Workout[]): ExerciseTimeStat[] {
  const acc = new Map<ID, { sum: number; sets: number; sessions: number }>();
  for (const w of finished(all)) {
    const perWorkout = new Map<ID, { sum: number; sets: number }>();
    for (const we of w.exercises) {
      for (const s of we.sets) {
        if (!timed(s)) continue;
        const cur = perWorkout.get(we.exerciseId) ?? { sum: 0, sets: 0 };
        cur.sum += s.workSec!; cur.sets += 1;
        perWorkout.set(we.exerciseId, cur);
      }
    }
    for (const [id, v] of perWorkout) {
      const a = acc.get(id) ?? { sum: 0, sets: 0, sessions: 0 };
      a.sum += v.sum; a.sets += v.sets; a.sessions += 1;
      acc.set(id, a);
    }
  }
  return [...acc.entries()]
    .map(([exerciseId, a]) => ({ exerciseId, avgSetSec: a.sum / a.sets, avgExerciseSec: a.sum / a.sessions, sets: a.sets, sessions: a.sessions }))
    .sort((x, y) => y.sets - x.sets);
}

/** Среднее время подхода по всем упражнениям; null, если ничего не измерено. */
export function averageSetSec(all: Workout[]): { avgSec: number; sets: number } | null {
  let sum = 0, n = 0;
  for (const w of finished(all)) for (const we of w.exercises) for (const s of we.sets) if (timed(s)) { sum += s.workSec!; n++; }
  return n ? { avgSec: sum / n, sets: n } : null;
}

// ---------- отдых по таймеру и темп ----------

const plain = (s: SetEntry): boolean => !s.kind || s.kind === 'normal';

export interface ExerciseRestStat { exerciseId: ID; avgRestSec: number; count: number }

/**
 * Отдых, который вышел на деле с учётом «+15 с» и «Пропустить»: от галочки подхода до начала следующего.
 * Начало следующего подхода — это конец отдыха, поэтому здесь именно отдых по таймеру: ожидание после его
 * конца входит уже во время подхода. Суперсеты, дроп-сеты, rest-pause и разминка не считаются.
 */
export function exerciseRestStats(all: Workout[]): ExerciseRestStat[] {
  const acc = new Map<ID, { sum: number; n: number }>();
  for (const w of finished(all)) {
    for (const we of w.exercises) {
      for (const rest of restSamplesOf(we)) {
        const cur = acc.get(we.exerciseId) ?? { sum: 0, n: 0 };
        cur.sum += rest; cur.n += 1;
        acc.set(we.exerciseId, cur);
      }
    }
  }
  return [...acc.entries()].map(([exerciseId, a]) => ({ exerciseId, avgRestSec: a.sum / a.n, count: a.n })).sort((x, y) => y.count - x.count);
}

/** Отдых по таймеру внутри одного упражнения одной тренировки: каждый подход, у которого он измерен, даёт одно число (секунды). */
export function restSamplesOf(we: WorkoutExercise): number[] {
  const out: number[] = [];
  if (we.group) return out;
  for (let j = 1; j < we.sets.length; j++) {
    const a = we.sets[j - 1], b = we.sets[j];
    if (!a.done || !b.done || b.warmup || !plain(b) || typeof b.startedAt === 'number') continue;
    if (typeof a.completedAt !== 'number' || typeof b.completedAt !== 'number' || typeof b.workSec !== 'number') continue;
    const rest = (b.completedAt - b.workSec * 1000 - a.completedAt) / 1000;
    if (rest < 3 || rest > MAX_SET_SEC) continue;
    out.push(rest);
  }
  return out;
}

export function averageRestSec(all: Workout[]): { avgSec: number; count: number } | null {
  const st = exerciseRestStats(all);
  const count = st.reduce((a, x) => a + x.count, 0);
  return count ? { avgSec: st.reduce((a, x) => a + x.avgRestSec * x.count, 0) / count, count } : null;
}

export interface ExerciseTempoStat {
  exerciseId: ID;
  secPerRep: number;
  /** На сколько процентов последний подход медленнее первого (в среднем по тренировкам); null, если данных мало. */
  slowdownPct: number | null;
}

/** Темп: секунд на повторение. Усталость видна по замедлению к последнему подходу. */
export function exerciseTempoStats(all: Workout[]): ExerciseTempoStat[] {
  const acc = new Map<ID, { sum: number; n: number; ratios: number[] }>();
  for (const w of finished(all)) {
    for (const we of w.exercises) {
      const sets = we.sets.filter((s) => timed(s) && plain(s) && s.reps > 0);
      if (sets.length === 0) continue;
      const cur = acc.get(we.exerciseId) ?? { sum: 0, n: 0, ratios: [] };
      for (const s of sets) { cur.sum += s.workSec! / s.reps; cur.n += 1; }
      if (sets.length >= 3) {
        const first = sets[0], last = sets[sets.length - 1];
        cur.ratios.push((last.workSec! / last.reps) / (first.workSec! / first.reps));
      }
      acc.set(we.exerciseId, cur);
    }
  }
  return [...acc.entries()].map(([exerciseId, a]) => ({
    exerciseId,
    secPerRep: a.sum / a.n,
    slowdownPct: a.ratios.length >= 2 ? (a.ratios.reduce((x, y) => x + y, 0) / a.ratios.length - 1) * 100 : null
  }));
}
