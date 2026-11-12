import type { Exercise, Workout } from './types';

export interface Range { from?: string; to?: string }
export const inRange = (date: string, r: Range) => (!r.from || date >= r.from) && (!r.to || date <= r.to);

/** Защита CSV от «формул»: Excel и Таблицы выполняют ячейки, начинающиеся с = + - @ */
export function csvCell(v: unknown): string {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) s = "'" + s;
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** Время выполнения подхода: пусто, если не измерено (старые тренировки, подходы без «Начать»). Без формул и без дробей. */
export const workSecCell = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? String(Math.round(v)) : '');

const KIND = { normal: 'обычный', drop: 'дроп-сет', restpause: 'rest-pause' } as const;

/** Таблица по подходам; разделитель «;» открывается в русском Excel. BOM добавляет вызывающая сторона при сохранении. */
export function workoutsToCsv(workouts: Workout[], exMap: Map<string, Exercise>, range: Range = {}): string {
  const rows = [['Дата', 'Тренировка', 'Упражнение', 'Подход', 'Тип', 'Вес, кг', 'Повторы', 'RPE', 'Заметка', 'Дистанция, км', 'Время, с', 'Время подхода, с']];
  for (const w of [...workouts].filter((x) => !x.deletedAt && x.status === 'done' && inRange(x.date, range)).sort((a, b) => a.date.localeCompare(b.date))) {
    for (const we of w.exercises) {
      const name = exMap.get(we.exerciseId)?.name ?? 'Удалённое упражнение';
      if (we.cardio) rows.push([w.date, w.title, name, '', 'кардио', '', '', '', '', (we.cardio.distanceM / 1000).toFixed(2), String(we.cardio.durationSec), '']);
      we.sets.filter((s) => s.done).forEach((s, i) => rows.push([w.date, w.title, name, String(i + 1), KIND[s.kind ?? 'normal'], String(s.weight), String(s.reps), s.rpe === undefined ? '' : String(s.rpe), s.note ?? '', '', '', workSecCell(s.workSec)]));
    }
  }
  return rows.map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

/** Оставить в файле резервной копии только записи из периода (справочники и шаблоны остаются целиком: на них ссылаются тренировки) */
export function filterBackup<T extends { workouts?: { id: string; date: string }[]; tracks?: { workoutId: string }[]; body?: { date: string }[]; checkins?: { date: string }[]; learning?: { date: string }[] }>(data: T, r: Range): T {
  const workouts = (data.workouts ?? []).filter((w) => inRange(w.date, r));
  const ids = new Set(workouts.map((w) => w.id));
  return { ...data, workouts, tracks: (data.tracks ?? []).filter((t) => ids.has(t.workoutId)), body: (data.body ?? []).filter((b) => inRange(b.date, r)), checkins: (data.checkins ?? []).filter((c) => inRange(c.date, r)), learning: (data.learning ?? []).filter((a) => inRange(a.date, r)) };
}
