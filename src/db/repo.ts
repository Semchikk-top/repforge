import { db } from './db';
import { uid, newId, toDateStr } from '../lib';
import { DEFAULT_SETTINGS, type BodyEntry, type Exercise, type Settings, type Program, type Template, type Track, type Workout } from '../domain/types';
import type { ProfileRow } from '../social/types';
import type { GameRow } from '../game/types';
import { SEED_EXERCISES } from '../domain/seed';

// ---------- устройство ----------
let cachedDeviceId: string | null = null;

export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  const row = await db.kv.get('deviceId');
  if (row) {
    cachedDeviceId = row.value as string;
  } else {
    cachedDeviceId = uid();
    await db.kv.put({ key: 'deviceId', value: cachedDeviceId });
  }
  return cachedDeviceId;
}

// ---------- настройки ----------
export async function loadSettings(): Promise<Settings> {
  const row = await db.kv.get('settings');
  return { ...DEFAULT_SETTINGS, ...((row?.value as Partial<Settings>) ?? {}) };
}

export async function saveSettings(s: Settings): Promise<void> {
  await db.kv.put({ key: 'settings', value: s });
}

export async function duplicateWorkout(id: string, date?: string): Promise<Workout | null> {
  const src = await db.workouts.get(id);
  if (!src) return null;
  const deviceId = await getDeviceId();
  const now = Date.now();
  const targetDate = date ?? toDateStr(new Date());
  const w: Workout = {
    id: newId(),
    createdAt: now,
    updatedAt: now,
    deviceId,
    date: targetDate,
    title: src.title,
    status: 'planned',
    exercises: src.exercises.map((we) => ({
      id: newId(),
      exerciseId: we.exerciseId,
      group: we.group,
      note: we.note,
      sets: we.sets.map((s) => ({ id: newId(), weight: s.weight, reps: s.reps, done: false, kind: s.kind, warmup: s.warmup }))
    })),
    note: src.note
  };
  await db.workouts.put(w);
  await logChange('workouts', w.id, 'put', deviceId);
  return w;
}

// ---------- запись с журналом изменений ----------
type TableName = 'exercises' | 'workouts' | 'templates' | 'tracks' | 'body' | 'programs' | 'profile' | 'game';

// Очередь отправки хранит не шаги правки, а «эта запись изменилась»: на сервер уходит сама запись целиком
// в её последнем виде. Поэтому правки одной записи схлопываются в одну строку очереди: вес 50 → 60 тремя
// нажатиями «+2,5» даёт одно изменение, а не три. Старую строку не обновляем, а заменяем новой: если она уже
// ушла в запрос, который ещё в пути, то после ответа закроется только она, а свежая правка отправится следующим кругом.
async function logChange(table: TableName, entityId: string, op: 'put' | 'delete', deviceId: string) {
  const stale = await db.changes.where('entityId').equals(entityId).and((c) => c.table === table && c.synced === 0).primaryKeys();
  if (stale.length) await db.changes.bulkDelete(stale);
  await db.changes.add({ table, entityId, op, ts: Date.now(), deviceId, synced: 0 });
}

/** Разовая уборка очереди, накопленной до схлопывания: у каждой записи остаётся только последняя строка. */
export async function compactChanges(): Promise<number> {
  return db.transaction('rw', db.changes, async () => {
    const pending = await db.changes.where('synced').equals(0).toArray();
    const last = new Map<string, number>();
    for (const c of pending) last.set(`${c.table}/${c.entityId}`, c.seq!); // порядок по seq: побеждает последняя
    const drop = pending.filter((c) => last.get(`${c.table}/${c.entityId}`) !== c.seq).map((c) => c.seq!);
    if (drop.length) await db.changes.bulkDelete(drop);
    return drop.length;
  });
}

type Input<T> = Omit<T, 'updatedAt' | 'deviceId'> & Partial<Pick<T extends { updatedAt: number; deviceId: string } ? T : never, 'updatedAt' | 'deviceId'>>;

export async function putExercise(e: Input<Exercise>) {
  const deviceId = await getDeviceId();
  const row: Exercise = { ...e, updatedAt: Date.now(), deviceId } as Exercise;
  await db.transaction('rw', db.exercises, db.changes, async () => {
    await db.exercises.put(row);
    await logChange('exercises', row.id, 'put', deviceId);
  });
  return row;
}

export async function putWorkout(w: Input<Workout>) {
  const deviceId = await getDeviceId();
  const row: Workout = { ...w, updatedAt: Date.now(), deviceId } as Workout;
  await db.transaction('rw', db.workouts, db.changes, async () => {
    await db.workouts.put(row);
    await logChange('workouts', row.id, 'put', deviceId);
  });
  return row;
}

