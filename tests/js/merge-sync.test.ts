// Слияние тренировок при синхронизации: настоящий syncNow против сервера в памяти (то же правило победителя, что в server/db.py).
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/db';
import { putWorkout } from '../../src/db/repo';
import { getSyncStatus, initSyncStatus, pruneBases, syncNow } from '../../src/sync/sync';
import type { SetEntry, Workout } from '../../src/domain/types';
import { FakeServer } from './helpers/fakeServer';

const set = (id: string, weight: number, done = false): SetEntry => ({ id, weight, reps: 8, done });
const mk = (extra: Partial<Workout> = {}): Workout => ({
  id: 'w1', createdAt: 100, updatedAt: 1000, deviceId: 'dev-B', date: new Date().toISOString().slice(0, 10), title: 'Грудь', status: 'active',
  exercises: [{ id: 'e1', exerciseId: 'seed-001', sets: [set('s1', 60), set('s2', 60), set('s3', 60)] }], ...extra
}) as Workout;

let server: FakeServer;
const local = async () => (await db.workouts.get('w1'))!;
const serverW = () => server.ents.get('workouts/w1')!.data as unknown as Workout;
const weights = (w: Workout) => w.exercises[0].sets.map((s) => [s.id, s.weight, s.done]);

/** Исходное состояние: тренировка уже синхронизирована с сервером, у нас есть общий предок. */
async function seedSynced() {
  const base = mk();
  server.push('workouts', 'w1', base.updatedAt, 'dev-B', base as never);
  await db.workouts.put(base);
  await db.bases.put({ id: 'workouts/w1', table: 'workouts', data: JSON.parse(JSON.stringify(base)), at: 1 });
  await db.kv.put({ key: 'sync.since', value: server.seq });
}

beforeEach(async () => {
  server = new FakeServer();
  await Promise.all([db.kv.clear(), db.changes.clear(), db.workouts.clear(), db.bases.clear(), db.conflicts.clear()]);
  await db.kv.put({ key: 'deviceId', value: 'dev-A' });
  await db.kv.put({ key: 'sync.config', value: { token: 'T', baseUrl: '' } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.endsWith('/api/sync')) return { ok: true, status: 200, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => server.handle(JSON.parse(String(init?.body))) } as Response;
  }));
  await initSyncStatus();
});
afterEach(() => vi.unstubAllGlobals());

