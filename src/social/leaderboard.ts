// Метрики рейтинга из локальных тренировок. Чистые функции: без базы, сети и ключей.
import { e1rm } from '../domain/analytics';
import { isCardio, type Exercise, type Workout } from '../domain/types';
import { addDays, toDateStr, weekStart } from '../lib';

export type PeriodKind = 'week' | '4weeks' | 'month' | 'all';
export const PERIOD_LABELS: Record<PeriodKind, string> = { week: 'Неделя', '4weeks': '4 недели', month: 'Месяц', all: 'Всё время' };
/** Периоды обмена с друзьями. */
export const PERIOD_KINDS: PeriodKind[] = ['week', '4weeks', 'all'];
/** Периоды мирового рейтинга: только календарные (у всех одни границы), скользящие «4 недели» туда не годятся. */
export const WORLD_PERIOD_KINDS: PeriodKind[] = ['week', 'month', 'all'];

export interface Period { from: string; to: string; tz: string }

export const MAX_EXERCISES = 200;

/** Календарная неделя (пн–вс), календарный месяц, последние 28 дней или всё время. Границы фиксирует отправитель. */
export function periodFor(kind: PeriodKind, now = new Date()): Period {
  const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } })();
  const today = toDateStr(now);
  if (kind === 'week') { const mon = weekStart(now); return { from: toDateStr(mon), to: toDateStr(addDays(mon, 6)), tz }; }
  if (kind === 'month') {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: toDateStr(first), to: toDateStr(new Date(now.getFullYear(), now.getMonth() + 1, 0)), tz };
  }
  if (kind === '4weeks') return { from: toDateStr(addDays(now, -27)), to: today, tz };
  return { from: '1970-01-01', to: today, tz };
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/** Ключ для сравнения упражнений у разных людей: у стартовых — общий id, у своих — имя + группа мышц + оборудование. */
export function exerciseKey(e: Pick<Exercise, 'id' | 'name' | 'muscle' | 'equipment' | 'custom'>): string {
  return e.custom ? `c:${norm(e.name)}|${e.muscle}|${norm(e.equipment ?? '')}` : e.id;
}

export interface ExerciseStat { key: string; name: string; muscle: string; e1rmKg: number; volumeKg: number; workSets: number }
export interface SnapshotStats {
  totals: { workouts: number; workSets: number; volumeKg: number };
  exercises: ExerciseStat[];
  cardio: { distanceKm: number; movingSec: number; sessions: number };
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Что идёт в рейтинг: выполненные рабочие подходы завершённых тренировок за период.
 * Разминки (warmup) не считаются; кардио учитывается отдельно, километры с килограммами не складываются.
 */
export function buildStats(workouts: Workout[], exercises: Exercise[], period: Period): SnapshotStats {
  const exMap = new Map(exercises.map((e) => [e.id, e]));
  const byKey = new Map<string, ExerciseStat>();
  const out: SnapshotStats = { totals: { workouts: 0, workSets: 0, volumeKg: 0 }, exercises: [], cardio: { distanceKm: 0, movingSec: 0, sessions: 0 } };
  let distM = 0;

  for (const w of workouts) {
    if (w.status !== 'done' || w.deletedAt || w.date < period.from || w.date > period.to) continue;
    let counted = false;
    for (const we of w.exercises) {
      const ex = exMap.get(we.exerciseId);
      if (isCardio(ex)) {
        if (we.cardio && we.cardio.distanceM > 0) { distM += we.cardio.distanceM; out.cardio.movingSec += Math.max(0, we.cardio.durationSec); out.cardio.sessions++; counted = true; }
        continue;
      }
      const key = ex ? exerciseKey(ex) : `x:${we.exerciseId}`;
      for (const s of we.sets) {
        if (!s.done || s.reps <= 0 || s.warmup) continue;
        counted = true;
        const vol = s.weight > 0 ? s.weight * s.reps : 0;
        const row = byKey.get(key) ?? { key, name: (ex?.name ?? 'Упражнение').slice(0, 60), muscle: ex?.muscle ?? 'core', e1rmKg: 0, volumeKg: 0, workSets: 0 };
        row.volumeKg += vol;
        row.workSets++;
        if (s.weight > 0) row.e1rmKg = Math.max(row.e1rmKg, e1rm(s.weight, s.reps));
        byKey.set(key, row);
        out.totals.workSets++;
        out.totals.volumeKg += vol;
      }
    }
    if (counted) out.totals.workouts++;
  }
  out.totals.volumeKg = r1(out.totals.volumeKg);
  out.cardio.distanceKm = r2(distM / 1000);
  out.cardio.movingSec = Math.round(out.cardio.movingSec);
  out.exercises = [...byKey.values()]
    .map((e) => ({ ...e, e1rmKg: r1(e.e1rmKg), volumeKg: r1(e.volumeKg) }))
    .sort((a, b) => b.volumeKg - a.volumeKg || b.workSets - a.workSets || a.name.localeCompare(b.name, 'ru'))
    .slice(0, MAX_EXERCISES);
  return out;
}

/** Нет ни одного подхода с отметкой разминки: старые данные считаются рабочими, и об этом надо сказать. */
export const hasWarmupMarks = (workouts: Workout[]): boolean =>
  workouts.some((w) => w.exercises.some((we) => we.sets.some((s) => s.warmup)));
