import { sportOf, type Exercise, type ID, type MuscleGroup, type SetEntry, type Sport, type Workout } from './types';
import { addDays, formatDuration, formatNum, parseDate, pluralRu, toDateStr, weekStart } from '../lib';

export const e1rm = (weight: number, reps: number): number =>
  reps <= 0 || weight <= 0 ? 0 : reps === 1 ? weight : weight * (1 + reps / 30);

export const doneSets = (w: Workout): { exerciseId: string; set: SetEntry }[] =>
  w.exercises.flatMap((we) => we.sets.filter((s) => s.done && !s.warmup).map((set) => ({ exerciseId: we.exerciseId, set })));

export const workoutVolume = (w: Workout): number =>
  doneSets(w).reduce((a, { set }) => a + set.weight * set.reps, 0);

export const workoutSetsCount = (w: Workout): number => doneSets(w).length;

export const finished = (ws: Workout[]): Workout[] =>
  ws.filter((w) => w.status === 'done' && !w.deletedAt).sort((a, b) => a.date.localeCompare(b.date));

// ---------- основная аналитика ----------

// ---------- дневная агрегация ----------
// Несколько тренировок за один день считаются одним тренировочным днём. Всё считается на чтении, схема базы не меняется.

export interface DayStat {
  date: string;
  /** Фактическое число завершённых тренировок за день. */
  sessions: number;
  sets: number;
  volumeKg: number;
  /** Сумма валидных длительностей тренировок дня, без пауз между ними. */
  durationMs: number;
  /** Сколько тренировок дали валидную длительность. Если меньше `sessions`, время неполное. */
  timedSessions: number;
  cardioKm: number;
  cardioSec: number;
}

/** Длительность тренировки, если оба времени есть, конец позже начала и разница меньше суток. */
export function sessionDurationMs(w: Workout): number | null {
  if (!w.startedAt || !w.finishedAt) return null;
  const d = w.finishedAt - w.startedAt;
  return d > 0 && d < 24 * 3600_000 ? d : null;
}

