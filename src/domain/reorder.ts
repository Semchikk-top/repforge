// Перестановка упражнений в тренировке. Без React: логику проверяют тесты.
//
// Единица перемещения — блок: одиночное упражнение или суперсет целиком (подряд идущие
// упражнения с одним group). Так суперсет нельзя случайно разорвать или «вклеить» в него чужое упражнение.
// Порядок внутри суперсета меняется через «Разорвать суперсет» и «Суперсет со следующим».

import { uid } from '../lib';
import type { Template, TemplateExercise, Workout, WorkoutExercise } from './types';

export interface Block { start: number; end: number } // end не включается

export function blocksOf<T extends { group?: string }>(exercises: T[]): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < exercises.length; ) {
    const g = exercises[i].group;
    let j = i + 1;
    if (g) while (j < exercises.length && exercises[j].group === g) j++;
    out.push({ start: i, end: j });
    i = j;
  }
  return out;
}

/** Номер блока, в котором лежит упражнение с индексом exIndex; -1, если такого нет. */
export function blockIndexOf<T extends { group?: string }>(exercises: T[], exIndex: number): number {
  return blocksOf(exercises).findIndex((b) => exIndex >= b.start && exIndex < b.end);
}

/** Переставить блок from так, чтобы он стал блоком номер to. Возвращает новый массив (или тот же, если менять нечего). */
export function moveBlock<T extends { group?: string }>(exercises: T[], from: number, to: number): T[] {
  const blocks = blocksOf(exercises);
  if (from === to || from < 0 || to < 0 || from >= blocks.length || to >= blocks.length) return exercises;
  const chunks = blocks.map((b) => exercises.slice(b.start, b.end));
  const [moved] = chunks.splice(from, 1);
  chunks.splice(to, 0, moved);
  // Блоки были разными, но могли хранить один и тот же group (остался от прежней связки). Если после переноса
  // такие блоки оказались рядом, они склеились бы в суперсет сами: позднему блоку даём новый group.
  for (let i = 1; i < chunks.length; i++) {
    const g = chunks[i][0].group;
    const before = chunks[i - 1][chunks[i - 1].length - 1].group;
    if (g && g === before) {
      const fresh = uid();
      chunks[i] = chunks[i].map((we) => ({ ...we, group: fresh }));
    }
  }
  return chunks.flat();
}

/** Сдвиг блока с упражнением exIndex на одну позицию вверх (-1) или вниз (+1). */
export function stepBlock<T extends { group?: string }>(exercises: T[], exIndex: number, dir: -1 | 1): T[] {
  const b = blockIndexOf(exercises, exIndex);
  return b < 0 ? exercises : moveBlock(exercises, b, b + dir);
}

/**
 * Куда встанет перетаскиваемый блок. mids — середины блоков по вертикали (в тех же единицах, что и y),
 * dragged — номер перетаскиваемого. Возвращает номер, который блок получит после переноса:
 * сколько остальных блоков находятся выше указателя.
 */
export function dropIndex(mids: number[], dragged: number, y: number): number {
  let above = 0;
  mids.forEach((m, i) => { if (i !== dragged && m < y) above++; });
  return above;
}

// ---------- отмена ----------

/** Вернуть порядок и связки, какими они были в prev. Упражнения, которых в prev нет (добавили позже), остаются в конце. */
export function restoreLayout(current: WorkoutExercise[], prev: WorkoutExercise[]): WorkoutExercise[] {
  const pos = new Map(prev.map((x, i) => [x.id, i]));
  const grp = new Map(prev.map((x) => [x.id, x.group]));
  return current
    .map((x) => (grp.has(x.id) ? { ...x, group: grp.get(x.id) } : x))
    .sort((a, b) => (pos.get(a.id) ?? Infinity) - (pos.get(b.id) ?? Infinity));
}

/** Вставить упражнение на прежнее место (после отмены удаления). */
export function insertAt(exercises: WorkoutExercise[], we: WorkoutExercise, index: number): WorkoutExercise[] {
  if (exercises.some((x) => x.id === we.id)) return exercises;
  const at = Math.max(0, Math.min(index, exercises.length));
  return [...exercises.slice(0, at), we, ...exercises.slice(at)];
}

// ---------- порядок в шаблоне ----------

/**
 * Шаблон с порядком упражнений из тренировки. null, если порядок тот же или состав упражнений другой
 * (что-то заменили, добавили, убрали): тогда сопоставить честно нельзя, и предлагать нечего.
 * Связка, которая из-за перестановки распалась (участники больше не подряд), перестаёт быть связкой.
 */
export function templateWithWorkoutOrder(t: Template, w: Workout): Template | null {
  const ids = (xs: { exerciseId: string }[]) => xs.map((x) => x.exerciseId).sort().join('|');
  if (t.exercises.length === 0 || ids(t.exercises) !== ids(w.exercises)) return null;
  const pool = new Map<string, TemplateExercise[]>();
  for (const e of t.exercises) pool.set(e.exerciseId, [...(pool.get(e.exerciseId) ?? []), e]);
  const ordered = w.exercises.map((we) => pool.get(we.exerciseId)!.shift()!);
  if (ordered.every((e, i) => e === t.exercises[i])) return null;
  const broken = new Set<string>();
  const seen = new Map<string, number>();
  ordered.forEach((e, i) => {
    if (!e.group) return;
    const last = seen.get(e.group);
    if (last !== undefined && last !== i - 1) broken.add(e.group);
    seen.set(e.group, i);
  });
  return { ...t, exercises: ordered.map((e) => (e.group && broken.has(e.group) ? { ...e, group: undefined } : e)) };
}
