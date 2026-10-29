// Хранилище профиля, друзей и снимков (Dexie).
import { db } from '../db/db';
import { putProfile, putProfileLocal } from '../db/repo';
import { generateIdentityKey, profileIdFor, signText, unwrapIdentityKey, wrapIdentityKey } from './crypto';
import { buildStats, PERIOD_KINDS, periodFor } from './leaderboard';
import { randomNonce, signSnapshot, type LeaderboardSnapshot } from './snapshot';
import { defaultPermissions, type Friend, type PeerSnapshotRow, type ProfileRow } from './types';

export const MAX_SNAPSHOTS_PER_FRIEND = 12;

export const getProfile = (): Promise<ProfileRow | undefined> => db.profile.get('me');

/**
 * Профиль создаётся один раз. Потеря ключа (очистка данных браузера) означает новую личность.
 * С паролем: ключ на мгновение существует в экспортируемом виде, из него снимается шифрованный
 * слепок (wrapped) для синхронизации, а для хранения ключ снова импортируется неэкспортируемым.
 * Без пароля: ключ как раньше живёт только в этом браузере и никуда не переносится.
 */
export async function ensureProfile(displayName: string, pass = ''): Promise<ProfileRow> {
  const have = await getProfile();
  if (have) return have;
  const p = pass.trim();
  const key = await generateIdentityKey('ed25519', !!p);
  let privateKey = key.privateKey;
  let wrapped;
  if (p) {
    wrapped = await wrapIdentityKey(privateKey, key.alg, p);
    privateKey = await unwrapIdentityKey(wrapped, p); // тот же ключ, но снова неэкспортируемый
  }
  return putProfile({
    id: 'me', profileId: await profileIdFor(key.publicKey), displayName: displayName.trim().slice(0, 40) || 'Без имени',
    alg: key.alg, publicKey: key.publicKey, privateKey, wrapped, createdAt: Date.now(), schema: 2
  });
}

export async function renameProfile(name: string): Promise<void> {
  const n = name.trim().slice(0, 40);
  if (!n) return;
  const me = await getProfile();
  if (me && me.displayName !== n) await putProfile({ ...me, displayName: n });
}

/** Разблокировка подписи на устройстве, куда профиль пришёл синхронизацией: тот же пароль
 *  расшифровывает слепок, ключ снова становится неэкспортируемым и живёт только здесь.
 *  Мета-поля и журнал не трогаем: для других устройств ничего не изменилось.
 *  Возвращает true, если подпись теперь доступна. */
export async function unlockProfile(pass: string): Promise<boolean> {
  const me = await getProfile();
  if (!me) return false;
  if (me.privateKey) return true;
  if (!me.wrapped) return false;
  try {
    const privateKey = await unwrapIdentityKey(me.wrapped, pass);
    await putProfileLocal({ ...me, privateKey });
    return true;
  } catch {
    return false;
  }
}

/** Старый профиль (до синхронизации) не имел мета-полей: дописываем их, чтобы он разом
 *  уехал на другие устройства. Слепка у такого ключа нет — он остаётся только здесь. */
export async function ensureProfileMeta(): Promise<void> {
  const me = await getProfile();
  if (!me || (typeof me.updatedAt === 'number' && me.deviceId)) return;
  // мета-полей в старой записи нет — putProfile сам проставит updatedAt/deviceId и запишет в журнал
  await putProfile({ ...me, schema: 2 });
}

/** Удалить профиль и всю связанную локальную соц-информацию. */
export async function deleteProfile(): Promise<void> {
  await db.transaction('rw', db.profile, db.friends, db.peerSnapshots, db.changes, async () => {
    await db.profile.clear();
    await db.friends.clear();
    await db.peerSnapshots.clear();
    await db.changes.where('table').equals('profile').delete();
  });
}

export const listFriends = (): Promise<Friend[]> => db.friends.toArray();
export const getFriend = (id: string): Promise<Friend | undefined> => db.friends.get(id);
export const putFriend = (f: Friend): Promise<string> => db.friends.put(f);

export async function setPermissions(id: string, p: Partial<Friend['permissions']>): Promise<void> {
  const f = await db.friends.get(id);
  if (f) await db.friends.put({ ...f, permissions: { ...f.permissions, ...p } });
}

/** Старые снимки удаляются совсем, а не прячутся. */
async function dropSnapshots(profileId: string): Promise<void> { await db.peerSnapshots.where('profileId').equals(profileId).delete(); }

export async function removeFriend(id: string): Promise<void> {
  await db.transaction('rw', db.friends, db.peerSnapshots, async () => { await db.friends.delete(id); await dropSnapshots(id); });
}

/** Блокировка: снимки удаляются, запись остаётся, чтобы не принимать новые заявки и данные. */
export async function blockFriend(id: string): Promise<void> {
  await db.transaction('rw', db.friends, db.peerSnapshots, async () => {
    const f = await db.friends.get(id);
    if (f) await db.friends.put({ ...f, status: 'blocked', permissions: { leaderboard: false, workoutDetails: false } });
    await dropSnapshots(id);
  });
}

/** Сохраняет проверенные снимки друга; более старые копии того же периода (повтор) не затирают новые. */
export async function saveSnapshots(profileId: string, snaps: LeaderboardSnapshot[], now = Date.now()): Promise<number> {
  let saved = 0;
  await db.transaction('rw', db.peerSnapshots, db.friends, async () => {
    for (const s of snaps) {
      if (s.profileId !== profileId) continue;
      const id = `${profileId}|${s.period.from}|${s.period.to}`;
      const cur = await db.peerSnapshots.get(id);
      if (cur && cur.snapshot.generatedAt >= s.generatedAt) continue;
      await db.peerSnapshots.put({ id, profileId, snapshot: s, receivedAt: now });
      saved++;
    }
    const all = await db.peerSnapshots.where('profileId').equals(profileId).toArray();
    all.sort((a, b) => b.snapshot.generatedAt - a.snapshot.generatedAt);
    for (const old of all.slice(MAX_SNAPSHOTS_PER_FRIEND)) await db.peerSnapshots.delete(old.id);
    const f = await db.friends.get(profileId);
    if (f && saved > 0) await db.friends.put({ ...f, lastSnapshotAt: Math.max(...snaps.map((s) => s.generatedAt)), lastSeenAt: now });
  });
  return saved;
}

export const allPeerSnapshots = (): Promise<PeerSnapshotRow[]> => db.peerSnapshots.toArray();

/** Подписанные снимки для трёх периодов: неделя, 4 недели, всё время.
 *  Без ключа (профиль пришёл синхронизацией и не разблокирован) снимки собрать нельзя. */
export async function buildMySnapshots(now = new Date()): Promise<LeaderboardSnapshot[]> {
  const me = await getProfile();
  if (!me?.privateKey) return [];
  const privateKey = me.privateKey;
  const [workouts, exercises] = await Promise.all([db.workouts.toArray(), db.exercises.toArray()]);
  const out: LeaderboardSnapshot[] = [];
  for (const kind of PERIOD_KINDS) {
    const period = periodFor(kind, now);
    out.push(await signSnapshot({
      v: 1, profileId: me.profileId, displayName: me.displayName, publicKey: me.publicKey, period,
      generatedAt: now.getTime(), nonce: randomNonce(), ...buildStats(workouts, exercises, period)
    }, { alg: me.alg, privateKey }));
  }
  return out;
}

export { defaultPermissions, signText };
