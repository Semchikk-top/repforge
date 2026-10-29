import { conflictLabel, isConflict } from './conflicts';
import { db } from '../db/db';
import { compactChanges, getDeviceId } from '../db/repo';
import type { ChangeRecord } from '../domain/types';

// Синхронизация по журналу изменений (outbox). Один запрос = отправка своих правок + получение чужих.
// Конфликты: побеждает запись с большим updatedAt, при равенстве — с большим deviceId (то же правило, что на сервере).

type TableName = ChangeRecord['table'];
const TABLES: TableName[] = ['exercises', 'workouts', 'templates', 'tracks', 'body', 'programs', 'profile', 'game'];
const BATCH = 500;
const MAX_ROUNDS = 20;

export interface SyncConfig {
  token: string;
  baseUrl: string; // пусто = тот же адрес, откуда открыто приложение
}

export interface SyncStatus {
  configured: boolean;
  syncing: boolean;
  lastAt: number | null;
  error: string | null;
  unauthorized: boolean;
}

let status: SyncStatus = { configured: false, syncing: false, lastAt: null, error: null, unauthorized: false };
const listeners = new Set<() => void>();
const setStatus = (patch: Partial<SyncStatus>) => {
  status = { ...status, ...patch };
  listeners.forEach((l) => l());
};
export const getSyncStatus = () => status;
export const subscribeSync = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

// ---------- конфигурация ----------
async function loadConfig(): Promise<SyncConfig | null> {
  const row = await db.kv.get('sync.config');
  return (row?.value as SyncConfig) ?? null;
}
const getSince = async () => ((await db.kv.get('sync.since'))?.value as number) ?? 0;

export async function initSyncStatus() {
  const [cfg, last] = await Promise.all([loadConfig(), db.kv.get('sync.lastAt')]);
  setStatus({ configured: !!cfg, lastAt: (last?.value as number) ?? null });
}

export function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'Телефон (Android)';
  if (/iPhone|iPad/i.test(ua)) return 'Телефон (iOS)';
  if (/Linux/i.test(ua)) return 'Компьютер (Linux)';
  return 'Компьютер';
}

async function enqueueEverything() {
  // при первом подключении отправляем весь локальный набор, а не только журнал
  const deviceId = await getDeviceId();
  const now = Date.now();
  const rows: ChangeRecord[] = [];
  for (const t of TABLES) {
    const ids = (await db.table(t).toCollection().primaryKeys()) as string[];
    for (const id of ids) rows.push({ table: t, entityId: id, op: 'put', ts: now, deviceId, synced: 0 });
  }
  await db.changes.clear();
  await db.changes.bulkAdd(rows);
}

export async function pairWithCode(code: string, baseUrl = ''): Promise<void> {
  const deviceId = await getDeviceId();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, deviceId, name: deviceLabel() })
    });
  } catch {
    throw new Error('Сервер недоступен. Проверь адрес и подключение.');
  }
  if (!res.ok) {
    const msg = (await res.json().catch(() => null))?.detail;
    throw new Error(typeof msg === 'string' ? msg : `Ошибка сервера (${res.status})`);
  }
  const { token } = (await res.json()) as { token: string };
  await db.kv.put({ key: 'sync.config', value: { token, baseUrl } satisfies SyncConfig });
  await db.kv.put({ key: 'sync.since', value: 0 });
  await enqueueEverything();
  setStatus({ configured: true, unauthorized: false, error: null });
  await syncNow();
}

export async function unpair() {
  // сначала отзываем токен на сервере, иначе он остался бы действительным навсегда
  try {
    const id = await getDeviceId();
    await apiFetch(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  } catch { /* сервер недоступен: устройство можно отозвать позже с ПК */ }
  await db.kv.delete('sync.config');
  await db.kv.delete('sync.since');
  await db.kv.delete('sync.lastAt');
  setStatus({ configured: false, lastAt: null, error: null, unauthorized: false });
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const cfg = await loadConfig();
  if (!cfg) throw new Error('Устройство не подключено');
  return fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' }
  });
}

// ---------- обмен ----------
interface WireEntity {
  table: TableName;
  id: string;
  updatedAt: number;
  deviceId: string;
  deleted: boolean;
  data: Record<string, unknown>;
  seq?: number;
}

async function collectPending(): Promise<{ entities: WireEntity[]; seqs: number[] }> {
  const pending = await db.changes.where('synced').equals(0).toArray();
  const keyOf = (p: ChangeRecord) => `${p.table}/${p.entityId}`;
  const last = new Map<string, ChangeRecord>();
  for (const p of pending) last.set(keyOf(p), p); // порядок по seq: остаётся последняя запись
  const included = new Set<string>();
  const entities: WireEntity[] = [];
  for (const [key, p] of last) {
    if (entities.length >= BATCH) break;
    included.add(key);
    const row = (await db.table(p.table).get(p.entityId)) as (Record<string, unknown> & { updatedAt: number; deviceId: string; deletedAt?: number | null }) | undefined;
    if (!row) continue; // сущности уже нет — запись журнала просто закрываем
    const data = { ...row };
    // ключ подписи — CryptoKey и наружу не идёт вообще: на сервере и у других устройств
    // бывает только шифрованный слепок (wrapped), который и так лежит в data
    if (p.table === 'profile') delete data.privateKey;
    entities.push({ table: p.table, id: p.entityId, updatedAt: row.updatedAt, deviceId: row.deviceId, deleted: !!row.deletedAt, data });
  }
  // закрываем только то, что вошло в этот запрос; правки, сделанные во время запроса, останутся в очереди
  return { entities, seqs: pending.filter((p) => included.has(keyOf(p))).map((p) => p.seq!) };
}

