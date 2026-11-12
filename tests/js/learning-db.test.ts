import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/db';
import { inspectBackup, validateBackup } from '../../src/db/backupInspect';
import { clearSnapshot, loadSnapshot, snapshotBeforeMigration } from '../../src/db/premigration';
import { addAttempt, exportAll, getLastQuiz, getLessonsRead, importAll, listAttempts, markLessonRead, setLastQuiz } from '../../src/db/repo';
import { courseMark } from '../../src/domain/learning';
import type { LearningAttempt } from '../../src/domain/types';
import { filterBackup } from '../../src/domain/exportData';
import { applyRemote } from '../../src/sync/sync';

const base = { courseId: 'muscle-growth', courseVersion: 1, correct: 9, total: 10, threshold: 80, passed: true };
const remote = (id: string, over: Partial<LearningAttempt> = {}) => ({ table: 'learning' as const, id, updatedAt: 1000, deviceId: 'phone', deleted: false, data: { ...base, createdAt: 1000, date: '2026-11-10', ...over } });

beforeEach(async () => { if (!db.isOpen()) await db.open(); await Promise.all([db.learning.clear(), db.changes.clear(), db.kv.clear(), db.workouts.clear(), db.exercises.clear()]); });

describe('попытки теста в базе', () => {
  it('addAttempt пишет запись и ставит её в очередь синхронизации', async () => {
    const a = await addAttempt(base);
    expect(a).toMatchObject({ ...base, date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(a.createdAt).toBe(a.updatedAt);
    expect(await db.learning.get(a.id)).toMatchObject({ courseId: 'muscle-growth', passed: true });
    const q = await db.changes.where('synced').equals(0).toArray();
    expect(q.filter((c) => c.table === 'learning' && c.entityId === a.id)).toHaveLength(1);
  });

  it('каждая попытка — отдельная запись с новым id: прежние не перезаписываются', async () => {
    const a = await addAttempt({ ...base, passed: false, correct: 5 });
    const b = await addAttempt(base);
    expect(a.id).not.toBe(b.id);
    expect((await listAttempts('muscle-growth')).map((x) => x.passed)).toEqual([false, true]);
    expect(await listAttempts('other')).toEqual([]);
  });

  it('прогресс по урокам и прошлый набор вопросов хранятся локально, а не в синхронизируемой таблице', async () => {
    await markLessonRead('c', 'a'); await markLessonRead('c', 'a'); await markLessonRead('c', 'b');
    expect(await getLessonsRead('c')).toEqual(['a', 'b']);
    expect(await getLessonsRead('other')).toEqual([]);
    await setLastQuiz('c', ['q1', 'q2']);
    expect(await getLastQuiz('c')).toEqual(['q1', 'q2']);
    expect(await db.changes.count()).toBe(0);
  });
});

describe('синхронизация попыток между устройствами', () => {
  it('чужая попытка сохраняется без карточки конфликта', async () => {
    await applyRemote([remote('r1')] as never, [], 1);
    expect(await db.learning.get('r1')).toMatchObject({ courseId: 'muscle-growth', deviceId: 'phone', updatedAt: 1000 });
    expect(await db.conflicts.count()).toBe(0);
  });
  it('попытки двух устройств объединяются: отметка есть, если успешная попытка была хотя бы на одном', async () => {
    const mine = await addAttempt({ ...base, passed: false, correct: 4 });
    await applyRemote([remote('r2', { passed: true, correct: 9 })] as never, [], 2);
    const all = await listAttempts();
    expect(all.map((x) => x.id).sort()).toEqual([mine.id, 'r2'].sort());
    expect(courseMark(all, 'muscle-growth').passed).toBe(true);
    expect(await db.conflicts.count()).toBe(0);
  });
  it('повторная доставка той же попытки ничего не дублирует', async () => {
    await applyRemote([remote('r3')] as never, [], 1);
    await applyRemote([remote('r3')] as never, [], 1);
    expect(await db.learning.count()).toBe(1);
  });
  it('запись неизвестной таблицы с сервера игнорируется, а learning принимается: запись попадает только в известную таблицу', async () => {
    await applyRemote([{ table: 'unknown', id: 'x', updatedAt: 1, deviceId: 'z', deleted: false, data: { a: 1 } }, remote('r4')] as never, [], 3);
    expect(await db.learning.count()).toBe(1);
  });
});

describe('резервная копия и восстановление', () => {
  it('экспорт содержит попытки и их число; импорт на пустую базу возвращает их', async () => {
    const a = await addAttempt(base);
    const json = await exportAll();
    const parsed = JSON.parse(json);
    expect(parsed.counts.learning).toBe(1);
    expect(parsed.learning[0].id).toBe(a.id);
    await db.learning.clear(); await db.changes.clear();
    await importAll(json);
    expect((await db.learning.toArray()).map((x) => x.id)).toEqual([a.id]);
    expect((await db.changes.toArray()).some((c) => c.table === 'learning')).toBe(true); // восстановленное уйдёт на другие устройства
  });
  it('копия версии 1.4.x без раздела learning принимается как есть', async () => {
    const old = JSON.stringify({ version: 1, exportedAt: 1, counts: { workouts: 0 }, workouts: [], exercises: [] });
    const v = validateBackup(old);
    expect(v.ok).toBe(true);
    await expect(importAll(old)).resolves.toBeTruthy();
    expect(await db.learning.count()).toBe(0);
  });
  it('неполная копия (число попыток не сходится) отвергается, негодные записи пропускаются', () => {
    const bad = JSON.stringify({ version: 1, counts: { learning: 2 }, learning: [{ id: 'a', updatedAt: 1, courseId: 'c', passed: true, correct: 9, total: 10 }] });
    expect(validateBackup(bad)).toMatchObject({ ok: false, error: expect.stringMatching(/«learning» должно быть 2/) });
    const mixed = validateBackup(JSON.stringify({ version: 1, learning: [{ id: 'a', updatedAt: 1, courseId: 'c', passed: true, correct: 9, total: 10 }, { id: 'b', updatedAt: 1, courseId: 'c' }, { id: 'c', updatedAt: 1, courseId: 'c', passed: true, correct: 1, total: 0 }] }));
    expect(mixed.ok && mixed.skipped).toEqual({ learning: 2 });
    expect(mixed.ok && mixed.data.learning).toHaveLength(1);
  });
  it('предпросмотр восстановления показывает попытки: что добавится, что уже есть', async () => {
    const a = await addAttempt(base);
    const row = (id: string, updatedAt: number) => ({ id, updatedAt, courseId: 'muscle-growth', courseVersion: 1, passed: true, correct: 9, total: 10 });
    const p = await inspectBackup(JSON.stringify({ version: 1, learning: [row(a.id, a.updatedAt), row('new1', 5), row('new2', 6)] }));
    expect(p.ok && p.tables.learning).toEqual({ total: 3, add: 2, replace: 0, same: 1, keep: 0 });
  });
  it('выгрузка за период оставляет попытки только этого периода', () => {
    const data = { learning: [{ date: '2026-10-01' }, { date: '2026-11-05' }] } as never;
    const out = filterBackup(data, { from: '2026-11-01', to: '2026-11-30' } as never) as { learning: unknown[] };
    expect(out.learning).toHaveLength(1);
  });
});

describe('миграция схемы 9 → 10 (1.4.x → 1.5.0)', () => {
  const reset = async () => {
    db.close();
    await new Promise<void>((res) => { const r = indexedDB.deleteDatabase('workout-pwa'); r.onsuccess = r.onerror = r.onblocked = () => res(); });
    await clearSnapshot();
  };
  /** База пользователя 1.4.x: схема 9 (в IndexedDB это 90), тренировки и чек-ины на месте, таблицы learning ещё нет. */
  async function makeV9() {
    const req = indexedDB.open('workout-pwa', 90);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const t of ['exercises', 'workouts', 'templates', 'tracks', 'body', 'programs', 'profile', 'game', 'checkins', 'bases']) d.createObjectStore(t, { keyPath: 'id' });
      d.createObjectStore('kv', { keyPath: 'key' });
      d.createObjectStore('changes', { keyPath: 'seq', autoIncrement: true });
    };
    const conn: IDBDatabase = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    const tx = conn.transaction(['workouts', 'checkins'], 'readwrite');
    tx.objectStore('workouts').put({ id: 'w1', createdAt: 1, updatedAt: 5, deviceId: 'd', date: '2026-10-01', title: 'Т', status: 'done', exercises: [] });
    tx.objectStore('checkins').put({ id: 'ci:1', createdAt: 1, updatedAt: 5, deviceId: 'd', date: '2026-10-01', slot: 'morning', energy: 3, mood: 3, soreness: 3, stress: 3 });
    await new Promise<void>((res) => { tx.oncomplete = () => res(); });
    conn.close();
  }
  afterEach(reset);

  it('данные сохраняются, таблица learning появляется, снимок перед миграцией делается', async () => {
    await reset();
    await makeV9();
    expect((await snapshotBeforeMigration()).status).toBe('saved');
    await db.open();
    expect(db.verno).toBe(10);
    expect((await db.workouts.toArray()).map((w) => w.id)).toEqual(['w1']);
    expect((await db.checkins.toArray()).map((c) => c.id)).toEqual(['ci:1']);
    expect(await db.learning.count()).toBe(0);
    const a = await addAttempt(base);
    expect((await db.learning.get(a.id))!.courseId).toBe('muscle-growth');
    const snap = await loadSnapshot();
    expect(snap!.meta).toMatchObject({ fromVersion: 9, toVersion: 10, workouts: 1 });
  });

  it('снимок перед миграцией восстанавливается в новую базу', async () => {
    await reset();
    await makeV9();
    await snapshotBeforeMigration();
    await db.open();
    await db.workouts.clear();
    const snap = await loadSnapshot();
    await importAll(snap!.json);
    expect((await db.workouts.toArray()).map((w) => w.id)).toEqual(['w1']);
  });

  it('база 1.5.0 с попытками экспортируется и снимком, который понимает новая таблица', async () => {
    await reset();
    await db.open();
    await addAttempt(base);
    const v = validateBackup(await exportAll());
    expect(v.ok && v.data.learning).toHaveLength(1);
  });
});
