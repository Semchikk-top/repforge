import { useRestTimer } from '../state/timer';
import { useCleanupGate } from '../state/cleanupGate';
import { describePresence } from '../nearby/presence';
import { REASON_TEXT, room } from '../nearby/room';
import { newMessages, useNow, useRoom } from '../nearby/useRoom';
import { useRoomUi } from '../nearby/RoomProvider';
import { IconClose, IconNearby } from './Icons';

/** Строка активной комнаты над навигацией: что делает друг, сколько новых сообщений. */
export function RoomBar() {
  const s = useRoom();
  const { openSheet, open } = useRoomUi();
  const timer = useRestTimer();
  const cleanup = useCleanupGate();
  const live = s.phase === 'active' && s.remote?.p.phase === 'resting';
  const now = useNow(live);
  if (s.phase === 'idle' || open) return null;

  const closed = s.phase === 'closed';
  const who = s.peerName || 'Друг';
  let text: string;
  let alert = false;
  if (closed) { text = s.reason === 'lost' ? 'связь потеряна' : s.reason === 'peer-left' ? 'друг вышел' : REASON_TEXT[s.reason ?? 'generic'].replace(/\.$/, '').toLowerCase().slice(0, 40); alert = true; }
  else if (s.phase === 'approval') { text = `${who} ждёт подтверждения`; alert = true; }
  else if (s.phase === 'awaiting') text = 'ждём подтверждения';
  else if (s.phase === 'waiting') text = `код ${s.code}`;
  else if (s.phase === 'active') {
    if (s.unread > 0) { text = newMessages(s.unread); alert = true; }
    else if (s.remote) {
      const d = describePresence(s.remote, now);
      text = s.remote.p.phase === 'resting' && !d.stale ? `${who} ${d.short}` : `${who}: ${d.short}`;
    }
    else text = `${who} на связи`;
  } else text = 'соединяемся…';

  return (
    <div className={'room-bar' + (timer.active || cleanup.gate ? ' with-timer' : '') + (alert ? ' alert' : '')} role="status">
      <button className="room-bar-main" onClick={openSheet} aria-label="Открыть комнату «Рядом»">
        <IconNearby size={20} />
        <span className="room-bar-text"><b>Рядом</b> · {text}</span>
      </button>
      {closed && <button className="icon-btn room-bar-x" onClick={() => room.dismiss()} aria-label="Скрыть"><IconClose size={18} /></button>}
    </div>
  );
}
