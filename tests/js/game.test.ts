// Геймификация 0.6: опыт и монеты, уровни, достижения, журнал, магазин, синхронизация.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/db/db';
import { applyRemote } from '../../src/sync/sync';
import { ACHIEVEMENTS, computeStats, earnedNow, longestStreak } from '../../src/game/achievements';
import { ITEMS, ITEM_BY_ID } from '../../src/game/catalog';
import { effectiveSetVolume, levelInfo, workoutAward, xpToReach } from '../../src/game/economy';
import { totalsOf } from '../../src/game/ledger';
import { buyItem, equipItem, reconcileGame, unlockManual } from '../../src/game/store';
import type { GameRow } from '../../src/game/types';
import type { Exercise, Workout } from '../../src/domain/types';

const ex = (id: string, name: string, muscle = 'chest'): Exercise => ({ id, name, muscle, equipment: '', custom: false, createdAt: 0, updatedAt: 0, deviceId: 's' } as Exercise);
const EXS = [ex('seed-001', 'Жим штанги лёжа'), ex('seed-005', 'Подтягивания', 'back'), ex('seed-030', 'Бег', 'cardio')];
const exMap = new Map(EXS.map((e) => [e.id, e]));
const set = (weight: number, reps: number, done = true, warmup = false) => ({ id: Math.random().toString(36), weight, reps, done, warmup });
let n = 0;
const wk = (date: string, exerciseId: string, sets: ReturnType<typeof set>[], extra: Partial<Workout> = {}): Workout =>
  ({ id: 'w' + ++n, date, title: 't', status: 'done', exercises: [{ id: 'e' + n, exerciseId, sets }], createdAt: 0, updatedAt: Date.now(), deviceId: 'd', ...extra } as Workout);
const run = (date: string, meters: number): Workout =>
  wk(date, 'seed-030', [], { exercises: [{ id: 'r' + n, exerciseId: 'seed-030', sets: [], cardio: { source: 'manual', distanceM: meters, durationSec: 1800 } }] } as Partial<Workout>);

beforeEach(async () => {
  await Promise.all([db.game.clear(), db.workouts.clear(), db.exercises.clear(), db.changes.clear()]);
  await db.exercises.bulkPut(EXS);
});

describe('опыт и монеты', () => {
  it('растут вместе с объёмом, разминка не считается', () => {
    const light = workoutAward(wk('2026-10-01', 'seed-001', [set(50, 10), set(50, 10)]), exMap);
    const heavy = workoutAward(wk('2026-10-02', 'seed-001', [set(100, 10), set(100, 10), set(100, 10), set(20, 10, true, true)]), exMap);
    expect(light.xp).toBe(40 + Math.round(1000 / 40));
    expect(heavy.xp).toBe(40 + Math.round(3000 / 40));
    expect(heavy.xp).toBeGreaterThan(light.xp);
    expect(heavy.coins).toBe(Math.floor(heavy.xp / 4));
  });
  it('пустая тренировка и невыполненные подходы ничего не дают', () => {
    expect(workoutAward(wk('2026-10-01', 'seed-001', [set(100, 10, false)]), exMap)).toEqual({ xp: 0, coins: 0 });
  });
  it('подтягивания без веса тоже приносят опыт; опечатка в весе упирается в потолок', () => {
    expect(workoutAward(wk('2026-10-01', 'seed-005', [set(0, 10)]), exMap).xp).toBeGreaterThan(40);
    expect(effectiveSetVolume(9999, 99)).toBe(6000);
    expect(effectiveSetVolume(50, 5000)).toBe(5000);
  });
  it('километры дают опыт', () => {
    expect(workoutAward(run('2026-10-01', 5000), exMap).xp).toBe(40 + 5 * 40);
  });
});

describe('уровни', () => {
  it('границы совпадают с формулой и не проваливаются на округлении', () => {
    expect(levelInfo(0).level).toBe(1);
    for (let l = 2; l <= 60; l++) {
      expect(levelInfo(xpToReach(l)).level).toBe(l);
      expect(levelInfo(xpToReach(l) - 1).level).toBe(l - 1);
    }
  });
  it('максимум и мусор на входе', () => {
    expect(levelInfo(1e12)).toMatchObject({ level: 100, atMax: true });
    expect(levelInfo(NaN).level).toBe(1);
  });
});

