// Короткий журнал событий синхронизации для экрана диагностики. Хранится на устройстве, наружу не уходит.
// Содержит только тексты ошибок и служебные пометки: токены, адреса с кодами и содержимое записей сюда не попадают.
import { db } from '../db/db';

export type EventKind = 'info' | 'warn' | 'error';
export interface SyncEvent { at: number; kind: EventKind; msg: string; count: number }

const KEY = 'sync.log';
const MAX = 40;
let cache: SyncEvent[] | null = null;
let chain: Promise<unknown> = Promise.resolve();

const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\b(authorization|bearer|token|api[_-]?key|password|pin)\b[\s:=]*(?:bearer\s+)?\S+/gi, '$1 …').slice(0, 300);

async function load(): Promise<SyncEvent[]> {
  if (cache) return cache;
  const row = await db.kv.get(KEY);
  cache = Array.isArray(row?.value) ? (row!.value as SyncEvent[]).slice(-MAX) : [];
  return cache;
}

/** Записать событие. Подряд идущие одинаковые склеиваются в одну строку со счётчиком. */
export function logSyncEvent(kind: EventKind, msg: string, now = Date.now()): Promise<void> {
  const text = clean(msg);
  const run = chain.then(async () => {
    const list = await load();
    const last = list[list.length - 1];
    if (last && last.kind === kind && last.msg === text) { last.count++; last.at = now; }
    else list.push({ at: now, kind, msg: text, count: 1 });
    if (list.length > MAX) list.splice(0, list.length - MAX);
    await db.kv.put({ key: KEY, value: list });
  }).catch(() => { /* журнал не должен мешать синхронизации */ });
  chain = run;
  return run;
}

export async function readSyncEvents(): Promise<SyncEvent[]> {
  await chain;
  return [...(await load())];
}

export async function clearSyncEvents(): Promise<void> {
  cache = [];
  await db.kv.delete(KEY);
}

/** Для тестов: сбросить кэш после очистки базы. */
export const _resetSyncLogCache = () => { cache = null; chain = Promise.resolve(); };
