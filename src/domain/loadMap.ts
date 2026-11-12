// Карта нагрузки: оценка по подходам для десяти силовых групп, с учётом вспомогательных мышц из карточек.
// Это оценка, а не измерение. Никаких «норм объёма»: сравнение только с собственным средним за восемь недель.
import { LOAD_BASELINE_DAYS, STRENGTH_MUSCLES, doneSets, finished } from './analytics';
import type { Card } from '../content/types';
import type { Exercise, MuscleGroup, Workout } from './types';
import { addDays, parseDate, toDateStr } from '../lib';

export const MAP_PERIODS = [7, 28] as const;
export type MapPeriod = (typeof MAP_PERIODS)[number];
export const PRIMARY_WEIGHT = 1;
export const SECONDARY_WEIGHT = 0.5;
/** Меньше такой истории «к обычному» не показываем: сравнивать пока не с чем. */
export const MIN_HISTORY_DAYS = 28;

/** Вес каждой группы для одного подхода: основные мышцы 1, вспомогательные 0,5; в группе берётся наибольший вес, а не сумма. */
export type GroupWeights = Map<MuscleGroup, number>;

/** Как узнать веса для упражнения: null — карточки нет, тогда подход целиком идёт в группу из поля `muscle`. */
export type WeightResolver = (exercise: Exercise) => GroupWeights | null;

const isStrength = (g: string): g is MuscleGroup => (STRENGTH_MUSCLES as string[]).includes(g);

/** Веса групп по карточке. Мышцы с неизвестной или не силовой группой пропускаются; если ничего не осталось, возвращается null. */
export function cardWeights(card: Card, groupOf: (muscleId: string) => string | null): GroupWeights | null {
  const out: GroupWeights = new Map();
  const put = (ids: string[], w: number) => {
    for (const id of ids) {
      const g = groupOf(id);
      if (g && isStrength(g) && (out.get(g) ?? 0) < w) out.set(g, w);
    }
  };
  put(card.secondaryMuscles, SECONDARY_WEIGHT);
  put(card.primaryMuscles, PRIMARY_WEIGHT);
  return out.size > 0 ? out : null;
}

export interface MapLoad {
  muscle: MuscleGroup;
  /** Оценка: подходы с весами 1 и 0,5 за период. */
  weighted: number;
  /** Доля от самой нагруженной группы за период, 0…1 (шкала собственная, без «идеала»). */
  level: number;
  /** Подходов в неделю за период и за последние восемь недель. */
  weekly: number;
  baselineWeekly: number;
  /** Отличие от собственного среднего в процентах; null, если истории меньше четырёх недель или раньше группу не нагружали. */
  vsUsual: number | null;
}

function tally(all: Workout[], exMap: Map<string, Exercise>, resolve: WeightResolver, days: number, now: Date): Map<MuscleGroup, number> {
  const from = toDateStr(addDays(now, -(days - 1)));
  const to = toDateStr(now);
  const acc = new Map<MuscleGroup, number>(STRENGTH_MUSCLES.map((m) => [m, 0]));
  const cache = new Map<string, GroupWeights | null>();
  for (const w of finished(all).filter((x) => x.date >= from && x.date <= to)) {
    for (const { exerciseId } of doneSets(w)) {
      const ex = exMap.get(exerciseId);
      if (!ex) continue;
      let weights = cache.get(ex.id);
      if (weights === undefined) { weights = ex.custom ? null : resolve(ex); cache.set(ex.id, weights); }
      if (weights) { for (const [g, k] of weights) acc.set(g, (acc.get(g) ?? 0) + k); continue; }
      if (isStrength(ex.muscle)) acc.set(ex.muscle, (acc.get(ex.muscle) ?? 0) + PRIMARY_WEIGHT); // кардио и неизвестное не считаются
    }
  }
  return acc;
}

export function loadMap(all: Workout[], exMap: Map<string, Exercise>, resolve: WeightResolver, opts: { days?: MapPeriod; now?: Date } = {}): MapLoad[] {
  const days = opts.days ?? 28;
  const now = opts.now ?? new Date();
  const cur = tally(all, exMap, resolve, days, now);
  const base = tally(all, exMap, resolve, LOAD_BASELINE_DAYS, now);
  const max = Math.max(0, ...cur.values());
  const done = finished(all);
  const history = done.length ? (now.getTime() - parseDate(done[0].date).getTime()) / 86_400_000 : 0;
  const enough = history >= MIN_HISTORY_DAYS;
  return STRENGTH_MUSCLES.map((muscle) => {
    const weighted = cur.get(muscle)!;
    const weekly = weighted / (days / 7);
    const baselineWeekly = base.get(muscle)! / (LOAD_BASELINE_DAYS / 7);
    return {
      muscle, weighted, level: max > 0 ? weighted / max : 0, weekly, baselineWeekly,
      vsUsual: enough && baselineWeekly > 0 ? Math.round((weekly / baselineWeekly - 1) * 100) : null
    };
  });
}
