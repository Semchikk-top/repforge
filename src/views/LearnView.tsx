import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { catalog as defaultCatalog, type Catalog } from '../content/catalog';
import { EDU_NOTICE, type CourseBundle } from '../content/types';
import { db } from '../db/db';
import { addAttempt, getLastQuiz, getLessonsRead, markLessonRead, setLastQuiz } from '../db/repo';
import { buildQuiz, courseMark, gradeQuiz, isOutdatedMark, lessonProgress, MARK_NOTICE, PASS_PERCENT, QUIZ_LENGTH, type Graded, type QuizQuestion } from '../domain/learning';
import type { LearningAttempt } from '../domain/types';
import { go } from '../state/router';
import { IconBack } from '../ui/Icons';
import { openExternal } from '../ui/openExternal';

// Раздел «Знания» (1.5.0): курсы, уроки и тест. Без наград, монет и рейтингов: отметка о прохождении — просто отметка.

const useAttempts = () => useLiveQuery(() => db.learning.toArray().then((r) => r.filter((x) => !x.deletedAt)), [], [] as LearningAttempt[]);

function DraftNote({ course }: { course: CourseBundle['course'] }) {
  if (course.status === 'published') return null;
  return <p className="why-draft" role="note">{course.status === 'draft' ? 'Черновик: текст ещё не проверен человеком.' : 'Проверено, но ещё не опубликовано.'} Виден только в предпросмотре.</p>;
}

function Back({ to, label }: { to: string; label: string }) {
  return <button className="link-btn learn-back" onClick={() => go(to)} aria-label={label}><IconBack size={16} /> {label}</button>;
}

function Sources({ course, catalog }: { course: CourseBundle; catalog: Catalog }) {
  const ids = [...new Set([...course.course.sources, ...course.questions.map((q) => q.source).filter((s): s is string => !!s)])];
  const list = ids.flatMap((id) => catalog.allSources().filter((s) => s.id === id));
  if (list.length === 0) return <p className="why-src" data-testid="learn-sources">Источник пока не указан.</p>;
  return (
    <p className="why-src" data-testid="learn-sources">Источники:{' '}
      {list.map((s, i) => <span key={s.id}>{i > 0 && '; '}<button className="link-btn" onClick={() => void openExternal(s.url)}>{s.title}</button>, {s.author}, {s.license}</span>)}.
    </p>
  );
}

// ---------- список курсов ----------
function CoursesList({ catalog }: { catalog: Catalog }) {
  const attempts = useAttempts();
  const courses = catalog.courses();
  return (
    <div data-testid="learn-list">
      <Back to="profile" label="Профиль" />
      <div className="section"><h2>Знания</h2>
        {courses.length === 0 && <p className="empty">Курсов пока нет.</p>}
        {courses.map(({ course }) => {
          const mark = courseMark(attempts, course.id);
          return (
            <button key={course.id} className="row learn-course" onClick={() => go(`learn/${course.id}`)}>
              <div className="grow"><div className="title">{course.title}</div><div className="meta">{course.lessons.length} уроков{mark.passed ? ' · отметка есть' : ''}</div></div>
            </button>
          );
        })}
        <p className="why-notice">{EDU_NOTICE}</p>
      </div>
    </div>
  );
}

