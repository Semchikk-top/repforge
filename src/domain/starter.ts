// Онбординг: из четырёх ответов (цель, опыт, дни в неделю, оборудование) подбирает 2–3 стартовые программы.
// Чистая логика без базы и React. Ничего не навязывает: решение и создание записей остаются за пользователем.

import { hashId } from './importWorkouts';
import { SEED_EXERCISES } from './seed';
import type { Exercise, MuscleGroup } from './types';

export type Goal = 'strength' | 'muscle' | 'general';
export type Experience = 'beginner' | 'intermediate';
export type Equipment = 'gym' | 'dumbbells' | 'bodyweight';
export interface Answers { goal: Goal; experience: Experience; days: 2 | 3 | 4; equipment: Equipment }

export const GOAL_LABEL: Record<Goal, string> = { strength: 'Сила', muscle: 'Мышцы', general: 'Общая форма' };
export const EXPERIENCE_LABEL: Record<Experience, string> = { beginner: 'Только начинаю', intermediate: 'Тренируюсь больше полугода' };
export const EQUIPMENT_LABEL: Record<Equipment, string> = { gym: 'Тренажёрный зал', dumbbells: 'Гантели и скамья дома', bodyweight: 'Без оборудования' };

// Движения, из которых собираются тренировки. Конкретное упражнение выбирается по оборудованию.
type Slot =
  | 'squat' | 'hinge' | 'hpush' | 'incline' | 'vpush' | 'hpull' | 'vpull'
  | 'legAcc' | 'legCurl' | 'calves' | 'biceps' | 'triceps' | 'delts' | 'rearDelt' | 'glutes' | 'core' | 'core2';

/** Основные движения получают больше подходов и меньше повторов, добивающие — наоборот. */
const COMPOUND = new Set<Slot>(['squat', 'hinge', 'hpush', 'incline', 'vpush', 'hpull', 'vpull', 'legAcc']);

/** Упражнения вне стартового набора создаются при выборе программы как обычные пользовательские. */
const EXTRA: Record<string, { muscle: MuscleGroup; equipment: string }> = {
  'Отжимания от пола': { muscle: 'chest', equipment: 'Свой вес' },
  'Приседания без веса': { muscle: 'legs', equipment: 'Свой вес' }
};

const PICK: Record<Equipment, Partial<Record<Slot, string>>> = {
  gym: {
    squat: 'Приседания со штангой', hinge: 'Румынская тяга', hpush: 'Жим штанги лёжа', incline: 'Жим гантелей на наклонной скамье',
    vpush: 'Жим стоя', hpull: 'Тяга штанги в наклоне', vpull: 'Тяга верхнего блока', legAcc: 'Жим ногами', legCurl: 'Сгибание ног',
    calves: 'Подъём на носки стоя', biceps: 'Подъём штанги на бицепс', triceps: 'Разгибание на блоке', delts: 'Махи гантелей в стороны',
    rearDelt: 'Тяга к лицу', glutes: 'Ягодичный мостик', core: 'Планка', core2: 'Скручивания'
  },
  dumbbells: {
    squat: 'Выпады с гантелями', hinge: 'Ягодичный мостик', hpush: 'Жим гантелей на наклонной скамье', incline: 'Разводка гантелей',
    vpush: 'Жим гантелей сидя', hpull: 'Тяга гантели одной рукой', biceps: 'Молотки', delts: 'Махи гантелей в стороны',
    glutes: 'Ягодичный мостик', core: 'Планка', core2: 'Скручивания'
  },
  bodyweight: {
    squat: 'Приседания без веса', hpush: 'Отжимания от пола', core: 'Планка', core2: 'Скручивания'
  }
};

interface Blueprint {
  id: string;
  title: string;
  description: string;
  days: 2 | 3 | 4;
  levels: Experience[];
  weekdays: number[]; // 1 — понедельник
  sessions: { title: string; core: Slot[]; extra: Slot[] }[]; // extra — только для опытных
}

const BLUEPRINTS: Blueprint[] = [
  {
    id: 'fb2', title: 'Всё тело, 2 дня', days: 2, levels: ['beginner', 'intermediate'], weekdays: [1, 4],
    description: 'Две тренировки на всё тело с днём отдыха между ними. Самый простой старт: хватает времени на восстановление.',
    sessions: [
      { title: 'Всё тело A', core: ['squat', 'hpush', 'hpull', 'core'], extra: ['biceps'] },
      { title: 'Всё тело B', core: ['hinge', 'vpush', 'vpull', 'core2'], extra: ['triceps'] }
    ]
  },
  {
    id: 'fb3', title: 'Всё тело, 3 дня', days: 3, levels: ['beginner', 'intermediate'], weekdays: [1, 3, 5],
    description: 'Три тренировки на всё тело через день. Каждая мышечная группа работает несколько раз в неделю, хорошо подходит начинающим.',
    sessions: [
      { title: 'Всё тело A', core: ['squat', 'hpush', 'hpull', 'core'], extra: ['biceps'] },
      { title: 'Всё тело B', core: ['hinge', 'vpush', 'vpull', 'core2'], extra: ['triceps'] },
      { title: 'Всё тело C', core: ['legAcc', 'incline', 'hpull', 'delts'], extra: ['calves'] }
    ]
  },
  {
    id: 'ppl3', title: 'Жим / тяга / ноги', days: 3, levels: ['intermediate'], weekdays: [1, 3, 5],
    description: 'Три дня с разделением: жимовые движения, тяговые и ноги. Больше объёма на каждую группу за тренировку.',
    sessions: [
      { title: 'Жим', core: ['hpush', 'vpush', 'incline'], extra: ['triceps', 'delts'] },
      { title: 'Тяга', core: ['vpull', 'hpull', 'biceps'], extra: ['rearDelt'] },
      { title: 'Ноги', core: ['squat', 'hinge', 'legAcc'], extra: ['legCurl', 'calves'] }
    ]
  },
  {
    id: 'ul4', title: 'Верх / низ, 4 дня', days: 4, levels: ['beginner', 'intermediate'], weekdays: [1, 2, 4, 5],
    description: 'Две тренировки на верх тела и две на низ. Каждая группа работает дважды в неделю.',
    sessions: [
      { title: 'Верх A', core: ['hpush', 'hpull', 'vpush', 'vpull'], extra: ['biceps', 'triceps'] },
      { title: 'Низ A', core: ['squat', 'hinge', 'legAcc', 'core'], extra: ['calves'] },
      { title: 'Верх B', core: ['incline', 'vpull', 'hpull', 'delts'], extra: ['triceps', 'biceps'] },
      { title: 'Низ B', core: ['hinge', 'squat', 'legCurl', 'core2'], extra: ['glutes'] }
    ]
  }
];