describe('слияние при синхронизации', () => {
  it('чужая правка НОВЕЕ нашей: после обмена у обоих есть обе правки', async () => {
    await seedSynced();
    const mine = mk(); mine.exercises[0].sets[0].weight = 62.5;                         // телефон: вес первого подхода
    await putWorkout({ ...mine, deviceId: undefined as never, updatedAt: undefined as never });
    const theirs = mk(); theirs.exercises[0].sets[2].done = true;                       // ПК: третий подход выполнен
    server.push('workouts', 'w1', Date.now() + 5000, 'dev-B', { ...theirs, updatedAt: Date.now() + 5000 } as never);

    await syncNow();
    expect(getSyncStatus().error).toBeNull();
    expect(weights(await local())).toEqual([['s1', 62.5, false], ['s2', 60, false], ['s3', 60, true]]);
    expect(weights(serverW())).toEqual(weights(await local()));
    expect(await db.changes.where('synced').equals(0).count()).toBe(0);
    expect(await db.conflicts.count()).toBe(0);
  });

  it('чужая правка СТАРШЕ нашей: наша запись не затирает её на сервере', async () => {
    await seedSynced();
    const theirs = mk(); theirs.exercises[0].sets[2].done = true;
    server.push('workouts', 'w1', 2000, 'dev-B', { ...theirs, updatedAt: 2000 } as never);   // ПК успел раньше
    const mine = mk(); mine.exercises[0].sets[0].weight = 62.5;
    await putWorkout({ ...mine, deviceId: undefined as never, updatedAt: undefined as never }); // у нас метка времени новее

    await syncNow();
    // раньше здесь сервер молча принял бы нашу запись целиком и «выполнен» у третьего подхода пропал бы
    expect(weights(serverW())).toEqual([['s1', 62.5, false], ['s2', 60, false], ['s3', 60, true]]);
    expect(weights(await local())).toEqual(weights(serverW()));
  });

  it('до отправки сначала забирает чужие правки, и только если есть что отправлять по тренировкам', async () => {
    await seedSynced();
    await syncNow();                                    // отправлять нечего: один запрос
    expect(server.requests).toHaveLength(1);
    server.requests.length = 0;
    const mine = mk(); mine.title = 'Новое имя';
    await putWorkout({ ...mine, deviceId: undefined as never, updatedAt: undefined as never });
    await syncNow();
    expect(server.requests.map((r) => r.n)).toEqual([0, 1]);   // сначала пустой запрос «забрать», потом отправка
  });

  it('настоящий спор за один подход: побеждает более новая запись, а проигравшая правка уходит в конфликты', async () => {
    await seedSynced();
    const mine = mk(); mine.exercises[0].sets[0].weight = 70;
    await putWorkout({ ...mine, deviceId: undefined as never, updatedAt: undefined as never });
    const theirs = mk(); theirs.exercises[0].sets[0].weight = 72.5;
    server.push('workouts', 'w1', Date.now() + 5000, 'dev-B', { ...theirs, updatedAt: Date.now() + 5000 } as never);
    await syncNow();
    expect((await local()).exercises[0].sets[0].weight).toBe(72.5);
    const c = await db.conflicts.toArray();
    expect(c).toHaveLength(1);
    expect((c[0].local as unknown as Workout).exercises[0].sets[0].weight).toBe(70);   // наша версия сохранена для выбора человеком
  });

  it('без общего предка действует прежнее правило: побеждает более новая запись целиком', async () => {
    const base = mk();
    server.push('workouts', 'w1', base.updatedAt, 'dev-B', base as never);
    await db.workouts.put(base);                                                     // предка нет (старая установка)
    const mine = mk(); mine.exercises[0].sets[0].weight = 62.5;
    await putWorkout({ ...mine, deviceId: undefined as never, updatedAt: undefined as never });
    const theirs = mk(); theirs.exercises[0].sets[2].done = true;
    server.push('workouts', 'w1', Date.now() + 5000, 'dev-B', { ...theirs, updatedAt: Date.now() + 5000 } as never);
    await syncNow();
    expect(weights(await local())[0]).toEqual(['s1', 60, false]);                    // чужая версия целиком
    expect(await db.conflicts.count()).toBe(1);                                      // а наша правка не пропала молча
  });

  it('если у нас ничего не осталось после слияния, лишней отправки нет', async () => {
    await seedSynced();
    await putWorkout({ ...mk(), deviceId: undefined as never, updatedAt: undefined as never });      // «правка» без изменений содержимого
    const theirs = mk(); theirs.exercises[0].sets[1].weight = 65;
    server.push('workouts', 'w1', Date.now() + 5000, 'dev-B', { ...theirs, updatedAt: Date.now() + 5000 } as never);
    await syncNow();
    expect((await local()).exercises[0].sets[1].weight).toBe(65);
    expect(await db.changes.where('synced').equals(0).count()).toBe(0);
  });

  it('предок обновляется после отправки: следующая правка сливается с актуальной основой', async () => {
    await seedSynced();
    const first = mk(); first.exercises[0].sets[0].weight = 62.5;
    await putWorkout({ ...first, deviceId: undefined as never, updatedAt: undefined as never });
    await syncNow();
    const base = (await db.bases.get('workouts/w1'))!.data as unknown as Workout;
    expect(base.exercises[0].sets[0].weight).toBe(62.5);
  });

  it('предки давних завершённых тренировок вычищаются, свежие остаются', async () => {
    await db.bases.bulkPut([
      { id: 'workouts/old', table: 'workouts', data: { status: 'done', date: '2020-01-01' }, at: 1 },
      { id: 'workouts/active-old', table: 'workouts', data: { status: 'active', date: '2020-01-01' }, at: 1 },
      { id: 'workouts/fresh', table: 'workouts', data: { status: 'done', date: new Date().toISOString().slice(0, 10) }, at: 1 }
    ]);
    expect(await pruneBases()).toBe(1);
    expect((await db.bases.toArray()).map((b) => b.id).sort()).toEqual(['workouts/active-old', 'workouts/fresh']);
  });
});