describe('достижения', () => {
  it('«Выдающийся»: жим 100 кг, только рабочие подходы', () => {
    const s = computeStats([wk('2026-10-01', 'seed-001', [set(100, 1)])], EXS);
    expect(earnedNow(s).map((a) => a.id)).toContain('bench100');
    const none = computeStats([wk('2026-10-01', 'seed-001', [set(100, 1, false)])], EXS);
    expect(earnedNow(none).map((a) => a.id)).not.toContain('bench100');
  });
  it('серия недель считается по самой длинной, а не по текущей', () => {
    expect(longestStreak(new Set(['2026-09-07', '2026-09-14', '2026-09-21', '2026-10-12']))).toBe(3);
  });
  it('ночная тренировка и дубль за день', () => {
    const night = wk('2026-10-01', 'seed-001', [set(50, 5)], { finishedAt: new Date(2026, 9, 2, 1, 30).getTime() });
    const s = computeStats([night, wk('2026-10-01', 'seed-001', [set(50, 5)])], EXS);
    expect(s.night).toBe(true);
    expect(s.doubleDay).toBe(true);
  });
  it('у каждого достижения есть условие или оно ручное; id не повторяются', () => {
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(ACHIEVEMENTS.length);
    for (const a of ACHIEVEMENTS) expect(!!a.measure || !!a.manual).toBe(true);
  });
});

describe('журнал и сверка', () => {
  it('начисляет за завершённые тренировки, повторная сверка ничего не удваивает', async () => {
    await db.workouts.put(wk('2026-10-01', 'seed-001', [set(100, 10), set(100, 10)]));
    const r1 = await reconcileGame();
    expect(r1.xpGained).toBeGreaterThan(0);
    const t1 = totalsOf(await db.game.toArray());
    const r2 = await reconcileGame();
    expect(r2.xpGained).toBe(0);
    expect(totalsOf(await db.game.toArray()).xp).toBe(t1.xp);
  });
  it('две сверки одновременно дают одно начисление', async () => {
    await db.workouts.put(wk('2026-10-01', 'seed-001', [set(80, 8)]));
    await Promise.all([reconcileGame(), reconcileGame(), reconcileGame()]);
    expect(await db.game.where('kind').equals('workout').count()).toBe(1);
    expect(await db.game.get('ach:first')).toBeTruthy();
  });
  it('награда за тренировку не уменьшается после правки вниз', async () => {
    const w = wk('2026-10-01', 'seed-001', [set(100, 10)]);
    await db.workouts.put(w);
    await reconcileGame();
    const before = totalsOf(await db.game.toArray()).earned;
    await db.workouts.put({ ...w, exercises: [{ ...w.exercises[0], sets: [set(10, 1)] }] });
    await reconcileGame();
    expect(totalsOf(await db.game.toArray()).earned).toBe(before);
  });
  it('удалённая и незавершённая тренировки не награждаются', async () => {
    await db.workouts.bulkPut([wk('2026-10-01', 'seed-001', [set(80, 8)], { status: 'active' }), wk('2026-10-02', 'seed-001', [set(80, 8)], { deletedAt: 1 })]);
    expect((await reconcileGame()).xpGained).toBe(0);
  });
  it('ручное достижение выдаётся один раз', async () => {
    expect((await unlockManual('dev'))?.id).toBe('dev');
    expect(await unlockManual('dev')).toBeNull();
    expect(await unlockManual('first')).toBeNull(); // не ручное
  });
});

