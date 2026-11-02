import { conflictLabel, isConflict } from './conflicts';
import { db } from '../db/db';
import { compactChanges, getDeviceId } from '../db/repo';
import { platform } from '../platform';
import type { ChangeRecord, ConflictRecord } from '../domain/types';
import { PROTOCOL_VERSION, parseSyncFailure, type Incompat } from './protocol';
import { clockProblem, clockMessage, measureClock, type ClockSample } from './clock';
import { logSyncEvent } from './log';
import { MERGE_SPECS, mergeEntity, sameRecord } from './merge';
import { addDays, toDateStr } from '../lib';

// Синхронизация по журналу изменений (outbox). Один запрос = отправка своих правок + получение чужих.
// Конфликты: побеждает запись с большим updatedAt, при равенстве — с большим deviceId (то же правило, что на сервере).

type TableName = ChangeRecord['table'];
const TABLES: TableName[] = ['exercises', 'workouts', 'templates', 'tracks', 'body', 'programs', 'profile', 'game', 'checkins'];
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
  /** Версии приложения и сервера несовместимы: синхронизация не идёт, пока одну из сторон не обновят. */
  incompat: Incompat | null;
  /** Последнее измерение расхождения часов с сервером. */
  clock: ClockSample | null;
  /** Что сервер сообщил о себе в последнем ответе. */
  server: { protocol: number; minClientProtocol: number; schema: number } | null;
}

let status: SyncStatus = { configured: false, syncing: false, lastAt: null, error: null, unauthorized: false, incompat: null, clock: null, server: null };
let lastIncompatAt = 0;
const INCOMPAT_RETRY_MS = 5 * 60_000;
const listeners = new Set<() => void>();
const setStatus = (patch: Partial<SyncStatus>) => {
  status = { ...status, ...patch };
  listeners.forEach((l) => l());
};
export const getSyncStatus = () => status;
export const subscribeSync = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

// ---------- конфигурация ----------
// В нативной оболочке токен лежит в Keystore/Keychain, а в IndexedDB остаётся только адрес сервера: так токен
// не попадает ни в выгрузки данных, ни в отладочные снимки хранилища страницы. В браузере защищённого хранилища нет.
const TOKEN_KEY = 'sync.token';
type StoredConfig = { token?: string; baseUrl?: string };
const readRow = async (): Promise<StoredConfig | null> => ((await db.kv.get('sync.config'))?.value as StoredConfig | undefined) ?? null;

async function loadConfig(): Promise<SyncConfig | null> {
  const row = await readRow();
  if (!row) return null;
  const baseUrl = row.baseUrl ?? '';
  if (!platform.secureStorage.hardwareBacked) return row.token ? { token: row.token, baseUrl } : null;

  let token = await platform.secureStorage.get(TOKEN_KEY);
  if (!token && row.token) {
    // обновление со старой версии: переносим токен из IndexedDB в защищённое хранилище
    try { await platform.secureStorage.set(TOKEN_KEY, row.token); token = row.token; } catch { return { token: row.token, baseUrl }; }
  }
  if (token && row.token) await db.kv.put({ key: 'sync.config', value: { token: '', baseUrl } satisfies SyncConfig });
  // токена в хранилище нет (его сбросила система): устройство надо подключить заново
  return token ? { token, baseUrl } : null;
}

async function saveConfig(token: string, baseUrl: string): Promise<void> {
  if (platform.secureStorage.hardwareBacked) {
    try {
      await platform.secureStorage.set(TOKEN_KEY, token);
      await db.kv.put({ key: 'sync.config', value: { token: '', baseUrl } satisfies SyncConfig });
      return;
    } catch { /* хранилище не отвечает: лучше сохранить как раньше, чем потерять сопряжение */ }
  }
  await db.kv.put({ key: 'sync.config', value: { token, baseUrl } satisfies SyncConfig });
}

/** Адрес сервера, с которым устройство сопряжено ('' = тот же адрес, откуда открыто приложение). */
export async function getServerUrl(): Promise<string> {
  return (await readRow())?.baseUrl ?? '';
}
const getSince = async () => ((await db.kv.get('sync.since'))?.value as number) ?? 0;

