// Настройки комнаты «Рядом». Адрес релея задаётся при сборке (VITE_ROOM_RELAY_URL=wss://relay.example) или, в нативном
// приложении, прямо в окне комнаты: тогда он хранится на устройстве и важнее адреса из сборки.
// Без адреса раздел остаётся в приложении, но создать комнату нельзя, и это честно сказано в интерфейсе.
import { CLEARTEXT_ALLOWED } from '../sync/server-url';

/** Версия протокола между телефонами и релеем. Меняется только при несовместимых изменениях. */
export const PROTO_VERSION = 1;

function normalizeRelay(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = v.trim().replace(/\/+$/, '');
  return /^wss?:\/\/[^\s/]+/i.test(s) ? s : '';
}

const BUILD_RELAY: string = normalizeRelay(import.meta.env?.VITE_ROOM_RELAY_URL);
const RELAY_KEY = 'room.relayUrl';

function storedRelay(): string {
  try { return normalizeRelay(globalThis.localStorage?.getItem(RELAY_KEY)); } catch { return ''; }
}

/** Адрес, заданный в приложении, иначе адрес из сборки, иначе пусто. Читается при каждом обращении: его можно сменить на лету. */
export const getRelayUrl = (): string => storedRelay() || BUILD_RELAY;
export const buildRelayUrl = (): string => BUILD_RELAY;
export const relayConfigured = (): boolean => getRelayUrl() !== '';

/**
 * Сохраняет адрес релея, введённый пользователем. Пустая строка возвращает адрес из сборки. Бросает Error с понятным
 * текстом, если адрес не годится. Открытый ws:// разрешён только в отладочной сборке для локальной сети.
 */
export function setRelayUrl(input: string, allowCleartext: boolean = CLEARTEXT_ALLOWED): string {
  const raw = input.trim();
  if (!raw) { try { globalThis.localStorage?.removeItem(RELAY_KEY); } catch { /* хранилище недоступно */ } return BUILD_RELAY; }
  const url = normalizeRelay(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `wss://${raw}`);
  let valid = false;
  try { const u = new URL(url); valid = !!u.hostname && !u.username && !u.password; } catch { /* неразборчивый адрес */ }
  if (!url || !valid) throw new Error('Адрес релея выглядит неправильно. Пример: wss://relay.имя.ts.net');
  if (url.toLowerCase().startsWith('ws://') && !allowCleartext) throw new Error('Эта сборка подключается к релею только по wss:// (с шифрованием).');
  try { globalThis.localStorage?.setItem(RELAY_KEY, url); } catch { throw new Error('Не удалось сохранить адрес на устройстве'); }
  return url;
}

export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

export const LIMITS = {
  connectRelayMs: 8000,     // ждём ответа релея
  iceGatherMs: 2000,        // non-trickle: ждём сбора кандидатов не дольше
  connectMs: 20000,         // от обмена SDP до открытого канала
  approvalMs: 3 * 60_000,   // хост не ответил на запрос входа
  heartbeatMs: 12_000,      // как часто напоминаем о себе
  deadAfterMs: 40_000,      // тишина дольше этого — связь потеряна
  disconnectedGraceMs: 5000 // «disconnected» бывает кратким
} as const;

/**
 * Для друзей «на расстоянии» нужен STUN/TURN: VITE_FRIEND_ICE_SERVERS=stun:stun.example:3478,turn:turn.example:3478
 * Без него обмен снимками работает только в одной сети, и интерфейс говорит об этом честно.
 */
export const FRIEND_ICE_SERVERS: string[] = String(import.meta.env?.VITE_FRIEND_ICE_SERVERS ?? '')
  .split(',').map((x: string) => x.trim()).filter((x: string) => /^(stun|turn|turns):/i.test(x));
