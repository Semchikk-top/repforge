import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { useSyncStatus } from './useSync';

export interface SyncBadge { text: string; warn: boolean; label: string }

/** Метка очереди синхронизации: число ожидающих изменений или «!» при проблеме. Без связи очередь не авария. */
export function useSyncBadge(): SyncBadge | null {
  const st = useSyncStatus();
  const pending = useLiveQuery(() => db.changes.where('synced').equals(0).count(), [], 0);
  const conflicts = useLiveQuery(() => db.conflicts.where('resolved').equals(0).count(), [], 0);
  const problem = (st.configured && st.unauthorized) || conflicts > 0;
  if (!((st.configured && pending > 0) || problem)) return null;
  return {
    text: conflicts > 0 ? '!' : pending > 99 ? '99+' : String(pending || '!'),
    warn: problem,
    label: conflicts > 0 ? 'Есть конфликты синхронизации' : problem ? 'Проблема с синхронизацией' : `Ожидает синхронизации: ${pending}`
  };
}