/** Статистика по дням: завершённые не удалённые тренировки, сгруппированные по `Workout.date`. По возрастанию даты. */
export function dailyStats(all: Workout[]): DayStat[] {
  const byDate = new Map<string, DayStat>();
  for (const w of finished(all)) {
    let d = byDate.get(w.date);
    if (!d) byDate.set(w.date, (d = { date: w.date, sessions: 0, sets: 0, volumeKg: 0, durationMs: 0, timedSessions: 0, cardioKm: 0, cardioSec: 0 }));
    d.sessions++;
    d.sets += workoutSetsCount(w);
    d.volumeKg += workoutVolume(w);
    const dur = sessionDurationMs(w);
    if (dur !== null) { d.durationMs += dur; d.timedSessions++; }
    for (const we of w.exercises) {
      if (!we.cardio || we.cardio.distanceM <= 0) continue;
      d.cardioKm += we.cardio.distanceM / 1000;
      d.cardioSec += Math.max(0, we.cardio.durationSec);
    }
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Короткая сводка дня: «2 тренировки · 42 подх. · 8 500 кг · 1 ч 10 мин». Неполное время помечается «≥». */
export function daySummaryText(d: DayStat, withSessions = true): string {
  const parts = withSessions ? [`${d.sessions} ${pluralRu(d.sessions, 'тренировка', 'тренировки', 'тренировок')}`] : [];
  if (d.sets > 0) parts.push(`${d.sets} подх.`);
  if (d.volumeKg > 0) parts.push(`${formatNum(Math.round(d.volumeKg)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')} кг`);
  if (d.timedSessions > 0) parts.push(`${d.timedSessions < d.sessions ? '≥ ' : ''}${formatDuration(d.durationMs)}`);
  return parts.join(' · ');
}

export function dayStat(all: Workout[], date: string): DayStat | null {
  return dailyStats(all.filter((w) => w.date === date)).find((d) => d.date === date) ?? null;
}

/** Число тренировочных дней в диапазоне дат (границы включены, любая может быть опущена). */
export function trainingDays(all: Workout[], from?: string, to?: string): number {
  return dailyStats(all).filter((d) => (!from || d.date >= from) && (!to || d.date <= to)).length;
}

export interface WeekStat { start: string; days: number; sessions: number; volume: number; sets: number }

export function weeklyStats(all: Workout[], weeks = 8, now = new Date()): WeekStat[] {
  const days = dailyStats(all);
  const thisStart = weekStart(now);
  const out: WeekStat[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const s = addDays(thisStart, -7 * i);
    const e = addDays(s, 7);
    const sStr = toDateStr(s), eStr = toDateStr(e);
    const inWeek = days.filter((d) => d.date >= sStr && d.date < eStr);
    out.push({
      start: sStr,
      days: inWeek.length,
      sessions: inWeek.reduce((a, d) => a + d.sessions, 0),
      volume: inWeek.reduce((a, d) => a + d.volumeKg, 0),
      sets: inWeek.reduce((a, d) => a + d.sets, 0)
    });
  }
  return out;
}

export interface PR { exerciseId: string; e1rm: number; weight: number; reps: number; date: string }

export function personalRecords(all: Workout[]): PR[] {
  const best = new Map<string, PR>();
  for (const w of finished(all)) {
    for (const { exerciseId, set } of doneSets(w)) {
      const v = e1rm(set.weight, set.reps);
      const cur = best.get(exerciseId);
      if (!cur || v > cur.e1rm) best.set(exerciseId, { exerciseId, e1rm: v, weight: set.weight, reps: set.reps, date: w.date });
    }
  }
  return [...best.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export function currentStreakWeeks(all: Workout[], now = new Date()): number {
  const ws = finished(all);
  const weeksWith = new Set(ws.map((w) => toDateStr(weekStart(parseDate(w.date)))));
  let cursor = weekStart(now);
  // текущая неделя может быть ещё пустой — не рвём серию
  if (!weeksWith.has(toDateStr(cursor))) cursor = addDays(cursor, -7);
  let n = 0;
  while (weeksWith.has(toDateStr(cursor))) { n++; cursor = addDays(cursor, -7); }
  return n;
}

// Прошлый результат по упражнению — подсказка во время тренировки
export function lastPerformance(all: Workout[], exerciseId: string, excludeId?: string): { date: string; sets: SetEntry[] } | null {
  const ws = finished(all).filter((w) => w.id !== excludeId).reverse();
  for (const w of ws) {
    const we = w.exercises.find((x) => x.exerciseId === exerciseId);
    const sets = we?.sets.filter((s) => s.done) ?? [];
    if (sets.length) return { date: w.date, sets };
  }
  return null;
}

// ---------- глубокая аналитика ----------

export interface MuscleStat { muscle: MuscleGroup; sets: number; volume: number }

export function muscleDistribution(all: Workout[], exMap: Map<string, Exercise>, days = 30, now = new Date()): MuscleStat[] {
  const from = toDateStr(addDays(now, -days));
  const acc = new Map<MuscleGroup, MuscleStat>();
  for (const w of finished(all).filter((x) => x.date >= from)) {
    for (const { exerciseId, set } of doneSets(w)) {
      const m = exMap.get(exerciseId)?.muscle;
      if (!m) continue;
      const cur = acc.get(m) ?? { muscle: m, sets: 0, volume: 0 };
      cur.sets += 1;
      cur.volume += set.weight * set.reps;
      acc.set(m, cur);
    }
  }
  return [...acc.values()].sort((a, b) => b.sets - a.sets);
}

// ---------- роза нагрузки ----------

/** Десять силовых групп в постоянном порядке: от него зависит положение лепестков розы. Кардио в силовую розу не входит. */
export const STRENGTH_MUSCLES: MuscleGroup[] = ['chest', 'back', 'shoulders', 'biceps', 'triceps', 'forearms', 'core', 'glutes', 'legs', 'calves'];
export type LoadMetric = 'sets' | 'volume';
export const LOAD_PERIODS = [7, 30, 90] as const;
export const LOAD_BASELINE_DAYS = 56; // восемь недель: «собственное среднее»

export interface MuscleLoad {
  muscle: MuscleGroup;
  sets: number;
  volume: number;
  /** Доля от собственного объёма за период, целые проценты; сумма по всем группам ровно 100 (или 0, если данных нет). */
  share: number;
  /** Доля за последние восемь недель: с чем сравнивать. */
  baselineShare: number;
  /** share − baselineShare, в процентных пунктах. */
  delta: number;
}

/** Целые проценты с суммой ровно 100: метод наибольших остатков. При нулевой сумме все доли 0. */
export function percentShares(values: number[]): number[] {
  const total = values.reduce((a, v) => a + v, 0);
  if (!(total > 0)) return values.map(() => 0);
  const raw = values.map((v) => (v / total) * 100);
  const base = raw.map(Math.floor);
  let left = 100 - base.reduce((a, v) => a + v, 0);
  const order = raw.map((r, i) => ({ i, rem: r - base[i] })).sort((a, b) => b.rem - a.rem || a.i - b.i);
  for (let k = 0; left > 0; k++, left--) base[order[k % order.length].i]++;
  return base;
}

function tally(all: Workout[], exMap: Map<string, Exercise>, days: number, now: Date) {
  const from = toDateStr(addDays(now, -(days - 1)));
  const to = toDateStr(now);
  const acc = new Map<MuscleGroup, { sets: number; volume: number }>(STRENGTH_MUSCLES.map((m) => [m, { sets: 0, volume: 0 }]));
  for (const w of finished(all).filter((x) => x.date >= from && x.date <= to)) {
    for (const { exerciseId, set } of doneSets(w)) { // разминка и невыполненные подходы уже отброшены
      const m = exMap.get(exerciseId)?.muscle;
      const cur = m ? acc.get(m) : undefined;
      if (!cur) continue; // кардио и неизвестные группы
      cur.sets += 1;
      cur.volume += set.weight * set.reps;
    }
  }
  return acc;
}

/**
 * Нагрузка по группам мышц за последние `days` дней (включая сегодня). Все десять групп присутствуют всегда, пустые с нулями:
 * иначе роза «схлопывалась» бы. Основная мышца упражнения, вторичные не учитываются.
 * Для каждой группы считается отклонение от собственного среднего за восемь недель, без универсальных «идеальных» процентов.
 */
export function muscleLoad(all: Workout[], exMap: Map<string, Exercise>, opts: { days?: number; metric?: LoadMetric; now?: Date } = {}): MuscleLoad[] {
  const days = opts.days ?? 30;
  const metric = opts.metric ?? 'sets';
  const now = opts.now ?? new Date();
  const cur = tally(all, exMap, days, now);
  const base = tally(all, exMap, LOAD_BASELINE_DAYS, now);
  const pick = (m: MuscleGroup, t: Map<MuscleGroup, { sets: number; volume: number }>) => t.get(m)![metric];
  const shares = percentShares(STRENGTH_MUSCLES.map((m) => pick(m, cur)));
  const baseShares = percentShares(STRENGTH_MUSCLES.map((m) => pick(m, base)));
  return STRENGTH_MUSCLES.map((muscle, i) => ({
    muscle,
    sets: cur.get(muscle)!.sets,
    volume: cur.get(muscle)!.volume,
    share: shares[i],
    baselineShare: baseShares[i],
    delta: shares[i] - baseShares[i]
  }));
}

export interface SeriesPoint { date: string; value: number }

export function e1rmSeries(all: Workout[], exerciseId: string): SeriesPoint[] {
  const out: SeriesPoint[] = [];
  for (const w of finished(all)) {
    let best = 0;
    for (const { exerciseId: id, set } of doneSets(w)) if (id === exerciseId) best = Math.max(best, e1rm(set.weight, set.reps));
    if (best > 0) out.push({ date: w.date, value: best });
  }
  return out;
}

export interface PlateauInfo { exerciseId: string; sessions: number; best: number; lastBest: number }

// Плато: в последних 3 тренировках лучший e1RM не превысил рекорд, поставленный ранее
export function detectPlateaus(all: Workout[]): PlateauInfo[] {
  const ids = new Set<string>();
  for (const w of finished(all)) for (const { exerciseId } of doneSets(w)) ids.add(exerciseId);
  const out: PlateauInfo[] = [];
  for (const id of ids) {
    const s = e1rmSeries(all, id);
    if (s.length < 5) continue;
    const before = Math.max(...s.slice(0, -3).map((p) => p.value));
    const recent = Math.max(...s.slice(-3).map((p) => p.value));
    if (recent <= before * 1.005) out.push({ exerciseId: id, sessions: s.length, best: before, lastBest: recent });
  }
  return out;
}

// Отношение нагрузки: объём за последние 7 дней к среднему недельному за предыдущие 28
export function loadRatio(all: Workout[], now = new Date()): { acute: number; chronic: number; ratio: number | null } {
  const ws = finished(all);
  const today = toDateStr(now);
  const d7 = toDateStr(addDays(now, -7));
  const d35 = toDateStr(addDays(now, -35));
  const acute = ws.filter((w) => w.date > d7 && w.date <= today).reduce((a, w) => a + workoutVolume(w), 0);
  const prev = ws.filter((w) => w.date > d35 && w.date <= d7).reduce((a, w) => a + workoutVolume(w), 0);
  const chronic = prev / 4;
  return { acute, chronic, ratio: chronic > 0 ? acute / chronic : null };
}

/** Средняя длительность тренировочного дня. Дни, где время известно не для всех тренировок, не берутся: иначе среднее занижено. */
export function averageDayDurationMs(all: Workout[]): number | null {
  const ds = dailyStats(all).filter((d) => d.sessions > 0 && d.timedSessions === d.sessions);
  return ds.length ? ds.reduce((a, d) => a + d.durationMs, 0) / ds.length : null;
}


// ---------- кардио ----------

export interface CardioSession {
  date: string;
  exerciseId: ID;
  sport: Sport;
  distanceM: number;
  durationSec: number;
  elevGainM: number;
  best?: Record<string, number>;
}

export function cardioSessions(all: Workout[], exMap: Map<string, Exercise>): CardioSession[] {
  const out: CardioSession[] = [];
  for (const w of finished(all)) {
    for (const we of w.exercises) {
      if (!we.cardio || we.cardio.distanceM <= 0) continue;
      const ex = exMap.get(we.exerciseId);
      out.push({
        date: w.date, exerciseId: we.exerciseId, sport: ex ? sportOf(ex) : 'run',
        distanceM: we.cardio.distanceM, durationSec: we.cardio.durationSec, elevGainM: we.cardio.elevGainM ?? 0, best: we.cardio.best
      });
    }
  }
  return out;
}

// Километры по неделям (последние weeks недель, с понедельника)
export function weeklyDistance(sessions: CardioSession[], weeks = 8, now = new Date()): { start: string; km: number }[] {
  const first = addDays(weekStart(now), -7 * (weeks - 1));
  const rows = Array.from({ length: weeks }, (_, i) => ({ start: toDateStr(addDays(first, 7 * i)), km: 0 }));
  for (const s of sessions) {
    const idx = Math.floor((weekStart(parseDate(s.date)).getTime() - first.getTime()) / (7 * 86400000) + 0.01);
    if (idx >= 0 && idx < weeks) rows[idx].km += s.distanceM / 1000;
  }
  return rows;
}

// Лучшее время на 1, 5 и 10 км по всем записанным маршрутам
export function bestEffortRecords(sessions: CardioSession[]): { meters: number; sec: number; date: string }[] {
  const out: { meters: number; sec: number; date: string }[] = [];
  for (const m of [1000, 5000, 10000]) {
    let best: { meters: number; sec: number; date: string } | null = null;
    for (const s of sessions) {
      const t = s.best?.[String(m)];
      if (t && (!best || t < best.sec)) best = { meters: m, sec: t, date: s.date };
    }
    if (best) out.push(best);
  }
  return out;
}

// Прошлый результат по кардио-упражнению: подсказка на экране тренировки
export function lastCardio(all: Workout[], exerciseId: string, excludeId?: string): { date: string; distanceM: number; durationSec: number } | null {
  for (const w of finished(all).filter((x) => x.id !== excludeId).reverse()) {
    const c = w.exercises.find((x) => x.exerciseId === exerciseId)?.cardio;
    if (c && c.distanceM > 0) return { date: w.date, distanceM: c.distanceM, durationSec: c.durationSec };
  }
  return null;
}


// Прогресс по целям текущей недели (с понедельника): тренировочные дни, число тренировок и километры бега и ходьбы
export function weekProgress(all: Workout[], exMap: Map<string, Exercise>, now = new Date()): { days: number; sessions: number; km: number } {
  const from = toDateStr(weekStart(now));
  const done = finished(all).filter((w) => w.date >= from);
  const km = cardioSessions(done, exMap).filter((x) => x.sport !== 'bike').reduce((a, x) => a + x.distanceM, 0) / 1000;
  return { days: trainingDays(done), sessions: done.length, km: Math.round(km * 100) / 100 };
}


// ---------- рекорды по упражнениям ----------

export interface RecordValue { value: number; weight: number; reps: number; date: string }
export interface ExerciseRecord {
  exerciseId: string;
  maxWeight: RecordValue | null;                         // самый тяжёлый подход
  maxE1rm: RecordValue | null;                           // расчётный максимум на одно повторение
  maxSetVolume: RecordValue | null;                      // вес × повторы за один подход
  maxSessionVolume: { value: number; date: string } | null; // суммарный объём упражнения за тренировку
  maxReps: { value: number; date: string } | null;       // для подходов без веса (подтягивания, отжимания)
  latest: string;                                        // дата последнего из рекордов
}

export function exerciseRecords(all: Workout[]): ExerciseRecord[] {
  const out = new Map<string, ExerciseRecord>();
  const get = (id: string) => {
    let r = out.get(id);
    if (!r) out.set(id, (r = { exerciseId: id, maxWeight: null, maxE1rm: null, maxSetVolume: null, maxSessionVolume: null, maxReps: null, latest: '' }));
    return r;
  };
  for (const w of finished(all)) {              // по возрастанию даты: при равенстве рекордом остаётся первый
    for (const we of w.exercises) {
      const done = we.sets.filter((x) => x.done && x.reps > 0 && !x.warmup);
      if (done.length === 0) continue;
      const r = get(we.exerciseId);
      let session = 0;
      for (const st of done) {
        const rv = (value: number): RecordValue => ({ value, weight: st.weight, reps: st.reps, date: w.date });
        session += st.weight * st.reps;
        if (st.weight > 0) {
          if (!r.maxWeight || st.weight > r.maxWeight.value) r.maxWeight = rv(st.weight);
          const e = e1rm(st.weight, st.reps);
          if (!r.maxE1rm || e > r.maxE1rm.value) r.maxE1rm = rv(e);
          const v = st.weight * st.reps;
          if (!r.maxSetVolume || v > r.maxSetVolume.value) r.maxSetVolume = rv(v);
        } else if (!r.maxReps || st.reps > r.maxReps.value) r.maxReps = { value: st.reps, date: w.date };
      }
      if (session > 0 && (!r.maxSessionVolume || session > r.maxSessionVolume.value)) r.maxSessionVolume = { value: session, date: w.date };
    }
  }
  for (const r of out.values()) {
    r.latest = [r.maxWeight?.date, r.maxE1rm?.date, r.maxSetVolume?.date, r.maxSessionVolume?.date, r.maxReps?.date].filter((d): d is string => !!d).sort().pop() ?? '';
  }
  return [...out.values()];
}
