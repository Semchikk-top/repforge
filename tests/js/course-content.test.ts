import { describe, expect, it } from 'vitest';
import course from '../../content/courses/muscle-growth/course.json';
import questions from '../../content/courses/muscle-growth/questions.json';
import principleFiles from '../../content/principles/progressive-overload.json';
import { buildBundle } from '../../src/content/build';
import { makeCatalog } from '../../src/content/catalog';
import type { Course, Question } from '../../src/content/types';
import { COURSE_RULES, validateCourse } from '../../src/content/validate';
import { SEED_EXERCISES } from '../../src/domain/seed';
import { buildQuiz } from '../../src/domain/learning';

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const PRINCIPLES = ['progressive-overload', 'recovery-and-sleep', 'deload-week', 'frequency-and-volume', 'rep-range-and-load', 'technique-over-load', 'specificity', 'movement-variety'];
const ctx = { sourceIds: new Set(['src1']), exerciseIds: new Set(SEED_EXERCISES.map((e) => e.id)), principleIds: new Set(PRINCIPLES) };
const C = course as unknown as Course;
const Q = questions as unknown as Question[];
const check = (c: unknown = C, q: unknown = Q) => validateCourse(c, q, ctx);

describe('курс «Как растут мышцы» (черновик)', () => {
  it('проходит все проверки как черновик', () => {
    expect(check()).toEqual([]);
    expect(principleFiles.id).toBe('progressive-overload'); // принципы, на которые ссылаются уроки, существуют
  });
  it('условия из ROADMAP: 5–7 уроков, банк не меньше двух длин теста, у каждого урока вопросы', () => {
    expect(C.lessons.length).toBeGreaterThanOrEqual(5);
    expect(C.lessons.length).toBeLessThanOrEqual(7);
    expect(Q.length).toBeGreaterThanOrEqual(2 * COURSE_RULES.quiz.length);
    for (const l of C.lessons) expect(Q.filter((q) => q.lesson === l.id).length, l.id).toBeGreaterThanOrEqual(COURSE_RULES.quiz.minPerLesson);
  });
  it('у каждого вопроса один правильный вариант, объяснение и разные варианты', () => {
    for (const q of Q) {
      expect(q.correct, q.id).toBeGreaterThanOrEqual(0);
      expect(q.correct, q.id).toBeLessThan(q.options.length);
      expect(new Set(q.options).size, q.id).toBe(q.options.length);
      expect(q.explanation.length, q.id).toBeGreaterThan(20);
    }
  });
  it('правильные ответы не жмутся к одной позиции (варианты перемешиваются в тесте, но в банке не должно быть перекоса)', () => {
    const pos = [0, 0, 0, 0];
    for (const q of Q) pos[q.correct]++;
    expect(Math.max(...pos) / Q.length).toBeLessThan(0.5);
  });
  it('это черновик без источников: в релизную сборку не попадает, в предпросмотр попадает', () => {
    expect(C.status).toBe('draft');
    expect(Object.keys(buildBundle([], [], [], { courses: [{ course: C, questions: Q }] }).courses!)).toEqual([]);
    const preview = buildBundle([], [], [], { preview: true, courses: [{ course: C, questions: Q }] });
    expect(preview.preview).toBe(true);
    expect(Object.keys(preview.courses!)).toEqual(['muscle-growth']);
  });
  it('из банка собирается полноценный тест на 10 вопросов с охватом всех уроков', () => {
    const quiz = buildQuiz(Q);
    expect(quiz).toHaveLength(10);
    expect(new Set(quiz.map((q) => q.lesson)).size).toBe(C.lessons.length);
  });
});

