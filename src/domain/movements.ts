// Замена упражнения без разрыва истории. Модель данных не меняется: «движение» упражнения выводится из таблицы
// для стартовых упражнений и из названия для остальных. История каждого упражнения остаётся его собственной, а у замены
// показывается подсказка по похожему упражнению: вес не переносится автоматически, решение за пользователем.

import { lastPerformance } from './analytics';
import { SEED_EXERCISES } from './seed';
import { isCardio, type Exercise, type SetEntry, type Workout } from './types';

export type Movement =
  | 'horizontal-press' | 'incline-press' | 'push-up' | 'dip' | 'chest-fly' | 'vertical-press' | 'lateral-raise' | 'rear-delt'
  | 'vertical-pull' | 'horizontal-pull' | 'squat' | 'lunge' | 'leg-press' | 'knee-extension' | 'knee-flexion'
  | 'hinge' | 'hip-thrust' | 'elbow-flexion' | 'elbow-extension' | 'calf-raise' | 'core-flexion' | 'core-hold' | 'leg-raise';

export const MOVEMENT_LABEL: Record<Movement, string> = {
  'horizontal-press': 'Жим лёжа', 'incline-press': 'Жим на наклонной', 'push-up': 'Отжимания', dip: 'Отжимания на брусьях', 'chest-fly': 'Разведения',
  'vertical-press': 'Жим над головой', 'lateral-raise': 'Махи в стороны', 'rear-delt': 'Задние дельты', 'vertical-pull': 'Вертикальная тяга',
  'horizontal-pull': 'Горизонтальная тяга', squat: 'Приседания', lunge: 'Выпады', 'leg-press': 'Жим ногами', 'knee-extension': 'Разгибание ног',
  'knee-flexion': 'Сгибание ног', hinge: 'Тяга с прямой спиной', 'hip-thrust': 'Ягодичный мостик', 'elbow-flexion': 'Сгибание рук',
  'elbow-extension': 'Разгибание рук', 'calf-raise': 'Подъём на носки', 'core-flexion': 'Скручивания', 'core-hold': 'Планка', 'leg-raise': 'Подъём ног'
};

/** Семейство: более широкая группа похожих движений. Внутри семейства упражнения можно заменять друг другом. */
const FAMILY: Record<Movement, string> = {
  'horizontal-press': 'push-h', 'incline-press': 'push-h', 'push-up': 'push-h', dip: 'push-h', 'chest-fly': 'push-h',
  'vertical-press': 'push-v', 'lateral-raise': 'delts', 'rear-delt': 'delts',
  'vertical-pull': 'pull-v', 'horizontal-pull': 'pull-h',
  squat: 'squat', lunge: 'squat', 'leg-press': 'squat', 'knee-extension': 'knee', 'knee-flexion': 'knee',
  hinge: 'hinge', 'hip-thrust': 'hinge', 'elbow-flexion': 'biceps', 'elbow-extension': 'triceps',
  'calf-raise': 'calves', 'core-flexion': 'core', 'core-hold': 'core', 'leg-raise': 'core'
};
export const familyOf = (m: Movement): string => FAMILY[m];

const SEED_MOVEMENT: Record<string, Movement> = {
  'Жим штанги лёжа': 'horizontal-press', 'Жим гантелей на наклонной скамье': 'incline-press', 'Отжимания на брусьях': 'dip', 'Разводка гантелей': 'chest-fly',
  'Подтягивания': 'vertical-pull', 'Тяга штанги в наклоне': 'horizontal-pull', 'Тяга верхнего блока': 'vertical-pull', 'Тяга нижнего блока': 'horizontal-pull',
  'Тяга гантели одной рукой': 'horizontal-pull', 'Становая тяга': 'hinge', 'Приседания со штангой': 'squat', 'Жим ногами': 'leg-press',
  'Выпады с гантелями': 'lunge', 'Разгибание ног': 'knee-extension', 'Сгибание ног': 'knee-flexion', 'Румынская тяга': 'hinge', 'Ягодичный мостик': 'hip-thrust',
  'Жим стоя': 'vertical-press', 'Жим гантелей сидя': 'vertical-press', 'Махи гантелей в стороны': 'lateral-raise', 'Тяга к лицу': 'rear-delt',
  'Подъём штанги на бицепс': 'elbow-flexion', 'Молотки': 'elbow-flexion', 'Французский жим': 'elbow-extension', 'Разгибание на блоке': 'elbow-extension',
  'Скручивания': 'core-flexion', 'Планка': 'core-hold', 'Подъём ног в висе': 'leg-raise', 'Подъём на носки стоя': 'calf-raise',
  // упражнения, которые создают онбординг и импорт
  'Отжимания от пола': 'push-up', 'Приседания без веса': 'squat'
};
const SEED_BY_ID = new Map(SEED_EXERCISES.map((e) => [e.id, SEED_MOVEMENT[e.name]]));

