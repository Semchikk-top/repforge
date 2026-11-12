// Какие шаблоны считаются тяжёлыми: большой вес и малое число повторений.
// Правило одно для всех упражнений (для жима лёжа оно совпадает с договорённостью: 0.85 от рекорда ±5 кг).
// Чистые функции поверх истории тренировок; результат отдаётся планировщику недели (schedule.ts).

import { exerciseRecords, lastPerformance } from './analytics';
import type { Why } from './explain';
import type { PlanTemplate } from './schedule';
import { isCardio, type Exercise, type Template, type TemplateExercise, type Workout } from './types';

export interface HeavyRules {
  /** Доля от рекорда (расчётного максимума на одно повторение), с которой вес считается большим. */
  share: number;
  /** Допуск вниз от этой доли, кг: вес от share × рекорд − допуск уже считается тяжёлым. */
  toleranceKg: number;
  /** Допуск не больше этой доли рекорда: чтобы для лёгких упражнений 5 кг не означали половину веса. */
  toleranceShare: number;
  /** Повторений в подходе не больше этого числа. */
  maxReps: number;
  /** Сколько тяжёлых подходов в шаблоне нужно, чтобы вся тренировка считалась тяжёлой. */
  minHeavySets: number;
}

export const DEFAULT_HEAVY_RULES: HeavyRules = {
  share: 0.85,
  toleranceKg: 5,
  toleranceShare: 0.05,
  maxReps: 6,
  minHeavySets: 2
};

/** Минимальный вес, с которого подход считается тяжёлым для упражнения с таким рекордом. */
export function heavyThreshold(record: number, rules: HeavyRules = DEFAULT_HEAVY_RULES): number {
  const tolerance = Math.min(rules.toleranceKg, rules.toleranceShare * record);
  return rules.share * record - tolerance;
}

/** Тяжёлый ли подход. Без рекорда (упражнение новое, свой вес, кардио) судить не о чем: не тяжёлый. */
export function isHeavySet(weight: number, reps: number, record: number, rules: HeavyRules = DEFAULT_HEAVY_RULES): boolean {
  if (!(record > 0) || !(weight > 0) || reps < 1 || reps > rules.maxReps) return false;
  return weight >= heavyThreshold(record, rules);
}

/** Почему подход тяжёлый или нет: те же проверки, что в isHeavySet, в том же порядке (слой «факт»). */
export function explainHeavySet(weight: number, reps: number, record: number, rules: HeavyRules = DEFAULT_HEAVY_RULES): Why {
  if (!(record > 0) || !(weight > 0) || reps < 1) return { code: 'heavy-no-record' };
  if (reps > rules.maxReps) return { code: 'heavy-many-reps', reps, maxReps: rules.maxReps };
  const threshold = heavyThreshold(record, rules);
  return weight >= threshold
    ? { code: 'heavy-yes', weight, reps, record, threshold, share: rules.share, maxReps: rules.maxReps }
    : { code: 'heavy-light', weight, reps, record, threshold };
}

export interface HeavyExerciseInfo {
  exerciseId: string;
  weight: number;
  reps: number;
  sets: number;
  /** Рекорд (расчётный максимум на одно повторение) или null, если истории нет. */
  record: number | null;
  /** Вес, с которого подход тяжёлый, или null, если рекорда нет. */
  threshold: number | null;
  heavy: boolean;
}

export interface TemplateHeaviness {
  heavy: boolean;
  heavySets: number;
  /** По каждому упражнению: почему так решено (для подсказки в интерфейсе и отладки). */
  exercises: HeavyExerciseInfo[];
}

/** Вес, с которым шаблон реально стартует: как в exercisesFromTemplate, прошлый результат важнее веса в шаблоне. */
function effectiveWeight(te: TemplateExercise, history: Workout[]): number {
  const last = lastPerformance(history, te.exerciseId);
  return last ? last.sets[last.sets.length - 1].weight : te.weight;
}

export function templateHeaviness(
  template: Template,
  history: Workout[],
  exMap: Map<string, Exercise>,
  rules: HeavyRules = DEFAULT_HEAVY_RULES,
  records: Map<string, number> = recordMap(history)
): TemplateHeaviness {
  const exercises: HeavyExerciseInfo[] = [];
  let heavySets = 0;
  for (const te of template.exercises) {
    const ex = exMap.get(te.exerciseId);
    if (!ex || ex.deletedAt || isCardio(ex)) continue;
    const record = records.get(te.exerciseId) ?? null;
    const weight = effectiveWeight(te, history);
    const heavy = record !== null && isHeavySet(weight, te.reps, record, rules);
    if (heavy) heavySets += te.sets;
    exercises.push({
      exerciseId: te.exerciseId, weight, reps: te.reps, sets: te.sets, record,
      threshold: record === null ? null : heavyThreshold(record, rules), heavy
    });
  }
  return { heavy: heavySets >= rules.minHeavySets, heavySets, exercises };
}

/** Упражнение → лучший расчётный максимум на одно повторение за всю историю. */
export function recordMap(history: Workout[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of exerciseRecords(history)) if (r.maxE1rm) m.set(r.exerciseId, r.maxE1rm.value);
  return m;
}

/** Шаблоны в виде, который принимает planWeek: с флагом heavy и группами мышц. */
export function toPlanTemplates(
  templates: Template[],
  history: Workout[],
  exMap: Map<string, Exercise>,
  rules: HeavyRules = DEFAULT_HEAVY_RULES
): PlanTemplate[] {
  const records = recordMap(history);
  return templates.map((t) => ({
    id: t.id,
    heavy: templateHeaviness(t, history, exMap, rules, records).heavy,
    tags: [...new Set(t.exercises.map((te) => exMap.get(te.exerciseId)?.muscle).filter((m): m is Exercise['muscle'] => !!m))]
  }));
}
