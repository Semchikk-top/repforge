// Справочное содержимое («Зачем это»): типы. Чистые данные без зависимостей от интерфейса.
// Источник правды лежит в content/ в корне репозитория; в приложение попадает только собранный bundle.

export type ContentStatus = 'draft' | 'reviewed' | 'published';
export const STATUSES: readonly ContentStatus[] = ['draft', 'reviewed', 'published'];

export interface Muscle { id: string; name: string; group: string; side: 'front' | 'back' | 'both' }

export interface Source {
  id: string;
  title: string;
  author: string;
  url: string;
  license: string;
  /** Дата, когда источник был получен и прочитан (ГГГГ-ММ-ДД). */
  retrievedAt: string;
}

/** Кто и когда проверил подсказки по технике и типичные ошибки (открытых источников для них нет). */
export interface TechniqueReview { by: string; at: string }

export interface Card {
  /** Id стартового упражнения из domain/seed.ts. */
  id: string;
  summary: string;
  primaryMuscles: string[];
  secondaryMuscles: string[];
  function: string;
  cues: string[];
  mistakes: string[];
  swapNote: string;
  sources: string[];
  status: ContentStatus;
  reviewedAt: string | null;
  contentVersion: number;
  /** Нужен для публикации: мышцы и функцию подтверждает источник, технику и ошибки — специалист. */
  techniqueReview?: TechniqueReview | null;
}

/** Короткая заметка-принцип («почему так»): та же схема статусов, что у карточек. */
export interface Principle {
  /** slug, например progressive-overload */
  id: string;
  title: string;
  /** Одно-два предложения: суть принципа простыми словами. */
  summary: string;
  points: string[];
  sources: string[];
  status: ContentStatus;
  reviewedAt: string | null;
  contentVersion: number;
}

/** Урок курса: 2–3 минуты чтения. Ссылки ведут на карточки упражнений и принципы, чтобы из них можно было «узнать больше». */
export interface Lesson {
  id: string;
  title: string;
  minutes: number;
  paragraphs: string[];
  relatedExercises: string[];
  relatedPrinciples: string[];
}

/** Курс («Как растут мышцы»). Те же статусы, что у карточек: в сборку попадает только published. */
export interface Course {
  id: string;
  title: string;
  summary: string;
  lessons: Lesson[];
  sources: string[];
  status: ContentStatus;
  reviewedAt: string | null;
  /** Растёт при каждой правке текста или вопросов: попытка помнит, по какой версии курса сдавалась. */
  contentVersion: number;
}

/** Вопрос теста: один правильный ответ, объяснение и основание. */
export interface Question {
  id: string;
  lesson: string;
  text: string;
  options: string[];
  /** Номер правильного варианта в options (с нуля). В тесте варианты перемешиваются. */
  correct: number;
  explanation: string;
  /** id источника из sources.json; у черновика может быть пустым, у проверенного обязателен. */
  source: string | null;
}

export interface CourseBundle { course: Course; questions: Question[] }

/** То, что уходит в сборку: названия мышц уже подставлены в справочник, источники только использованные. */
export interface Bundle {
  schema: 1;
  /** true — в сборку попали черновики (только для просмотра на своём устройстве, в релиз не идёт). */
  preview: boolean;
  muscles: Record<string, string>;
  /** id мышцы → группа приложения (chest, back…). Нужна карте нагрузки; у старых сборок поля нет. */
  muscleGroups?: Record<string, string>;
  sources: Record<string, Source>;
  cards: Record<string, Card>;
  principles: Record<string, Principle>;
  /** Курсы (1.5.0); у старых сборок поля нет. */
  courses?: Record<string, CourseBundle>;
}

export const EMPTY_BUNDLE: Bundle = { schema: 1, preview: false, muscles: {}, sources: {}, cards: {}, principles: {}, courses: {} };

/** Строка, которая показывается на каждой карточке и в правовой части. */
export const EDU_NOTICE = 'Образовательная информация, не медицинская рекомендация.';
