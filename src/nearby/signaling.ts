// WebSocket к релею. Через него идут только код комнаты, имена и SDP (offer/answer); чат и presence — никогда.
import { LIMITS } from './config';

export type RelayMsg = { t: string; [key: string]: unknown };

export interface SignalingHandlers {
  onOpen(): void;
  onMessage(msg: RelayMsg): void;
  /** neverOpened: соединение так и не установилось (нет сети, релей недоступен, чужой Origin). */
  onClose(neverOpened: boolean): void;
}
export interface SignalingHandle { send(msg: object): void; close(): void }
export type SignalingFactory = (url: string, h: SignalingHandlers) => SignalingHandle;

const MAX_INCOMING_CHARS = 80 * 1024; // SDP до 64 КБ плюс служебные поля

export const connectSignaling: SignalingFactory = (url, h) => {
  let opened = false;
  let finished = false;
  let ws: WebSocket | null = null;
  let timer: number | undefined;

  const finish = () => {
    if (finished) return;
    finished = true;
    window.clearTimeout(timer);
    h.onClose(!opened);
  };

  try {
    ws = new WebSocket(url);
  } catch {
    queueMicrotask(finish);
    return { send() {}, close() {} };
  }
  const sock = ws;
  timer = window.setTimeout(() => { if (!opened) { try { sock.close(); } catch { /* уже закрыт */ } finish(); } }, LIMITS.connectRelayMs);

  sock.onopen = () => { opened = true; window.clearTimeout(timer); if (!finished) h.onOpen(); };
  sock.onmessage = (e) => {
    if (finished || typeof e.data !== 'string' || e.data.length > MAX_INCOMING_CHARS) return;
    try {
      const m = JSON.parse(e.data) as unknown;
      if (m && typeof m === 'object' && typeof (m as RelayMsg).t === 'string') h.onMessage(m as RelayMsg);
    } catch { /* мусор от релея игнорируем */ }
  };
  sock.onerror = () => { /* подробностей браузер не даёт; итог придёт в onclose */ };
  sock.onclose = finish;

  return {
    send(msg) { if (!finished && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg)); },
    close() {
      finished = true; // собственное закрытие не считаем обрывом
      window.clearTimeout(timer);
      try { sock.close(); } catch { /* уже закрыт */ }
    }
  };
};
