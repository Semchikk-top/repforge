// Сводка из журнала. Данные с сервера не считаем доверенными: берём только известную форму и ограничиваем числа.
import { ACH_BY_ID } from './achievements';
import { DEFAULTS, ITEM_BY_ID, isFree } from './catalog';
import { levelInfo, rankOf, type LevelInfo } from './economy';
import { SLOTS, type GameRow, type Slot } from './types';

const MAX_NUM = 1_000_000;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX_NUM, Math.max(0, Math.round(v))) : 0);
/**
 * Момент времени в миллисекундах. Не num(): тот режет значение до миллиона (защита от раздутых опыта и монет),
 * и любая дата превращалась в 1 января 1970. Некорректное значение даёт 0, и вызывающий берёт запасное.
 */
const ts = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_TS ? Math.round(v) : 0);
const MAX_TS = 8.64e15; // предел Date

export interface Totals {
  xp: number; coins: number; earned: number; spent: number;
  level: LevelInfo; rank: string;
  unlocked: Map<string, number>;            // id достижения -> когда получено
  owned: Set<string>;
  equipped: Record<Slot, string>;
  nickname?: string;
}

export function totalsOf(rows: GameRow[]): Totals {
  let xp = 0, earned = 0, spent = 0;
  const unlocked = new Map<string, number>();
  const bought = new Set<string>();
  let state: Extract<GameRow, { kind: 'state' }> | undefined;
  for (const r of rows) {
    if (!r || r.deletedAt || typeof r !== 'object') continue;
    if (r.kind === 'workout') { xp += num(r.xp); earned += num(r.coins); }
    else if (r.kind === 'achievement') {
      if (!ACH_BY_ID.has(r.achId)) continue;
      xp += num(r.xp); earned += num(r.coins);
      // одно достижение могло записаться на двух устройствах: помним самое раннее получение
      const at = ts(r.at) || ts(r.createdAt) || ts(r.updatedAt);
      const prev = unlocked.get(r.achId);
      unlocked.set(r.achId, prev && (!at || prev < at) ? prev : at);
    } else if (r.kind === 'purchase') {
      if (!ITEM_BY_ID.has(r.itemId) || bought.has(r.itemId)) continue;
      bought.add(r.itemId);
      spent += num(r.price);
    } else if (r.kind === 'state') state = r;
  }
  const owned = new Set<string>(bought);
  for (const it of ITEM_BY_ID.values()) {
    if (isFree(it)) owned.add(it.id);
    if (it.requires && unlocked.has(it.requires)) owned.add(it.id);
  }
  const equipped = { ...DEFAULTS };
  for (const slot of SLOTS) {
    const id = state?.equipped?.[slot];
    const it = typeof id === 'string' ? ITEM_BY_ID.get(id) : undefined;
    if (it && it.slot === slot && owned.has(it.id)) equipped[slot] = it.id;
  }
  const nickname = typeof state?.nickname === 'string' ? state.nickname.trim().slice(0, 40) || undefined : undefined;
  const level = levelInfo(xp);
  return { xp, coins: earned - spent, earned, spent, level, rank: rankOf(level.level), unlocked, owned, equipped, nickname };
}
