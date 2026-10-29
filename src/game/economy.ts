// Опыт, монеты и уровни. Чистые функции без базы.
import { doneSets } from '../domain/analytics';
import { sportOf, type Exercise, type Sport, type Workout } from '../domain/types';

export const XP_BASE = 40;            // за любую тренировку, где что-то сделано
export const VOLUME_PER_XP = 40;      // 40 кг объёма = 1 XP
export const BODYWEIGHT_KG = 30;      // подход без веса (подтягивания) считается так, будто на нём 30 кг
export const MAX_SET_VOLUME = 6000;   // потолок объёма одного подхода: защита от опечаток вроде 9999 кг
export const MAX_SET_REPS = 100;
export const MAX_WORKOUT_XP = 2000;
export const COIN_DIV = 4;            // монет = XP / 4
export const KM_XP: Record<Sport, number> = { run: 40, walk: 15, bike: 10 };
export const MAX_LEVEL = 100;

export interface Award { xp: number; coins: number }

/** Объём подхода для начисления опыта (не путать с «настоящим» объёмом в аналитике). */
export function effectiveSetVolume(weight: number, reps: number): number {
  const r = Math.min(Math.max(reps, 0), MAX_SET_REPS);
  const v = weight > 0 ? weight * r : r * BODYWEIGHT_KG;
  return Math.min(v, MAX_SET_VOLUME);
}

export function workoutAward(w: Workout, exercises: Map<string, Exercise>): Award {
  let vol = 0;
  let cardioXp = 0;
  let worked = false;
  for (const we of w.exercises) {
    const ex = exercises.get(we.exerciseId);
    if (we.cardio && we.cardio.distanceM > 0) {
      const km = Math.min(we.cardio.distanceM / 1000, 100);
      cardioXp += km * KM_XP[ex ? sportOf(ex) : 'run'];
      if (km >= 0.1) worked = true;
      continue;
    }
  }
  for (const { set } of doneSets(w)) {
    if (set.reps <= 0) continue;
    worked = true;
    vol += effectiveSetVolume(set.weight, set.reps);
  }
  if (!worked) return { xp: 0, coins: 0 };
  const xp = Math.min(MAX_WORKOUT_XP, Math.round(XP_BASE + vol / VOLUME_PER_XP + cardioXp));
  return { xp, coins: Math.floor(xp / COIN_DIV) };
}

// ---------- уровни ----------
/** Сколько всего опыта нужно, чтобы достичь уровня L (уровень 1 — с нуля). */
export const xpToReach = (level: number): number => (level <= 1 ? 0 : Math.round(100 * Math.pow(level - 1, 1.6)));

export interface LevelInfo { level: number; into: number; span: number; progress: number; atMax: boolean }

export function levelInfo(xp: number): LevelInfo {
  const x = Math.max(0, Number.isFinite(xp) ? xp : 0);
  let level = Math.min(MAX_LEVEL, Math.floor(Math.pow(x / 100, 1 / 1.6)) + 1);
  while (level < MAX_LEVEL && xpToReach(level + 1) <= x) level++;
  while (level > 1 && xpToReach(level) > x) level--;
  if (level >= MAX_LEVEL) return { level: MAX_LEVEL, into: 0, span: 0, progress: 1, atMax: true };
  const base = xpToReach(level);
  const span = xpToReach(level + 1) - base;
  const into = x - base;
  return { level, into, span, progress: span > 0 ? Math.min(1, into / span) : 1, atMax: false };
}

const RANKS: [number, string][] = [[1, 'Новичок'], [5, 'Любитель'], [10, 'Атлет'], [20, 'Профи'], [35, 'Мастер'], [50, 'Элита'], [75, 'Легенда'], [100, 'Титан']];
export function rankOf(level: number): string {
  let out = RANKS[0][1];
  for (const [l, name] of RANKS) if (level >= l) out = name;
  return out;
}