// ---------- экран курса ----------
function CourseScreen({ bundle, catalog }: { bundle: CourseBundle; catalog: Catalog }) {
  const { course } = bundle;
  const attempts = useAttempts();
  const read = useLiveQuery(() => getLessonsRead(course.id), [course.id], [] as string[]);
  const mark = courseMark(attempts, course.id);
  const prog = lessonProgress(course, read);
  return (
    <div data-testid="learn-course">
      <Back to="learn" label="Знания" />
      <div className="section"><h2>{course.title}</h2>
        <DraftNote course={course} />
        <p className="sub">{course.summary}</p>
        <p className="sub" data-testid="learn-progress">Прочитано уроков: {prog.done} из {prog.total}.</p>
        {course.lessons.map((l, i) => (
          <button key={l.id} className="row learn-lesson" onClick={() => go(`learn/${course.id}/${l.id}`)}>
            <div className="grow"><div className="title">{i + 1}. {l.title}</div><div className="meta">около {l.minutes} мин{read.includes(l.id) ? ' · прочитан' : ''}</div></div>
          </button>
        ))}
      </div>
      <div className="section">
        <h2>Тест</h2>
        <p className="sub">{QUIZ_LENGTH} вопросов по всем урокам, порог {PASS_PERCENT}%. Результат и разбор ошибок показываются сразу после теста. Тест можно пройти ещё раз в любой момент, вопросы будут другими.</p>
        {mark.passed && (
          <div className="learn-mark" data-testid="learn-mark" role="status">
            <b>Отметка: курс пройден{mark.firstPassedAt ? ` ${mark.firstPassedAt}` : ''}.</b>
            {isOutdatedMark(mark, course.contentVersion) && <p className="sub">Курс с тех пор обновился. Можно пройти тест по новой версии.</p>}
            <p className="why-notice">{MARK_NOTICE}</p>
          </div>
        )}
        <button className="btn primary block" onClick={() => go(`learn/${course.id}/test`)} data-testid="learn-start">{mark.attempts ? 'Пройти тест ещё раз' : 'Пройти тест'}</button>
      </div>
      <div className="why-foot"><p className="why-notice">{EDU_NOTICE}</p><Sources course={bundle} catalog={catalog} /></div>
    </div>
  );
}

// ---------- урок ----------
function LessonScreen({ bundle, lessonId }: { bundle: CourseBundle; lessonId: string }) {
  const { course } = bundle;
  const idx = course.lessons.findIndex((l) => l.id === lessonId);
  const lesson = course.lessons[idx];
  if (!lesson) return <p className="empty">Такого урока нет.</p>;
  const next = course.lessons[idx + 1];
  const done = async () => { await markLessonRead(course.id, lesson.id); go(next ? `learn/${course.id}/${next.id}` : `learn/${course.id}`); };
  return (
    <div data-testid="learn-lesson">
      <Back to={`learn/${course.id}`} label={course.title} />
      <div className="section"><h2>{lesson.title}</h2>
        <p className="sub">Урок {idx + 1} из {course.lessons.length} · около {lesson.minutes} мин</p>
        <DraftNote course={course} />
        <div className="lesson-body">{lesson.paragraphs.map((p, i) => <p key={i}>{p}</p>)}</div>
        <button className="btn primary block" onClick={() => void done()} data-testid="lesson-done">{next ? 'Прочитано. Дальше' : 'Прочитано. К курсу'}</button>
      </div>
    </div>
  );
}