describe('магазин', () => {
  const give = async (coins: number) => db.game.put({ id: 'wk:test', kind: 'workout', workoutId: 'test', date: '2026-10-01', xp: coins * 4, coins, createdAt: 0, updatedAt: 1, deviceId: 'd' });

  it('без денег не купить, с деньгами списывает цену', async () => {
    expect(await buyItem('av-kettle')).toEqual({ ok: false, reason: 'poor' });
    await give(500);
    expect(await buyItem('av-kettle')).toEqual({ ok: true });
    expect(totalsOf(await db.game.toArray()).coins).toBe(500 - ITEM_BY_ID.get('av-kettle')!.price);
  });
  it('повторная покупка и покупка наградного предмета отклоняются', async () => {
    await give(5000);
    await buyItem('av-kettle');
    expect(await buyItem('av-kettle')).toEqual({ ok: false, reason: 'owned' });
    expect(await buyItem('tt-dev')).toEqual({ ok: false, reason: 'reward' });
    expect(await buyItem('нет-такого')).toEqual({ ok: false, reason: 'unknown' });
  });
  it('надеть можно только своё; наградной предмет открывается достижением', async () => {
    expect(await equipItem('avatar', 'av-flame')).toBe(false);
    expect(await equipItem('avatar', 'av-plate')).toBe(true);
    expect(totalsOf(await db.game.toArray()).equipped.avatar).toBe('av-plate');
    expect(await equipItem('title', 'tt-dev')).toBe(false);
    await unlockManual('dev');
    expect(await equipItem('title', 'tt-dev')).toBe(true);
    expect(await equipItem('avatar', null)).toBe(true);
    expect(totalsOf(await db.game.toArray()).equipped.avatar).toBe('av-letter');
  });
  it('у каждого предмета уникальный id, цена и слот', () => {
    expect(new Set(ITEMS.map((i) => i.id)).size).toBe(ITEMS.length);
    for (const i of ITEMS) expect(i.price).toBeGreaterThanOrEqual(0);
  });
});

describe('данные с сервера не считаются доверенными', () => {
  it('мусор, чужие id и огромные числа не ломают сводку', () => {
    const rows = [
      { id: 'x', kind: 'workout', xp: 'много', coins: -5 },
      { id: 'y', kind: 'workout', xp: 1e15, coins: 1e15 },
      { id: 'ach:выдумка', kind: 'achievement', achId: 'выдумка', xp: 999, coins: 999 },
      { id: 'buy:нет', kind: 'purchase', itemId: 'нет', price: 1 },
      null,
      { id: 'state', kind: 'state', equipped: { avatar: 'av-flame', frame: 'нет' } }
    ] as unknown as GameRow[];
    const t = totalsOf(rows);
    expect(t.xp).toBe(1_000_000);
    expect(t.unlocked.size).toBe(0);
    expect(t.equipped.avatar).toBe('av-letter'); // не куплен
    expect(t.equipped.frame).toBe('fr-none');
  });
  it('удалённая запись с сервера не считается', () => {
    const t = totalsOf([{ id: 'wk:a', kind: 'workout', workoutId: 'a', date: '', xp: 100, coins: 25, createdAt: 0, updatedAt: 1, deviceId: 'd', deletedAt: 5 } as GameRow]);
    expect(t.xp).toBe(0);
  });
});

describe('синхронизация', () => {
  it('записи журнала с другого устройства применяются без карточки конфликта', async () => {
    await db.game.put({ id: 'state', kind: 'state', equipped: { avatar: 'av-plate' }, createdAt: 0, updatedAt: 10, deviceId: 'a' });
    await db.changes.add({ table: 'game', entityId: 'state', op: 'put', ts: 1, deviceId: 'a', synced: 0 });
    await applyRemote([{ table: 'game', id: 'state', updatedAt: 20, deviceId: 'b', deleted: false, data: { kind: 'state', equipped: { avatar: 'av-letter' }, createdAt: 0 } }], [], 5);
    expect(await db.conflicts.count()).toBe(0);
    expect(((await db.game.get('state')) as { equipped: Record<string, string> }).equipped.avatar).toBe('av-letter');
  });
});