export async function initSyncStatus() {
  const [cfg, last, clock] = await Promise.all([loadConfig(), db.kv.get('sync.lastAt'), db.kv.get('sync.clock')]);
  setStatus({ configured: !!cfg, lastAt: (last?.value as number) ?? null, clock: (clock?.value as ClockSample | undefined) ?? null, server: null, incompat: null });
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
  await saveConfig(token, baseUrl);
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
  await platform.secureStorage.remove(TOKEN_KEY);
  await db.kv.delete('sync.since');
  await db.kv.delete('sync.lastAt');
  await db.kv.delete('sync.clock');
  setStatus({ configured: false, lastAt: null, error: null, unauthorized: false, incompat: null, clock: null, server: null });
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

// Какие таблицы сливаем по полям и что хранить в качестве общего предка (версии, которую сервер отдал в прошлый раз).
// Предок нужен только для записей, с которыми реально можно разойтись: свежих и незавершённых. Старая история
// никем не правится, а предки под неё удвоили бы место. Не сливаются: tracks (точки маршрута не правят после записи)
// и profile (личный ключ не покидает устройство); у них действует прежнее правило «побеждает целая запись».
const BASE_DAYS = 60;
interface MergePolicy {
  keep: (data: Record<string, unknown>) => boolean;
  /** Можно сливать и без предка: запись с детерминированным id (чек-ин, настройки игры) заводят на двух устройствах независимо. */
  withoutBase?: boolean;
}
const recent = (d: Record<string, unknown>) => typeof d.date === 'string' && d.date >= toDateStr(addDays(new Date(), -BASE_DAYS));
const MERGE_POLICY: Record<string, MergePolicy> = {
  workouts: { keep: (d) => d.status !== 'done' || recent(d) },
  exercises: { keep: () => true },
  templates: { keep: () => true },
  programs: { keep: () => true },
  body: { keep: recent },
  checkins: { keep: recent, withoutBase: true },
  game: { keep: (d) => d.kind === 'state', withoutBase: true }   // журнал начислений детерминирован, сливать нужно только «надето» и ник
};
const mergeable = (table: string) => table in MERGE_POLICY && table in MERGE_SPECS;

async function putBase(e: { table: string; id: string; deleted: boolean; data: Record<string, unknown> }) {
  const policy = MERGE_POLICY[e.table];
  if (!policy) return;
  if (!e.deleted && policy.keep(e.data)) await db.bases.put({ id: `${e.table}/${e.id}`, table: e.table, data: e.data, at: Date.now() });
  else await db.bases.delete(`${e.table}/${e.id}`);
}

/** Убрать общие предки записей, которые уже не правят (давние завершённые тренировки, старые замеры): вызывается при запуске. */
export async function pruneBases(): Promise<number> {
  const old = (await db.bases.toArray()).filter((b) => !MERGE_POLICY[b.table]?.keep(b.data)).map((b) => b.id);
  if (old.length) await db.bases.bulkDelete(old);
  return old.length;
}

export async function applyRemote(entities: WireEntity[], sentSeqs: number[], since: number, sent: WireEntity[] = []) {
  await db.transaction('rw', [db.exercises, db.workouts, db.templates, db.tracks, db.body, db.programs, db.profile, db.game, db.checkins, db.conflicts, db.changes, db.kv, db.bases], async () => {
    const pending = new Set((await db.changes.where('synced').equals(0).toArray()).map((c) => `${c.table}:${c.entityId}`));
    const myId = await getDeviceId();
    // то, что мы отправили, теперь и есть версия сервера (если чужая окажется новее, ниже она перезапишет предка)
    // (если сервер вернул ту же запись, значит наша версия у него не победила: предок остаётся прежним, он нужен для слияния)
    for (const s of sent) if (!entities.some((x) => x.table === s.table && x.id === s.id)) await putBase(s);
    for (const e of entities.filter(isValidRemote)) {
      const table = db.table(e.table);
      const local = (await table.get(e.id)) as ({ updatedAt: number; deviceId: string; deletedAt?: number } & Record<string, unknown>) | undefined;

      // Запись правили и у нас, и на другом устройстве: сливаем по полям (у тренировок и списков с id: по подходам и элементам),
      // а не выбираем одну запись целиком. Без общего предка (первая синхронизация, старая запись) сливать не из чего:
      // действует прежнее правило, кроме таблиц с детерминированными id (см. MergePolicy.withoutBase).
      if (mergeable(e.table) && MERGE_POLICY[e.table].keep(e.data) && local && !local.deletedAt && !e.deleted && e.deviceId !== myId && pending.has(`${e.table}:${e.id}`) && !sameRecord(local, e.data)) {
        const base = await db.bases.get(`${e.table}/${e.id}`);
        // чужая версия совпадает с предком и не новее нашей: от неё ничего нового, наша правка и так дойдёт до сервера
        const nothingNew = !!base && sameRecord(base.data, e.data) && !newer(e, local);
        if ((base || MERGE_POLICY[e.table].withoutBase) && !nothingNew) {
          const { merged, lostLocal } = mergeEntity(base?.data, local as Record<string, unknown>, e.data, !newer(e, local), MERGE_SPECS[e.table]);
          if (lostLocal && e.table !== 'game') {
            await db.conflicts.add({
              table: e.table as ConflictRecord['table'], entityId: e.id, label: conflictLabel(e.table, local), local, localUpdatedAt: local.updatedAt,
              remoteUpdatedAt: e.updatedAt, remoteDeviceId: e.deviceId, at: Date.now(), resolved: 0
            });
          }
          const stale = await db.changes.where('entityId').equals(e.id).and((c) => c.table === e.table && c.synced === 0).primaryKeys();
          if (stale.length) await db.changes.bulkDelete(stale);
          if (sameRecord(merged, e.data)) {
            // от наших правок ничего не осталось: принимаем чужую версию целиком, отправлять нечего
            await table.put({ ...e.data, id: e.id, updatedAt: e.updatedAt, deviceId: e.deviceId });
            pending.delete(`${e.table}:${e.id}`);
          } else {
            // слитая версия новее обеих, иначе сервер оставил бы чужую; уходит на сервер следующим кругом
            const updatedAt = Math.max(Date.now(), local.updatedAt, e.updatedAt) + 1;
            await table.put({ ...merged, id: e.id, updatedAt, deviceId: myId });
            await db.changes.add({ table: e.table as ChangeRecord['table'], entityId: e.id, op: 'put', ts: Date.now(), deviceId: myId, synced: 0 });
          }
          await putBase(e);
          continue;
        }
      }

      // игровой журнал не даёт карточек конфликта: записи детерминированы, а выбор «надетого» не стоит выбора человека
      if (e.table !== 'game' && newer(e, local) && local && isConflict({ local, remote: e, localPending: pending.has(`${e.table}:${e.id}`), myDeviceId: myId })) {
        // нашу несинхронизированную правку перезаписывает чужая: сохраняем снимок, решать будет человек
        await db.conflicts.add({
          table: e.table, entityId: e.id, label: conflictLabel(e.table, local), local, localUpdatedAt: local.updatedAt,
          remoteUpdatedAt: e.updatedAt, remoteDeviceId: e.deviceId, at: Date.now(), resolved: 0
        });
      }
      if (newer(e, local)) {
        await table.put({ ...e.data, id: e.id, updatedAt: e.updatedAt, deviceId: e.deviceId });
        await putBase(e);
      }
    }
    if (sentSeqs.length) await db.changes.bulkUpdate(sentSeqs.map((seq) => ({ key: seq, changes: { synced: 1 as const } })));
    await db.changes.where('synced').equals(1).delete();
    await db.kv.put({ key: 'sync.since', value: since });
  });
}

let clockWarned = false;

/** Версии сервера и часы из ответа на синхронизацию. Ошибка здесь не должна ломать сам обмен. */
function trackServer(body: { protocol?: number; minClientProtocol?: number; schema?: number; serverTime?: number }, sentAt: number, receivedAt: number) {
  try {
    if (typeof body.protocol === 'number') {
      setStatus({ server: { protocol: body.protocol, minClientProtocol: body.minClientProtocol ?? body.protocol, schema: body.schema ?? 0 } });
    }
    const sample = typeof body.serverTime === 'number' ? measureClock(sentAt, receivedAt, body.serverTime) : null;
    if (!sample) return;
    setStatus({ clock: sample });
    void db.kv.put({ key: 'sync.clock', value: sample });
    const problem = clockProblem(sample);
    if (problem && !clockWarned) { clockWarned = true; void logSyncEvent('warn', clockMessage(problem)); }
    if (!problem) clockWarned = false;
  } catch { /* необязательные сведения */ }
}

let running: Promise<void> | null = null;

export function syncNow(): Promise<void> {
  if (running) return running;
  running = (async () => {
    const cfg = await loadConfig();
    if (!cfg) return;
    setStatus({ syncing: true });
    try {
      // Один обмен с сервером. push=false — только забрать чужие правки: так наши несинхронизированные правки тренировки
      // успевают слиться с чужими до отправки, а не перезаписать их целиком (см. applyRemote и merge.ts).
      const exchange = async (push: boolean): Promise<{ more: boolean; sent: number } | null> => {
        const { entities, seqs } = push ? await collectPending() : { entities: [] as WireEntity[], seqs: [] as number[] };
        const since = await getSince();
        let res: Response;
        const sentAt = Date.now();
        try {
          res = await apiFetch('/api/sync', { method: 'POST', body: JSON.stringify({ since, protocol: PROTOCOL_VERSION, entities }) });
        } catch {
          setStatus({ error: 'Нет связи с сервером' });
          return null;
        }
        const receivedAt = Date.now();
        if (res.status === 401) { setStatus({ unauthorized: true, error: 'Устройство отключено сервером. Подключи заново.' }); void logSyncEvent('error', 'Сервер отклонил токен устройства (401)'); return null; }
        if (!res.ok) {
          const f = parseSyncFailure(res.status, await res.json().catch(() => null));
          if (f.incompat) lastIncompatAt = receivedAt;
          setStatus({ error: f.message, incompat: f.incompat });
          void logSyncEvent('error', `${f.message} [HTTP ${res.status}]`);
          return null;
        }
        const body = (await res.json()) as { seq: number; more: boolean; entities: WireEntity[]; protocol?: number; minClientProtocol?: number; schema?: number; serverTime?: number };
        trackServer(body, sentAt, receivedAt);
        await applyRemote(body.entities, seqs, body.seq, entities);
        return { more: body.more, sent: entities.length };
      };

      const hasPendingMergeable = (await db.changes.where('synced').equals(0).filter((c) => mergeable(c.table)).count()) > 0;
      if (hasPendingMergeable) {
        for (let i = 0; i < MAX_ROUNDS; i++) {
          const r = await exchange(false);
          if (!r) return;
          if (!r.more) break;
        }
      }
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const r = await exchange(true);
        if (!r) return;
        const stillPending = (await db.changes.where('synced').equals(0).count()) > 0;
        if (!r.more && !(stillPending && r.sent >= BATCH)) break;
      }
      const now = Date.now();
      await db.kv.put({ key: 'sync.lastAt', value: now });
      setStatus({ lastAt: now, error: null, unauthorized: false, incompat: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Ошибка синхронизации';
      setStatus({ error: msg });
      void logSyncEvent('error', `Сбой при применении ответа: ${msg}`);
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
  // при несовместимых версиях бессмысленно долбить сервер каждые 30 секунд: пробуем раз в несколько минут
  if (status.incompat && Date.now() - lastIncompatAt < INCOMPAT_RETRY_MS) return;
  clearTimeout(timer);
  timer = setTimeout(() => { void syncNow(); }, delay);
}

export async function startSyncEngine() {
  if (started) return;
  started = true;
  await initSyncStatus();
  await compactChanges().catch(() => { /* очередь просто останется длиннее: на отправку это не влияет */ });
  await pruneBases().catch(() => { /* лишние предки только занимают место */ });
  db.changes.hook('creating', () => { scheduleSync(); });
  window.addEventListener('online', () => scheduleSync(300));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(300); });
  setInterval(() => { if (document.visibilityState === 'visible') scheduleSync(0); }, 30_000);
  scheduleSync(500);
}