const newer = (remote: { updatedAt: number; deviceId: string }, local?: { updatedAt: number; deviceId: string }) =>
  !local || remote.updatedAt > local.updatedAt || (remote.updatedAt === local.updatedAt && remote.deviceId > local.deviceId);

// Данные с сервера не считаем доверенными: берём только известные таблицы и записи правильной формы
const isValidRemote = (e: WireEntity): boolean =>
  !!e && TABLES.includes(e.table) && typeof e.id === 'string' && e.id.length > 0 && e.id.length <= 64 &&
  Number.isFinite(e.updatedAt) && typeof e.deviceId === 'string' && !!e.data && typeof e.data === 'object' && !Array.isArray(e.data);

export async function applyRemote(entities: WireEntity[], sentSeqs: number[], since: number) {
  await db.transaction('rw', [db.exercises, db.workouts, db.templates, db.tracks, db.body, db.programs, db.profile, db.game, db.conflicts, db.changes, db.kv], async () => {
    const pending = new Set((await db.changes.where('synced').equals(0).toArray()).map((c) => `${c.table}:${c.entityId}`));
    const myId = await getDeviceId();
    for (const e of entities.filter(isValidRemote)) {
      const table = db.table(e.table);
      const local = (await table.get(e.id)) as ({ updatedAt: number; deviceId: string; deletedAt?: number } & Record<string, unknown>) | undefined;
      // игровой журнал не даёт карточек конфликта: записи детерминированы, а выбор «надетого» не стоит выбора человека
      if (e.table !== 'game' && newer(e, local) && local && isConflict({ local, remote: e, localPending: pending.has(`${e.table}:${e.id}`), myDeviceId: myId })) {
        // нашу несинхронизированную правку перезаписывает чужая: сохраняем снимок, решать будет человек
        await db.conflicts.add({
          table: e.table, entityId: e.id, label: conflictLabel(e.table, local), local, localUpdatedAt: local.updatedAt,
          remoteUpdatedAt: e.updatedAt, remoteDeviceId: e.deviceId, at: Date.now(), resolved: 0
        });
      }
      if (newer(e, local)) await table.put({ ...e.data, id: e.id, updatedAt: e.updatedAt, deviceId: e.deviceId });
    }
    if (sentSeqs.length) await db.changes.bulkUpdate(sentSeqs.map((seq) => ({ key: seq, changes: { synced: 1 as const } })));
    await db.changes.where('synced').equals(1).delete();
    await db.kv.put({ key: 'sync.since', value: since });
  });
}

let running: Promise<void> | null = null;

export function syncNow(): Promise<void> {
  if (running) return running;
  running = (async () => {
    const cfg = await loadConfig();
    if (!cfg) return;
    setStatus({ syncing: true });
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const { entities, seqs } = await collectPending();
        const since = await getSince();
        let res: Response;
        try {
          res = await apiFetch('/api/sync', { method: 'POST', body: JSON.stringify({ since, entities }) });
        } catch {
          setStatus({ error: 'Нет связи с сервером' });
          return;
        }
        if (res.status === 401) { setStatus({ unauthorized: true, error: 'Устройство отключено сервером. Подключи заново.' }); return; }
        if (!res.ok) { setStatus({ error: `Ошибка сервера (${res.status})` }); return; }
        const body = (await res.json()) as { seq: number; more: boolean; entities: WireEntity[] };
        await applyRemote(body.entities, seqs, body.seq);
        const stillPending = (await db.changes.where('synced').equals(0).count()) > 0;
        if (!body.more && !(stillPending && entities.length >= BATCH)) break;
      }
      const now = Date.now();
      await db.kv.put({ key: 'sync.lastAt', value: now });
      setStatus({ lastAt: now, error: null, unauthorized: false });
    } catch (e) {
      setStatus({ error: e instanceof Error ? e.message : 'Ошибка синхронизации' });
    } finally {
      setStatus({ syncing: false });
    }
  })().finally(() => { running = null; });
  return running;
}

// ---------- запуск в приложении ----------
let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;

export function scheduleSync(delay = 1500) {
  if (!status.configured || status.unauthorized) return;
  clearTimeout(timer);
  timer = setTimeout(() => { void syncNow(); }, delay);
}

export async function startSyncEngine() {
  if (started) return;
  started = true;
  await initSyncStatus();
  await compactChanges().catch(() => { /* очередь просто останется длиннее: на отправку это не влияет */ });
  db.changes.hook('creating', () => { scheduleSync(); });
  window.addEventListener('online', () => scheduleSync(300));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(300); });
  setInterval(() => { if (document.visibilityState === 'visible') scheduleSync(0); }, 30_000);
  scheduleSync(500);
}
