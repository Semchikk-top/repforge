import { db } from './db';
import { BACKUP_TABLES, decide, sanitizeSettings, validateBackup } from './backupInspect';
import { uid, newId, toDateStr } from '../lib';
import { checkInId, normalizeCheckIn, type CheckInDraft } from '../domain/checkin';
import type { ImportPlan } from '../domain/importWorkouts';
import type { StarterPlan } from '../domain/starter';
import { DEFAULT_SETTINGS, type BodyEntry, type CheckIn, type CheckInSlot, type Exercise, type Settings, type Program, type Template, type Track, type Workout } from '../domain/types';
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
type TableName = 'exercises' | 'workouts' | 'templates' | 'tracks' | 'body' | 'programs' | 'profile' | 'game' | 'checkins';

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

/**
 * Сохранить чек-ин. Запись одна на дату и слот: id берётся из пары, поэтому повторное сохранение правит ту же запись,
 * а удалённая ранее запись «оживает». Не прошедший проверку черновик отклоняется (null).
 */
export async function saveCheckIn(draft: CheckInDraft): Promise<CheckIn | null> {
  const d = normalizeCheckIn(draft);
  if (!d) return null;
  const deviceId = await getDeviceId();
  const id = checkInId(d.date, d.slot);
  return db.transaction('rw', db.checkins, db.changes, async () => {
    // Запись с этой датой и слотом могла появиться под другим id (импорт, ручная правка): правим её, а не заводим вторую.
    const dup = await db.checkins.where('[date+slot]').equals([d.date, d.slot]).first();
    const prev = dup ?? (await db.checkins.get(id));
    const row: CheckIn = { ...d, id: prev?.id ?? id, createdAt: prev?.createdAt ?? Date.now(), updatedAt: Date.now(), deviceId, deletedAt: null };
    await db.checkins.put(row);
    await logChange('checkins', row.id, 'put', deviceId);
    return row;
  });
}

export async function deleteCheckIn(date: string, slot: CheckInSlot): Promise<void> {
  const deviceId = await getDeviceId();
  await db.transaction('rw', db.checkins, db.changes, async () => {
    const cur = await db.checkins.where('[date+slot]').equals([date, slot]).first();
    if (!cur || cur.deletedAt) return;
    await db.checkins.put({ ...cur, deletedAt: Date.now(), updatedAt: Date.now(), deviceId });
    await logChange('checkins', cur.id, 'put', deviceId);
  });
}

/**
 * Записать подтверждённый план импорта. Только создаёт записи: если запись с таким id уже есть, она остаётся нетронутой.
 * Пока в плане есть неразрешённые упражнения, писать нечего: это ошибка вызова, а не молчаливый пропуск.
 */
export async function applyImportPlan(plan: ImportPlan): Promise<{ workouts: number; exercises: number; skipped: number }> {
  if (plan.unresolved.length) throw new Error('Не для всех упражнений выбрано решение');
  const deviceId = await getDeviceId();
  const now = Date.now();
  let workouts = 0, exercises = 0, skipped = 0;
  await db.transaction('rw', db.exercises, db.workouts, db.changes, async () => {
    for (const e of plan.newExercises) {
      if (await db.exercises.get(e.id)) continue;
      await db.exercises.put({ id: e.id, name: e.name, muscle: e.muscle, equipment: '', custom: true, createdAt: now, updatedAt: now, deviceId });
      await logChange('exercises', e.id, 'put', deviceId);
      exercises++;
    }
    for (const w of plan.workouts) {
      if (await db.workouts.get(w.id)) { skipped++; continue; }
      await db.workouts.put({ ...w, createdAt: now, updatedAt: now, deviceId });
      await logChange('workouts', w.id, 'put', deviceId);
      workouts++;
    }
  });
  return { workouts, exercises, skipped };
}

/**
 * Создать выбранную стартовую программу: недостающие упражнения, по шаблону на каждую тренировку и саму программу.
 * Всё в одной транзакции, чтобы не осталось полусозданной программы. Существующие упражнения не меняются.
 */
export async function applyStarterPlan(plan: StarterPlan, startDate: string, weeks = 8): Promise<string> {
  const deviceId = await getDeviceId();
  const now = Date.now();
  const programId = uid();
  await db.transaction('rw', db.exercises, db.templates, db.programs, db.changes, async () => {
    for (const e of plan.newExercises) {
      if (await db.exercises.get(e.id)) continue;
      await db.exercises.put({ id: e.id, name: e.name, muscle: e.muscle, equipment: e.equipment, custom: true, createdAt: now, updatedAt: now, deviceId });
      await logChange('exercises', e.id, 'put', deviceId);
    }
    const days: Program['days'] = [];
    for (const [i, s] of plan.sessions.entries()) {
      const id = uid();
      await db.templates.put({ id, title: s.title, exercises: s.exercises.map((x) => ({ exerciseId: x.exerciseId, sets: x.sets, reps: x.reps, weight: 0 })), createdAt: now, updatedAt: now, deviceId });
      await logChange('templates', id, 'put', deviceId);
      days.push({ weekday: plan.weekdays[i], templateId: id });
    }
    await db.programs.put({ id: programId, title: plan.title, startDate, weeks, days, createdAt: now, updatedAt: now, deviceId });
    await logChange('programs', programId, 'put', deviceId);
  });
  return programId;
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
  const [exercises, workouts, templates, tracks, body, programs, game, checkins, settings] = await Promise.all([
    db.exercises.toArray(),
    db.workouts.toArray(),
    db.templates.toArray(),
    db.tracks.toArray(),
    db.body.toArray(),
    db.programs.toArray(),
    db.game.toArray(),
    db.checkins.toArray(),
    loadSettings()
  ]);
  const counts = { exercises: exercises.length, workouts: workouts.length, templates: templates.length, tracks: tracks.length, body: body.length, programs: programs.length, game: game.length, checkins: checkins.length };
  // counts — сверка при импорте: неполный файл (обрезанный вручную, потерянный раздел) не примется молча
  return JSON.stringify({ version: 1, exportedAt: Date.now(), counts, exercises, workouts, templates, tracks, body, programs, game, checkins, settings }, null, 2);
}

export async function importAll(json: string): Promise<{ exercises: number; workouts: number; templates: number }> {
  // Сначала проверка: битая или чужая копия не должна изменить ни одной записи
  const v = validateBackup(json);
  if (!v.ok) throw new Error(v.error);
  const data = v.data;
  const deviceId = await getDeviceId();
  const written: Record<string, number> = {};
  await db.transaction('rw', [db.exercises, db.workouts, db.templates, db.tracks, db.body, db.programs, db.game, db.checkins, db.changes], async () => {
    // Побеждает более свежая запись: решение то же, что показывает предпросмотр (decide)
    for (const t of BACKUP_TABLES) {
      const table = db[t] as unknown as { get(id: string): Promise<{ updatedAt: number } | undefined>; put(row: unknown): Promise<unknown> };
      for (const row of data[t] ?? []) {
        const d = decide(await table.get(row.id), row);
        if (d !== 'add' && d !== 'replace') continue;
        await table.put(row);
        await logChange(t, row.id, 'put', deviceId);
        written[t] = (written[t] ?? 0) + 1;
      }
    }
  });
  if (data.settings) await saveSettings(sanitizeSettings(data.settings));
  return { exercises: written.exercises ?? 0, workouts: written.workouts ?? 0, templates: written.templates ?? 0 };
}
