// Достижения: каталог и расчёт прогресса. Чистые функции.
import { doneSets, finished, workoutVolume } from '../domain/analytics';
import { sportOf, type Exercise, type Workout } from '../domain/types';
import { addDays, parseDate, toDateStr, weekStart } from '../lib';

export type Tier = 'bronze' | 'silver' | 'gold' | 'epic';
export const TIER_LABELS: Record<Tier, string> = { bronze: 'Бронза', silver: 'Серебро', gold: 'Золото', epic: 'Эпик' };

// Id стартовых упражнений общие на всех устройствах (см. domain/seed.ts)
export const EX = { bench: 'seed-001', pullups: 'seed-005', deadlift: 'seed-010', squat: 'seed-011' } as const;

export interface Stats {
  workouts: number;           // завершённые тренировки, где что-то сделано
  volumeKg: number;           // общий объём всех рабочих подходов
  maxWorkoutVolume: number;
  streakWeeks: number;        // самая длинная серия недель подряд
  bench: number; squat: number; deadlift: number; // самый тяжёлый рабочий подход, кг
  pullupReps: number;         // больше всего подтягиваний за подход
  runKmMax: number;           // самый длинный бег за раз
  cardioKm: number;           // всего километров (бег, ходьба, велосипед)
  exerciseKinds: number;      // сколько разных упражнений делал
  longestMs: number;          // самая долгая тренировка
  night: boolean;             // завершал тренировку с 00:00 до 04:00
  dawn: boolean;              // завершал тренировку с 04:00 до 06:00
  newYear: boolean;           // тренировался 1 января
  doubleDay: boolean;         // две тренировки за один день
  purchases: number;          // куплено предметов
}

export function longestStreak(weeks: Set<string>): number {
  let best = 0;
  for (const w of weeks) {
    if (weeks.has(toDateStr(addDays(parseDate(w), -7)))) continue; // не начало серии
    let n = 0;
    let c = parseDate(w);
    while (weeks.has(toDateStr(c))) { n++; c = addDays(c, 7); }
    best = Math.max(best, n);
  }
  return best;
}

export function computeStats(all: Workout[], exercises: Exercise[], purchases = 0): Stats {
  const exMap = new Map(exercises.map((e) => [e.id, e]));
  const s: Stats = { workouts: 0, volumeKg: 0, maxWorkoutVolume: 0, streakWeeks: 0, bench: 0, squat: 0, deadlift: 0, pullupReps: 0, runKmMax: 0, cardioKm: 0, exerciseKinds: 0, longestMs: 0, night: false, dawn: false, newYear: false, doubleDay: false, purchases };
  const weeks = new Set<string>();
  const kinds = new Set<string>();
  const perDay = new Map<string, number>();
  for (const w of finished(all)) {
    let worked = false;
    for (const { exerciseId, set } of doneSets(w)) {
      if (set.reps <= 0) continue;
      worked = true;
      kinds.add(exerciseId);
      if (exerciseId === EX.bench) s.bench = Math.max(s.bench, set.weight);
      if (exerciseId === EX.squat) s.squat = Math.max(s.squat, set.weight);
      if (exerciseId === EX.deadlift) s.deadlift = Math.max(s.deadlift, set.weight);
      if (exerciseId === EX.pullups) s.pullupReps = Math.max(s.pullupReps, Math.min(set.reps, 100));
    }
    for (const we of w.exercises) {
      const m = we.cardio?.distanceM ?? 0;
      if (m <= 0) continue;
      worked = true;
      kinds.add(we.exerciseId);
      const km = Math.min(m / 1000, 1000);
      s.cardioKm += km;
      const ex = exMap.get(we.exerciseId);
      if ((ex ? sportOf(ex) : 'run') === 'run') s.runKmMax = Math.max(s.runKmMax, km);
    }
    if (!worked) continue;
    s.workouts++;
    const v = workoutVolume(w);
    s.volumeKg += v;
    s.maxWorkoutVolume = Math.max(s.maxWorkoutVolume, v);
    weeks.add(toDateStr(weekStart(parseDate(w.date))));
    perDay.set(w.date, (perDay.get(w.date) ?? 0) + 1);
    if (w.date.endsWith('-01-01')) s.newYear = true;
    if (w.finishedAt) {
      const h = new Date(w.finishedAt).getHours();
      if (h < 4) s.night = true; else if (h < 6) s.dawn = true;
      if (w.startedAt && w.finishedAt > w.startedAt && w.finishedAt - w.startedAt < 24 * 3600_000) s.longestMs = Math.max(s.longestMs, w.finishedAt - w.startedAt);
    }
  }
  s.streakWeeks = longestStreak(weeks);
  s.exerciseKinds = kinds.size;
  s.doubleDay = [...perDay.values()].some((n) => n >= 2);
  s.cardioKm = Math.round(s.cardioKm * 100) / 100;
  return s;
}

export interface Measure { cur: number; target: number }
export interface AchievementDef {
  id: string; title: string; desc: string; tier: Tier; reward: number; glyph: string;
  group: string; secret?: boolean;
  /** Не считается по тренировкам: выдаётся отдельным действием (пасхалка). */
  manual?: boolean;
  measure?: (s: Stats) => Measure;
  unit?: string;
}

