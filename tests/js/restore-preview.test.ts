import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/db';
import { decide, inspectBackup, validateBackup } from '../../src/db/backupInspect';
import { exportAll, importAll, putWorkout } from '../../src/db/repo';
import type { Workout } from '../../src/domain/types';

const wk = (id: string, updatedAt: number, title = 'Т'): Workout => ({ id, createdAt: 1, updatedAt, deviceId: 'd', date: '2026-10-01', title, status: 'done', exercises: [] });
const file = (extra: object) => JSON.stringify({ version: 1, exportedAt: 1_700_000_000_000, ...extra });

beforeEach(async () => { await Promise.all([db.workouts.clear(), db.exercises.clear(), db.checkins.clear(), db.changes.clear()]); });

describe('decide', () => {
  it('нет на устройстве — добавить; в копии новее — заменить; равные — без изменений; на устройстве новее — оставить', () => {
    expect(decide(undefined, { updatedAt: 5 })).toBe('add');
    expect(decide({ updatedAt: 4 }, { updatedAt: 5 })).toBe('replace');
    expect(decide({ updatedAt: 5 }, { updatedAt: 5 })).toBe('same');
    expect(decide({ updatedAt: 6 }, { updatedAt: 5 })).toBe('keep');
  });
});

describe('validateBackup: битые и чужие копии', () => {
  const err = (json: string) => { const v = validateBackup(json); return v.ok ? null : v.error; };

  it('не JSON, обрезанный файл и посторонний JSON отвергаются понятным текстом', () => {
    expect(err('{"version":1,"workouts":[{"id"')).toMatch(/повреждён/);
    expect(err('')).toMatch(/повреждён/);
    expect(err('[1,2,3]')).toMatch(/Неизвестный формат/);
    expect(err('{"hello":"world"}')).toMatch(/Неизвестный формат/);
  });

  it('чужая версия формата: более новая просит обновить приложение, неизвестная отвергается', () => {
    expect(err(file({ version: 2 }).replace('"version":1', '"version":2'))).toMatch(/более новой версией.*формат 2/);
    expect(err(JSON.stringify({ version: 0 }))).toMatch(/Неизвестный формат/);
    expect(err(JSON.stringify({ version: '1' }))).toMatch(/Неизвестный формат/);
  });

  it('раздел не список, повторяющиеся номера, неполный файл по счётчикам', () => {
    expect(err(file({ workouts: { a: 1 } }))).toMatch(/«workouts» не список/);
    expect(err(file({ workouts: [wk('a', 1), wk('a', 2)] }))).toMatch(/повторяются номера/);
    expect(err(file({ counts: { workouts: 3 }, workouts: [wk('a', 1)] }))).toMatch(/неполная.*должно быть 3.*в файле 1/);
    expect(validateBackup(file({ counts: { workouts: 1 }, workouts: [wk('a', 1)] })).ok).toBe(true);
  });

  it('непригодные записи пропускаются и считаются, годные остаются', () => {
    const v = validateBackup(file({ workouts: [wk('ok', 5), { id: 'no-time' }, { updatedAt: 1 }, { id: 'x', updatedAt: 1, date: 5, exercises: [] }, null] }));
    expect(v.ok).toBe(true);
    if (v.ok) { expect(v.data.workouts!.map((w) => w.id)).toEqual(['ok']); expect(v.skipped.workouts).toBe(4); }
  });

  it('пустая копия без разделов допустима', () => { expect(validateBackup(file({})).ok).toBe(true); });
});

describe('предпросмотр восстановления поверх существующих записей', () => {
  it('считает добавится, заменится, без изменений, останется и конфликты', async () => {
    await putWorkout(wk('same', 10)); await putWorkout(wk('older', 10)); await putWorkout(wk('newer', 10));
    // putWorkout сам ставит updatedAt: фиксируем нужные значения напрямую
    await db.workouts.update('same', { updatedAt: 100 });
    await db.workouts.update('older', { updatedAt: 50 });
    await db.workouts.update('newer', { updatedAt: 500 });
    const p = await inspectBackup(file({ workouts: [wk('same', 100), wk('older', 200), wk('newer', 300), wk('fresh', 1)], exercises: [{ id: 'e', updatedAt: 1, name: 'x' }], checkins: [{ id: 'c', updatedAt: 1, slot: 'bad' }] }));
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.tables.workouts).toEqual({ total: 4, add: 1, replace: 1, same: 1, keep: 1 });
    expect(p.tables.exercises).toMatchObject({ total: 1, add: 1 });
    expect(p.tables.checkins.total).toBe(0);        // запись с неизвестным слотом отброшена
    expect(p.skipped).toBe(1);
    expect(p.totals).toMatchObject({ add: 2, replace: 1, same: 1, keep: 1, conflicts: 2 });
    expect(p.exportedAt).toBe(1_700_000_000_000);
  });

  it('предпросмотр ничего не пишет, а импорт делает ровно то, что он обещал', async () => {
    await putWorkout(wk('older', 1)); await putWorkout(wk('newer', 1));
    await db.workouts.update('older', { updatedAt: 50, title: 'Старая правка' });
    await db.workouts.update('newer', { updatedAt: 500, title: 'Свежая правка' });
    const json = file({ workouts: [wk('older', 200, 'Из копии'), wk('newer', 300, 'Из копии'), wk('fresh', 1, 'Из копии')] });
    const before = await db.workouts.toArray();
    const p = await inspectBackup(json);
    expect(await db.workouts.toArray()).toEqual(before);   // предпросмотр не меняет базу
    const r = await importAll(json);
    expect(p.ok && p.totals.add + p.totals.replace).toBe(r.workouts);
    expect((await db.workouts.get('older'))!.title).toBe('Из копии');
    expect((await db.workouts.get('newer'))!.title).toBe('Свежая правка');   // на устройстве новее: не откатывается
    expect((await db.workouts.get('fresh'))!.title).toBe('Из копии');
  });

  it('битая копия не записывает ничего и не создаёт записей в очереди синхронизации', async () => {
    await expect(importAll(file({ counts: { workouts: 2 }, workouts: [wk('a', 1)] }))).rejects.toThrow(/неполная/);
    await expect(importAll('{"version":1,"workouts":[')).rejects.toThrow(/повреждён/);
    await expect(importAll(JSON.stringify({ version: 7 }))).rejects.toThrow(/более новой/);
    expect(await db.workouts.count()).toBe(0);
    expect(await db.changes.count()).toBe(0);
  });

  it('экспорт → импорт на пустую базу возвращает данные, счётчики в файле сходятся', async () => {
    await putWorkout(wk('a', 1)); await putWorkout(wk('b', 1));
    const json = await exportAll();
    expect(JSON.parse(json).counts.workouts).toBe(2);
    await db.workouts.clear();
    const p = await inspectBackup(json);
    expect(p.ok && p.totals.add).toBeGreaterThanOrEqual(2);
    expect((await importAll(json)).workouts).toBe(2);
  });
});
