// Слияние остальных таблиц при синхронизации (0.12): шаблоны, упражнения, замеры, чек-ины, настройки игры.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/db/db';
import { putBody, putExercise, putGame, putTemplate, saveCheckIn } from '../../src/db/repo';
import { initSyncStatus, pruneBases, syncNow } from '../../src/sync/sync';
import { FakeServer } from './helpers/fakeServer';

let server: FakeServer;
const future = () => Date.now() + 5000;
const today = new Date().toISOString().slice(0, 10);
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

const TPL = { id: 't1', createdAt: 100, updatedAt: 1000, deviceId: 'dev-B', title: 'Грудь', exercises: [
  { exerciseId: 'bench', sets: 3, reps: 8, weight: 60 }, { exerciseId: 'fly', sets: 3, reps: 12, weight: 20 }] };

/** Запись уже синхронизирована: есть на сервере, у нас и в предках. */
async function seed(table: 'templates' | 'exercises' | 'body', row: { id: string; updatedAt: number; deviceId: string }) {
  server.push(table, row.id, row.updatedAt, row.deviceId, row as never);
  await db.table(table).put(row);
  await db.bases.put({ id: `${table}/${row.id}`, table, data: clone(row) as never, at: 1 });
  await db.kv.put({ key: 'sync.since', value: server.seq });
}

beforeEach(async () => {
  server = new FakeServer();
  await Promise.all([db.kv, db.changes, db.templates, db.exercises, db.body, db.checkins, db.game, db.bases, db.conflicts, db.workouts].map((t) => t.clear()));
  await db.kv.put({ key: 'deviceId', value: 'dev-A' });
  await db.kv.put({ key: 'sync.config', value: { token: 'T', baseUrl: '' } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.endsWith('/api/sync')) return { ok: true, status: 200, json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => server.handle(JSON.parse(String(init?.body))) } as Response;
  }));
  await initSyncStatus();
});
afterEach(() => vi.unstubAllGlobals());

describe('шаблоны', () => {
  it('вес поменяли у нас, подходы у соседнего устройства: на сервере и у нас остаются обе правки', async () => {
    await seed('templates', TPL);
    const mine = clone(TPL); mine.exercises[0].weight = 65;
    await putTemplate(mine as never);
    const theirs = clone(TPL); theirs.exercises[1].sets = 4;
    server.push('templates', 't1', future(), 'dev-B', { ...theirs, updatedAt: future() } as never);

    await syncNow();
    const local = (await db.templates.get('t1'))!;
    expect(local.exercises.map((e) => [e.weight, e.sets])).toEqual([[65, 3], [20, 4]]);
    expect((server.ents.get('templates/t1')!.data as typeof TPL).exercises.map((e) => [e.weight, e.sets])).toEqual([[65, 3], [20, 4]]);
    expect(await db.conflicts.count()).toBe(0);
    expect(await db.changes.where('synced').equals(0).count()).toBe(0);
  });

  it('чужая правка старше нашей по времени: наша отправка не затирает её (сначала забираем чужое)', async () => {
    await seed('templates', TPL);
    const theirs = clone(TPL); theirs.title = 'Грудь и плечи';
    server.push('templates', 't1', 2000, 'dev-B', { ...theirs, updatedAt: 2000 } as never);
    const mine = clone(TPL); mine.exercises[0].weight = 62.5;
    await putTemplate(mine as never);
    await syncNow();
    const onServer = server.ents.get('templates/t1')!.data as typeof TPL;
    expect(onServer.title).toBe('Грудь и плечи');
    expect(onServer.exercises[0].weight).toBe(62.5);
  });

  it('другое устройство удалило шаблон, а мы его правили: действует прежнее правило, наша версия остаётся в «Конфликтах»', async () => {
    await seed('templates', TPL);
    const mine = clone(TPL); mine.exercises[0].weight = 70;
    await putTemplate(mine as never);
    server.push('templates', 't1', future(), 'dev-B', { ...TPL, deletedAt: future(), updatedAt: future() } as never, true);
    await syncNow();
    expect((await db.templates.get('t1'))!.deletedAt).toBeTruthy();
    expect(await db.conflicts.count()).toBe(1);
  });
});

describe('упражнения', () => {
  it('переименовали у нас, добавили заметку на другом устройстве', async () => {
    const EX = { id: 'x1', createdAt: 1, updatedAt: 1000, deviceId: 'dev-B', name: 'Жим лёжа', muscle: 'chest', equipment: 'штанга', custom: true };
    await seed('exercises', EX);
    await putExercise({ ...EX, name: 'Жим штанги лёжа' } as never);
    server.push('exercises', 'x1', future(), 'dev-B', { ...EX, note: 'узкий хват', updatedAt: future() } as never);
    await syncNow();
    expect(await db.exercises.get('x1')).toMatchObject({ name: 'Жим штанги лёжа', note: 'узкий хват' });
    expect(server.ents.get('exercises/x1')!.data).toMatchObject({ name: 'Жим штанги лёжа', note: 'узкий хват' });
  });
});

