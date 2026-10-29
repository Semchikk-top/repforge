// Очередь отправки: правки одной записи схлопываются в одну строку.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/db';
import { compactChanges, putWorkout, softDelete } from '../../src/db/repo';
import { applyRemote } from '../../src/sync/sync';
import type { Workout } from '../../src/domain/types';

const base = (id: string, weight: number): Omit<Workout, 'updatedAt' | 'deviceId'> =>
  ({ id, date: '2026-10-29', title: 'Грудь', status: 'active', createdAt: 0, exercises: [{ id: 'e1', exerciseId: 'seed-001', sets: [{ id: 's1', weight, reps: 8, done: false, warmup: false }] }] }) as never;

const pending = () => db.changes.where('synced').equals(0).toArray();

beforeEach(async () => { await Promise.all([db.workouts.clear(), db.changes.clear()]); });

describe('схлопывание правок', () => {
  it('50 → 60 кг четырьмя шагами по 2,5 даёт одно изменение с итоговым весом', async () => {
    for (const kg of [52.5, 55, 57.5, 60]) await putWorkout(base('w1', kg));
    const p = await pending();
    expect(p).toHaveLength(1);
    expect((await db.workouts.get('w1'))!.exercises[0].sets[0].weight).toBe(60);
  });
  it('разные записи остаются разными изменениями', async () => {
    await putWorkout(base('w1', 50)); await putWorkout(base('w2', 50)); await putWorkout(base('w1', 55));
    expect((await pending()).map((c) => c.entityId).sort()).toEqual(['w1', 'w2']);
  });
  it('правка, а затем удаление — одна строка с удалением', async () => {
    await putWorkout(base('w1', 50));
    await softDelete('workouts', 'w1');
    const p = await pending();
    expect(p).toHaveLength(1);
    expect(p[0].op).toBe('delete');
  });
  it('правка, сделанная пока запрос в пути, не теряется', async () => {
    await putWorkout(base('w1', 50));
    const sent = (await pending()).map((c) => c.seq!);   // эти строки «ушли» на сервер
    await putWorkout(base('w1', 60));                    // правка во время запроса
    await applyRemote([], sent, 1);                      // ответ пришёл: закрываем отправленное
    const p = await pending();
    expect(p).toHaveLength(1);                           // свежая правка осталась в очереди
    expect(p[0].seq).not.toBe(sent[0]);
  });
  it('уже накопленная очередь чистится один раз и без потерь', async () => {
    const row = (entityId: string) => ({ table: 'workouts' as const, entityId, op: 'put' as const, ts: 1, deviceId: 'd', synced: 0 as const });
    await db.changes.bulkAdd([row('a'), row('a'), row('b'), row('a'), row('b')]);
    expect(await compactChanges()).toBe(3);
    expect((await pending()).map((c) => c.entityId).sort()).toEqual(['a', 'b']);
    expect(await compactChanges()).toBe(0);
  });
});
