// Редактирование шаблона: черновик правится целиком, а в базу попадает только по «Сохранить».
// Так «Отмена» ничего не портит, а уже созданные тренировки не затрагиваются: они хранят свои копии упражнений.
// Чистая логика, без React и базы.

import { moveBlock, stepBlock } from './reorder';
import type { ID, Program, Template, TemplateExercise } from './types';

export const TITLE_MAX = 60;
export const SETS_MAX = 20;
export const REPS_MAX = 100;
export const WEIGHT_MAX = 1000;

export interface TemplateDraft { title: string; exercises: TemplateExercise[] }

const clampInt = (v: number, lo: number, hi: number, fallback: number): number => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback);

/** Копия шаблона для правки: изменения черновика не трогают исходник. */
export function draftOf(t: Pick<Template, 'title' | 'exercises'>): TemplateDraft {
  return { title: t.title, exercises: t.exercises.map((e) => ({ ...e })) };
}

/** Связка из одного упражнения связкой не является: убираем group у «одиночек». */
export function cleanGroups(exercises: TemplateExercise[]): TemplateExercise[] {
  return exercises.map((e, i) => {
    if (!e.group) return e;
    const alone = exercises[i - 1]?.group !== e.group && exercises[i + 1]?.group !== e.group;
    return alone ? { ...e, group: undefined } : e;
  });
}

export const renameDraft = (d: TemplateDraft, title: string): TemplateDraft => ({ ...d, title });

/** Новое упражнение в конец: для силового три подхода по 10, вес 0 (подставится по истории при старте тренировки). */
export function addToDraft(d: TemplateDraft, exerciseId: ID, cardio = false): TemplateDraft {
  return { ...d, exercises: [...d.exercises, { exerciseId, sets: cardio ? 1 : 3, reps: 10, weight: 0 }] };
}

export function removeFromDraft(d: TemplateDraft, index: number): TemplateDraft {
  if (index < 0 || index >= d.exercises.length) return d;
  return { ...d, exercises: cleanGroups(d.exercises.filter((_, i) => i !== index)) };
}

/** Сдвиг блока (одиночного упражнения или связки целиком) вверх (-1) или вниз (+1). */
export function stepInDraft(d: TemplateDraft, index: number, dir: -1 | 1): TemplateDraft {
  const next = stepBlock(d.exercises, index, dir);
  return next === d.exercises ? d : { ...d, exercises: next };
}

export function moveInDraft(d: TemplateDraft, fromBlock: number, toBlock: number): TemplateDraft {
  const next = moveBlock(d.exercises, fromBlock, toBlock);
  return next === d.exercises ? d : { ...d, exercises: next };
}

export type ExercisePatch = Partial<Pick<TemplateExercise, 'sets' | 'reps' | 'weight'>>;

/** Правка подходов, повторов и рабочего веса. Значения приводятся к допустимым границам. */
export function patchInDraft(d: TemplateDraft, index: number, patch: ExercisePatch): TemplateDraft {
  const cur = d.exercises[index];
  if (!cur) return d;
  const next: TemplateExercise = {
    ...cur,
    ...(patch.sets !== undefined ? { sets: clampInt(patch.sets, 1, SETS_MAX, cur.sets) } : {}),
    ...(patch.reps !== undefined ? { reps: clampInt(patch.reps, 1, REPS_MAX, cur.reps) } : {}),
    ...(patch.weight !== undefined ? { weight: Number.isFinite(patch.weight) ? Math.min(WEIGHT_MAX, Math.max(0, Math.round(patch.weight * 100) / 100)) : cur.weight } : {})
  };
  return { ...d, exercises: d.exercises.map((e, i) => (i === index ? next : e)) };
}

export const titleOk = (title: string): boolean => title.trim().length > 0;

/** Можно сохранять: есть название и хотя бы одно упражнение. */
export const draftValid = (d: TemplateDraft): boolean => titleOk(d.title) && d.exercises.length > 0;

const sameEx = (a: TemplateExercise, b: TemplateExercise): boolean =>
  a.exerciseId === b.exerciseId && a.group === b.group && a.sets === b.sets && a.reps === b.reps && a.weight === b.weight;

/** Отличается ли черновик от сохранённого шаблона (название сравнивается как оно будет сохранено). */
export function isDirty(t: Pick<Template, 'title' | 'exercises'>, d: TemplateDraft): boolean {
  return t.title !== d.title.trim().slice(0, TITLE_MAX) || t.exercises.length !== d.exercises.length || t.exercises.some((e, i) => !sameEx(e, d.exercises[i]));
}

/** Шаблон с применённым черновиком: id, даты создания и остальное остаются прежними. */
export function applyDraft(t: Template, d: TemplateDraft): Template {
  return { ...t, title: d.title.trim().slice(0, TITLE_MAX), exercises: cleanGroups(d.exercises.map((e) => ({ ...e }))) };
}

/** Программы, в которых используется шаблон (удалённые и архивные не в счёт). */
export function programsUsing(programs: Program[], templateId: ID): Program[] {
  return programs.filter((p) => !p.deletedAt && !p.archivedAt && p.days.some((d) => d.templateId === templateId));
}