export async function putTemplate(t: Input<Template>) {
  const deviceId = await getDeviceId();
  const row: Template = { ...t, updatedAt: Date.now(), deviceId } as Template;
  await db.transaction('rw', db.templates, db.changes, async () => {
    await db.templates.put(row);
    await logChange('templates', row.id, 'put', deviceId);
  });
  return row;
}

export async function putBody(b: Input<BodyEntry>) {
  const deviceId = await getDeviceId();
  const row: BodyEntry = { ...b, updatedAt: Date.now(), deviceId } as BodyEntry;
  await db.transaction('rw', db.body, db.changes, async () => {
    await db.body.put(row);
    await logChange('body', row.id, 'put', deviceId);
  });
  return row;
}

export async function putTrack(t: Input<Track>) {
  const deviceId = await getDeviceId();
  const row: Track = { ...t, updatedAt: Date.now(), deviceId } as Track;
  await db.transaction('rw', db.tracks, db.changes, async () => {
    await db.tracks.put(row);
    await logChange('tracks', row.id, 'put', deviceId);
  });
  return row;
}

// Мягкое удаление: запись остаётся с deletedAt, чтобы удаление синхронизировалось
export async function putProgram(pr: Input<Program>) {
  const deviceId = await getDeviceId();
  const row: Program = { ...pr, updatedAt: Date.now(), deviceId } as Program;
  await db.transaction('rw', db.programs, db.changes, async () => {
    await db.programs.put(row);
    await logChange('programs', row.id, 'put', deviceId);
  });
  return row;
}

// Игровой журнал: пачка записей одной транзакцией (запись + строки журнала изменений).
// Дистрибутивный Omit: у каждой разновидности записи свои поля.
type DOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never;
export async function putGame(rows: DOmit<GameRow, 'updatedAt' | 'deviceId'>[]): Promise<void> {
  if (!rows.length) return;
  const deviceId = await getDeviceId();
  const now = Date.now();
  await db.transaction('rw', db.game, db.changes, async () => {
    for (const r of rows) {
      await db.game.put({ ...r, updatedAt: now, deviceId } as GameRow);
      await logChange('game', r.id, 'put', deviceId);
    }
  });
}

// Профиль один (id 'me'); privateKey — CryptoKey, он остаётся только локально
// (в журнале и на сервере его нет, sync.ts вырезает его при отправке).
export async function putProfile(p: Omit<ProfileRow, 'updatedAt' | 'deviceId'>): Promise<ProfileRow> {
  const deviceId = await getDeviceId();
  const row: ProfileRow = { ...p, updatedAt: Date.now(), deviceId };
  await db.transaction('rw', db.profile, db.changes, async () => {
    await db.profile.put(row);
    await logChange('profile', 'me', 'put', deviceId);
  });
  return row;
}

/** Локальное обогащение профиля (расшифровка слепка): без обновления меты и без записи
 *  в журнал — подпись появилась на этом устройстве, но для синхронизации ничего не изменилось. */
export async function putProfileLocal(p: ProfileRow): Promise<void> {
  await db.profile.put(p);
}

/** Вернуть сохранённую версию записи (после конфликта синхронизации): она становится новой правкой и уходит на сервер */
export async function restoreRow(table: TableName, row: Record<string, unknown> & { id: string }) {
  const deviceId = await getDeviceId();
  await db.transaction('rw', db.table(table), db.changes, async () => {
    await db.table(table).put({ ...row, updatedAt: Date.now(), deviceId });
    await logChange(table, row.id, 'put', deviceId);
  });
}

export async function softDelete(table: TableName, id: string) {
  const deviceId = await getDeviceId();
  const now = Date.now();
  await db.transaction('rw', db.table(table), db.changes, async () => {
    const row = await db.table(table).get(id);
    if (!row) return;
    await db.table(table).put({ ...row, deletedAt: now, updatedAt: now, deviceId });
    await logChange(table, id, 'delete', deviceId);
  });
}

// ---------- конструкторы ----------
export async function newWorkout(partial: Partial<Workout> & { date: string }): Promise<Workout> {
  const deviceId = await getDeviceId();
  const now = Date.now();
  const w: Workout = {
    id: uid(),
    createdAt: now,
    updatedAt: now,
    deviceId,
    title: 'Тренировка',
    status: 'planned',
    exercises: [],
    ...partial
  };
  await putWorkout(w);
  return w;
}

