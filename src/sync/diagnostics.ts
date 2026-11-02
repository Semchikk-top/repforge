// Сбор сведений для экрана диагностики и текстовый отчёт «скопировать и показать».
// В отчёт не попадают токены, адрес сервера, содержимое тренировок и заметок: только версии, счётчики и тексты ошибок.
import { db } from '../db/db';
import { platform } from '../platform';
import { apiFetch, getSyncStatus, type SyncStatus } from './sync';
import { PROTOCOL_VERSION } from './protocol';
import { clockProblem, formatSkew } from './clock';
import { readSyncEvents, type SyncEvent } from './log';

/** Достижение, которое открывает экран диагностики (пока выдаётся семью нажатиями на версию в настройках). */
export const DIAGNOSTICS_ACHIEVEMENT = 'dev';
export const diagnosticsUnlocked = (unlocked: { has(id: string): boolean }): boolean => unlocked.has(DIAGNOSTICS_ACHIEVEMENT);

export interface ServerDiagnostics {
  serverVersion: string; protocol: number; minClientProtocol: number; schema: number; python: string;
  seq: number; time: number; entities: Record<string, number>; deletedEntities: number; devices: number;
  dbBytes: number | null; backups: number;
}

export interface DiagnosticsSnapshot {
  at: number;
  app: { version: string; protocol: number; dbVersion: number; os: string; native: boolean; online: boolean; tzOffsetMin: number };
  storage: { persisted: boolean | null; usage: number | null; quota: number | null };
  deviceId: string;
  sync: Pick<SyncStatus, 'configured' | 'lastAt' | 'error' | 'unauthorized' | 'incompat' | 'clock' | 'server'> & { pending: number; since: number; conflictsOpen: number };
  /** null — устройство не подключено; 'unsupported' — сервер не знает такого запроса (до 0.11); 'unreachable' — нет связи. */
  serverInfo: ServerDiagnostics | 'unsupported' | 'unreachable' | null;
  counts: Record<string, number>;
  events: SyncEvent[];
}

const TABLES = ['exercises', 'workouts', 'templates', 'tracks', 'body', 'programs', 'game', 'checkins', 'friends', 'photos', 'conflicts', 'changes'] as const;

async function storageInfo(): Promise<DiagnosticsSnapshot['storage']> {
  const s = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  const [persisted, est] = await Promise.all([
    s?.persisted?.().catch(() => null) ?? Promise.resolve(null),
    s?.estimate?.().catch(() => null) ?? Promise.resolve(null)
  ]);
  return { persisted, usage: est?.usage ?? null, quota: est?.quota ?? null };
}

async function fetchServerInfo(configured: boolean): Promise<DiagnosticsSnapshot['serverInfo']> {
  if (!configured) return null;
  try {
    const r = await apiFetch('/api/diagnostics');
    if (r.status === 404 || r.status === 405) return 'unsupported';
    if (!r.ok) return 'unreachable';
    return (await r.json()) as ServerDiagnostics;
  } catch { return 'unreachable'; }
}

export async function collectDiagnostics(): Promise<DiagnosticsSnapshot> {
  const st = getSyncStatus();
  const [counts, pending, since, open, deviceId, events, storage, serverInfo] = await Promise.all([
    Promise.all(TABLES.map(async (t) => [t, await db.table(t).count()] as const)),
    db.changes.where('synced').equals(0).count(),
    db.kv.get('sync.since'),
    db.conflicts.where('resolved').equals(0).count(),
    db.kv.get('deviceId'),
    readSyncEvents(),
    storageInfo(),
    fetchServerInfo(st.configured)
  ]);
  return {
    at: Date.now(),
    app: {
      version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev', protocol: PROTOCOL_VERSION, dbVersion: db.verno,
      os: platform.info.os, native: platform.info.native, online: typeof navigator === 'undefined' ? true : navigator.onLine,
      tzOffsetMin: -new Date().getTimezoneOffset()
    },
    storage,
    deviceId: String(deviceId?.value ?? '').slice(0, 8),
    sync: { configured: st.configured, lastAt: st.lastAt, error: st.error, unauthorized: st.unauthorized, incompat: st.incompat, clock: st.clock, server: st.server, pending, since: Number(since?.value ?? 0), conflictsOpen: open },
    serverInfo,
    counts: Object.fromEntries(counts),
    events
  };
}

