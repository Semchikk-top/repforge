// Подписанный снимок рейтинга: единственное, что друзья получают по умолчанию. Только агрегаты.
import { canonicalJson, PUBLIC_KEY_RE, signText, verifyText, type IdentityKey } from './crypto';
import { MAX_EXERCISES, type Period, type SnapshotStats } from './leaderboard';

export const SNAPSHOT_MAX_BYTES = 64 * 1024;
export const MAX_AGE_MS = 90 * 24 * 3600 * 1000;
export const MAX_FUTURE_MS = 10 * 60 * 1000;

export interface LeaderboardSnapshot extends SnapshotStats {
  v: 1;
  profileId: string;
  displayName: string;
  publicKey: string;
  period: Period;
  generatedAt: number;
  nonce: string;
  sig: string;
}
export type UnsignedSnapshot = Omit<LeaderboardSnapshot, 'sig'>;

export const PROFILE_ID_RE = /^p_[A-Za-z0-9_-]{22}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const randomNonce = (): string => {
  const b = new Uint8Array(12);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
};

export async function signSnapshot(u: UnsignedSnapshot, key: Pick<IdentityKey, 'alg' | 'privateKey'>): Promise<LeaderboardSnapshot> {
  return { ...u, sig: await signText(key, canonicalJson(u)) };
}

const str = (v: unknown, max: number, min = 0): string | null =>
  typeof v === 'string' && v.length >= min && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;
const num = (v: unknown, max: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? v : null;

/** Строгая проверка формы и диапазонов. Лишние поля отбрасываются; возвращает чистый объект или null. */
export function validateSnapshot(raw: unknown): LeaderboardSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return null; // неизвестная основная версия — отказ
  const profileId = str(r.profileId, 40, 3), displayName = str(r.displayName, 40, 1), publicKey = str(r.publicKey, 140, 10);
  const nonce = str(r.nonce, 64, 8), sig = str(r.sig, 200, 20), generatedAt = num(r.generatedAt, 8.64e15);
  if (!profileId || !PROFILE_ID_RE.test(profileId) || !displayName || !publicKey || !PUBLIC_KEY_RE.test(publicKey) || !nonce || !sig || generatedAt === null) return null;
  const p = r.period as Record<string, unknown> | undefined;
  const from = str(p?.from, 10, 10), to = str(p?.to, 10, 10), tz = str(p?.tz, 64, 1);
  if (!from || !to || !tz || !DATE_RE.test(from) || !DATE_RE.test(to) || from > to) return null;
  const t = r.totals as Record<string, unknown> | undefined;
  const workouts = num(t?.workouts, 1e6), workSets = num(t?.workSets, 1e7), volumeKg = num(t?.volumeKg, 1e10);
  if (workouts === null || workSets === null || volumeKg === null) return null;
  const c = r.cardio as Record<string, unknown> | undefined;
  const distanceKm = num(c?.distanceKm, 1e6), movingSec = num(c?.movingSec, 1e9), sessions = num(c?.sessions, 1e6);
  if (distanceKm === null || movingSec === null || sessions === null) return null;
  if (!Array.isArray(r.exercises) || r.exercises.length > MAX_EXERCISES) return null;
  const exercises: LeaderboardSnapshot['exercises'] = [];
  for (const e of r.exercises) {
    const o = e as Record<string, unknown>;
    const key = str(o?.key, 120, 1), name = str(o?.name, 60, 1), muscle = str(o?.muscle, 20, 1);
    const e1 = num(o?.e1rmKg, 3000), vol = num(o?.volumeKg, 1e9), ws = num(o?.workSets, 1e6);
    if (!key || !name || !muscle || e1 === null || vol === null || ws === null) return null;
    exercises.push({ key, name, muscle, e1rmKg: e1, volumeKg: vol, workSets: ws });
  }
  return {
    v: 1, profileId, displayName, publicKey, period: { from, to, tz }, generatedAt, nonce,
    totals: { workouts, workSets, volumeKg }, exercises, cardio: { distanceKm, movingSec, sessions }, sig
  };
}

export type SnapshotCheck = 'ok' | 'malformed' | 'too-big' | 'bad-signature' | 'wrong-key' | 'too-old' | 'from-future';

/**
 * Полная проверка входящего снимка. Подпись проверяется по исходному объекту без sig:
 * лишние поля новой минорной версии не ломают подпись, но в хранилище не попадают.
 * expectedKey — ключ, закреплённый за другом; если задан, чужой ключ — отказ.
 */
export async function checkSnapshot(raw: unknown, now: number, expectedKey?: string): Promise<{ result: SnapshotCheck; snapshot?: LeaderboardSnapshot }> {
  let size = 0;
  try { size = JSON.stringify(raw).length; } catch { return { result: 'malformed' }; }
  if (size > SNAPSHOT_MAX_BYTES) return { result: 'too-big' };
  const snap = validateSnapshot(raw);
  if (!snap) return { result: 'malformed' };
  if (expectedKey && snap.publicKey !== expectedKey) return { result: 'wrong-key' };
  const { sig, ...unsigned } = raw as Record<string, unknown>;
  if (!(await verifyText(snap.publicKey, canonicalJson(unsigned), sig as string))) return { result: 'bad-signature' };
  if (snap.generatedAt > now + MAX_FUTURE_MS) return { result: 'from-future' };
  if (snap.generatedAt < now - MAX_AGE_MS) return { result: 'too-old' };
  return { result: 'ok', snapshot: snap };
}
