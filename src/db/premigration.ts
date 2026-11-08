// Снимок данных перед миграцией схемы IndexedDB. Dexie обновляет базу сам при первом обращении, и если миграция
// сломается посередине, прежнего состояния уже не вернуть. Поэтому до первого обращения читаем старую базу «сырым»
// IndexedDB и кладём копию в отдельную базу. Она живёт, пока её не заменит следующий снимок.
import { db } from './db';
import { BACKUP_FORMAT, BACKUP_TABLES } from './backupInspect';

const SNAP_DB = 'workout-pwa-premigration';
const SNAP_STORE = 'snap';
/** Dexie хранит версию схемы n как n × 10 в IndexedDB. */
const DEXIE_FACTOR = 10;

export interface SnapshotMeta { at: number; fromVersion: number; toVersion: number; rows: number; workouts: number }
export type SnapshotResult =
  | { status: 'not-needed' }
  | { status: 'saved'; meta: SnapshotMeta }
  | { status: 'failed'; error: string };

const wrap = <T>(req: IDBRequest<T>): Promise<T> => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error ?? new Error('Ошибка IndexedDB')); });
const done = (tx: IDBTransaction): Promise<void> => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error ?? new Error('Ошибка IndexedDB')); tx.onabort = () => rej(tx.error ?? new Error('Операция отменена')); });

/** Версия схемы существующей базы (в терминах Dexie); 0, если базы ещё нет. Саму базу не создаёт. */
async function installedVersion(name: string): Promise<number> {
  if (typeof indexedDB.databases === 'function') {
    const found = (await indexedDB.databases()).find((d) => d.name === name);
    return found?.version ? Math.round(found.version / DEXIE_FACTOR) : 0;
  }
  // старые браузеры: открываем без версии и отменяем создание, если базы не было
  return new Promise((res, rej) => {
    const req = indexedDB.open(name);
    let fresh = false;
    req.onupgradeneeded = () => { fresh = true; req.transaction?.abort(); };
    req.onsuccess = () => { const v = req.result.version; req.result.close(); res(Math.round(v / DEXIE_FACTOR)); };
    req.onerror = () => (fresh ? res(0) : rej(req.error));
  });
}

async function readRaw(name: string): Promise<{ tables: Record<string, unknown[]>; version: number }> {
  const conn = await wrap(indexedDB.open(name));
  try {
    const present = BACKUP_TABLES.filter((t) => conn.objectStoreNames.contains(t));
    const tx = conn.transaction(present, 'readonly');
    const tables: Record<string, unknown[]> = {};
    await Promise.all(present.map(async (t) => { tables[t] = await wrap(tx.objectStore(t).getAll()); }));
    return { tables, version: Math.round(conn.version / DEXIE_FACTOR) };
  } finally { conn.close(); } // обязательно закрыть: иначе обновление схемы в Dexie застрянет на «blocked»
}

async function openSnapDb(): Promise<IDBDatabase> {
  const req = indexedDB.open(SNAP_DB, 1);
  req.onupgradeneeded = () => { req.result.createObjectStore(SNAP_STORE, { keyPath: 'id' }); };
  return wrap(req);
}

/**
 * Вызывать один раз при запуске, до первого обращения к db. Если схема на устройстве старее текущей и данные есть,
 * сохраняет снимок и проверяет, что он записался. При failed вызывающий должен спросить пользователя, продолжать ли.
 */
export async function snapshotBeforeMigration(): Promise<SnapshotResult> {
  try {
    if (typeof indexedDB === 'undefined') return { status: 'not-needed' };
    const from = await installedVersion(db.name);
    const to = db.verno;
    if (from === 0 || from >= to) return { status: 'not-needed' };

    const { tables } = await readRaw(db.name);
    const rows = Object.values(tables).reduce((n, r) => n + r.length, 0);
    if (rows === 0) return { status: 'not-needed' }; // защищать нечего

    const counts = Object.fromEntries(Object.entries(tables).map(([t, r]) => [t, r.length]));
    const at = Date.now();
    const json = JSON.stringify({ version: BACKUP_FORMAT, exportedAt: at, counts, ...tables });
    const meta: SnapshotMeta = { at, fromVersion: from, toVersion: to, rows, workouts: tables.workouts?.length ?? 0 };

    const snap = await openSnapDb();
    try {
      const tx = snap.transaction(SNAP_STORE, 'readwrite');
      tx.objectStore(SNAP_STORE).put({ id: 'last', meta, json });
      await done(tx);
      const back = (await wrap(snap.transaction(SNAP_STORE, 'readonly').objectStore(SNAP_STORE).get('last'))) as { json?: string } | undefined;
      if (back?.json !== json) return { status: 'failed', error: 'Снимок записался с ошибкой' };
    } finally { snap.close(); }
    return { status: 'saved', meta };
  } catch (e) {
    return { status: 'failed', error: e instanceof Error ? e.message : String(e) };
  }
}

export async function loadSnapshot(): Promise<{ meta: SnapshotMeta; json: string } | null> {
  try {
    if (typeof indexedDB === 'undefined') return null;
    if (typeof indexedDB.databases === 'function' && !(await indexedDB.databases()).some((d) => d.name === SNAP_DB)) return null;
    const snap = await openSnapDb();
    try {
      const row = (await wrap(snap.transaction(SNAP_STORE, 'readonly').objectStore(SNAP_STORE).get('last'))) as { meta: SnapshotMeta; json: string } | undefined;
      return row ?? null;
    } finally { snap.close(); }
  } catch { return null; }
}

export async function clearSnapshot(): Promise<void> {
  await new Promise<void>((res) => { const r = indexedDB.deleteDatabase(SNAP_DB); r.onsuccess = r.onerror = r.onblocked = () => res(); });
}
