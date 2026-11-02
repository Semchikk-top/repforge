// Импорт тренировок из CSV-экспорта Hevy и Strong. Чистая логика: без базы и React, её проверяют тесты.
//
// Форматы описаны по документации и открытым примерам экспортов; на реальных файлах конкретного пользователя
// они не проверялись, поэтому разбор терпим к порядку и названиям колонок, а всё непонятное считается и показывается
// в предпросмотре, а не молча теряется. Импорт только создаёт записи: существующие не перезаписываются.

import type { Exercise, MuscleGroup, SetKind, Workout } from './types';

// ---------- CSV ----------

/** Разбор CSV: BOM, кавычки, переносы строк внутри ячеек, разделитель определяется сам (запятая, «;» или табуляция). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  let inQ = false;
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of firstLine) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  const delim = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? [','])[0];

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  inQ = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else cell += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

// ---------- разобранные данные ----------

export type ImportFormat = 'hevy' | 'strong';
export type WeightUnit = 'kg' | 'lb';

export interface ImportedSet { weight: number; reps: number; warmup: boolean; kind: SetKind; rpe?: number; note?: string }
export interface ImportedExercise { name: string; sets: ImportedSet[]; note?: string; supersetKey?: string }
export interface ImportedWorkout {
  /** Стабильный ключ источника: по нему считается id, поэтому повторный импорт того же файла ничего не дублирует. */
  key: string;
  date: string;
  title: string;
  startedAt?: number;
  finishedAt?: number;
  note?: string;
  exercises: ImportedExercise[];
}

export interface ParsedImport {
  format: ImportFormat;
  /** Единица веса, если она видна по заголовку; null — файл не говорит, нужно спросить. */
  detectedUnit: WeightUnit | null;
  workouts: ImportedWorkout[];
  /** Строки, которые не удалось прочитать (дата или название не распознаны). */
  badRows: number;
  /** Подходы без повторов (планка, бег, время и дистанция): в этой версии не переносятся. */
  skippedSets: number;
}

export type ParseResult = { ok: true; data: ParsedImport } | { ok: false; error: string };

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const t = s.trim().replace(',', '.');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};
const pad = (n: number) => String(n).padStart(2, '0');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Дата и время без пересчёта часовых поясов: берём то, что написано в файле. Понимает «2024-01-15 10:30:00» и «15 Jan 2024, 10:30». */
export function parseDateTime(s: string): { date: string; ms: number } | null {
  const t = s.trim();
  let y: number, mo: number, d: number, h = 0, mi = 0;
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(t);
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; h = m[4] ? +m[4] : 0; mi = m[5] ? +m[5] : 0; }
  else {
    m = /^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2}))?/.exec(t);
    const idx = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1;
    if (!m || idx < 0) return null;
    y = +m[3]; mo = idx + 1; d = +m[1]; h = m[4] ? +m[4] : 0; mi = m[5] ? +m[5] : 0;
  }
  const ms = new Date(y, mo - 1, d, h, mi).getTime();
  if (!Number.isFinite(ms) || mo < 1 || mo > 12 || d < 1 || d > 31 || new Date(ms).getDate() !== d) return null;
  return { date: `${y}-${pad(mo)}-${pad(d)}`, ms };
}

/** «1h 5m», «45m», «1h», «1:05:00», «3900» (секунды) → секунды. */
export function parseDuration(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (!t) return null;
  let m = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?$/.exec(t);
  if (m && (m[1] || m[2] || m[3])) return (+(m[1] ?? 0)) * 3600 + (+(m[2] ?? 0)) * 60 + +(m[3] ?? 0);
  m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (m) return m[3] !== undefined ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
  const n = num(t);
  return n !== null && n >= 0 ? Math.round(n) : null;
}

const roundRpe = (v: number | null): number | undefined => (v !== null && v >= 6 && v <= 10 ? Math.round(v * 2) / 2 : undefined);

// ---------- определение формата ----------