export async function newTemplateFromWorkout(w: Workout, title: string) {
  const deviceId = await getDeviceId();
  const now = Date.now();
  const t: Template = {
    id: uid(),
    createdAt: now,
    updatedAt: now,
    deviceId,
    title,
    exercises: w.exercises.map((we) => {
      const done = we.sets.filter((s) => s.done);
      const src = done.length ? done : we.sets;
      const last = src[src.length - 1];
      return {
        exerciseId: we.exerciseId,
        group: we.group,
        sets: Math.max(1, src.length),
        reps: last?.reps ?? 10,
        weight: last?.weight ?? 0
      };
    })
  };
  await putTemplate(t);
  return t;
}

// ---------- стартовые упражнения ----------
// Добавляем недостающие. updatedAt = 0 и записи не попадают в журнал: они одинаковы на каждом
// устройстве, а любая правка пользователя (updatedAt > 0) выигрывает при синхронизации.
export async function ensureSeeds() {
  const existing = new Set((await db.exercises.toCollection().primaryKeys()) as string[]);
  const missing = SEED_EXERCISES.filter((e) => !existing.has(e.id));
  if (!missing.length) return;
  const rows: Exercise[] = missing.map((e) => ({
    id: e.id,
    createdAt: 0,
    updatedAt: 0,
    deviceId: 'seed',
    name: e.name,
    muscle: e.muscle,
    equipment: e.equipment,
    custom: false
  }));
  await db.exercises.bulkPut(rows);
}

// ---------- экспорт / импорт ----------
export async function exportAll(): Promise<string> {
  const [exercises, workouts, templates, tracks, body, programs, game, settings] = await Promise.all([
    db.exercises.toArray(),
    db.workouts.toArray(),
    db.templates.toArray(),
    db.tracks.toArray(),
    db.body.toArray(),
    db.programs.toArray(),
    db.game.toArray(),
    loadSettings()
  ]);
  return JSON.stringify({ version: 1, exportedAt: Date.now(), exercises, workouts, templates, tracks, body, programs, game, settings }, null, 2);
}

export async function importAll(json: string): Promise<{ exercises: number; workouts: number; templates: number }> {
  const data = JSON.parse(json);
  if (!data || data.version !== 1) throw new Error('Неизвестный формат файла');
  const deviceId = await getDeviceId();
  let ex = 0, wk = 0, tp = 0;
  await db.transaction('rw', [db.exercises, db.workouts, db.templates, db.tracks, db.body, db.programs, db.game, db.changes], async () => {
    // Импорт по правилу «побеждает более свежая запись»
    for (const e of (data.exercises ?? []) as Exercise[]) {
      const cur = await db.exercises.get(e.id);
      if (!cur || cur.updatedAt < e.updatedAt) { await db.exercises.put(e); await logChange('exercises', e.id, 'put', deviceId); ex++; }
    }
    for (const w of (data.workouts ?? []) as Workout[]) {
      const cur = await db.workouts.get(w.id);
      if (!cur || cur.updatedAt < w.updatedAt) { await db.workouts.put(w); await logChange('workouts', w.id, 'put', deviceId); wk++; }
    }
    for (const t of (data.templates ?? []) as Template[]) {
      const cur = await db.templates.get(t.id);
      if (!cur || cur.updatedAt < t.updatedAt) { await db.templates.put(t); await logChange('templates', t.id, 'put', deviceId); tp++; }
    }
    for (const b of (data.body ?? []) as BodyEntry[]) {
      const cur = await db.body.get(b.id);
      if (!cur || cur.updatedAt < b.updatedAt) { await db.body.put(b); await logChange('body', b.id, 'put', deviceId); }
    }
    for (const t of (data.programs ?? []) as Program[]) {
      const cur = await db.programs.get(t.id);
      if (!cur || cur.updatedAt < t.updatedAt) { await db.programs.put(t); await logChange('programs', t.id, 'put', deviceId); }
    }
    for (const g of (data.game ?? []) as GameRow[]) {
      const cur = await db.game.get(g.id);
      if (!cur || cur.updatedAt < g.updatedAt) { await db.game.put(g); await logChange('game', g.id, 'put', deviceId); }
    }
    for (const t of (data.tracks ?? []) as Track[]) {
      const cur = await db.tracks.get(t.id);
      if (!cur || cur.updatedAt < t.updatedAt) { await db.tracks.put(t); await logChange('tracks', t.id, 'put', deviceId); }
    }
  });
  if (data.settings) await saveSettings({ ...DEFAULT_SETTINGS, ...data.settings });
  return { exercises: ex, workouts: wk, templates: tp };
}
