// Авторегуляция нагрузки: чистые правила «сегодня с поправкой на состояние». Без React и базы, их проверяют тесты.
// Ничего не меняется само: функция только предлагает, а поправку применяет явное нажатие «Сделать легче».
// Это подсказка, а не медицинская рекомендация: каждая причина показана пользователю отдельно.

import type { Why } from './explain';
import { addDays, toDateStr } from '../lib';
import { finished, loadRatio } from './analytics';
import type { Readiness } from './checkin';
import type { SetEntry, Workout, WorkoutExercise } from './types';

/** Отношение острой нагрузки к привычной, начиная с которого считаем её высокой (1,5× и больше). */
export const HIGH_LOAD_RATIO = 1.5;
/** От такого отношения поправка сильнее: −10% вместо −5%. */
export const SEVERE_LOAD_RATIO = 2;
/** Готовность ниже этого порога (из 100) тоже даёт сильную поправку. */
export const SEVERE_READINESS = 25;
/** Сон короче этого (часы) называем среди причин. */
export const SHORT_SLEEP_HOURS = 6;
/** Сколько тренировок должно быть за 4 недели до острой недели, чтобы считать «привычную» нагрузку надёжной. */
export const MIN_BASELINE_WORKOUTS = 3;
/** Шаг округления веса при поправке, кг. Вес всегда уменьшается минимум на один шаг. */
export const EASE_STEP = 0.5;

/**
 * loadRatio с защитой от шума: при короткой истории привычная нагрузка близка к нулю, и любое занятие даёт «2×».
 * Если за предыдущие 4 недели меньше MIN_BASELINE_WORKOUTS тренировок, возвращает null.
 */
export function reliableLoadRatio(all: Workout[], now: Date = new Date()): number | null {
  const from = toDateStr(addDays(now, -35));
  const to = toDateStr(addDays(now, -7));
  const baseline = finished(all).filter((w) => w.date > from && w.date <= to).length;
  return baseline >= MIN_BASELINE_WORKOUTS ? loadRatio(all, now).ratio : null;
}

export type EaseReasonKey = 'sleep' | 'readiness' | 'load' | 'plateau';
export interface EaseReason { key: EaseReasonKey; text: string }

export interface EasePlan {
  /** На сколько процентов снизить вес в ещё не выполненных рабочих подходах. */
  pct: 5 | 10;
}

export interface AutoregInput {
  /** Готовность по утреннему чек-ину сегодня; null, если чек-ина нет. */
  readiness: Readiness | null;
  /** Часы сна из утреннего чек-ина. */
  sleepHours?: number | null;
  /** loadRatio().ratio; null, если истории для сравнения мало. */
  loadRatio: number | null;
  /** Названия упражнений сегодняшней тренировки, где вес давно не растёт. */
  plateauNames?: string[];
}

export interface Autoregulation {
  mode: 'ease' | 'normal';
  /** Есть ли вообще данные для вывода: без чек-ина и истории карточку не показываем. */
  known: boolean;
  headline: string;
  detail: string;
  /** Почему предложено именно так. В обычном режиме может содержать только застой. */
  reasons: EaseReason[];
  /** Поправка для кнопки «Сделать легче»; null в обычном режиме. */
  plan: EasePlan | null;
}

/** Причина облегчения в виде «факта» для «Почему так»: текст причины уже собран выше тем же кодом, что принял решение. */
export const explainEaseReason = (r: EaseReason): Why => ({ code: `ease-${r.key}` as 'ease-sleep' | 'ease-readiness' | 'ease-load' | 'ease-plateau', text: r.text });

const fmtRatio = (r: number): string => `${(Math.round(r * 10) / 10).toFixed(1).replace('.', ',')}×`;
const fmtHours = (h: number): string => `${String(Math.round(h * 2) / 2).replace('.', ',')} ч`;