const headerIndex = (header: string[]) => {
  const map = new Map<string, number>();
  header.forEach((h, i) => { const k = norm(h); if (k && !map.has(k)) map.set(k, i); });
  return (...names: string[]): number => {
    for (const n of names) { const i = map.get(norm(n)); if (i !== undefined) return i; }
    return -1;
  };
};

export function detectFormat(header: string[]): ImportFormat | null {
  const col = headerIndex(header);
  if (col('exercise_title') >= 0 && col('start_time') >= 0) return 'hevy';
  if (col('Exercise Name') >= 0 && col('Date') >= 0 && col('Workout Name') >= 0) return 'strong';
  return null;
}

// ---------- сборка тренировок из строк ----------

interface RowSet {
  workoutKey: string; title: string; start: { date: string; ms: number }; endMs?: number; durationSec?: number; note?: string;
  exercise: string; exNote?: string; superset?: string; set: ImportedSet | null; // null — подход без повторов
}

function assemble(format: ImportFormat, rows: RowSet[], detectedUnit: WeightUnit | null, badRows: number): ParsedImport {
  const byKey = new Map<string, ImportedWorkout>();
  let skippedSets = 0;
  for (const r of rows) {
    let w = byKey.get(r.workoutKey);
    if (!w) {
      const finishedAt = r.endMs ?? (r.durationSec !== undefined ? r.start.ms + r.durationSec * 1000 : undefined);
      w = { key: `${format}|${r.workoutKey}`, date: r.start.date, title: r.title, startedAt: r.start.ms, finishedAt: finishedAt && finishedAt > r.start.ms ? finishedAt : undefined, note: r.note, exercises: [] };
      byKey.set(r.workoutKey, w);
    }
    // тот же упражнение подряд или с другой позиции: подходы одного названия объединяются в первое вхождение
    let ex = w.exercises.find((e) => e.name === r.exercise);
    if (!ex) { ex = { name: r.exercise, sets: [], note: r.exNote, supersetKey: r.superset }; w.exercises.push(ex); }
    if (r.set) ex.sets.push(r.set); else skippedSets++;
  }
  const workouts = [...byKey.values()]
    .map((w) => ({ ...w, exercises: w.exercises.filter((e) => e.sets.length > 0) }))
    .filter((w) => w.exercises.length > 0)
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  return { format, detectedUnit, workouts, badRows, skippedSets };
}

function parseHevy(header: string[], body: string[][]): ParsedImport {
  const col = headerIndex(header);
  const c = {
    title: col('title'), start: col('start_time'), end: col('end_time'), desc: col('description'), ex: col('exercise_title'),
    ss: col('superset_id'), exNote: col('exercise_notes'), type: col('set_type'),
    kg: col('weight_kg'), lbs: col('weight_lbs'), reps: col('reps'), rpe: col('rpe')
  };
  const unit: WeightUnit | null = c.kg >= 0 ? 'kg' : c.lbs >= 0 ? 'lb' : null;
  const wCol = c.kg >= 0 ? c.kg : c.lbs;
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  const out: RowSet[] = [];
  let bad = 0;
  for (const r of body) {
    const start = parseDateTime(get(r, c.start));
    const exercise = get(r, c.ex);
    if (!start || !exercise) { bad++; continue; }
    const end = c.end >= 0 ? parseDateTime(get(r, c.end)) : null;
    const reps = num(get(r, c.reps));
    const type = get(r, c.type).toLowerCase();
    const weight = num(get(r, wCol)) ?? 0;
    const title = get(r, c.title) || 'Тренировка';
    const ss = get(r, c.ss);
    out.push({
      workoutKey: `${get(r, c.start)}|${title}`, title, start, endMs: end?.ms, note: get(r, c.desc) || undefined,
      exercise, exNote: get(r, c.exNote) || undefined, superset: ss || undefined,
      set: reps !== null && reps >= 1
        ? { weight: Math.max(0, weight), reps: Math.round(reps), warmup: type === 'warmup', kind: type === 'dropset' ? 'drop' : 'normal', rpe: roundRpe(num(get(r, c.rpe))) }
        : null
    });
  }
  return assemble('hevy', out, unit, bad);
}