const dt = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleString('ru-RU') : '—');
const mb = (b: number | null) => (b === null ? '—' : `${(b / 1048576).toFixed(1)} МБ`);

/** Совместимость версий одной фразой: то, что чаще всего нужно знать при сбое синхронизации. */
export function compatibilityLine(d: Pick<DiagnosticsSnapshot, 'sync'>): string {
  const { incompat, server } = d.sync;
  if (incompat === 'server_outdated') return 'Сервер старее приложения: обнови сервер';
  if (incompat === 'client_outdated') return 'Приложение старее, чем нужно серверу: обнови приложение';
  if (!server) return d.sync.configured ? 'Сервер версий не сообщал (до 0.11) или связи ещё не было' : 'Устройство не подключено';
  return server.protocol === PROTOCOL_VERSION ? `Совместимо (протокол ${PROTOCOL_VERSION})` : `Протоколы различаются: приложение ${PROTOCOL_VERSION}, сервер ${server.protocol}`;
}

export function buildReport(d: DiagnosticsSnapshot): string {
  const L: string[] = [];
  L.push(`Диагностика RepForge · ${dt(d.at)}`);
  L.push('');
  L.push('Приложение');
  L.push(`  версия ${d.app.version}, протокол ${d.app.protocol}, схема базы на устройстве ${d.app.dbVersion}`);
  L.push(`  ${d.app.native ? 'оболочка' : 'браузер'}, ${d.app.os}, ${d.app.online ? 'сеть есть' : 'нет сети'}, часовой пояс UTC${d.app.tzOffsetMin >= 0 ? '+' : '−'}${Math.abs(d.app.tzOffsetMin / 60)}`);
  L.push(`  устройство ${d.deviceId || '—'}…, хранилище: ${mb(d.storage.usage)} из ${mb(d.storage.quota)}${d.storage.persisted === false ? ', НЕ закреплено' : ''}`);
  L.push('');
  L.push('Синхронизация');
  L.push(`  ${d.sync.configured ? 'подключено' : 'не подключено'}${d.sync.unauthorized ? ', сервер отклонил токен' : ''}`);
  L.push(`  совместимость: ${compatibilityLine(d)}`);
  L.push(`  последняя успешная: ${dt(d.sync.lastAt)}, в очереди: ${d.sync.pending}, позиция на сервере: ${d.sync.since}, открытых конфликтов: ${d.sync.conflictsOpen}`);
  if (d.sync.error) L.push(`  ошибка: ${d.sync.error}`);
  const cp = clockProblem(d.sync.clock);
  L.push(d.sync.clock ? `  часы: расхождение ${d.sync.clock.offsetMs >= 0 ? '+' : '−'}${formatSkew(d.sync.clock.offsetMs)} (задержка ${d.sync.clock.rttMs} мс)${cp ? ' — ТРЕВОГА' : ', в норме'}` : '  часы: не измерялись');
  L.push('');
  L.push('Сервер');
  if (d.serverInfo === null) L.push('  нет подключения');
  else if (d.serverInfo === 'unsupported') L.push('  не поддерживает диагностику (версия до 0.11)');
  else if (d.serverInfo === 'unreachable') L.push('  не ответил');
  else {
    const s = d.serverInfo;
    L.push(`  версия ${s.serverVersion}, протокол ${s.protocol} (минимум клиента ${s.minClientProtocol}), схема базы ${s.schema}, Python ${s.python}`);
    L.push(`  записей: ${Object.entries(s.entities).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}; удалённых ${s.deletedEntities}`);
    L.push(`  устройств ${s.devices}, база ${mb(s.dbBytes)}, копий ${s.backups}, seq ${s.seq}, время сервера ${dt(s.time)}`);
  }
  L.push('');
  L.push('Данные на устройстве');
  L.push('  ' + Object.entries(d.counts).map(([k, v]) => `${k} ${v}`).join(', '));
  L.push('');
  L.push(`События синхронизации (${d.events.length})`);
  for (const e of d.events.slice(-15)) L.push(`  ${dt(e.at)} [${e.kind}] ${e.msg}${e.count > 1 ? ` ×${e.count}` : ''}`);
  if (!d.events.length) L.push('  нет');
  return L.join('\n');
}
