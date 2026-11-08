import { useState } from 'react';
import { go } from '../state/router';
import { useSyncStatus } from '../sync/useSync';
import { clockProblem, formatSkew } from '../sync/clock';
import { msgServerOlder, serverOlderThanClient } from '../sync/protocol';

const CLIENT_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

/** Плашка о проблемах, которые молча портят данные или останавливают синхронизацию: несовместимые версии и сбитые часы. */
export function SyncNotice() {
  const st = useSyncStatus();
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  if (!st.configured || st.unauthorized) return null;

  const cp = clockProblem(st.clock);
  const older = !st.incompat && serverOlderThanClient(st.server?.version, CLIENT_VERSION);
  const key = st.incompat ? 'incompat:' + st.incompat : older ? 'server-older:' + st.server?.version : cp ? 'clock' : '';
  if (!key || hidden[key]) return null;
  const text = st.incompat
    ? (st.error ?? 'Версии приложения и сервера несовместимы')
    : older
    ? msgServerOlder(st.server!.version!, CLIENT_VERSION)
    : `Часы ${cp!.ahead ? 'спешат' : 'отстают'} на ${formatSkew(cp!.offsetMs)} относительно сервера: правки с разных устройств могут перезаписывать друг друга.`;
  return (
    <div className="reminder" role="alert">
      <span>{text}</span>
      <button className="btn small primary" onClick={() => go('settings')}>Подробнее</button>
      <button className="btn small ghost" onClick={() => setHidden((h) => ({ ...h, [key]: true }))}>Скрыть</button>
    </div>
  );
}