function parseStrong(header: string[], body: string[][]): ParsedImport {
  const col = headerIndex(header);
  const wKg = col('Weight (kg)', 'Weight kg'), wLb = col('Weight (lbs)', 'Weight (lb)', 'Weight lbs');
  const c = {
    date: col('Date'), title: col('Workout Name'), dur: col('Duration'), ex: col('Exercise Name'), order: col('Set Order'),
    weight: wKg >= 0 ? wKg : wLb >= 0 ? wLb : col('Weight'), reps: col('Reps'), notes: col('Notes'), wnotes: col('Workout Notes'), rpe: col('RPE')
  };
  const unit: WeightUnit | null = wKg >= 0 ? 'kg' : wLb >= 0 ? 'lb' : null;
  const get = (r: string[], i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
  const out: RowSet[] = [];
  let bad = 0;
  for (const r of body) {
    const order = get(r, c.order);
    if (/^rest/i.test(order)) continue; // строки таймера отдыха это не подходы
    const start = parseDateTime(get(r, c.date));
    const exercise = get(r, c.ex);
    if (!start || !exercise) { bad++; continue; }
    const reps = num(get(r, c.reps));
    const title = get(r, c.title) || 'Тренировка';
    const code = order.toUpperCase();
    const dur = parseDuration(get(r, c.dur));
    out.push({
      workoutKey: `${get(r, c.date)}|${title}`, title, start, durationSec: dur ?? undefined, note: get(r, c.wnotes) || undefined, exercise,
      set: reps !== null && reps >= 1
        ? { weight: Math.max(0, num(get(r, c.weight)) ?? 0), reps: Math.round(reps), warmup: code === 'W', kind: code === 'D' ? 'drop' : 'normal', rpe: roundRpe(num(get(r, c.rpe))), note: get(r, c.notes) || undefined }
        : null
    });
  }
  return assemble('strong', out, unit, bad);
}

/** Разбор файла целиком. Не бросает исключений: понятная причина отказа возвращается в `error`. */
export function parseWorkoutImport(text: string): ParseResult {
  let rows: string[][];
  try { rows = parseCsv(text); } catch { return { ok: false, error: 'Не удалось прочитать файл как таблицу.' }; }
  if (rows.length < 2) return { ok: false, error: 'В файле нет данных.' };
  const format = detectFormat(rows[0]);
  if (!format) return { ok: false, error: 'Формат не распознан. Поддерживаются CSV-экспорты Hevy и Strong.' };
  const data = format === 'hevy' ? parseHevy(rows[0], rows.slice(1)) : parseStrong(rows[0], rows.slice(1));
  if (data.workouts.length === 0) return { ok: false, error: 'Тренировок с подходами в файле не нашлось.' };
  return { ok: true, data };
}

// ---------- сопоставление упражнений ----------

export type Resolution =
  | { kind: 'existing'; exerciseId: string }
  | { kind: 'new'; name: string; muscle: MuscleGroup | null }
  | { kind: 'skip' };

export interface Suggestion { resolution: Resolution; reason: 'exact' | 'alias' | 'guess' | 'cardio' }

/** Стартовые упражнения приложения по английским названиям из Hevy и Strong. Ключи сравниваются после normalize. */
const ALIASES: Record<string, string[]> = {
  'Жим штанги лёжа': ['Bench Press (Barbell)', 'Bench Press'],
  'Жим гантелей на наклонной скамье': ['Incline Bench Press (Dumbbell)', 'Incline Dumbbell Press'],
  'Отжимания на брусьях': ['Chest Dip', 'Chest Dip (Assisted)', 'Dips'],
  'Разводка гантелей': ['Chest Fly (Dumbbell)', 'Dumbbell Fly', 'Flat Dumbbell Fly'],
  'Подтягивания': ['Pull Up', 'Pull Ups', 'Chin Up', 'Pullups'],
  'Тяга штанги в наклоне': ['Bent Over Row (Barbell)', 'Barbell Row'],
  'Тяга верхнего блока': ['Lat Pulldown (Cable)', 'Lat Pulldown', 'Lat Pulldown (Machine)'],
  'Тяга нижнего блока': ['Seated Cable Row', 'Seated Row (Cable)', 'Seated Row (Machine)'],
  'Тяга гантели одной рукой': ['Dumbbell Row', 'One Arm Dumbbell Row', 'Single Arm Row (Dumbbell)', 'Bent Over One Arm Row (Dumbbell)'],
  'Становая тяга': ['Deadlift (Barbell)', 'Deadlift'],
  'Приседания со штангой': ['Squat (Barbell)', 'Back Squat', 'Barbell Squat'],
  'Жим ногами': ['Leg Press', 'Leg Press (Machine)'],
  'Выпады с гантелями': ['Lunge (Dumbbell)', 'Dumbbell Lunge', 'Walking Lunge (Dumbbell)'],
  'Разгибание ног': ['Leg Extension (Machine)', 'Leg Extension'],
  'Сгибание ног': ['Lying Leg Curl (Machine)', 'Seated Leg Curl (Machine)', 'Leg Curl', 'Lying Leg Curl'],
  'Румынская тяга': ['Romanian Deadlift (Barbell)', 'Romanian Deadlift'],
  'Ягодичный мостик': ['Hip Thrust (Barbell)', 'Glute Bridge', 'Hip Thrust'],
  'Жим стоя': ['Overhead Press (Barbell)', 'Overhead Press', 'Standing Military Press (Barbell)'],
  'Жим гантелей сидя': ['Seated Shoulder Press (Dumbbell)', 'Shoulder Press (Dumbbell)', 'Dumbbell Shoulder Press'],
  'Махи гантелей в стороны': ['Lateral Raise (Dumbbell)', 'Dumbbell Lateral Raise', 'Side Lateral Raise'],
  'Тяга к лицу': ['Face Pull', 'Face Pull (Cable)'],
  'Подъём штанги на бицепс': ['Bicep Curl (Barbell)', 'Barbell Curl', 'Biceps Curl (Barbell)'],
  'Молотки': ['Hammer Curl (Dumbbell)', 'Hammer Curl'],
  'Французский жим': ['Skullcrusher (Barbell)', 'Lying Triceps Extension (Barbell)', 'Skull Crusher'],
  'Разгибание на блоке': ['Triceps Pushdown (Cable - Straight Bar)', 'Triceps Pushdown', 'Triceps Pushdown (Cable)', 'Tricep Pushdown'],
  'Скручивания': ['Crunch', 'Crunch (Machine)', 'Crunches'],
  'Планка': ['Plank'],
  'Подъём ног в висе': ['Hanging Leg Raise', 'Hanging Knee Raise'],
  'Подъём на носки стоя': ['Standing Calf Raise (Machine)', 'Standing Calf Raise', 'Calf Raise']
};
const ALIAS_BY_KEY = new Map<string, string>();
for (const [ru, list] of Object.entries(ALIASES)) for (const en of list) ALIAS_BY_KEY.set(norm(en), ru);

/** Грубая догадка о группе мышц по английскому названию. null — не уверены: пользователь выберет сам. */
export function guessMuscle(name: string): MuscleGroup | 'cardio' | null {
  const n = name.toLowerCase();
  const has = (re: RegExp) => re.test(n);
  if (has(/\b(run|running|treadmill|cycling|bike|biking|walk|walking|elliptical|stair|rowing machine|swim|jump rope|ski)\b/)) return 'cardio';
  if (has(/calf|calves/)) return 'calves';
  if (has(/forearm|wrist/)) return 'forearms';
  if (has(/leg curl|hamstring|leg extension|leg press|squat|lunge|quad|step up|hack/)) return 'legs';
  if (has(/romanian|stiff leg|glute|hip thrust|bridge|kickback/)) return 'glutes';
  if (has(/chest dip|chest fly|pec/)) return 'chest';
  if (has(/deadlift/)) return 'back';
  if (has(/tricep|skull|pushdown|dip\b/)) return 'triceps';
  if (has(/bicep|curl/)) return 'biceps';
  if (has(/shoulder|lateral raise|front raise|rear delt|reverse fly|overhead press|military|arnold|upright row|shrug|face pull/)) return 'shoulders';
  if (has(/bench|chest|fly|push up|pushup|press/)) return 'chest';
  if (has(/row|pull|lat |lats|chin|back|pulldown|hyperextension/)) return 'back';
  if (has(/crunch|plank|sit up|situp|\babs?\b|core|leg raise|knee raise|twist|wheel/)) return 'core';
  return null;
}

/**
 * Предложение по каждому названию из файла: уже существующее упражнение (точное имя или известный перевод),
 * новое с догаданной группой мышц или пропуск (кардио в этой версии не импортируется). Пользователь всё может поменять.
 */
export function suggestResolutions(names: string[], exercises: Exercise[]): Map<string, Suggestion> {
  const live = exercises.filter((e) => !e.deletedAt);
  const byName = new Map(live.map((e) => [norm(e.name), e]));
  const out = new Map<string, Suggestion>();
  for (const name of names) {
    const k = norm(name);
    const exact = byName.get(k);
    if (exact) { out.set(name, { resolution: { kind: 'existing', exerciseId: exact.id }, reason: 'exact' }); continue; }
    const ru = ALIAS_BY_KEY.get(k);
    const alias = ru ? byName.get(norm(ru)) : undefined;
    if (alias) { out.set(name, { resolution: { kind: 'existing', exerciseId: alias.id }, reason: 'alias' }); continue; }
    const g = guessMuscle(name);
    if (g === 'cardio') out.set(name, { resolution: { kind: 'skip' }, reason: 'cardio' });
    else out.set(name, { resolution: { kind: 'new', name, muscle: g }, reason: 'guess' });
  }
  return out;
}

// ---------- план импорта ----------

/** Короткий стабильный хеш (FNV-1a) для детерминированных id. */
export function hashId(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

export const importedExerciseId = (name: string): string => `imp-ex-${hashId(norm(name))}`;
const importedWorkoutId = (key: string): string => `imp-wk-${hashId(key)}${hashId(key.split('').reverse().join(''))}`;

const LB = 0.45359237;
export const toKg = (w: number, unit: WeightUnit): number => (unit === 'lb' ? Math.round(w * LB * 100) / 100 : Math.round(w * 100) / 100);

export interface PlannedExercise { id: string; name: string; muscle: MuscleGroup }
export interface ImportPlan {
  workouts: Omit<Workout, 'createdAt' | 'updatedAt' | 'deviceId'>[];
  newExercises: PlannedExercise[];
  /** Названия, для которых не выбрана группа мышц или решение: пока они есть, импортировать нельзя. */
  unresolved: string[];
  /** Тренировки, уже имеющиеся в приложении (тот же файл или те же подходы в тот же день): не импортируются. */
  duplicates: number;
  sets: number;
  skippedByChoice: number;
  from: string | null;
  to: string | null;
}

/** Отпечаток тренировки: дата и рабочие подходы по упражнениям. Не зависит от id записи и порядка упражнений. */
export function workoutFingerprint(w: { date: string; exercises: { exerciseId: string; sets: { weight: number; reps: number; warmup?: boolean }[] }[] }): string {
  const parts = w.exercises.map((e) => `${e.exerciseId}:${e.sets.filter((s) => !s.warmup).map((s) => `${s.weight}x${s.reps}`).join(',')}`).sort();
  return `${w.date}|${parts.join(';')}`;
}

export function buildImportPlan(
  parsed: ParsedImport,
  resolutions: Map<string, Resolution>,
  unit: WeightUnit,
  existing: { workouts: Workout[]; exercises: Exercise[] }
): ImportPlan {
  const exById = new Set(existing.exercises.filter((e) => !e.deletedAt).map((e) => e.id));
  const knownIds = new Set(existing.workouts.map((w) => w.id));
  const seen = new Set(existing.workouts.filter((w) => !w.deletedAt && w.status === 'done').map((w) => workoutFingerprint(w)));

  const unresolved: string[] = [];
  const created = new Map<string, PlannedExercise>();
  const idOf = new Map<string, string | null>(); // название → id упражнения или null (пропуск)
  const names = [...new Set(parsed.workouts.flatMap((w) => w.exercises.map((e) => e.name)))];
  for (const name of names) {
    const r = resolutions.get(name);
    if (!r) { unresolved.push(name); continue; }
    if (r.kind === 'skip') idOf.set(name, null);
    else if (r.kind === 'existing') { if (exById.has(r.exerciseId)) idOf.set(name, r.exerciseId); else unresolved.push(name); }
    else if (!r.muscle || !r.name.trim()) unresolved.push(name);
    else {
      const id = importedExerciseId(r.name);
      idOf.set(name, id);
      if (!exById.has(id) && !created.has(id)) created.set(id, { id, name: r.name.trim().slice(0, 80), muscle: r.muscle });
    }
  }

  const workouts: ImportPlan['workouts'] = [];
  let duplicates = 0, sets = 0, skippedByChoice = 0;
  for (const w of parsed.workouts) {
    const id = importedWorkoutId(w.key);
    const exercises = w.exercises.flatMap((e, i) => {
      const exerciseId = idOf.get(e.name);
      if (exerciseId === undefined) return [];
      if (exerciseId === null) { skippedByChoice++; return []; }
      return [{ src: e, row: { id: `${id}-e${i}`, exerciseId, sets: e.sets.map((s, j) => ({ id: `${id}-e${i}-s${j}`, weight: toKg(s.weight, unit), reps: s.reps, done: true, ...(s.warmup ? { warmup: true } : {}), ...(s.kind !== 'normal' ? { kind: s.kind } : {}), ...(s.rpe !== undefined ? { rpe: s.rpe } : {}), ...(s.note ? { note: s.note.slice(0, 200) } : {}) })), ...(e.note ? { note: e.note.slice(0, 500) } : {}) } }];
    });
    if (exercises.length === 0) continue;
    // суперсеты Hevy: подряд идущие упражнения с одним superset_id получают общий group
    const rows = exercises.map((x) => x.row);
    const groups = new Map<string, string>();
    exercises.forEach((x) => {
      const k = x.src.supersetKey;
      if (!k) return;
      const members = exercises.filter((y) => y.src.supersetKey === k);
      if (members.length < 2) return;
      if (!groups.has(k)) groups.set(k, `${id}-g${groups.size}`);
      (x.row as { group?: string }).group = groups.get(k);
    });
    const fp = workoutFingerprint({ date: w.date, exercises: rows });
    if (knownIds.has(id) || seen.has(fp)) { duplicates++; continue; }
    seen.add(fp); // тот же тренировочный день дважды в одном файле считается один раз
    workouts.push({
      id, date: w.date, title: w.title.slice(0, 80), status: 'done', imported: true, startedAt: w.startedAt, finishedAt: w.finishedAt,
      ...(w.note ? { note: w.note.slice(0, 1000) } : {}), exercises: rows
    });
    sets += rows.reduce((a, e) => a + e.sets.length, 0);
  }
  const dates = workouts.map((w) => w.date).sort();
  return { workouts, newExercises: [...created.values()], unresolved, duplicates, sets, skippedByChoice, from: dates[0] ?? null, to: dates[dates.length - 1] ?? null };
}
