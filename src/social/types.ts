import type { Alg, WrappedKey } from './crypto';
import type { LeaderboardSnapshot } from './snapshot';

export interface ProfileRow {
  id: 'me';
  profileId: string;
  displayName: string;
  alg: Alg;
  publicKey: string;
  /** Неэкспортируемый ключ: приложение умеет только подписывать им, прочитать его нельзя.
   *  Отсутствует, пока профиль пришёл синхронизацией и пароль профиля ещё не введён. */
  privateKey?: CryptoKey;
  /** Зашифрованный паролем слепок ключа (JWK под AES-GCM): ездит синхронизацией,
   *  без пароля серверу и чужим устройствам бесполезен. */
  wrapped?: WrappedKey;
  createdAt: number;
  updatedAt: number;
  deviceId: string;
  deletedAt?: number | null;
  /** 2 — мета-поля синхронизации; без них (старая схема) профиль нужно дописать при старте. */
  schema: 1 | 2;
}

export interface Friend {
  profileId: string;
  publicKey: string;
  displayName: string;
  status: 'accepted' | 'blocked';
  addedAt: number;
  lastSeenAt?: number;
  lastSnapshotAt?: number;
  /** Что МОЖНО видеть этому другу обо мне. */
  permissions: { leaderboard: boolean; workoutDetails: boolean };
}

export interface PeerSnapshotRow {
  id: string; // profileId|from|to
  profileId: string;
  snapshot: LeaderboardSnapshot;
  receivedAt: number;
}

export const defaultPermissions = (): Friend['permissions'] => ({ leaderboard: true, workoutDetails: false });
