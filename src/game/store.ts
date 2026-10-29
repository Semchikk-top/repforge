// Запись в игровой журнал. Все изменения идут через одну очередь: два параллельных пересчёта
// (завершение тренировки и фоновая сверка) иначе могли бы начислить одно и то же дважды.
import { db } from '../db/db';
import { putGame } from '../db/repo';
import { workoutAward } from './economy';
import { ACH_BY_ID, computeStats, earnedNow, type AchievementDef } from './achievements';
import { ITEM_BY_ID } from './catalog';
import { totalsOf, type Totals } from './ledger';
import type { GameRow, Slot } from './types';

let queue: Promise<unknown> = Promise.resolve();
const locked = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
};

type Row<K extends GameRow['kind']> = Extract<GameRow, { kind: K }>;
const now = () => Date.now();

export interface Reconciled {
  newAchievements: AchievementDef[];
  xpGained: number;
  coinsGained: number;
  before: Totals;
  after: Totals;
}

async function reconcileInner(): Promise<Reconciled> {
  const [rows, workouts, exercises] = await Promise.all([db.game.toArray(), db.workouts.toArray(), db.exercises.toArray()]);
  const before = totalsOf(rows);
  const exMap = new Map(exercises.map((e) => [e.id, e]));
  const have = new Map(rows.filter((r): r is Row<'workout'> => r.kind === 'workout').map((r) => [r.workoutId, r]));
  const writes: Parameters<typeof putGame>[0] = [];

  // 1) начисления за тренировки: награда не уменьшается (правка задним числом не отнимает монеты)
  for (const w of workouts) {
    if (w.status !== 'done' || w.deletedAt) continue;
    const a = workoutAward(w, exMap);
    if (a.xp <= 0) continue;
    const cur = have.get(w.id);
    if (cur && cur.xp >= a.xp && cur.coins >= a.coins) continue;
    writes.push({ id: `wk:${w.id}`, createdAt: cur?.createdAt ?? now(), kind: 'workout', workoutId: w.id, date: w.date, xp: Math.max(a.xp, cur?.xp ?? 0), coins: Math.max(a.coins, cur?.coins ?? 0) });
  }
  if (writes.length) { await putGame(writes); writes.length = 0; }

  // 2) достижения (покупки уже в журнале: «Шопоголик» считает их)
  const mid = totalsOf(await db.game.toArray());
  const purchases = (await db.game.where('kind').equals('purchase').toArray()).filter((r) => !r.deletedAt).length;
  const stats = computeStats(workouts, exercises, purchases);
  const fresh = earnedNow(stats).filter((a) => !mid.unlocked.has(a.id));
  for (const a of fresh) writes.push({ id: `ach:${a.id}`, createdAt: now(), kind: 'achievement', achId: a.id, xp: a.reward, coins: a.reward, at: now() });
  if (writes.length) await putGame(writes);

  const after = totalsOf(await db.game.toArray());
  return { newAchievements: fresh, xpGained: after.xp - before.xp, coinsGained: after.earned - before.earned, before, after };
}

/** Сверка журнала с тренировками: идемпотентна, её можно звать сколько угодно раз. */
export const reconcileGame = (): Promise<Reconciled> => locked(reconcileInner);

/** Ручное достижение (пасхалка). Возвращает достижение, только если оно получено прямо сейчас. */
export function unlockManual(achId: string): Promise<AchievementDef | null> {
  return locked(async () => {
    const def = ACH_BY_ID.get(achId);
    if (!def?.manual) return null;
    if (await db.game.get(`ach:${achId}`)) return null;
    await putGame([{ id: `ach:${achId}`, createdAt: now(), kind: 'achievement', achId, xp: def.reward, coins: def.reward, at: now() }]);
    return def;
  });
}

export type BuyResult = { ok: true } | { ok: false; reason: 'unknown' | 'owned' | 'reward' | 'poor' };

export function buyItem(itemId: string): Promise<BuyResult> {
  return locked(async () => {
    const it = ITEM_BY_ID.get(itemId);
    if (!it) return { ok: false, reason: 'unknown' } as const;
    if (it.requires) return { ok: false, reason: 'reward' } as const;
    const t = totalsOf(await db.game.toArray());
    if (t.owned.has(itemId)) return { ok: false, reason: 'owned' } as const;
    if (t.coins < it.price) return { ok: false, reason: 'poor' } as const;
    await putGame([{ id: `buy:${itemId}`, createdAt: now(), kind: 'purchase', itemId, price: it.price, at: now() }]);
    return { ok: true } as const;
  });
}

async function writeState(patch: (s: Row<'state'>) => Row<'state'>): Promise<void> {
  const cur = (await db.game.get('state')) as Row<'state'> | undefined;
  const base: Row<'state'> = cur && cur.kind === 'state' ? cur : { id: 'state', createdAt: now(), updatedAt: 0, deviceId: '', kind: 'state', equipped: {} };
  const next = patch({ ...base, equipped: { ...base.equipped } });
  const { updatedAt: _u, deviceId: _d, ...rest } = next;
  void _u; void _d;
  await putGame([rest]);
}

/** Надеть предмет (null — вернуть вариант по умолчанию). Предмет должен быть куплен или получен. */
export function equipItem(slot: Slot, itemId: string | null): Promise<boolean> {
  return locked(async () => {
    if (itemId !== null) {
      const it = ITEM_BY_ID.get(itemId);
      if (!it || it.slot !== slot || !totalsOf(await db.game.toArray()).owned.has(itemId)) return false;
    }
    await writeState((s) => {
      if (itemId === null) delete s.equipped[slot]; else s.equipped[slot] = itemId;
      return s;
    });
    return true;
  });
}

export function setNickname(name: string): Promise<void> {
  return locked(() => writeState((s) => ({ ...s, nickname: name.trim().slice(0, 40) || undefined })));
}

