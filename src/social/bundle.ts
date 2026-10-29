// Обмен без сети: подписанный пакет снимков в виде текста или файла. Проверяется так же строго, как по каналу.
import { profileIdFor } from './crypto';
import { parseCard, type Card } from './friendwire';
import { checkSnapshot, type LeaderboardSnapshot } from './snapshot';

export const BUNDLE_TYPE = 'workout-pwa-friend-bundle';
export const BUNDLE_MAX_CHARS = 300_000;
const MAX_SNAPSHOTS = 12;

export function makeBundleText(card: Card, snapshots: LeaderboardSnapshot[]): string {
  return JSON.stringify({ type: BUNDLE_TYPE, v: 1, card, snapshots: snapshots.slice(0, MAX_SNAPSHOTS) });
}

export type BundleError = 'too-big' | 'not-a-bundle' | 'bad-card' | 'wrong-key' | 'no-valid-snapshots';

export interface ParsedBundle { card: Card; snapshots: LeaderboardSnapshot[]; rejected: number }

/**
 * Разбор и проверка пакета. pinnedKey — ключ уже добавленного друга: пакет с другим ключом отклоняется,
 * иначе «подмена личности» была бы просто подменой файла.
 */
export async function parseBundleText(text: string, now: number, pinnedKey?: string): Promise<{ ok: true; bundle: ParsedBundle } | { ok: false; error: BundleError }> {
  if (typeof text !== 'string' || text.length > BUNDLE_MAX_CHARS) return { ok: false, error: 'too-big' };
  let o: Record<string, unknown>;
  try { o = JSON.parse(text.trim()); } catch { return { ok: false, error: 'not-a-bundle' }; }
  if (!o || typeof o !== 'object' || o.type !== BUNDLE_TYPE || o.v !== 1 || !Array.isArray(o.snapshots)) return { ok: false, error: 'not-a-bundle' };
  const card = parseCard(o.card);
  if (!card || (await profileIdFor(card.publicKey)) !== card.profileId) return { ok: false, error: 'bad-card' };
  if (pinnedKey && pinnedKey !== card.publicKey) return { ok: false, error: 'wrong-key' };
  const snapshots: LeaderboardSnapshot[] = [];
  let rejected = 0;
  for (const raw of o.snapshots.slice(0, MAX_SNAPSHOTS)) {
    const c = await checkSnapshot(raw, now, card.publicKey);
    if (c.result === 'ok' && c.snapshot!.profileId === card.profileId) snapshots.push(c.snapshot!); else rejected++;
  }
  if (snapshots.length === 0) return { ok: false, error: 'no-valid-snapshots' };
  return { ok: true, bundle: { card, snapshots, rejected } };
}

export const BUNDLE_ERROR_TEXT: Record<BundleError, string> = {
  'too-big': 'Файл слишком большой для снимка.',
  'not-a-bundle': 'Это не файл снимка из этого приложения.',
  'bad-card': 'Карточка в файле повреждена или не совпадает с ключом.',
  'wrong-key': 'Ключ в файле не совпадает с ключом этого друга. Возможна подмена.',
  'no-valid-snapshots': 'В файле нет ни одного снимка с верной подписью и свежей датой.'
};
