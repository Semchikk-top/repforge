import { useState } from 'react';
import { go } from '../state/router';
import { useSyncStatus } from '../sync/useSync';
import { clockProblem, formatSkew } from '../sync/clock';

/** Плашка о проблемах, которые молча портят данные или останавливают синхронизацию: несовместимые версии и сбитые часы. */
export function SyncNotice() {
  const st = useSyncStatus();
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  if (!st.configured || st.unauthorized) return null;

  const cp = clockProblem(st.clock);
  const key = st.incompat ? 'incompat:' + st.incompat : cp ? 'clock' : '';
  if (!key || hidden[key]) return null;
  const text = st.incompat
    ? (st.error ?? 'Версии приложения и сервера несовместимы')
    : `Часы ${cp!.ahead ? 'спешат' : 'отстают'} на ${formatSkew(cp!.offsetMs)} относительно сервера: правки с разных устройств могут перезаписывать друг друга.`;
  return (
    <div className="reminder" role="alert">
      <span>{text}</span>
      <button className="btn small primary" onClick={() => go('settings')}>Подробнее</button>
      <button className="btn small ghost" onClick={() => setHidden((h) => ({ ...h, [key]: true }))}>Скрыть</button>
    </div>
  );
}
