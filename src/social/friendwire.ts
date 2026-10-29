// Сообщения по каналу между друзьями. Разбор строгий: всё неизвестное отбрасывается.
import { PUBLIC_KEY_RE } from './crypto';
import { PROFILE_ID_RE } from './snapshot';
import type { Part } from './chunking';

export const FRIEND_PROTO = 1;

export interface Card { profileId: string; publicKey: string; displayName: string }

export type FriendWire =
  | { k: 'hello'; v: number; card: Card; nonce: string; got: boolean }
  | { k: 'auth'; sig: string }
  | { k: 'confirm' }
  | { k: 'decline' }
  | { k: 'bye'; reason: string }
  | { k: 'done' }
  | { k: 'part'; part: Part };

const MAX_WIRE = 20_000;
const clean = (v: unknown, max: number, min = 1): string | null =>
  typeof v === 'string' && v.length >= min && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;

export function parseCard(raw: unknown): Card | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const profileId = clean(o.profileId, 40), publicKey = clean(o.publicKey, 140), displayName = clean(o.displayName, 40);
  if (!profileId || !PROFILE_ID_RE.test(profileId) || !publicKey || !PUBLIC_KEY_RE.test(publicKey) || !displayName) return null;
  return { profileId, publicKey, displayName };
}

export function parseFriendWire(text: unknown): FriendWire | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_WIRE) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(text); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  switch (o.k) {
    case 'hello': {
      const card = parseCard(o.card), nonce = clean(o.nonce, 64, 8);
      if (!card || !nonce || typeof o.v !== 'number' || !Number.isInteger(o.v)) return null;
      return { k: 'hello', v: o.v, card, nonce, got: o.got === true };
    }
    case 'auth': { const sig = clean(o.sig, 200, 20); return sig ? { k: 'auth', sig } : null; }
    case 'confirm': case 'decline': case 'done': return { k: o.k };
    case 'bye': return { k: 'bye', reason: clean(o.reason, 40, 0) ?? '' };
    case 'part': {
      const p = o.part as Record<string, unknown> | undefined;
      const id = clean(p?.id, 16), data = typeof p?.data === 'string' ? p.data : null;
      if (!id || data === null || data.length > 14_000 || !Number.isInteger(p?.i) || !Number.isInteger(p?.n)) return null;
      return { k: 'part', part: { id, i: p!.i as number, n: p!.n as number, data } };
    }
    default: return null;
  }
}

export const encodeFriendWire = (w: FriendWire): string => JSON.stringify(w);

/** Текст, который подписывается при подтверждении личности на этом канале. */
export const authText = (binding: string, peerNonce: string, myProfileId: string): string => `wpwa-friend-v1|${binding}|${peerNonce}|${myProfileId}`;
