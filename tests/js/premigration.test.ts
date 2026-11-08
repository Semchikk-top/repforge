import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/db';
import { clearSnapshot, loadSnapshot, snapshotBeforeMigration } from '../../src/db/premigration';
import { importAll } from '../../src/db/repo';
import { validateBackup } from '../../src/db/backupInspect';

/** Создаёт «старую» базу версии 1 (в терминах Dexie, то есть 10 в IndexedDB) с данными, как у пользователя до обновлений. */
async function makeOldDb(rows: { workouts?: unknown[]; exercises?: unknown[] } = {}) {
  const req = indexedDB.open('workout-pwa', 10);
  req.onupgradeneeded = () => {
    const d = req.result;
    d.createObjectStore('exercises', { keyPath: 'id' });
    d.createObjectStore('workouts', { keyPath: 'id' });
    d.createObjectStore('templates', { keyPath: 'id' });
    d.createObjectStore('kv', { keyPath: 'key' });
  };
  const conn: IDBDatabase = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const tx = conn.transaction(['exercises', 'workouts'], 'readwrite');
  (rows.exercises ?? []).forEach((r) => tx.objectStore('exercises').put(r));
  (rows.workouts ?? []).forEach((r) => tx.objectStore('workouts').put(r));
  await new Promise<void>((res) => { tx.oncomplete = () => res(); });
  conn.close();
}
const reset = async () => {
  db.close();
  await new Promise<void>((res) => { const r = indexedDB.deleteDatabase('workout-pwa'); r.onsuccess = r.onerror = r.onblocked = () => res(); });
  await clearSnapshot();
};
const w = (id: string) => ({ id, createdAt: 1, updatedAt: 5, deviceId: 'd', date: '2026-10-01', title: 'Т', status: 'done', exercises: [] });
const ex = (id: string) => ({ id, createdAt: 1, updatedAt: 5, deviceId: 'd', name: 'Жим', muscle: 'chest', equipment: '', custom: false });

afterEach(async () => { vi.restoreAllMocks(); await reset(); });

describe('снимок перед миграцией схемы', () => {
  it('первый запуск без базы: снимок не нужен и базу он не создаёт', async () => {
    expect(await snapshotBeforeMigration()).toEqual({ status: 'not-needed' });
    expect((await indexedDB.databases()).some((d) => d.name === 'workout-pwa')).toBe(false);
  });

  it('старая схема с данными: снимок сохраняется и читается как обычная копия', async () => {
    await makeOldDb({ workouts: [w('w1'), w('w2')], exercises: [ex('e1')] });
    const r = await snapshotBeforeMigration();
    expect(r.status).toBe('saved');
    const snap = await loadSnapshot();
    expect(snap!.meta).toMatchObject({ fromVersion: 1, toVersion: db.verno, workouts: 2, rows: 3 });
    const v = validateBackup(snap!.json);
    expect(v.ok && v.data.workouts?.map((x) => x.id)).toEqual(['w1', 'w2']);
  });

  it('после снимка Dexie обновляет схему без блокировки, данные на месте', async () => {
    await makeOldDb({ workouts: [w('w1')] });
    expect((await snapshotBeforeMigration()).status).toBe('saved');
    await db.open();
    expect(db.verno).toBeGreaterThan(1);
    expect((await db.workouts.toArray()).map((x) => x.id)).toEqual(['w1']);
  });

  it('снимок позволяет вернуть данные в новую базу (восстановление поверх существующих записей)', async () => {
    await makeOldDb({ workouts: [w('w1'), w('w2')] });
    await snapshotBeforeMigration();
    await db.open();
    await db.workouts.delete('w2');                                   // миграция «потеряла» запись
    await db.workouts.update('w1', { updatedAt: 99, title: 'Правка' }); // а эта изменена после — она новее и не должна откатиться
    const snap = await loadSnapshot();
    const r = await importAll(snap!.json);
    expect(r.workouts).toBe(1);
    expect((await db.workouts.get('w2'))?.title).toBe('Т');
    expect((await db.workouts.get('w1'))?.title).toBe('Правка');
  });

  it('база уже текущей версии или пустая: снимок не делается', async () => {
    await db.open();
    expect(await snapshotBeforeMigration()).toEqual({ status: 'not-needed' });
    await reset();
    await makeOldDb({});
    expect(await snapshotBeforeMigration()).toEqual({ status: 'not-needed' }); // старая схема, но данных нет
  });

  it('сбой записи снимка сообщается как failed, а старая база не тронута', async () => {
    await makeOldDb({ workouts: [w('w1')] });
    const real = indexedDB.open.bind(indexedDB);
    vi.spyOn(indexedDB, 'open').mockImplementation(((name: string, version?: number) => {
      if (name === 'workout-pwa-premigration') throw new Error('нет места');
      return real(name, version);
    }) as typeof indexedDB.open);
    const r = await snapshotBeforeMigration();
    expect(r).toMatchObject({ status: 'failed', error: 'нет места' });
    vi.restoreAllMocks();
    await db.open();
    expect(await db.workouts.count()).toBe(1);
  });
});
