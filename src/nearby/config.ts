// Настройки комнаты «Рядом». Адрес релея задаётся при сборке: VITE_ROOM_RELAY_URL=wss://relay.example
// Без него раздел остаётся в приложении, но создать комнату нельзя, и это честно сказано в интерфейсе.

/** Версия протокола между телефонами и релеем. Меняется только при несовместимых изменениях. */
export const PROTO_VERSION = 1;

function normalizeRelay(v: unknown): string {
  if (typeof v !== 'string') return '';
  const s = v.trim().replace(/\/+$/, '');
  return /^wss?:\/\/[^\s/]+/i.test(s) ? s : '';
}

export const RELAY_URL: string = normalizeRelay(import.meta.env?.VITE_ROOM_RELAY_URL);
export const relayConfigured = (): boolean => RELAY_URL !== '';

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