// подходы × повторы: основное движение / добивающее
const SCHEME: Record<Goal, { compound: [number, number]; accessory: [number, number] }> = {
  strength: { compound: [5, 5], accessory: [3, 8] },
  muscle: { compound: [3, 8], accessory: [3, 12] },
  general: { compound: [3, 10], accessory: [2, 12] }
};

export interface StarterExercise { name: string; exerciseId: string; sets: number; reps: number; isNew: boolean }
export interface StarterSession { title: string; exercises: StarterExercise[] }
export interface StarterPlan {
  id: string;
  title: string;
  description: string;
  weekdays: number[];
  sessions: StarterSession[];
  /** Упражнения, которых нет в приложении: будут созданы при выборе программы. */
  newExercises: { id: string; name: string; muscle: MuscleGroup; equipment: string }[];
  /** Пояснение, если оборудование сильно ограничило набор. */
  note?: string;
}

const seedByName = new Map(SEED_EXERCISES.map((e) => [e.name, e.id]));
export const starterExerciseId = (name: string): string => seedByName.get(name) ?? `start-ex-${hashId(name)}`;

function build(bp: Blueprint, a: Answers): StarterPlan | null {
  const pick = PICK[a.equipment];
  const scheme = SCHEME[a.goal];
  const maxExercises = a.experience === 'beginner' ? 5 : 7;
  const used = new Set<string>();
  const newEx = new Map<string, StarterPlan['newExercises'][number]>();

  const sessions: StarterSession[] = [];
  for (const s of bp.sessions) {
    const slots = [...s.core, ...(a.experience === 'intermediate' ? s.extra : [])];
    const exercises: StarterExercise[] = [];
    const inSession = new Set<string>();
    for (const slot of slots) {
      const name = pick[slot];
      if (!name || inSession.has(name) || exercises.length >= maxExercises) continue;
      inSession.add(name); used.add(name);
      const [sets, reps] = COMPOUND.has(slot) ? scheme.compound : scheme.accessory;
      const exerciseId = starterExerciseId(name);
      const isNew = !seedByName.has(name);
      if (isNew && !newEx.has(exerciseId)) newEx.set(exerciseId, { id: exerciseId, name, ...EXTRA[name] });
      exercises.push({ name, exerciseId, sets: name === 'Планка' ? 3 : sets, reps: name === 'Планка' ? 30 : reps, isNew });
    }
    if (exercises.length >= 2) sessions.push({ title: s.title, exercises });
  }
  if (sessions.length === 0) return null;
  return {
    id: bp.id, title: bp.title, description: bp.description, weekdays: bp.weekdays.slice(0, sessions.length), sessions,
    newExercises: [...newEx.values()],
    note: [
      a.equipment === 'bodyweight' ? 'Без оборудования набор получается коротким. Когда появится турник или гантели, программу можно расширить.' : '',
      used.has('Планка') ? 'Для планки в поле повторов записывай секунды.' : ''
    ].filter(Boolean).join(' ') || undefined
  };
}

/**
 * Подбирает до трёх программ. Не предлагает программы с большим числом дней, чем выбрано;
 * подходящие по числу дней и уровню идут первыми. Для любого ответа возвращается хотя бы одна программа.
 */
export function recommendPrograms(a: Answers): StarterPlan[] {
  const scored = BLUEPRINTS
    .filter((b) => b.days <= a.days)
    .map((b) => ({ b, score: (b.days === a.days ? 10 : 10 - 4 * (a.days - b.days)) + (b.levels.includes(a.experience) ? 3 : -10) + (a.experience === 'intermediate' && b.id.startsWith('ppl') ? 1 : 0) }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || y.b.days - x.b.days);
  const out: StarterPlan[] = [];
  for (const { b } of scored) {
    const plan = build(b, a);
    if (plan) out.push(plan);
    if (out.length === 3) break;
  }
  return out;
}

/** Нужен ли онбординг: данных ещё нет совсем и пользователь не отказывался. Опытный человек с историей карточки не видит. */
export function shouldOfferOnboarding(counts: { workouts: number; templates: number; programs: number }, dismissed: boolean): boolean {
  return !dismissed && counts.workouts === 0 && counts.templates === 0 && counts.programs === 0;
}

/** Для проверок: все упражнения плана известны либо среди имеющихся, либо среди создаваемых. */
export function missingExercises(plan: StarterPlan, existing: Pick<Exercise, 'id' | 'deletedAt'>[]): string[] {
  const have = new Set(existing.filter((e) => !e.deletedAt).map((e) => e.id));
  const create = new Set(plan.newExercises.map((e) => e.id));
  return plan.sessions.flatMap((s) => s.exercises).filter((e) => !have.has(e.exerciseId) && !create.has(e.exerciseId)).map((e) => e.name);
}