describe('замеры тела', () => {
  it('вес с одного устройства, талия с другого', async () => {
    const B = { id: 'b1', createdAt: 1, updatedAt: 1000, deviceId: 'dev-B', date: today, weightKg: 80 };
    await seed('body', B);
    await putBody({ ...B, weightKg: 79.4 } as never);
    server.push('body', 'b1', future(), 'dev-B', { ...B, waistCm: 84, updatedAt: future() } as never);
    await syncNow();
    expect(await db.body.get('b1')).toMatchObject({ weightKg: 79.4, waistCm: 84 });
  });

  it('давние замеры предка не получают: слияния нет, действует прежнее правило', async () => {
    const OLD = { id: 'b-old', createdAt: 1, updatedAt: 1000, deviceId: 'dev-B', date: '2020-01-01', weightKg: 80 };
    server.push('body', 'b-old', 1000, 'dev-B', OLD as never);
    await syncNow();
    expect(await db.body.get('b-old')).toBeTruthy();
    expect(await db.bases.get('body/b-old')).toBeUndefined();
  });
});

describe('чек-ины', () => {
  const draft = { date: today, slot: 'morning' as const, energy: 4 as const, mood: 3 as const, soreness: 2 as const, stress: 2 as const };

  it('утренний чек-ин заполнили на двух устройствах независимо: поля объединяются, предка не нужно', async () => {
    await saveCheckIn(draft);
    const id = `ci:${today}:morning`;
    const mine = (await db.checkins.toArray())[0];
    server.push('checkins', mine.id, future(), 'dev-B', { ...mine, sleepHours: 7.5, updatedAt: future(), deviceId: 'dev-B' } as never);
    await syncNow();
    const merged = (await db.checkins.toArray())[0];
    expect(merged).toMatchObject({ energy: 4, mood: 3, sleepHours: 7.5 });
    expect(merged.id).toBe(mine.id);
    expect(id).toContain(today);
    expect(await db.conflicts.count()).toBe(0);
    expect(server.ents.get(`checkins/${mine.id}`)!.data).toMatchObject({ sleepHours: 7.5, mood: 3 });
  });
});

describe('настройки игры', () => {
  it('«надето» сливается по слотам, а журнал начислений по-прежнему не сливается', async () => {
    await putGame([{ id: 'state', createdAt: 1, kind: 'state', equipped: { avatar: 'av-plate' } } as never]);
    const mine = (await db.game.get('state'))!;
    server.push('game', 'state', future(), 'dev-B', { ...mine, equipped: { frame: 'fr-gold' }, updatedAt: future(), deviceId: 'dev-B' } as never);
    await syncNow();
    expect((await db.game.get('state'))!.equipped).toEqual({ avatar: 'av-plate', frame: 'fr-gold' });
    expect(await db.conflicts.count()).toBe(0);
  });

  it('запись достижения с двух устройств не сливается и карточек конфликта не создаёт: побеждает более новая', async () => {
    await putGame([{ id: 'ach:dev', createdAt: 1, kind: 'achievement', achId: 'dev', xp: 500, coins: 500, at: 111 } as never]);
    const mine = (await db.game.get('ach:dev'))!;
    server.push('game', 'ach:dev', future(), 'dev-B', { ...mine, at: 222, updatedAt: future(), deviceId: 'dev-B' } as never);
    await syncNow();
    expect((await db.game.get('ach:dev'))!).toMatchObject({ at: 222 });
    expect(await db.conflicts.count()).toBe(0);
  });
});

describe('предки', () => {
  it('предки хранятся для свежих и вычищаются для давних по правилам таблицы', async () => {
    await db.bases.bulkPut([
      { id: 'body/old', table: 'body', data: { date: '2020-01-01' }, at: 1 },
      { id: 'body/new', table: 'body', data: { date: today }, at: 1 },
      { id: 'checkins/old', table: 'checkins', data: { date: '2020-01-01' }, at: 1 },
      { id: 'templates/t', table: 'templates', data: { title: 'x' }, at: 1 },
      { id: 'game/ach:dev', table: 'game', data: { kind: 'achievement' }, at: 1 },
      { id: 'game/state', table: 'game', data: { kind: 'state' }, at: 1 },
      { id: 'tracks/t1', table: 'tracks', data: {}, at: 1 }
    ]);
    expect(await pruneBases()).toBe(4);
    expect((await db.bases.toArray()).map((b) => b.id).sort()).toEqual(['body/new', 'game/state', 'templates/t']);
  });
});
