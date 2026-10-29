import { useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { friendLink } from './instance';
import type { Friend, PeerSnapshotRow, ProfileRow } from './types';

export const useFriendLink = () => useSyncExternalStore(friendLink.subscribe, friendLink.getState, friendLink.getState);

/** undefined — ещё грузится, null — профиля нет. */
export const useProfile = (): ProfileRow | null | undefined => useLiveQuery(async () => (await db.profile.get('me')) ?? null, [], undefined);
export const useFriends = (): Friend[] => useLiveQuery(() => db.friends.toArray(), [], [] as Friend[]);
export const usePeerSnapshots = (): PeerSnapshotRow[] => useLiveQuery(() => db.peerSnapshots.toArray(), [], [] as PeerSnapshotRow[]);
