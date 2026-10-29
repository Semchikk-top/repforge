import type { WorkoutExercise } from './types';
import { uid } from '../lib';

export interface GroupInfo {
  label: string | null;     // «A1», «A2», «B1»…; null — упражнение не в суперсете
  isLast: boolean;          // последнее в связке: после него начинается отдых
  nextIndex: number | null; // следующее упражнение связки
}

// Суперсет — это подряд идущие упражнения с одинаковым group; одиночное «группой» не считается
export function groupInfo(exercises: WorkoutExercise[]): GroupInfo[] {
  const out: GroupInfo[] = exercises.map(() => ({ label: null, isLast: true, nextIndex: null }));
  let letter = 0;
  for (let i = 0; i < exercises.length; ) {
    const g = exercises[i].group;
    let j = i + 1;
    if (g) while (j < exercises.length && exercises[j].group === g) j++;
    if (g && j - i >= 2) {
      const ch = String.fromCharCode(65 + (letter++ % 26));
      for (let k = i; k < j; k++) out[k] = { label: `${ch}${k - i + 1}`, isLast: k === j - 1, nextIndex: k < j - 1 ? k + 1 : null };
    }
    i = j;
  }
  return out;
}

/** Связать упражнение i со следующим: оба (и вся их связка) получают общий group */
export function linkWithNext(exercises: WorkoutExercise[], i: number): WorkoutExercise[] {
  if (i < 0 || i >= exercises.length - 1) return exercises;
  const a = exercises[i], b = exercises[i + 1];
  const id = a.group ?? b.group ?? uid();
  const runOf = (idx: number) => {
    const g = exercises[idx].group;
    if (!g) return [idx];
    let s = idx, e = idx;
    while (s > 0 && exercises[s - 1].group === g) s--;
    while (e < exercises.length - 1 && exercises[e + 1].group === g) e++;
    return Array.from({ length: e - s + 1 }, (_, k) => s + k);
  };
  const members = new Set([...runOf(i), ...runOf(i + 1)]);
  return exercises.map((we, idx) => (members.has(idx) ? { ...we, group: id } : we));
}

/** Разорвать связь между i и следующим: хвост связки получает новый group */
export function splitAfter(exercises: WorkoutExercise[], i: number): WorkoutExercise[] {
  const g = exercises[i]?.group;
  if (!g || exercises[i + 1]?.group !== g) return exercises;
  let e = i + 1;
  while (e < exercises.length - 1 && exercises[e + 1].group === g) e++;
  const fresh = uid();
  const tail = new Set(Array.from({ length: e - i }, (_, k) => i + 1 + k));
  const next = exercises.map((we, idx) => (tail.has(idx) ? { ...we, group: fresh } : we));
  // одинокое упражнение больше не «группа»
  return next.map((we, idx) => {
    if (!we.group) return we;
    const alone = next[idx - 1]?.group !== we.group && next[idx + 1]?.group !== we.group;
    return alone ? { ...we, group: undefined } : we;
  });
}

/** Сколько отдыхать после выполненного подхода. null — отдыха нет (суперсет, дроп-сет), число — секунды. */
export function restAfter(opts: { superset: GroupInfo | undefined; nextSetKind: string | undefined; restSec: number }): number | null {
  if (opts.nextSetKind === 'drop') return null;          // дроп-сет идёт сразу, без отдыха
  if (opts.nextSetKind === 'restpause') return 15;       // rest-pause: короткая пауза
  if (opts.superset?.label && !opts.superset.isLast) return null; // в суперсете отдыхаем после последнего упражнения связки
  return opts.restSec;
}
