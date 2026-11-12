// Проверки содержимого. Чистые функции: их вызывают и скрипт `npm run content:check`, и тесты.
// Каждая функция возвращает список ошибок (пустой — всё хорошо), а не бросает исключение: так видны все проблемы сразу.

import { STATUSES, type Card, type Course, type Lesson, type Muscle, type Principle, type Question, type Source } from './types';

import rules from '../../content/rules.json';

/** Правила лежат в content/rules.json: их же читает конвейер знаний на сервере, так что расходиться им негде. */
/** Лицензии, при которых текст можно использовать с указанием источника. Остальные источники отклоняются. */
export const ALLOWED_LICENSES: readonly string[] = rules.allowedLicenses;

export const LIMITS = rules.limits as {
  summary: [number, number]; function: [number, number]; cue: [number, number]; mistake: [number, number]; swapNote: [number, number];
  cues: [number, number]; mistakes: [number, number];
  title: [number, number]; points: [number, number]; point: [number, number]; pSummary: [number, number];
};

/** Темы, которых в карточках быть не должно: лекарства, диагнозы, диеты, обещания «как тренер». Флаг (?i) в JSON заменяется на i. */
export const FORBIDDEN: RegExp[] = rules.forbidden.map((p) => new RegExp(p.replace(/^\(\?i\)/, ''), 'i'));

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const inRange = (s: string, [min, max]: readonly [number, number] | readonly number[]) => s.trim().length >= min && s.trim().length <= max;

function forbiddenIn(text: string): string | null {
  for (const re of FORBIDDEN) { const m = re.exec(text); if (m) return m[0]; }
  return null;
}

export function validateMuscles(list: unknown, groups: readonly string[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(list)) return ['muscles.json: ожидается массив'];
  const seen = new Set<string>();
  for (const [i, raw] of list.entries()) {
    const m = raw as Partial<Muscle>;
    const where = `muscles.json[${i}]`;
    if (!isStr(m.id) || !ID.test(m.id)) { errors.push(`${where}: плохой id`); continue; }
    if (seen.has(m.id)) errors.push(`${where}: повтор id «${m.id}»`);
    seen.add(m.id);
    if (!isStr(m.name) || !m.name.trim()) errors.push(`${m.id}: нет названия`);
    if (!isStr(m.group) || !groups.includes(m.group)) errors.push(`${m.id}: неизвестная группа «${String(m.group)}»`);
    if (m.side !== 'front' && m.side !== 'back' && m.side !== 'both') errors.push(`${m.id}: side должен быть front, back или both`);
  }
  return errors;
}

export function validateSources(list: unknown, today?: string): string[] {
  const errors: string[] = [];
  if (!Array.isArray(list)) return ['sources.json: ожидается массив'];
  const seen = new Set<string>();
  for (const [i, raw] of list.entries()) {
    const s = raw as Partial<Source>;
    const where = `sources.json[${i}]`;
    if (!isStr(s.id) || !ID.test(s.id)) { errors.push(`${where}: плохой id`); continue; }
    if (seen.has(s.id)) errors.push(`${s.id}: повтор id`);
    seen.add(s.id);
    if (!isStr(s.title) || !s.title.trim()) errors.push(`${s.id}: нет названия`);
    if (!isStr(s.author) || !s.author.trim()) errors.push(`${s.id}: нет автора`);
    if (!isStr(s.url) || !/^https:\/\/[^\s<>]+$/.test(s.url)) errors.push(`${s.id}: ссылка должна начинаться с https://`);
    if (!isStr(s.license) || !(ALLOWED_LICENSES as readonly string[]).includes(s.license)) errors.push(`${s.id}: лицензия «${String(s.license)}» не разрешена (можно: ${ALLOWED_LICENSES.join(', ')})`);
    if (!isStr(s.retrievedAt) || !DATE.test(s.retrievedAt)) errors.push(`${s.id}: дата получения в формате ГГГГ-ММ-ДД`);
    else if (today && s.retrievedAt > today) errors.push(`${s.id}: дата получения в будущем`);
  }
  return errors;
}