describe('проверки содержимого курса', () => {
  it('банк меньше двух длин теста', () => {
    expect(check(C, Q.slice(0, 19)).join('\n')).toMatch(/нужно не меньше 20/);
  });
  it('вопрос про несуществующий урок, правильный ответ вне списка, повтор вариантов', () => {
    const q = clone(Q);
    q[0].lesson = 'нет-такого';
    q[1].correct = 9;
    q[2].options = ['Да', 'да', 'Нет'];
    const e = check(C, q).join('\n');
    expect(e).toMatch(/lesson «нет-такого»/);
    expect(e).toMatch(/correct: номер правильного/);
    expect(e).toMatch(/варианты ответа повторяются/);
  });
  it('у урока меньше двух вопросов', () => {
    const q = Q.filter((x) => x.lesson !== C.lessons[0].id || x.id === 's1');
    expect(check(C, q).join('\n')).toMatch(new RegExp(`к уроку ${C.lessons[0].id} меньше 2 вопросов`));
  });
  it('уроков должно быть 5–7', () => {
    const c = clone(C); c.lessons = c.lessons.slice(0, 4);
    expect(check(c, Q.filter((q) => c.lessons.some((l) => l.id === q.lesson))).join('\n')).toMatch(/lessons: от 5 до 7 уроков/);
  });
  it('ссылки урока на упражнения и принципы должны существовать', () => {
    const c = clone(C);
    c.lessons[0].relatedExercises = ['seed-999'];
    c.lessons[1].relatedPrinciples = ['нет-такого-принципа'];
    const e = check(c).join('\n');
    expect(e).toMatch(/упражнения «seed-999»/);
    expect(e).toMatch(/принципа «нет-такого-принципа»/);
  });
  it('запрещённые темы ловятся и в уроках, и в вопросах', () => {
    const c = clone(C); c.lessons[0].paragraphs[0] += ' Принимай добавки для роста.';
    expect(check(c).join('\n')).toMatch(/запрещённая тема/);
    const q = clone(Q); q[0].explanation = 'Лучше принимать препараты для восстановления сил.';
    expect(check(C, q).join('\n')).toMatch(/запрещённая тема/);
  });
  it('reviewed и published требуют источник у курса и у каждого вопроса', () => {
    const c = clone(C); c.status = 'reviewed'; c.reviewedAt = '2026-11-11';
    expect(check(c).join('\n')).toMatch(/без источника курс не может быть reviewed/);
    c.sources = ['src1'];
    expect(check(c).join('\n')).toMatch(/для reviewed и published у вопроса должен быть источник/);
    const q = clone(Q).map((x) => ({ ...x, source: 'src1' }));
    expect(check(c, q)).toEqual([]);
    const bad = clone(q); bad[0].source = 'нет';
    expect(check(c, bad).join('\n')).toMatch(/источника «нет» нет в sources.json/);
  });
  it('опубликованный курс попадает в сборку вместе с источниками и в каталог', () => {
    const c = clone(C); c.status = 'published'; c.reviewedAt = '2026-11-11'; c.sources = ['src1'];
    const q = clone(Q).map((x) => ({ ...x, source: 'src1' }));
    const src = { id: 'src1', title: 'Учебник', author: 'А', url: 'https://example.org', license: 'CC-BY-4.0', retrievedAt: '2026-11-11' };
    const cat = makeCatalog(buildBundle([], [], [src], { courses: [{ course: c, questions: q }] }));
    expect(cat.courses().map((x) => x.course.id)).toEqual(['muscle-growth']);
    expect(cat.course('muscle-growth')!.questions).toHaveLength(Q.length);
    expect(cat.questionSources(q[0]).map((s) => s.id)).toEqual(['src1']);
    expect(cat.lessonsForExercise('seed-001').map((r) => r.lesson.id)).toContain('muscle-structure');
    expect(cat.lessonsForPrinciple('progressive-overload').map((r) => r.lesson.id)).toContain('how-muscles-grow');
    expect(cat.lessonsForExercise('seed-040')).toEqual([]);
    expect(cat.lessonsForExercise(undefined)).toEqual([]);
  });
  it('пустой каталог без курсов не падает', () => {
    const cat = makeCatalog(buildBundle([], [], []));
    expect(cat.courses()).toEqual([]);
    expect(cat.course('x')).toBeNull();
    expect(cat.lessonsForExercise('seed-001')).toEqual([]);
  });
});
