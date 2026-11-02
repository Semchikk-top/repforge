// Рабочие экземпляры: хранилище на Dexie, транспорт WebRTC + релей. Живёт вне React.
import { FRIEND_ICE_SERVERS, getRelayUrl } from '../nearby/config';
import { createPeerLink } from '../nearby/peer';
import { connectSignaling } from '../nearby/signaling';
import { signText } from './crypto';
import { FriendLink, type FriendStoreApi } from './friendlink';
import { buildMySnapshots, getFriend, getProfile, putFriend, saveSnapshots } from './store';
import { defaultPermissions } from './types';

export const friendStore: FriendStoreApi = {
  async identity() {
    const me = await getProfile();
    if (!me?.privateKey) return null; // без ключа подписывать нельзя: для протокола друзей профиля «как бы нет»
    const privateKey = me.privateKey;
    return { profileId: me.profileId, publicKey: me.publicKey, displayName: me.displayName, sign: (t: string) => signText({ alg: me.alg, privateKey }, t) };
  },
  getFriend,
  async addFriend(card) {
    await putFriend({ profileId: card.profileId, publicKey: card.publicKey, displayName: card.displayName, status: 'accepted', addedAt: Date.now(), permissions: defaultPermissions() });
  },
  async touchFriend(card) {
    const f = await getFriend(card.profileId);
    if (f) await putFriend({ ...f, displayName: card.displayName, lastSeenAt: Date.now() });
  },
  mySnapshots: () => buildMySnapshots(),
  saveSnapshots: (id, snaps) => saveSnapshots(id, snaps)
};

export const friendLink = new FriendLink({
  signaling: connectSignaling,
  peer: createPeerLink,
  // STUN/TURN включаются только явной настройкой сборки; тогда допускаются и публичные адреса
  peerOptions: FRIEND_ICE_SERVERS.length ? { iceServers: [{ urls: FRIEND_ICE_SERVERS }], allowPublic: true } : undefined,
  get relayUrl() { return getRelayUrl(); },
  store: friendStore,
  now: () => Date.now()
});