// Порядок важен: частные случаи раньше общих («жим ногами» раньше «жима», «тяга к лицу» раньше «тяги»).
const RULES: [RegExp, Movement][] = [
  [/отжимани\S* от пола|push.?up/i, 'push-up'],
  [/брусь|\bdips?\b|chest dip/i, 'dip'],
  [/жим\S* ног|leg press/i, 'leg-press'],
  [/разгибани\S* ног|leg extension/i, 'knee-extension'],
  [/сгибани\S* ног|leg curl/i, 'knee-flexion'],
  [/к лицу|face pull|задн\S* дельт|reverse fly/i, 'rear-delt'],
  [/подтягив|верхн\S* блок|pulldown|pull.?up|chin.?up/i, 'vertical-pull'],
  [/ягодичн|hip thrust|glute bridge|мостик/i, 'hip-thrust'],
  [/становая|румынск|deadlift|good.?morning/i, 'hinge'],
  [/наклон\S*.*жим|жим\S*.*наклон|incline/i, 'incline-press'],
  [/развод|разведен(?!.*в сторон)|chest fly|dumbbell fly|pec.?deck|пек.?дек|кроссовер/i, 'chest-fly'],
  [/жим\S*.*(стоя|сидя)|жим над головой|overhead|military|shoulder press|арнольд/i, 'vertical-press'],
  [/жим\S*.*лёж|жим\S*.*лежа|bench press/i, 'horizontal-press'],
  [/мах|lateral raise|в сторон/i, 'lateral-raise'],
  [/тяга|\brow\b|rowing/i, 'horizontal-pull'],
  [/присед|squat/i, 'squat'],
  [/выпад|lunge|болгарск/i, 'lunge'],
  [/подъ[её]м\S* ног|leg raise|knee raise/i, 'leg-raise'],
  [/подъ[её]м\S* на носк|носк|икр|calf/i, 'calf-raise'],
  [/трицепс|француз|pushdown|skull|tricep|разгибани\S* рук/i, 'elbow-extension'],
  [/бицепс|молот|curl|сгибани\S* рук/i, 'elbow-flexion'],
  [/скручив|crunch|пресс/i, 'core-flexion'],
  [/планк|plank/i, 'core-hold']
];

/** Движение упражнения: таблица для стартовых, иначе по названию. null — кардио или название не распознано. */
export function movementOf(ex: Pick<Exercise, 'id' | 'name' | 'muscle'>): Movement | null {
  if (ex.muscle === 'cardio') return null;
  const seeded = SEED_BY_ID.get(ex.id);
  if (seeded) return seeded;
  for (const [re, m] of RULES) if (re.test(ex.name)) return m;
  return null;
}

export type Relation = 'same-movement' | 'same-family' | 'same-muscle';
export const RELATION_LABEL: Record<Relation, string> = { 'same-movement': 'То же движение', 'same-family': 'Похожее движение', 'same-muscle': 'Та же мышца' };
const RANK: Record<Relation, number> = { 'same-movement': 0, 'same-family': 1, 'same-muscle': 2 };

export interface Alternative {
  exercise: Exercise;
  relation: Relation;
  /** Собственный последний результат по этому упражнению, если он есть. */
  own: { date: string; sets: SetEntry[] } | null;
}

function relationOf(target: Exercise, other: Exercise): Relation | null {
  const a = movementOf(target), b = movementOf(other);
  if (a && b && a === b) return 'same-movement';
  if (a && b && FAMILY[a] === FAMILY[b]) return 'same-family';
  return other.muscle === target.muscle ? 'same-muscle' : null;
}

/** Сколько раз упражнение выполнялось: чаще используемые идут выше при равной близости. */
function usage(history: Workout[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of history) {
    if (w.deletedAt || w.status !== 'done') continue;
    for (const we of w.exercises) if (we.sets.some((s) => s.done)) m.set(we.exerciseId, (m.get(we.exerciseId) ?? 0) + 1);
  }
  return m;
}

/**
 * Варианты замены: сначала то же движение, потом похожее, потом та же мышца; внутри — привычные раньше редких.
 * Исходное упражнение, кардио, удалённые и уже стоящие в тренировке (`exclude`) не предлагаются.
 */
export function alternativesFor(target: Exercise, all: Exercise[], history: Workout[], exclude: Set<string> = new Set()): Alternative[] {
  if (isCardio(target)) return [];
  const used = usage(history);
  return all
    .filter((e) => e.id !== target.id && !e.deletedAt && !isCardio(e) && !exclude.has(e.id))
    .flatMap((e) => { const relation = relationOf(target, e); return relation ? [{ exercise: e, relation, own: lastPerformance(history, e.id) }] : []; })
    .sort((x, y) =>
      RANK[x.relation] - RANK[y.relation]
      || (used.get(y.exercise.id) ?? 0) - (used.get(x.exercise.id) ?? 0)
      || x.exercise.name.localeCompare(y.exercise.name, 'ru'));
}

export interface HistoryHint { from: Exercise; relation: 'same-movement' | 'same-family'; date: string; sets: SetEntry[] }

/**
 * Подсказка для упражнения без собственной истории: последний результат по самому близкому упражнению
 * (то же движение, затем семейство). Если своя история есть, подсказка не нужна. Вес не подставляется сам.
 */
export function historyHint(target: Exercise, all: Exercise[], history: Workout[], excludeWorkoutId?: string): HistoryHint | null {
  if (isCardio(target) || lastPerformance(history, target.id, excludeWorkoutId)) return null;
  const candidates = all
    .filter((e) => e.id !== target.id && !e.deletedAt && !isCardio(e))
    .flatMap((e) => { const r = relationOf(target, e); return r === 'same-movement' || r === 'same-family' ? [{ e, r }] : []; })
    .sort((x, y) => RANK[x.r] - RANK[y.r]);
  let best: HistoryHint | null = null;
  for (const { e, r } of candidates) {
    const last = lastPerformance(history, e.id, excludeWorkoutId);
    if (!last) continue;
    // ближайшее по смыслу упражнение важнее более свежего, но чужого; при равенстве берём то, что делали позже
    if (!best || RANK[r] < RANK[best.relation] || (RANK[r] === RANK[best.relation] && last.date > best.date)) best = { from: e, relation: r as HistoryHint['relation'], date: last.date, sets: last.sets };
  }
  return best;
}
