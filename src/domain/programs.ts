import { addDays, parseDate, toDateStr } from '../lib';
import { exercisesFromTemplate } from './ops';
import type { Exercise, Program, Template, Workout, WorkoutExercise } from './types';

export const WEEKDAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** Ближайший понедельник (включая сегодня, если сегодня понедельник) */
export function nextMonday(from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  return toDateStr(addDays(d, (8 - (d.getDay() || 7)) % 7));
}

/** Понедельник недели, в которую попадает дата */
export function mondayOf(date: string): Date {
  const d = parseDate(date);
  return addDays(d, -((d.getDay() + 6) % 7));
}

export const slotKey = (programId: string, week: number, weekday: number) => `${programId}:${week}:${weekday}`;

export interface PlannedSlot { date: string; title: string; programSlot: string; exercises: WorkoutExercise[] }

/** Какие тренировки программа ещё не назначила. Уже существующие и прошедшие даты пропускаются: так повторное нажатие безопасно. */
export function planProgram(opts: {
  program: Program; templates: Map<string, Template>; existing: Workout[]; history: Workout[]; exMap: Map<string, Exercise>; today?: string;
}): { slots: PlannedSlot[]; skippedPast: number; missingTemplates: number } {
  const { program, templates, existing, history, exMap } = opts;
  const today = opts.today ?? toDateStr(new Date());
  const have = new Set(existing.filter((w) => !w.deletedAt && w.programSlot).map((w) => w.programSlot));
  const monday = mondayOf(program.startDate);
  const slots: PlannedSlot[] = [];
  let skippedPast = 0, missingTemplates = 0;
  for (let week = 0; week < program.weeks; week++) {
    for (const day of [...program.days].sort((a, b) => a.weekday - b.weekday)) {
      const tpl = templates.get(day.templateId);
      if (!tpl || tpl.deletedAt) { missingTemplates++; continue; }
      const date = toDateStr(addDays(monday, week * 7 + (day.weekday - 1)));
      if (date < today) { skippedPast++; continue; }
      const key = slotKey(program.id, week, day.weekday);
      if (have.has(key)) continue;
      slots.push({ date, title: tpl.title, programSlot: key, exercises: exercisesFromTemplate(tpl, history, exMap) });
    }
  }
  return { slots, skippedPast, missingTemplates };
}

/** Номер текущей недели программы (1…weeks) или null, если она не идёт */
export function currentWeek(program: Program, today: string = toDateStr(new Date())): number | null {
  const diff = Math.floor((parseDate(today).getTime() - mondayOf(program.startDate).getTime()) / (7 * 86400000));
  return diff >= 0 && diff < program.weeks ? diff + 1 : null;
}
