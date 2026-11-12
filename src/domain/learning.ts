// Тест курса и отметка о прохождении. Чистые функции без обращения к базе и интерфейсу.
// Принципы (ROADMAP 1.5.0): без наград и рейтингов; повторная попытка сразу и с другим набором вопросов;
// отметка не хранится, а выводится из попыток: «есть успешная попытка».
import { COURSE_RULES } from '../content/validate';
import type { Question } from '../content/types';
import type { LearningAttempt } from './types';

export const QUIZ_LENGTH = COURSE_RULES.quiz.length;
export const PASS_PERCENT = COURSE_RULES.quiz.passPercent;
/** Пояснение, которое показывается на каждой отметке. Слова «сертификат» и «диплом» не используем нигде. */
export const MARK_NOTICE = 'Отметка в приложении, не документ. Она ничего не даёт, кроме самой отметки.';

export type Rng = () => number;

function shuffled<T>(items: readonly T[], rng: Rng): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Вопрос в том виде, в каком он показан: варианты уже перемешаны, correct указывает на новое место. */
export interface QuizQuestion {
  id: string;
  lesson: string;
  text: string;
  options: string[];
  correct: number;
  explanation: string;
  source: string | null;
}

function present(q: Question, rng: Rng): QuizQuestion {
  const order = shuffled(q.options.map((_, i) => i), rng);
  return { id: q.id, lesson: q.lesson, text: q.text, options: order.map((i) => q.options[i]), correct: order.indexOf(q.correct), explanation: q.explanation, source: q.source };
}

/**
 * Набор вопросов для попытки. Берём поровну из разных уроков (по кругу), чтобы тест проверял весь курс.
 * `avoid` — id вопросов прошлой попытки: пока в банке хватает других, они не повторяются, поэтому повторная попытка
 * выглядит по-новому. Если вопросов не хватает, добираем из прежних.
 */
export function buildQuiz(bank: readonly Question[], opts: { rng?: Rng; length?: number; avoid?: readonly string[] } = {}): QuizQuestion[] {
  const rng = opts.rng ?? Math.random;
  const length = Math.min(opts.length ?? QUIZ_LENGTH, bank.length);
  const avoid = new Set(opts.avoid ?? []);
  const picked: Question[] = [];
  for (const pool of [bank.filter((q) => !avoid.has(q.id)), bank.filter((q) => avoid.has(q.id))]) {
    const byLesson = new Map<string, Question[]>();
    for (const q of shuffled(pool, rng)) byLesson.set(q.lesson, [...(byLesson.get(q.lesson) ?? []), q]);
    const lessons = shuffled([...byLesson.keys()], rng);
    while (picked.length < length && lessons.some((l) => byLesson.get(l)!.length)) {
      for (const l of lessons) {
        const q = byLesson.get(l)!.shift();
        if (q && picked.length < length) picked.push(q);
      }
    }
  }
  return shuffled(picked, rng).map((q) => present(q, rng));
}

export interface Graded {
  correct: number;
  total: number;
  percent: number;
  threshold: number;
  passed: boolean;
  /** Разбор: каждый вопрос с выбранным ответом. Показывается один раз после теста и нигде не сохраняется. */
  review: { question: QuizQuestion; chosen: number | null; ok: boolean }[];
}

/** answers[i] — номер выбранного варианта; null — вопрос пропущен (считается неверным). */
export function gradeQuiz(quiz: readonly QuizQuestion[], answers: readonly (number | null)[], threshold = PASS_PERCENT): Graded {
  const review = quiz.map((question, i) => ({ question, chosen: answers[i] ?? null, ok: answers[i] === question.correct }));
  const correct = review.filter((r) => r.ok).length;
  const total = quiz.length;
  const percent = total ? Math.round((correct / total) * 100) : 0;
  return { correct, total, percent, threshold, passed: total > 0 && (correct / total) * 100 >= threshold, review };
}

/** Отметка о прохождении курса: есть хотя бы одна успешная попытка (по любой версии курса). */
export function courseMark(attempts: readonly LearningAttempt[], courseId: string): { passed: boolean; firstPassedAt: string | null; lastPassedVersion: number | null; attempts: number } {
  const mine = attempts.filter((a) => a.courseId === courseId && !a.deletedAt);
  const ok = mine.filter((a) => a.passed).sort((x, y) => x.createdAt - y.createdAt);
  return { passed: ok.length > 0, firstPassedAt: ok[0]?.date ?? null, lastPassedVersion: ok.length ? ok[ok.length - 1].courseVersion : null, attempts: mine.length };
}

/** Курс обновили после того, как человек его прошёл: отметка остаётся, но можно пройти новую версию. */
export const isOutdatedMark = (mark: { passed: boolean; lastPassedVersion: number | null }, currentVersion: number): boolean =>
  mark.passed && mark.lastPassedVersion !== null && mark.lastPassedVersion < currentVersion;

export const lessonProgress = (course: { lessons: { id: string }[] }, read: readonly string[]): { done: number; total: number } =>
  ({ done: course.lessons.filter((l) => read.includes(l.id)).length, total: course.lessons.length });
