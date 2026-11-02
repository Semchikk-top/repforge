// «Что делать сегодня»: один главный совет на главном экране вместо россыпи карточек.
// Чистая функция от дневника: без базы, без часов (дата приходит параметром), поэтому легко проверяется тестами.
// Совет всегда один главный (кнопка) и, при необходимости, один запасной. Порядок правил важен: сверху то, что уже в движении.
import type { Workout } from './types';
import type { ReadinessLevel } from './checkin';
import { workoutSetsCount, workoutVolume } from './analytics';
import { parseDate } from '../lib';

export type TodayAction =
  | { type: 'open'; workoutId: string }     // открыть тренировку
  | { type: 'start' }                       // выбрать и начать другую тренировку на сегодня
  | { type: 'repeat'; workoutId: string }   // скопировать прошлую тренировку на сегодня и открыть
  | { type: 'move'; workoutId: string }     // перенести пропущенную на сегодня и открыть
  | { type: 'onboarding' };                 // подобрать стартовую программу

export type TodayKind = 'continue' | 'planned' | 'done' | 'missed' | 'first' | 'rest' | 'suggest';

export interface TodayStep { text: string; done: boolean }
export interface TodayButton { label: string; action: TodayAction }
export interface TodayAdvice {
  kind: TodayKind;
  headline: string;
  detail: string;
  primary?: TodayButton;
  secondary?: TodayButton;
  /** Пошаговый путь для новичка. */
  steps?: TodayStep[];
}

export interface TodayInput {
  today: string;
  /** Тренировки без удалённых. */
  workouts: Workout[];
  /** Есть ли шаблоны или программы: человек уже выбрал себе план. */
  hasPlan: boolean;
  /** Показывали бы мы сейчас подбор стартовой программы (дневник пуст, карточку не закрывали). */
  onboardingOffered: boolean;
  /** Готовность по утреннему чек-ину сегодня, если он заполнен. */
  readiness: ReadinessLevel | null;
}

/** Сколько дней назад пропущенную тренировку ещё предлагаем перенести: дальше она уже не «пропущена», а забытая. */
export const MISSED_DAYS = 7;
/** Подряд идущие дни с тренировкой, после которых совет — отдых. */
export const REST_AFTER_STREAK = 3;
/** После такого перерыва (дней) мягко просим начать полегче. */
export const LONG_BREAK_DAYS = 10;

const DAY = 86_400_000;
export const dayDiff = (a: string, b: string): number => Math.round((parseDate(a).getTime() - parseDate(b).getTime()) / DAY);

const ON_DAY = ['в воскресенье', 'в понедельник', 'во вторник', 'в среду', 'в четверг', 'в пятницу', 'в субботу'];

