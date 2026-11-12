// Доступ к справочнику из интерфейса. Работает без сети: bundle лежит в сборке.
import raw from './bundle.generated.json';
import { EMPTY_BUNDLE, type Bundle, type Card, type CourseBundle, type Lesson, type Principle, type Question, type Source } from './types';

export interface LessonRef { courseId: string; courseTitle: string; lesson: Lesson }

export interface Catalog {
  preview: boolean;
  has: (exerciseId: string | undefined) => boolean;
  card: (exerciseId: string | undefined) => Card | null;
  principle: (id: string | undefined) => Principle | null;
  principleSources: (p: Principle) => Source[];
  muscleNames: (ids: string[]) => string[];
  /** Группа приложения для мышцы из справочника (для карты нагрузки); null, если неизвестна. */
  groupOf: (muscleId: string) => string | null;
  sourcesOf: (card: Card) => Source[];
  allSources: () => Source[];
  /** Курсы (1.5.0), по алфавиту названий. Пусто, пока ни один не опубликован. */
  courses: () => CourseBundle[];
  course: (id: string | undefined) => CourseBundle | null;
  /** Уроки, которые ссылаются на упражнение или принцип: для «Узнать больше». */
  lessonsForExercise: (exerciseId: string | undefined) => LessonRef[];
  lessonsForPrinciple: (principleId: string | undefined) => LessonRef[];
  questionSources: (q: Question) => Source[];
}

export function makeCatalog(bundle: Bundle): Catalog {
  const card = (id: string | undefined) => (id ? bundle.cards[id] ?? null : null);
  const courses = () => Object.values(bundle.courses ?? {}).sort((a, b) => a.course.title.localeCompare(b.course.title, 'ru'));
  const lessonsWhere = (pick: (l: Lesson) => string[], id: string | undefined): LessonRef[] =>
    id ? courses().flatMap(({ course }) => course.lessons.filter((l) => pick(l).includes(id)).map((lesson) => ({ courseId: course.id, courseTitle: course.title, lesson }))) : [];
  return {
    preview: bundle.preview,
    has: (id) => card(id) !== null,
    card,
    principle: (id) => (id ? bundle.principles?.[id] ?? null : null),
    principleSources: (p) => p.sources.map((s) => bundle.sources[s]).filter((s): s is Source => !!s),
    muscleNames: (ids) => ids.map((m) => bundle.muscles[m] ?? m),
    groupOf: (m) => bundle.muscleGroups?.[m] ?? null,
    sourcesOf: (c) => c.sources.map((s) => bundle.sources[s]).filter((s): s is Source => !!s),
    allSources: () => Object.values(bundle.sources).sort((a, b) => a.title.localeCompare(b.title, 'ru')),
    courses,
    course: (id) => (id ? bundle.courses?.[id] ?? null : null),
    lessonsForExercise: (id) => lessonsWhere((l) => l.relatedExercises, id),
    lessonsForPrinciple: (id) => lessonsWhere((l) => l.relatedPrinciples, id),
    questionSources: (q) => (q.source && bundle.sources[q.source] ? [bundle.sources[q.source]] : [])
  };
}

const bundle: Bundle = raw && (raw as Bundle).schema === 1 ? { ...EMPTY_BUNDLE, ...(raw as Partial<Bundle>) } as Bundle : EMPTY_BUNDLE;
export const catalog: Catalog = makeCatalog(bundle);