const m = (cur: number, target: number): Measure => ({ cur, target });
const flag = (v: boolean): Measure => m(v ? 1 : 0, 1);
const WORKOUTS = 'Тренировки', STRENGTH = 'Сила', VOLUME = 'Объём', CARDIO = 'Кардио', MISC = 'Разное', SECRET = 'Секретные';

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'first', title: 'Первый шаг', desc: 'Завершить первую тренировку', tier: 'bronze', reward: 20, glyph: 'dumbbell', group: WORKOUTS, measure: (s) => m(s.workouts, 1) },
  { id: 'w10', title: 'Втянулся', desc: '10 тренировок', tier: 'bronze', reward: 50, glyph: 'dumbbell', group: WORKOUTS, measure: (s) => m(s.workouts, 10), unit: 'тр.' },
  { id: 'w50', title: 'Постоянство', desc: '50 тренировок', tier: 'silver', reward: 150, glyph: 'calendar', group: WORKOUTS, measure: (s) => m(s.workouts, 50), unit: 'тр.' },
  { id: 'w100', title: 'Сотка', desc: '100 тренировок', tier: 'gold', reward: 400, glyph: 'trophy', group: WORKOUTS, measure: (s) => m(s.workouts, 100), unit: 'тр.' },
  { id: 'w300', title: 'Зал как дом', desc: '300 тренировок', tier: 'epic', reward: 1000, glyph: 'crown', group: WORKOUTS, measure: (s) => m(s.workouts, 300), unit: 'тр.' },
  { id: 'streak4', title: 'Месяц без пропусков', desc: '4 недели подряд с тренировками', tier: 'silver', reward: 100, glyph: 'flame', group: WORKOUTS, measure: (s) => m(s.streakWeeks, 4), unit: 'нед.' },
  { id: 'streak12', title: 'Квартал в строю', desc: '12 недель подряд', tier: 'gold', reward: 300, glyph: 'flame', group: WORKOUTS, measure: (s) => m(s.streakWeeks, 12), unit: 'нед.' },
  { id: 'streak26', title: 'Полгода без пауз', desc: '26 недель подряд', tier: 'epic', reward: 800, glyph: 'flame', group: WORKOUTS, measure: (s) => m(s.streakWeeks, 26), unit: 'нед.' },

  { id: 'bench60', title: 'Разогрелся', desc: 'Жим лёжа 60 кг', tier: 'bronze', reward: 40, glyph: 'dumbbell', group: STRENGTH, measure: (s) => m(s.bench, 60), unit: 'кг' },
  { id: 'bench80', title: 'Серьёзный вес', desc: 'Жим лёжа 80 кг', tier: 'silver', reward: 100, glyph: 'dumbbell', group: STRENGTH, measure: (s) => m(s.bench, 80), unit: 'кг' },
  { id: 'bench100', title: 'Выдающийся', desc: 'Жим лёжа 100 кг', tier: 'gold', reward: 300, glyph: 'medal', group: STRENGTH, measure: (s) => m(s.bench, 100), unit: 'кг' },
  { id: 'bench140', title: 'Монстр жима', desc: 'Жим лёжа 140 кг', tier: 'epic', reward: 800, glyph: 'crown', group: STRENGTH, measure: (s) => m(s.bench, 140), unit: 'кг' },
  { id: 'squat100', title: 'Глубокий присед', desc: 'Приседания со штангой 100 кг', tier: 'silver', reward: 120, glyph: 'mountain', group: STRENGTH, measure: (s) => m(s.squat, 100), unit: 'кг' },
  { id: 'squat140', title: 'Королевский присед', desc: 'Приседания со штангой 140 кг', tier: 'gold', reward: 400, glyph: 'mountain', group: STRENGTH, measure: (s) => m(s.squat, 140), unit: 'кг' },
  { id: 'dead140', title: 'Земля дрожит', desc: 'Становая тяга 140 кг', tier: 'gold', reward: 300, glyph: 'layers', group: STRENGTH, measure: (s) => m(s.deadlift, 140), unit: 'кг' },
  { id: 'dead180', title: 'Тяжелее некуда', desc: 'Становая тяга 180 кг', tier: 'epic', reward: 700, glyph: 'layers', group: STRENGTH, measure: (s) => m(s.deadlift, 180), unit: 'кг' },
  { id: 'pull10', title: 'Турникмен', desc: '10 подтягиваний за подход', tier: 'silver', reward: 100, glyph: 'pulse', group: STRENGTH, measure: (s) => m(s.pullupReps, 10), unit: 'повт.' },
  { id: 'pull20', title: 'Человек-паук', desc: '20 подтягиваний за подход', tier: 'gold', reward: 350, glyph: 'pulse', group: STRENGTH, measure: (s) => m(s.pullupReps, 20), unit: 'повт.' },

  { id: 'vol10', title: 'Десять тонн', desc: 'Поднять суммарно 10 т', tier: 'bronze', reward: 60, glyph: 'layers', group: VOLUME, measure: (s) => m(s.volumeKg, 10_000), unit: 'кг' },
  { id: 'vol100', title: 'Сто тонн', desc: 'Поднять суммарно 100 т', tier: 'silver', reward: 200, glyph: 'layers', group: VOLUME, measure: (s) => m(s.volumeKg, 100_000), unit: 'кг' },
  { id: 'vol1000', title: 'Тысяча тонн', desc: 'Поднять суммарно 1000 т', tier: 'gold', reward: 600, glyph: 'layers', group: VOLUME, measure: (s) => m(s.volumeKg, 1_000_000), unit: 'кг' },
  { id: 'day10', title: 'Тяжёлый день', desc: '10 т за одну тренировку', tier: 'silver', reward: 120, glyph: 'bolt', group: VOLUME, measure: (s) => m(s.maxWorkoutVolume, 10_000), unit: 'кг' },

  { id: 'run5', title: 'Пятёрка', desc: 'Пробежать 5 км за раз', tier: 'bronze', reward: 80, glyph: 'pulse', group: CARDIO, measure: (s) => m(s.runKmMax, 5), unit: 'км' },
  { id: 'run10', title: 'Десятка', desc: 'Пробежать 10 км за раз', tier: 'silver', reward: 160, glyph: 'pulse', group: CARDIO, measure: (s) => m(s.runKmMax, 10), unit: 'км' },
  { id: 'run21', title: 'Полумарафон', desc: 'Пробежать 21,1 км за раз', tier: 'gold', reward: 500, glyph: 'medal', group: CARDIO, measure: (s) => m(s.runKmMax, 21.0975), unit: 'км' },
  { id: 'km100', title: 'Сто километров', desc: '100 км кардио суммарно', tier: 'silver', reward: 200, glyph: 'mountain', group: CARDIO, measure: (s) => m(s.cardioKm, 100), unit: 'км' },
  { id: 'km1000', title: 'Тысяча километров', desc: '1000 км кардио суммарно', tier: 'epic', reward: 900, glyph: 'mountain', group: CARDIO, measure: (s) => m(s.cardioKm, 1000), unit: 'км' },

  { id: 'kinds10', title: 'Разносторонний', desc: '10 разных упражнений', tier: 'bronze', reward: 60, glyph: 'star', group: MISC, measure: (s) => m(s.exerciseKinds, 10), unit: 'упр.' },
  { id: 'kinds25', title: 'Энциклопедия', desc: '25 разных упражнений', tier: 'silver', reward: 200, glyph: 'star', group: MISC, measure: (s) => m(s.exerciseKinds, 25), unit: 'упр.' },
  { id: 'long2h', title: 'Марафонец зала', desc: 'Тренировка дольше двух часов', tier: 'silver', reward: 80, glyph: 'sun', group: MISC, measure: (s) => m(s.longestMs / 3600_000, 2), unit: 'ч' },

  // секретные: описание скрыто, пока не получены
  { id: 'dev', title: 'Разработчик', desc: 'Вы знаете, где у приложения двойное дно', tier: 'epic', reward: 500, glyph: 'code', group: SECRET, secret: true, manual: true },
  { id: 'night', title: 'Полуночник', desc: 'Завершить тренировку между полуночью и четырьмя утра', tier: 'silver', reward: 100, glyph: 'moon', group: SECRET, secret: true, measure: (s) => flag(s.night) },
  { id: 'dawn', title: 'Жаворонок', desc: 'Завершить тренировку между четырьмя и шестью утра', tier: 'silver', reward: 100, glyph: 'sun', group: SECRET, secret: true, measure: (s) => flag(s.dawn) },
  { id: 'double', title: 'Дубль', desc: 'Две тренировки за один день', tier: 'bronze', reward: 60, glyph: 'twin', group: SECRET, secret: true, measure: (s) => flag(s.doubleDay) },
  { id: 'newyear', title: 'С Новым годом', desc: 'Потренироваться 1 января', tier: 'gold', reward: 250, glyph: 'gift', group: SECRET, secret: true, measure: (s) => flag(s.newYear) },
  { id: 'shopper', title: 'Шопоголик', desc: 'Купить пять предметов в магазине', tier: 'bronze', reward: 100, glyph: 'bag', group: SECRET, secret: true, measure: (s) => m(s.purchases, 5) },
  { id: 'bench250', title: 'Не из этого мира', desc: 'Жим лёжа 250 кг', tier: 'epic', reward: 5000, glyph: 'infinity', group: SECRET, secret: true, measure: (s) => m(s.bench, 250), unit: 'кг' },
  { id: 'atlas', title: 'Атлант', desc: 'Поднять суммарно 10 000 т', tier: 'epic', reward: 10000, glyph: 'infinity', group: SECRET, secret: true, measure: (s) => m(s.volumeKg, 10_000_000), unit: 'кг' }
];

export const ACH_BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

/** Достижения, условие которых выполнено сейчас (ручные не считаются). */
export const earnedNow = (s: Stats): AchievementDef[] =>
  ACHIEVEMENTS.filter((a) => a.measure && (() => { const r = a.measure!(s); return r.cur >= r.target; })());