export interface CardContext {
  muscleIds: Set<string>;
  sourceIds: Set<string>;
  /** Id стартовых упражнений, для которых карточка возможна (без кардио-проверок: их решает вызывающий). */
  exerciseIds: Set<string>;
}

export function validateCard(raw: unknown, ctx: CardContext): string[] {
  const c = raw as Partial<Card>;
  const errors: string[] = [];
  const id = isStr(c?.id) ? c.id : '?';
  const err = (msg: string) => errors.push(`${id}: ${msg}`);
  if (!c || typeof c !== 'object') return ['карточка не объект'];

  if (!isStr(c.id) || !ctx.exerciseIds.has(c.id)) err('такого стартового упражнения нет в domain/seed.ts');

  if (!isStr(c.summary) || !inRange(c.summary, LIMITS.summary)) err(`summary: от ${LIMITS.summary[0]} до ${LIMITS.summary[1]} символов`);
  if (!isStr(c.function) || !inRange(c.function, LIMITS.function)) err(`function: от ${LIMITS.function[0]} до ${LIMITS.function[1]} символов`);
  if (!isStr(c.swapNote) || !inRange(c.swapNote, LIMITS.swapNote)) err(`swapNote: от ${LIMITS.swapNote[0]} до ${LIMITS.swapNote[1]} символов`);

  for (const [field, [min, max], textMax] of [['cues', LIMITS.cues, LIMITS.cue], ['mistakes', LIMITS.mistakes, LIMITS.mistake]] as const) {
    const v = c[field];
    if (!isStrArr(v) || v.length < min || v.length > max) { err(`${field}: от ${min} до ${max} пунктов`); continue; }
    v.forEach((t, i) => { if (!inRange(t, textMax)) err(`${field}[${i}]: от ${textMax[0]} до ${textMax[1]} символов`); });
  }

  if (!isStrArr(c.primaryMuscles) || c.primaryMuscles.length < 1) err('primaryMuscles: нужна хотя бы одна мышца');
  if (!isStrArr(c.secondaryMuscles)) err('secondaryMuscles: ожидается массив (может быть пустым)');
  const muscles = [...(isStrArr(c.primaryMuscles) ? c.primaryMuscles : []), ...(isStrArr(c.secondaryMuscles) ? c.secondaryMuscles : [])];
  for (const m of muscles) if (!ctx.muscleIds.has(m)) err(`мышцы «${m}» нет в справочнике muscles.json`);
  if (new Set(muscles).size !== muscles.length) err('одна мышца указана дважды (в основных и вспомогательных или повтором)');

  if (!isStrArr(c.sources)) err('sources: ожидается массив id из sources.json');
  else for (const s of c.sources) if (!ctx.sourceIds.has(s)) err(`источника «${s}» нет в sources.json`);

  if (!isStr(c.status) || !(STATUSES as readonly string[]).includes(c.status)) err('status: draft, reviewed или published');
  else if (c.status === 'draft') {
    if (c.reviewedAt !== null) err('reviewedAt у черновика должен быть null');
  } else {
    if (!isStr(c.reviewedAt) || !DATE.test(c.reviewedAt)) err('reviewedAt: дата проверки ГГГГ-ММ-ДД обязательна для reviewed и published');
    if (!isStrArr(c.sources) || c.sources.length === 0) err('без источника карточка не может быть reviewed или published');
  }
  if (!Number.isInteger(c.contentVersion) || (c.contentVersion as number) < 1) err('contentVersion: целое число от 1');

  const tr = c.techniqueReview;
  if (tr !== undefined && tr !== null) {
    if (!isStr(tr.by) || !inRange(tr.by, [2, 80])) err('techniqueReview.by: кто проверил (роль или имя), 2–80 символов');
    if (!isStr(tr.at) || !DATE.test(tr.at)) err('techniqueReview.at: дата проверки ГГГГ-ММ-ДД');
  }
  if (c.status === 'published' && (tr === undefined || tr === null)) err('для published нужна проверка техники специалистом (techniqueReview)');

  const texts = [c.summary, c.function, c.swapNote, ...(isStrArr(c.cues) ? c.cues : []), ...(isStrArr(c.mistakes) ? c.mistakes : [])];
  for (const t of texts) if (isStr(t)) { const hit = forbiddenIn(t); if (hit) err(`запрещённая тема или обещание: «${hit}»`); }
  return errors;
}