export function autoregulate(i: AutoregInput): Autoregulation {
  const { readiness, loadRatio } = i;
  const plateauNames = i.plateauNames ?? [];
  const known = readiness !== null || loadRatio !== null;
  const lowReadiness = readiness?.level === 'low';
  const highLoad = loadRatio !== null && loadRatio >= HIGH_LOAD_RATIO;

  const plateauReason: EaseReason | null = plateauNames.length
    ? { key: 'plateau', text: `вес не растёт три тренировки: ${plateauNames.join(', ')}` }
    : null;

  if (!lowReadiness && !highLoad) {
    return {
      mode: 'normal', known,
      headline: 'Обычный прогресс',
      detail: plateauReason
        ? 'Состояние в норме, нагрузка привычная. Там, где вес застрял, можно добавить повторение вместо веса.'
        : 'Состояние в норме, нагрузка привычная. Работай по плану и прибавляй вес, как обычно.',
      reasons: plateauReason ? [plateauReason] : [],
      plan: null
    };
  }

  const reasons: EaseReason[] = [];
  if (lowReadiness && readiness) {
    if (typeof i.sleepHours === 'number' && Number.isFinite(i.sleepHours) && i.sleepHours < SHORT_SLEEP_HOURS) reasons.push({ key: 'sleep', text: `сон ${fmtHours(i.sleepHours)}` });
    reasons.push({ key: 'readiness', text: `готовность ${readiness.score} из 100` });
  }
  if (highLoad && loadRatio !== null) reasons.push({ key: 'load', text: `нагрузка ${fmtRatio(loadRatio)} обычной` });
  if (plateauReason) reasons.push(plateauReason);

  const severe = (lowReadiness && highLoad)
    || (readiness !== null && readiness.score < SEVERE_READINESS)
    || (loadRatio !== null && loadRatio >= SEVERE_LOAD_RATIO);
  const pct: 5 | 10 = severe ? 10 : 5;

  return {
    mode: 'ease', known,
    headline: 'Сегодня с поправкой на состояние',
    detail: `Предлагаю снизить вес на ${pct}% в невыполненных подходах. Там, где работаешь с собственным весом, уберу один подход. Решаешь ты: пока не нажмёшь, ничего не изменится.`,
    reasons,
    plan: { pct }
  };
}

// ---------- применение поправки ----------

export interface EaseResult {
  workout: Workout;
  /** Сколько подходов получили меньший вес. */
  lowered: number;
  /** Сколько подходов убрано (у упражнений без внешнего веса). */
  dropped: number;
}

/** Рабочий подход, который ещё предстоит выполнить: разминки и выполненные подходы не трогаем. */
const pending = (s: SetEntry): boolean => !s.done && !s.warmup;

const lighter = (weight: number, pct: number): number => {
  const next = Math.round((weight * (1 - pct / 100)) / EASE_STEP) * EASE_STEP;
  return Math.max(0, next >= weight ? weight - EASE_STEP : next);
};

/**
 * Применяет поправку к тренировке: снижает вес в невыполненных рабочих подходах на pct%.
 * У упражнений с нулевым весом (собственный вес) вместо этого убирает последний невыполненный подход,
 * но оставляет хотя бы один. Выполненные подходы, разминки и кардио не меняются. Входной объект не изменяется.
 */
export function easeWorkout(w: Workout, plan: EasePlan): EaseResult {
  let lowered = 0;
  let dropped = 0;
  const exercises: WorkoutExercise[] = w.exercises.map((we) => {
    if (we.cardio) return we;
    const todo = we.sets.filter(pending);
    if (todo.length === 0) return we;
    if (todo.every((s) => s.weight <= 0)) {
      if (todo.length < 2) return we;
      const drop = todo[todo.length - 1].id;
      dropped += 1;
      return { ...we, sets: we.sets.filter((s) => s.id !== drop) };
    }
    return {
      ...we,
      sets: we.sets.map((s) => {
        if (!pending(s) || s.weight <= 0) return s;
        const weight = lighter(s.weight, plan.pct);
        if (weight === s.weight) return s;
        lowered += 1;
        return { ...s, weight };
      })
    };
  });
  return { workout: lowered || dropped ? { ...w, exercises } : w, lowered, dropped };
}

/** Ключ в локальном хранилище (kv): поправка к этой тренировке уже применена, повторно не предлагаем. */
export const easeAppliedKey = (workoutId: string): string => `autoreg.applied.${workoutId}`;

/**
 * Можно ли отменить поправку: только пока тренировка осталась ровно такой, какой её сделала поправка.
 * Если после неё отметили подход или поменяли вес, откат вернул бы старое состояние и стёр бы эти правки.
 */
export function canUndoEase(current: Workout, eased: Workout): boolean {
  return JSON.stringify(current.exercises) === JSON.stringify(eased.exercises);
}