/** «сегодня», «завтра», «вчера», «3 дн. назад», «в пятницу, 7 ноября», «12 ноября». */
export function dayWord(date: string, today: string): string {
  const d = dayDiff(date, today);
  if (d === 0) return 'сегодня';
  if (d === 1) return 'завтра';
  if (d === -1) return 'вчера';
  if (d < 0 && d >= -14) return `${-d} дн. назад`;
  const dt = parseDate(date);
  const dm = dt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  return d > 1 && d < 7 ? `${ON_DAY[dt.getDay()]}, ${dm}` : dm;
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const exWord = (n: number) => `${n} ${plural(n, 'упражнение', 'упражнения', 'упражнений')}`;
const setWord = (n: number) => `${n} ${plural(n, 'подход', 'подхода', 'подходов')}`;

const byDateAsc = (a: Workout, b: Workout) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt;

/**
 * Какая тренировка по ритму человека идёт следующей. Находим прошлое вхождение последней по названию
 * и берём то, что за ним следовало (A, B, A, B → после B идёт A). Если ритма ещё нет, берём то, что давнее всего не делали.
 * Возвращает самую свежую тренировку с этим названием: в ней актуальные веса.
 */
export function nextInCycle(done: Workout[]): Workout | null {
  const list = [...done].sort(byDateAsc);
  if (!list.length) return null;
  const last = list[list.length - 1];
  const title = (w: Workout) => w.title.trim().toLowerCase();
  let nextTitle: string | null = null;
  for (let i = list.length - 2; i >= 0; i--) {
    if (title(list[i]) === title(last)) { nextTitle = title(list[i + 1]); break; }
  }
  if (nextTitle === null) {
    const lastSeen = new Map<string, string>();
    for (const w of list) lastSeen.set(title(w), w.date);
    const others = [...lastSeen.entries()].filter(([t]) => t !== title(last)).sort((a, b) => a[1].localeCompare(b[1]));
    nextTitle = others.length ? others[0][0] : title(last);
  }
  for (let i = list.length - 1; i >= 0; i--) if (title(list[i]) === nextTitle) return list[i];
  return last;
}

/** Сколько последних дней подряд (считая от вчера или от сегодня) была тренировка. */
export function trainingStreak(done: Workout[], today: string): number {
  const days = new Set(done.map((w) => w.date));
  let n = 0;
  let cursor = days.has(today) ? 0 : -1;
  while (days.has(shift(today, cursor))) { n++; cursor--; }
  return n;
}

function shift(date: string, n: number): string {
  const d = parseDate(date);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function todayAdvice(i: TodayInput): TodayAdvice {
  const { today, workouts } = i;
  const live = workouts.filter((w) => !w.deletedAt);
  const done = live.filter((w) => w.status === 'done');
  const own = done.filter((w) => !w.imported);
  const history = own.length ? own : done;           // перенесённая история годится, пока своей нет
  const low = i.readiness === 'low';
  const lowNote = low ? ' Утренний чек-ин показал, что сил меньше обычного: снизь вес или объём.' : '';

  // 1. тренировка уже идёт
  const active = live.filter((w) => w.status === 'active').sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
  if (active) {
    const n = workoutSetsCount(active);
    return {
      kind: 'continue', headline: `Идёт тренировка: ${active.title}`,
      detail: n ? `Выполнено: ${setWord(n)}. Продолжай с того места, где остановился.` : 'Только началась: отмечай подходы по ходу.',
      primary: { label: 'Продолжить', action: { type: 'open', workoutId: active.id } }
    };
  }

  // 2. на сегодня что-то запланировано
  const planned = live.filter((w) => w.status === 'planned' && w.date === today).sort(byDateAsc);
  if (planned.length) {
    const w = planned[0];
    const more = planned.length > 1 ? ` Ещё на сегодня: ${planned.length - 1}.` : '';
    return {
      kind: 'planned', headline: `Сегодня: ${w.title}`,
      detail: `${w.exercises.length ? exWord(w.exercises.length) : 'Без упражнений: добавишь по ходу'}.${more}${lowNote}`,
      primary: { label: 'Начать', action: { type: 'open', workoutId: w.id } },
      secondary: { label: 'Другая тренировка', action: { type: 'start' } }
    };
  }

  // 3. сегодня уже потренировались
  const doneToday = done.filter((w) => w.date === today).sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  const upcoming = live.filter((w) => w.status === 'planned' && w.date > today).sort(byDateAsc);
  if (doneToday.length) {
    const w = doneToday[0];
    const sets = workoutSetsCount(w);
    const vol = Math.round(workoutVolume(w));
    const next = upcoming[0];
    return {
      kind: 'done', headline: 'Сегодняшняя тренировка выполнена',
      detail: `${w.title}${sets ? `: ${setWord(sets)}${vol ? `, ${vol} кг суммарно` : ''}` : ''}. ` +
        (next ? `Следующая — ${dayWord(next.date, today)}: ${next.title}.` : 'Дальше отдых. Следующую пока не запланировал.'),
      primary: next ? { label: 'Что дальше', action: { type: 'open', workoutId: next.id } } : undefined
    };
  }

  // 4. пропущена недавняя тренировка
  const missed = live.filter((w) => w.status === 'planned' && w.date < today && dayDiff(today, w.date) <= MISSED_DAYS).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (missed) {
    return {
      kind: 'missed', headline: `Пропущена: ${missed.title}`,
      detail: `Была запланирована ${dayWord(missed.date, today)}. Можно сделать сегодня: расписание сдвигать не придётся.${lowNote}`,
      primary: { label: 'Сделать сегодня', action: { type: 'move', workoutId: missed.id } },
      secondary: { label: 'Другая тренировка', action: { type: 'start' } }
    };
  }

  // 5. новичок: тренировок ещё не было
  if (!history.length) {
    const next = upcoming[0];
    const steps: TodayStep[] = [
      { text: 'Выбрать стартовую программу или собрать тренировку', done: i.hasPlan || live.length > 0 },
      { text: 'Провести первую тренировку', done: false },
      { text: 'Завершить её и посмотреть прогресс во вкладке «Аналитика»', done: false }
    ];
    if (next) {
      return {
        kind: 'first', headline: 'Первая тренировка уже в плане',
        detail: `${next.title} — ${dayWord(next.date, today)}. Можно подождать или начать раньше.`,
        primary: { label: 'Посмотреть', action: { type: 'open', workoutId: next.id } },
        secondary: { label: 'Начать сейчас', action: { type: 'start' } }, steps
      };
    }
    return {
      kind: 'first', headline: 'С чего начать',
      detail: i.onboardingOffered
        ? 'Ответь на четыре вопроса, и приложение подберёт программу и расставит тренировки по неделе.'
        : 'Нажми «Начать»: добавь упражнения и отмечай подходы, остальное приложение посчитает само.',
      primary: i.onboardingOffered ? { label: 'Подобрать программу', action: { type: 'onboarding' } } : { label: 'Начать тренировку', action: { type: 'start' } },
      secondary: i.onboardingOffered ? { label: 'Просто начать', action: { type: 'start' } } : undefined, steps
    };
  }

  // 6. сегодня лучше отдохнуть
  const last = [...history].sort(byDateAsc).pop()!;
  const sinceLast = dayDiff(today, last.date);
  const streak = trainingStreak(history, today);
  const next = upcoming[0];
  if (streak >= REST_AFTER_STREAK || (low && sinceLast === 1)) {
    return {
      kind: 'rest', headline: 'Сегодня лучше отдохнуть',
      detail: streak >= REST_AFTER_STREAK
        ? `${streak} ${plural(streak, 'день', 'дня', 'дней')} подряд с тренировкой: мышцам нужно время.`
        : 'Вчера была тренировка, а утренний чек-ин показал, что сил меньше обычного.',
      primary: next ? { label: 'Ближайшая тренировка', action: { type: 'open', workoutId: next.id } } : undefined,
      secondary: { label: 'Всё равно потренироваться', action: { type: 'start' } }
    };
  }

  // 7. по плану сегодня отдых
  if (next && dayDiff(next.date, today) <= 7) {
    return {
      kind: 'rest', headline: 'Сегодня по плану отдых',
      detail: `Ближайшая тренировка — ${dayWord(next.date, today)}: ${next.title}.`,
      primary: { label: 'Открыть', action: { type: 'open', workoutId: next.id } },
      secondary: { label: 'Потренироваться сегодня', action: { type: 'start' } }
    };
  }

  // 8. плана нет: предлагаем по ритму человека
  const rec = nextInCycle(history)!;
  const gap = sinceLast <= 0 ? '' : `Последняя тренировка была ${dayWord(last.date, today)} (${last.title}). `;
  const long = sinceLast >= LONG_BREAK_DAYS;
  return {
    kind: 'suggest', headline: `Можно: ${rec.title}`,
    detail: long
      ? `${gap}Перерыв заметный: начни полегче, на 70–80% привычных весов, и вернёшься в ритм за неделю.`
      : `${gap}По твоему ритму дальше идёт это.${lowNote}`,
    primary: { label: 'Начать', action: { type: 'repeat', workoutId: rec.id } },
    secondary: { label: 'Другая тренировка', action: { type: 'start' } }
  };
}
