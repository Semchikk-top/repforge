// «Почему так»: объяснение решений приложения в два слоя, без участия модели.
//   1. Факт из твоих данных: структурированная причина (код + числа), которую возвращает тот же код, что принял решение.
//   2. Принцип: id заметки из справочника (content/principles), к которой ведёт «Узнать больше».
// Тексты фактов собираются здесь из кода причины, а не хранятся рядом с решением: так объяснение не расходится с поведением.

import { formatRest } from './rest';

export type Why =
  | { code: 'rest-exercise'; sec: number }
  | { code: 'rest-settings'; sec: number }
  | { code: 'rest-suggest'; direction: 'longer' | 'shorter'; currentSec: number; avgSec: number; workouts: number; sec: number }
  | { code: 'next-comeback'; weeks: number; weight: number }
  | { code: 'next-deload'; weight: number; reps: number }
  | { code: 'next-hold-rpe'; rpe: number }
  | { code: 'next-add-weight'; reps: number; steps: 1 | 2; rpe: number | null }
  | { code: 'next-add-reps'; add: 1 | 2; rpe: number | null }
  | { code: 'heavy-yes'; weight: number; reps: number; record: number; threshold: number; share: number; maxReps: number }
  | { code: 'heavy-light'; weight: number; reps: number; record: number; threshold: number }
  | { code: 'heavy-many-reps'; reps: number; maxReps: number }
  | { code: 'heavy-no-record' }
  | { code: 'ease-sleep' | 'ease-readiness' | 'ease-load' | 'ease-plateau'; text: string };

export type WhyCode = Why['code'];

/** Принцип из справочника, который объясняет решение. Все id проверяются тестом на соответствие content/principles. */
export const PRINCIPLE_OF: Record<WhyCode, string> = {
  'rest-exercise': 'rest-between-sets',
  'rest-settings': 'rest-between-sets',
  'rest-suggest': 'rest-between-sets',
  'next-comeback': 'progressive-overload',
  'next-deload': 'deload-week',
  'next-hold-rpe': 'effort-reps-in-reserve',
  'next-add-weight': 'progressive-overload',
  'next-add-reps': 'progressive-overload',
  'heavy-yes': 'heavy-session',
  'heavy-light': 'heavy-session',
  'heavy-many-reps': 'heavy-session',
  'heavy-no-record': 'heavy-session',
  'ease-sleep': 'recovery-and-sleep',
  'ease-readiness': 'recovery-and-sleep',
  'ease-load': 'frequency-and-volume',
  'ease-plateau': 'progressive-overload'
};

export const principleOf = (w: Why): string => PRINCIPLE_OF[w.code];

const num = (n: number): string => String(Math.round(n * 100) / 100).replace('.', ',');
const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Факт из твоих данных простыми словами. Без советов: совет даёт принцип. */
export function renderWhy(w: Why): string {
  switch (w.code) {
    case 'rest-exercise': return `Отдых ${formatRest(w.sec)}: это значение задано в самом упражнении.`;
    case 'rest-settings': return `Отдых ${formatRest(w.sec)}: у упражнения свой отдых не задан, поэтому взято значение из настроек.`;
    case 'rest-suggest': return `В последних ${w.workouts} тренировках ты отдыхал в среднем около ${formatRest(w.avgSec)} при заданных ${formatRest(w.currentSec)}, то есть ${w.direction === 'longer' ? 'дольше' : 'короче'}, чем стоит. Поэтому предложено ${formatRest(w.sec)}.`;
    case 'next-comeback': return `Прошлая тренировка была ${w.weeks} нед. назад. После такого перерыва предложено около 90% рабочего веса (${num(w.weight)}).`;
    case 'next-deload': return `При весе ${num(w.weight)} повторов становилось меньше две тренировки подряд. Поэтому предложена разгрузка: вес −10%, ${w.reps} повторов.`;
    case 'next-hold-rpe': return `В прошлый раз усилие было почти предельным (RPE ${num(w.rpe)}), поэтому предложено повторить тот же результат, не добавляя.`;
    case 'next-add-weight': return w.steps === 2
      ? `Во всех подходах было ${w.reps}+ повторений, а усилие лёгкое (RPE ${num(w.rpe ?? 0)}), поэтому вес предложено увеличить сразу на два шага.`
      : `Во всех подходах было ${w.reps}+ повторений, поэтому вес предложено увеличить на один шаг.`;
    case 'next-add-reps': return w.add === 2
      ? `В прошлый раз было легко (RPE ${num(w.rpe ?? 0)}), поэтому предложено добавить два повторения.`
      : 'Верх диапазона повторений ещё не достигнут, поэтому предложено добавить одно повторение к прошлому разу.';
    case 'heavy-yes': return `Подход ${num(w.weight)}×${w.reps} тяжёлый: вес не ниже ${num(w.threshold)} (около ${Math.round(w.share * 100)}% твоего рекорда ${num(w.record)}) и повторений не больше ${w.maxReps}.`;
    case 'heavy-light': return `Подход ${num(w.weight)}×${w.reps} не тяжёлый: порог для рекорда ${num(w.record)} равен ${num(w.threshold)}.`;
    case 'heavy-many-reps': return `Подход не считается тяжёлым: повторений ${w.reps}, а тяжёлыми считаются подходы до ${w.maxReps}.`;
    case 'heavy-no-record': return 'Судить о тяжести не по чему: у упражнения нет рекорда, вес не задан или это упражнение с собственным весом.';
    case 'ease-sleep': case 'ease-readiness': case 'ease-load': case 'ease-plateau': return `Причина: ${w.text}.`;
  }
}

export { cap };
