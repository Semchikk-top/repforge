import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { restoreRow } from '../db/repo';
import type { ConflictRecord } from '../domain/types';
import { useToast } from '../ui/Toast';

const when = (ms: number) => new Date(ms).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Правки, которые перезаписали с другого устройства: можно вернуть свою версию или оставить чужую */
export function ConflictsCard() {
  const toast = useToast();
  const list = useLiveQuery(() => db.conflicts.where('resolved').equals(0).reverse().sortBy('at'), [], [] as ConflictRecord[]);
  if (list.length === 0) return null;

  const restore = async (c: ConflictRecord) => {
    await restoreRow(c.table, c.local as Record<string, unknown> & { id: string });
    await db.conflicts.update(c.id!, { resolved: 1 });
    toast('Твоя версия возвращена и уйдёт на другие устройства');
  };
  const keep = async (c: ConflictRecord) => { await db.conflicts.update(c.id!, { resolved: 1 }); };

  return (
    <div className="section" role="region" aria-label="Конфликты синхронизации">
      <h2>Конфликты синхронизации ({list.length})</h2>
      <p className="sub">Эти записи ты менял на этом устройстве, а потом их перезаписала более поздняя правка с другого. Раньше твоя версия просто пропадала; теперь ты решаешь, какую оставить.</p>
      <div className="list">
        {list.map((c) => (
          <div key={c.id} className="row" style={{ alignItems: 'flex-start' }}>
            <div className="grow">
              <div className="title">{c.label}</div>
              <div className="meta">твоя правка: {when(c.localUpdatedAt)} · перезаписана: {when(c.remoteUpdatedAt)}</div>
              <div className="conn-actions" style={{ justifyContent: 'flex-start' }}>
                <button className="btn small primary" onClick={() => void restore(c)}>Вернуть мою</button>
                <button className="btn small" onClick={() => void keep(c)}>Оставить чужую</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
