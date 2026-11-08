// Плашка «Убери инвентарь»: после последнего рабочего подхода упражнения (или суперсета) показывается напоминание,
// и только после галочки начинается обычный отдых. Чистые функции: без базы, часов и React.
import type { GroupInfo } from './superset';
import { isCardio, type Exercise, type SetEntry, type WorkoutExercise } from './types';

const norm = (s: string | undefined) => (s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/** Оборудование, после которого убирать нечего. Пустое или неизвестное оборудование считается инвентарём. */
const NO_INVENTORY = new Set(['свой вес', 'без оборудования']);

/** Нужна ли уборка после упражнения: силовое, оборудование не «Свой вес» и не «Без оборудования». Неизвестное упражнение (удалено) — нет. */
export function needsEquipmentCleanup(exercise: Exercise | undefined): boolean {
  if (!exercise || isCardio(exercise)) return false;
  return !NO_INVENTORY.has(norm(exercise.equipment));
}

const isWork = (s: SetEntry) => !s.warmup;

/** Индексы упражнений связки, в которой стоит `index` (одиночное упражнение — только оно само). */
export function groupMembers(exercises: WorkoutExercise[], groupInfo: GroupInfo[], index: number): number[] {
  const g = exercises[index]?.group;
  if (!g || !groupInfo[index]?.label) return [index];
  let s = index, e = index;
  while (s > 0 && exercises[s - 1].group === g) s--;
  while (e < exercises.length - 1 && exercises[e + 1].group === g) e++;
  return Array.from({ length: e - s + 1 }, (_, k) => s + k);
}

/**
 * Показывать ли плашку после отметки `set` в упражнении `index`. `exercises` — состояние до записи галочки,
 * поэтому сам `set` считается выполненным по определению, а остальные подходы берутся как есть.
 */
export function shouldShowCleanup(opts: {
  exercises: WorkoutExercise[];
  groupInfo: GroupInfo[];
  index: number;
  exerciseMap: Map<string, Exercise>;
  set: SetEntry;
}): boolean {
  const { exercises, groupInfo, index, exerciseMap, set } = opts;
  const we = exercises[index];
  if (!we || set.done || !isWork(set)) return false;          // set.done — состояние до отметки: снимаем галочку — плашки нет
  if (isCardio(exerciseMap.get(we.exerciseId))) return false;
  // в упражнении не осталось рабочих подходов, кроме только что отмеченного
  if (we.sets.some((s) => s.id !== set.id && isWork(s) && !s.done)) return false;
  const info = groupInfo[index];
  const members = groupMembers(exercises, groupInfo, index);
  if (info?.label) {
    if (!info.isLast) return false;                           // уборка после последнего упражнения связки
    const open = members.some((i) => i !== index && exercises[i].sets.some((s) => isWork(s) && !s.done));
    if (open) return false;
  }
  return members.some((i) => needsEquipmentCleanup(exerciseMap.get(exercises[i].exerciseId)));
}

/** Что показать в плашке: названия упражнений связки, у которых есть инвентарь (для одиночного — его название). */
export function cleanupLabel(opts: { exercises: WorkoutExercise[]; groupInfo: GroupInfo[]; index: number; exerciseMap: Map<string, Exercise> }): string {
  const { exercises, groupInfo, index, exerciseMap } = opts;
  const names = groupMembers(exercises, groupInfo, index)
    .map((i) => exerciseMap.get(exercises[i].exerciseId))
    .filter((e): e is Exercise => needsEquipmentCleanup(e))
    .map((e) => e.name);
  return names.join(' · ');
}
