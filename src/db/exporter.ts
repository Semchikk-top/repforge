import { db } from './db';
import { platform } from '../platform';
import { exportAll } from './repo';
import { filterBackup, workoutsToCsv, type Range } from '../domain/exportData';
import { toMultiGpx } from '../cardio/gpx';
import type { Exercise } from '../domain/types';

export function download(name: string, content: string | Blob, type: string) {
  void platform.files.save(name, type, content).catch(() => { /* пользователь закрыл окно «Поделиться» */ });
}

/** Резервная копия за период (формат тот же, что у полного экспорта, её можно импортировать) */
export async function backupJson(range: Range): Promise<string> {
  return JSON.stringify(filterBackup(JSON.parse(await exportAll()), range), null, 2);
}

/** Таблица для Excel: BOM нужен, чтобы кириллица открылась правильно */
export async function workoutsCsv(range: Range): Promise<string> {
  const [workouts, exs] = await Promise.all([db.workouts.toArray(), db.exercises.toArray()]);
  return '\ufeff' + workoutsToCsv(workouts, new Map<string, Exercise>(exs.map((e) => [e.id, e])), range);
}

/** Все маршруты за период одним GPX; возвращает файл и число маршрутов */
export async function routesGpx(range: Range, zoneM: number): Promise<{ xml: string; count: number }> {
  const [workouts, exs] = await Promise.all([db.workouts.toArray(), db.exercises.toArray()]);
  const names = new Map(exs.map((e) => [e.id, e.name]));
  const items: { name: string; startMs: number; track: [number, number, number, number | null][] }[] = [];
  for (const w of workouts) {
    if (w.deletedAt || w.status !== 'done' || (range.from && w.date < range.from) || (range.to && w.date > range.to)) continue;
    for (const we of w.exercises) {
      const id = we.cardio?.trackId;
      const t = id ? await db.tracks.get(id) : undefined;
      if (t && !t.deletedAt) items.push({ name: `${w.date} ${names.get(we.exerciseId) ?? 'Маршрут'}`, startMs: w.startedAt ?? Date.parse(w.date), track: t.points });
    }
  }
  const xml = toMultiGpx(items, zoneM);
  return { xml, count: (xml.match(/<trk>/g) ?? []).length };
}