describe('перенесённая история (импорт) наград не даёт', () => {
  const imported = (date: string, sets = [set(100, 10), set(100, 10), set(100, 10)]) => wk(date, 'seed-001', sets, { imported: true });

  it('за импортированную тренировку нет ни опыта, ни монет, а такая же обычная награждается', () => {
    const sets = [set(100, 10), set(100, 10)];
    expect(workoutAward(imported('2026-10-01', sets), exMap)).toEqual({ xp: 0, coins: 0 });
    expect(workoutAward(wk('2026-10-01', 'seed-001', sets), exMap).xp).toBeGreaterThan(0);
  });

  it('в достижения импортированные тренировки не входят: ни число тренировок, ни тоннаж, ни рекорд жима', () => {
    const many = Array.from({ length: 12 }, (_, i) => imported(`2026-09-${String(i + 1).padStart(2, '0')}`, [set(140, 1)]));
    const s = computeStats(many, EXS);
    expect(s.workouts).toBe(0);
    expect(s.volumeKg).toBe(0);
    expect(s.bench).toBe(0);
    expect(earnedNow(s)).toEqual([]);
    const mixed = computeStats([...many, wk('2026-10-01', 'seed-001', [set(60, 5)])], EXS);
    expect(mixed.workouts).toBe(1);
    expect(mixed.bench).toBe(60);
  });

  it('сверка журнала после импорта большой истории ничего не начисляет и не открывает достижений', async () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ ...imported(`2026-0${1 + (i % 9)}-${String(1 + (i % 27)).padStart(2, '0')}`), id: `imp-${i}` }));
    await db.workouts.bulkPut(many);
    const r = await reconcileGame();
    expect(r.xpGained).toBe(0);
    expect(r.coinsGained).toBe(0);
    expect(r.newAchievements).toEqual([]);
    expect(await db.game.count()).toBe(0);
  });

  it('обычная тренировка рядом с импортом награждается как обычно, а импорт остаётся без награды', async () => {
    await db.workouts.bulkPut([{ ...imported('2026-09-01'), id: 'imp-1' }, { ...wk('2026-10-01', 'seed-001', [set(100, 10), set(100, 10)]), id: 'own-1' }]);
    const r = await reconcileGame();
    expect(r.xpGained).toBeGreaterThan(0);
    const rows = await db.game.toArray();
    expect(rows.some((g) => g.id === 'wk:own-1')).toBe(true);
    expect(rows.some((g) => g.id === 'wk:imp-1')).toBe(false);
  });
});

describe('время получения достижения', () => {
  const [a1, a2] = ACHIEVEMENTS;
  const row = (achId: string, at: unknown, extra: Record<string, unknown> = {}) =>
    ({ id: `ach:${achId}`, kind: 'achievement', achId, xp: 10, coins: 10, at, createdAt: 5, updatedAt: 9, deviceId: 'd', ...extra }) as unknown as GameRow;

  it('время в миллисекундах не обрезается (раньше любая дата превращалась в 1 января 1970)', () => {
    const at = Date.UTC(2026, 9, 30, 12, 0, 0);
    const t = totalsOf([row(a1.id, at)]);
    expect(t.unlocked.get(a1.id)).toBe(at);
    expect(new Date(t.unlocked.get(a1.id)!).getUTCFullYear()).toBe(2026);
  });
  it('порядок «недавно получено» определяется временем', () => {
    const t = totalsOf([row(a1.id, 1_790_000_000_000), row(a2.id, 1_791_000_000_000)]);
    const order = [...t.unlocked.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
    expect(order).toEqual([a2.id, a1.id]);
  });
  it('без корректного времени берётся createdAt, затем updatedAt', () => {
    expect(totalsOf([row(a1.id, 'вчера')]).unlocked.get(a1.id)).toBe(5);
    expect(totalsOf([row(a1.id, NaN, { createdAt: undefined })]).unlocked.get(a1.id)).toBe(9);
    expect(totalsOf([row(a1.id, -4)]).unlocked.get(a1.id)).toBe(5);
    expect(totalsOf([row(a1.id, 1e300)]).unlocked.get(a1.id)).toBe(5);
  });
  it('если достижение записалось на двух устройствах, помнится самое раннее', () => {
    const t = totalsOf([row(a1.id, 2_000_000_000_000), { ...row(a1.id, 1_900_000_000_000), id: 'ach:' + a1.id + ':copy' } as GameRow]);
    expect(t.unlocked.get(a1.id)).toBe(1_900_000_000_000);
  });
});