export interface PrincipleContext { sourceIds: Set<string> }

export function validatePrinciple(raw: unknown, ctx: PrincipleContext): string[] {
  const c = raw as Partial<Principle>;
  if (!c || typeof c !== 'object') return ['принцип не объект'];
  const id = isStr(c.id) ? c.id : '?';
  const errors: string[] = [];
  const err = (msg: string) => errors.push(`${id}: ${msg}`);
  if (!isStr(c.id) || !ID.test(c.id)) err('id: латиница, цифры и дефисы');
  else if (c.id.startsWith('seed-')) err('id не должен начинаться с seed- (так называются упражнения)');
  if (!isStr(c.title) || !inRange(c.title, LIMITS.title)) err(`title: от ${LIMITS.title[0]} до ${LIMITS.title[1]} символов`);
  if (!isStr(c.summary) || !inRange(c.summary, LIMITS.pSummary)) err(`summary: от ${LIMITS.pSummary[0]} до ${LIMITS.pSummary[1]} символов`);
  const pts = c.points;
  if (!isStrArr(pts) || pts.length < LIMITS.points[0] || pts.length > LIMITS.points[1]) err(`points: от ${LIMITS.points[0]} до ${LIMITS.points[1]} пунктов`);
  else pts.forEach((t, i) => { if (!inRange(t, LIMITS.point)) err(`points[${i}]: от ${LIMITS.point[0]} до ${LIMITS.point[1]} символов`); });
  if (!isStrArr(c.sources)) err('sources: ожидается массив id из sources.json');
  else for (const s of c.sources) if (!ctx.sourceIds.has(s)) err(`источника «${s}» нет в sources.json`);
  if (!isStr(c.status) || !(STATUSES as readonly string[]).includes(c.status)) err('status: draft, reviewed или published');
  else if (c.status === 'draft') { if (c.reviewedAt !== null) err('reviewedAt у черновика должен быть null'); }
  else {
    if (!isStr(c.reviewedAt) || !DATE.test(c.reviewedAt)) err('reviewedAt: дата проверки обязательна для reviewed и published');
    if (!isStrArr(c.sources) || c.sources.length === 0) err('без источника заметка не может быть reviewed или published');
  }
  if (!Number.isInteger(c.contentVersion) || (c.contentVersion as number) < 1) err('contentVersion: целое число от 1');
  for (const t of [c.title, c.summary, ...(isStrArr(pts) ? pts : [])]) if (isStr(t)) { const hit = forbiddenIn(t); if (hit) err(`запрещённая тема или обещание: «${hit}»`); }
  return errors;
}

// ---------- курсы (1.5.0) ----------
export const COURSE_RULES = rules.course as {
  quiz: { length: number; passPercent: number; bankMultiplier: number; minPerLesson: number };
  lessons: [number, number]; minutes: [number, number];
  courseTitle: [number, number]; courseSummary: [number, number];
  lessonTitle: [number, number]; paragraphs: [number, number]; paragraph: [number, number]; lessonChars: [number, number];
  question: [number, number]; options: [number, number]; option: [number, number]; explanation: [number, number];
};

export interface CourseContext { sourceIds: Set<string>; exerciseIds: Set<string>; principleIds: Set<string> }

