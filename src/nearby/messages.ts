// Протокол по каналу данных между телефонами: короткие JSON-сообщения, всё проверяется на входе.
import { sanitizePresence, type Presence } from './presence';

export const MAX_TEXT = 300;
export const MAX_NAME = 24;
export const MAX_WIRE_CHARS = 2048;
export const MAX_MESSAGES = 100;

export type Wire =
  | { k: 'hello'; name: string; proto: number; app: string; got: boolean }
  | { k: 'approve' }
  | { k: 'reject' }
  | { k: 'bye' }
  | { k: 'ping' }
  | { k: 'call' }
  | { k: 'chat'; text: string }
  | { k: 'presence'; p: Presence };

/** Без управляющих символов, лишних пробелов и длиннее предела. */
export function cleanText(s: unknown, max: number): string {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function parseWire(raw: unknown): Wire | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_WIRE_CHARS) return null;
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  switch (r.k) {
    case 'hello': {
      const name = cleanText(r.name, MAX_NAME);
      const proto = typeof r.proto === 'number' ? r.proto : NaN;
      if (!name || !Number.isInteger(proto)) return null;
      return { k: 'hello', name, proto, app: cleanText(r.app, 20), got: r.got === true };
    }
    case 'approve': case 'reject': case 'bye': case 'ping': case 'call':
      return { k: r.k };
    case 'chat': {
      const text = cleanText(r.text, MAX_TEXT);
      return text ? { k: 'chat', text } : null;
    }
    case 'presence': {
      const p = sanitizePresence(r.p);
      return p ? { k: 'presence', p } : null;
    }
    default: return null;
  }
}

export const encodeWire = (w: Wire): string => JSON.stringify(w);

export const QUICK_PHRASES = [
  { id: 'here', text: 'Я здесь' },
  { id: 'coming', text: 'Иду' },
  { id: 'spot', text: 'Подстрахуй' },
  { id: 'one-more', text: 'Ещё подход' },
  { id: 'resting', text: 'Отдыхаю' },
  { id: 'ready', text: 'Готов' }
] as const;
export type QuickId = (typeof QUICK_PHRASES)[number]['id'];

/** «Подстрахуй» дополняется текущим упражнением — но только если человек не скрывает, что делает. */
export function quickText(id: QuickId, local: Presence | null): string {
  const phrase = QUICK_PHRASES.find((q) => q.id === id)!.text;
  if (id === 'spot' && local && !local.hidden && local.phase !== 'idle' && local.exerciseName) return `${phrase}: ${local.exerciseName}`;
  return phrase;
}