// ---------- тест ----------
function Quiz({ bundle, catalog }: { bundle: CourseBundle; catalog: Catalog }) {
  const { course } = bundle;
  const [quiz, setQuiz] = useState<QuizQuestion[] | null>(null);
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<Graded | null>(null);
  const saved = useRef(false);

  const start = async () => {
    const q = buildQuiz(bundle.questions, { avoid: await getLastQuiz(course.id) });
    saved.current = false;
    setQuiz(q); setAnswers(q.map(() => null)); setStep(0); setResult(null);
  };
  useEffect(() => { void start(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [course.id]);

  const finish = async (final: (number | null)[]) => {
    if (!quiz || saved.current) return;
    saved.current = true;
    const g = gradeQuiz(quiz, final);
    // попытка записывается один раз и только после завершения; какие именно ответы были неверными, не хранится
    await addAttempt({ courseId: course.id, courseVersion: course.contentVersion, correct: g.correct, total: g.total, threshold: g.threshold, passed: g.passed });
    await setLastQuiz(course.id, quiz.map((q) => q.id));
    setResult(g);
  };

  if (!quiz) return <p className="empty">Готовлю вопросы…</p>;
  if (quiz.length === 0) return <div><Back to={`learn/${course.id}`} label={course.title} /><p className="empty">В курсе нет вопросов.</p></div>;

  if (result) {
    const wrong = result.review.filter((r) => !r.ok);
    return (
      <div data-testid="quiz-result">
        <div className="section"><h2>Результат</h2>
          <p className="learn-score" data-testid="quiz-score">Верно {result.correct} из {result.total} ({result.percent}%). Порог {result.threshold}%.</p>
          {result.passed
            ? <div className="learn-mark" role="status"><b>Тест пройден. Отметка о прохождении записана.</b><p className="why-notice">{MARK_NOTICE}</p></div>
            : <p className="sub" role="status">Тест не пройден. Это ничего не отменяет: можно перечитать уроки и пройти ещё раз, вопросы будут другими.</p>}
        </div>
        {wrong.length > 0 && (
          <div className="section" data-testid="quiz-review"><h2>Разбор ошибок</h2>
            {wrong.map((r) => {
              const lesson = course.lessons.find((l) => l.id === r.question.lesson);
              const srcs = catalog.questionSources(bundle.questions.find((q) => q.id === r.question.id)!);
              return (
                <div key={r.question.id} className="learn-review">
                  <p><b>{r.question.text}</b></p>
                  <p className="sub">Ваш ответ: {r.chosen === null ? 'нет ответа' : r.question.options[r.chosen]}</p>
                  <p>Верно: {r.question.options[r.question.correct]}</p>
                  <p className="sub">{r.question.explanation}</p>
                  {lesson && <button className="link-btn" onClick={() => go(`learn/${course.id}/${lesson.id}`)}>Перечитать: {lesson.title}</button>}
                  {srcs.map((s) => <p key={s.id} className="why-src">Источник: <button className="link-btn" onClick={() => void openExternal(s.url)}>{s.title}</button>, {s.license}</p>)}
                </div>
              );
            })}
          </div>
        )}
        <button className="btn primary block" onClick={() => void start()} data-testid="quiz-again">Пройти ещё раз</button>
        <button className="btn ghost block" style={{ marginTop: 8 }} onClick={() => go(`learn/${course.id}`)}>К курсу</button>
      </div>
    );
  }

  const q = quiz[step];
  const chosen = answers[step];
  const last = step === quiz.length - 1;
  const pick = (i: number) => setAnswers((a) => a.map((v, k) => (k === step ? i : v)));
  const next = () => { if (last) void finish(answers); else setStep(step + 1); };
  return (
    <div data-testid="quiz">
      <Back to={`learn/${course.id}`} label="Выйти из теста" />
      <div className="section">
        <p className="sub" data-testid="quiz-step">Вопрос {step + 1} из {quiz.length}</p>
        <fieldset className="quiz-q">
          <legend><b>{q.text}</b></legend>
          <div role="radiogroup" aria-label="Варианты ответа">
            {q.options.map((o, i) => (
              <button key={i} role="radio" aria-checked={chosen === i} className={'quiz-opt' + (chosen === i ? ' on' : '')} onClick={() => pick(i)} data-testid="quiz-opt">{o}</button>
            ))}
          </div>
        </fieldset>
        <button className="btn primary block" disabled={chosen === null} onClick={next} data-testid="quiz-next">{last ? 'Завершить' : 'Дальше'}</button>
      </div>
    </div>
  );
}

export function LearnView({ segs, catalog = defaultCatalog }: { segs: string[]; catalog?: Catalog }) {
  const [, courseId, third] = segs;
  const bundle = useMemo(() => catalog.course(courseId), [catalog, courseId]);
  if (!courseId) return <CoursesList catalog={catalog} />;
  if (!bundle) return <div><Back to="learn" label="Знания" /><p className="empty">Такого курса нет.</p></div>;
  if (third === 'test') return <Quiz key={bundle.course.id} bundle={bundle} catalog={catalog} />;
  if (third) return <LessonScreen bundle={bundle} lessonId={third} />;
  return <CourseScreen bundle={bundle} catalog={catalog} />;
}