/** Курс и его банк вопросов проверяются вместе: вопрос ссылается на урок, а размер банка зависит от длины теста. */
export function validateCourse(rawCourse: unknown, rawQuestions: unknown, ctx: CourseContext): string[] {
  const R = COURSE_RULES;
  const c = rawCourse as Partial<Course>;
  if (!c || typeof c !== 'object') return ['курс не объект'];
  const id = isStr(c.id) ? c.id : '?';
  const errors: string[] = [];
  const err = (msg: string) => errors.push(`${id}: ${msg}`);
  if (!isStr(c.id) || !ID.test(c.id)) err('id: латиница, цифры и дефисы');
  else if (c.id.startsWith('seed-')) err('id не должен начинаться с seed-');
  if (!isStr(c.title) || !inRange(c.title, R.courseTitle)) err(`title: от ${R.courseTitle[0]} до ${R.courseTitle[1]} символов`);
  if (!isStr(c.summary) || !inRange(c.summary, R.courseSummary)) err(`summary: от ${R.courseSummary[0]} до ${R.courseSummary[1]} символов`);

  const texts: string[] = [c.title, c.summary].filter(isStr);
  const lessons = Array.isArray(c.lessons) ? (c.lessons as Lesson[]) : [];
  if (!Array.isArray(c.lessons) || lessons.length < R.lessons[0] || lessons.length > R.lessons[1]) err(`lessons: от ${R.lessons[0]} до ${R.lessons[1]} уроков`);
  const lessonIds = new Set<string>();
  lessons.forEach((l, i) => {
    const lid = isStr(l?.id) ? l.id : `#${i}`;
    const lerr = (msg: string) => err(`урок ${lid}: ${msg}`);
    if (!isStr(l?.id) || !ID.test(l.id)) lerr('id: латиница, цифры и дефисы');
    else if (lessonIds.has(l.id)) lerr('id повторяется');
    else lessonIds.add(l.id);
    if (!isStr(l?.title) || !inRange(l.title, R.lessonTitle)) lerr(`title: от ${R.lessonTitle[0]} до ${R.lessonTitle[1]} символов`);
    if (!Number.isInteger(l?.minutes) || l.minutes < R.minutes[0] || l.minutes > R.minutes[1]) lerr(`minutes: целое от ${R.minutes[0]} до ${R.minutes[1]}`);
    const ps = l?.paragraphs;
    if (!isStrArr(ps) || ps.length < R.paragraphs[0] || ps.length > R.paragraphs[1]) lerr(`paragraphs: от ${R.paragraphs[0]} до ${R.paragraphs[1]} абзацев`);
    else {
      ps.forEach((p, k) => { if (!inRange(p, R.paragraph)) lerr(`абзац ${k + 1}: от ${R.paragraph[0]} до ${R.paragraph[1]} символов`); texts.push(p); });
      const total = ps.join('').length;
      if (total < R.lessonChars[0] || total > R.lessonChars[1]) lerr(`длина урока ${total} знаков, нужно от ${R.lessonChars[0]} до ${R.lessonChars[1]} (2–3 минуты чтения)`);
    }
    if (isStr(l?.title)) texts.push(l.title);
    if (!isStrArr(l?.relatedExercises)) lerr('relatedExercises: ожидается массив id упражнений');
    else for (const e of l.relatedExercises) if (!ctx.exerciseIds.has(e)) lerr(`упражнения «${e}» нет среди стартовых`);
    if (!isStrArr(l?.relatedPrinciples)) lerr('relatedPrinciples: ожидается массив id принципов');
    else for (const p of l.relatedPrinciples) if (!ctx.principleIds.has(p)) lerr(`принципа «${p}» нет в content/principles`);
  });

  if (!isStrArr(c.sources)) err('sources: ожидается массив id из sources.json');
  else for (const s of c.sources) if (!ctx.sourceIds.has(s)) err(`источника «${s}» нет в sources.json`);
  if (!isStr(c.status) || !(STATUSES as readonly string[]).includes(c.status)) err('status: draft, reviewed или published');
  else if (c.status === 'draft') { if (c.reviewedAt !== null) err('reviewedAt у черновика должен быть null'); }
  else {
    if (!isStr(c.reviewedAt) || !DATE.test(c.reviewedAt)) err('reviewedAt: дата проверки обязательна для reviewed и published');
    if (!isStrArr(c.sources) || c.sources.length === 0) err('без источника курс не может быть reviewed или published');
  }
  if (!Number.isInteger(c.contentVersion) || (c.contentVersion as number) < 1) err('contentVersion: целое число от 1');

  // ----- вопросы -----
  const qs = Array.isArray(rawQuestions) ? (rawQuestions as Question[]) : null;
  if (!qs) { err('questions.json: ожидается массив вопросов'); return errors; }
  const need = R.quiz.length * R.quiz.bankMultiplier;
  if (qs.length < need) err(`в банке ${qs.length} вопросов, нужно не меньше ${need} (вдвое больше длины теста, чтобы повторная попытка отличалась)`);
  const qids = new Set<string>();
  const perLesson = new Map<string, number>();
  const published = c.status === 'reviewed' || c.status === 'published';
  qs.forEach((q, i) => {
    const qid = isStr(q?.id) ? q.id : `#${i}`;
    const qerr = (msg: string) => err(`вопрос ${qid}: ${msg}`);
    if (!isStr(q?.id) || !ID.test(q.id)) qerr('id: латиница, цифры и дефисы');
    else if (qids.has(q.id)) qerr('id повторяется');
    else qids.add(q.id);
    if (!isStr(q?.lesson) || !lessonIds.has(q.lesson)) qerr(`lesson «${String(q?.lesson)}» не совпадает ни с одним уроком`);
    else perLesson.set(q.lesson, (perLesson.get(q.lesson) ?? 0) + 1);
    if (!isStr(q?.text) || !inRange(q.text, R.question)) qerr(`text: от ${R.question[0]} до ${R.question[1]} символов`);
    const opts = q?.options;
    if (!isStrArr(opts) || opts.length < R.options[0] || opts.length > R.options[1]) qerr(`options: от ${R.options[0]} до ${R.options[1]} вариантов`);
    else {
      opts.forEach((o, k) => { if (!inRange(o, R.option)) qerr(`вариант ${k + 1}: от ${R.option[0]} до ${R.option[1]} символов`); texts.push(o); });
      if (new Set(opts.map((o) => o.trim().toLowerCase())).size !== opts.length) qerr('варианты ответа повторяются');
      if (!Number.isInteger(q.correct) || q.correct < 0 || q.correct >= opts.length) qerr('correct: номер правильного варианта (с нуля) в пределах options');
    }
    if (!isStr(q?.explanation) || !inRange(q.explanation, R.explanation)) qerr(`explanation: от ${R.explanation[0]} до ${R.explanation[1]} символов`);
    if (q?.source !== null && q?.source !== undefined) {
      if (!isStr(q.source) || !ctx.sourceIds.has(q.source)) qerr(`источника «${String(q.source)}» нет в sources.json`);
    } else if (published) qerr('для reviewed и published у вопроса должен быть источник');
    for (const t of [q?.text, q?.explanation]) if (isStr(t)) texts.push(t);
  });
  for (const lid of lessonIds) if ((perLesson.get(lid) ?? 0) < R.quiz.minPerLesson) err(`к уроку ${lid} меньше ${R.quiz.minPerLesson} вопросов: тест должен проверять каждый урок`);
  for (const t of texts) { const hit = forbiddenIn(t); if (hit) { err(`запрещённая тема или обещание: «${hit}»`); break; } }
  return errors;
}
