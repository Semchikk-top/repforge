import { describe, expect, it } from 'vitest';
import type { Question } from '../../src/content/types';
import { buildQuiz, courseMark, gradeQuiz, isOutdatedMark, lessonProgress, MARK_NOTICE, PASS_PERCENT, QUIZ_LENGTH } from '../../src/domain/learning';
import type { LearningAttempt } from '../../src/domain/types';

/** Предсказуемый генератор случайных чисел: тесты не должны зависеть от везения. */
function seeded(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const bank = (lessons = 6, per = 5): Question[] => Array.from({ length: lessons * per }, (_, i) => ({
  id: `q${i}`, lesson: `l${i % lessons}`, text: `Вопрос номер ${i} в банке?`, options: ['Первый', 'Второй', 'Третий', 'Четвёртый'], correct: i % 4, explanation: `Пояснение к вопросу ${i}.`, source: null
}));
const att = (o: Partial<LearningAttempt>): LearningAttempt => ({ id: 'a', createdAt: 1, updatedAt: 1, deviceId: 'd', courseId: 'c', courseVersion: 1, correct: 9, total: 10, threshold: 80, passed: true, date: '2026-11-11', ...o });

describe('условия теста', () => {
  it('10 вопросов и порог 80%: из общего файла правил', () => {
    expect(QUIZ_LENGTH).toBe(10);
    expect(PASS_PERCENT).toBe(80);
  });
  it('на отметке есть пояснение «не документ», слов «сертификат» и «диплом» нет', () => {
    expect(MARK_NOTICE).toMatch(/не документ/);
    expect(MARK_NOTICE.toLowerCase()).not.toMatch(/сертификат|диплом/);
  });
});

describe('подбор вопросов', () => {
  it('берёт десять разных вопросов и охватывает уроки поровну', () => {
    const quiz = buildQuiz(bank(), { rng: seeded(1) });
    expect(quiz).toHaveLength(10);
    expect(new Set(quiz.map((q) => q.id)).size).toBe(10);
    const per = new Map<string, number>();
    quiz.forEach((q) => per.set(q.lesson, (per.get(q.lesson) ?? 0) + 1));
    expect(per.size).toBe(6);                                   // все шесть уроков представлены
    expect(Math.max(...per.values())).toBeLessThanOrEqual(2);   // 10 вопросов на 6 уроков: по 1–2
  });

  it('варианты ответа перемешаны, а правильный номер указывает на тот же текст', () => {
    const source = bank();
    const byId = new Map(source.map((q) => [q.id, q]));
    let moved = 0;
    for (let seed = 1; seed <= 20; seed++) {
      for (const q of buildQuiz(source, { rng: seeded(seed) })) {
        const orig = byId.get(q.id)!;
        expect([...q.options].sort()).toEqual([...orig.options].sort());
        expect(q.options[q.correct]).toBe(orig.options[orig.correct]);
        if (q.options[0] !== orig.options[0]) moved++;
      }
    }
    expect(moved).toBeGreaterThan(50);  // порядок действительно меняется
  });

  it('повторная попытка получает другой набор: вопросы прошлой попытки не повторяются, пока хватает других', () => {
    const source = bank(6, 5);          // 30 вопросов
    const first = buildQuiz(source, { rng: seeded(7) });
    const second = buildQuiz(source, { rng: seeded(8), avoid: first.map((q) => q.id) });
    expect(second).toHaveLength(10);
    expect(second.filter((q) => first.some((f) => f.id === q.id))).toEqual([]);
    expect(new Set(second.map((q) => q.lesson)).size).toBe(6);
  });

  it('если свежих вопросов не хватает, добирает из прежних, а не укорачивает тест', () => {
    const source = bank(2, 6);          // 12 вопросов, прошлые 10 исключаем: свежих всего 2
    const first = buildQuiz(source, { rng: seeded(3) });
    const second = buildQuiz(source, { rng: seeded(4), avoid: first.map((q) => q.id) });
    expect(second).toHaveLength(10);
    expect(new Set(second.map((q) => q.id)).size).toBe(10);
  });

  it('маленький банк даёт тест по размеру банка, пустой банк — пустой тест', () => {
    expect(buildQuiz(bank(1, 4), { rng: seeded(1) })).toHaveLength(4);
    expect(buildQuiz([], { rng: seeded(1) })).toEqual([]);
  });

  it('воспроизводим при одинаковом генераторе', () => {
    const a = buildQuiz(bank(), { rng: seeded(42) }).map((q) => q.id + q.options.join());
    const b = buildQuiz(bank(), { rng: seeded(42) }).map((q) => q.id + q.options.join());
    expect(a).toEqual(b);
  });
});

describe('проверка ответов', () => {
  const quiz = buildQuiz(bank(), { rng: seeded(5) });
  const answers = (right: number) => quiz.map((q, i) => (i < right ? q.correct : (q.correct + 1) % q.options.length));

  it('8 из 10 проходят, 7 из 10 нет: порог 80% включительно', () => {
    expect(gradeQuiz(quiz, answers(8))).toMatchObject({ correct: 8, total: 10, percent: 80, passed: true });
    expect(gradeQuiz(quiz, answers(7))).toMatchObject({ correct: 7, percent: 70, passed: false });
    expect(gradeQuiz(quiz, answers(10))).toMatchObject({ percent: 100, passed: true });
    expect(gradeQuiz(quiz, answers(0))).toMatchObject({ correct: 0, passed: false });
  });
  it('пропущенный вопрос считается неверным, а пустой тест не проходится', () => {
    const skipped = quiz.map((q, i) => (i < 7 ? q.correct : null));
    expect(gradeQuiz(quiz, skipped)).toMatchObject({ correct: 7, passed: false });
    expect(gradeQuiz([], [])).toMatchObject({ total: 0, passed: false });
  });
  it('разбор ошибок: каждый вопрос с выбранным ответом и признаком верности', () => {
    const g = gradeQuiz(quiz, answers(8));
    expect(g.review).toHaveLength(10);
    expect(g.review.filter((r) => !r.ok)).toHaveLength(2);
    expect(g.review[9].chosen).toBe((quiz[9].correct + 1) % quiz[9].options.length);
    expect(g.review[0].question.explanation).toMatch(/Пояснение/);
  });
  it('порог, действовавший в попытке, можно передать явно', () => {
    expect(gradeQuiz(quiz, answers(7), 70).passed).toBe(true);
    expect(gradeQuiz(quiz, answers(7), 70).threshold).toBe(70);
  });
});

describe('отметка о прохождении выводится из попыток', () => {
  it('без успешной попытки отметки нет, с одной успешной есть, неудачные после неё её не отменяют', () => {
    expect(courseMark([], 'c')).toEqual({ passed: false, firstPassedAt: null, lastPassedVersion: null, attempts: 0 });
    const fail = att({ id: '1', passed: false, correct: 5, createdAt: 1, date: '2026-11-01' });
    expect(courseMark([fail], 'c')).toMatchObject({ passed: false, attempts: 1 });
    const ok = att({ id: '2', createdAt: 2, date: '2026-11-02' });
    const later = att({ id: '3', passed: false, createdAt: 3, date: '2026-11-03' });
    expect(courseMark([fail, ok, later], 'c')).toMatchObject({ passed: true, firstPassedAt: '2026-11-02', attempts: 3 });
  });
  it('считает только свой курс и не учитывает удалённые записи', () => {
    expect(courseMark([att({ courseId: 'other' })], 'c').passed).toBe(false);
    expect(courseMark([att({ deletedAt: 5 })], 'c').passed).toBe(false);
  });
  it('порядок записей не важен: слияние устройств — это просто объединение', () => {
    const a = [att({ id: '1', createdAt: 1 }), att({ id: '2', passed: false, createdAt: 2 })];
    expect(courseMark(a, 'c')).toEqual(courseMark([...a].reverse(), 'c'));
  });
  it('отметка прежней версии курса остаётся, но помечается как устаревшая', () => {
    const m = courseMark([att({ courseVersion: 1 })], 'c');
    expect(m.passed).toBe(true);
    expect(isOutdatedMark(m, 1)).toBe(false);
    expect(isOutdatedMark(m, 2)).toBe(true);
    expect(isOutdatedMark(courseMark([], 'c'), 2)).toBe(false);
  });
  it('прогресс по урокам', () => {
    const course = { lessons: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
    expect(lessonProgress(course, ['a', 'c', 'zzz'])).toEqual({ done: 2, total: 3 });
  });
});
