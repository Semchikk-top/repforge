import { useEffect, useRef, useState, type FormEvent } from 'react';
import { formatClock } from '../lib';
import { useRestTimer } from '../state/timer';
import { Sheet } from '../ui/Sheet';
import { Toggle } from '../ui/Toggle';
import { useToast } from '../ui/Toast';
import { unlockAudio } from '../nearby/alert';
import { formatCodeInput, normalizeCode } from '../nearby/code';
import { relayConfigured } from '../nearby/config';
import { MAX_NAME, MAX_TEXT, QUICK_PHRASES } from '../nearby/messages';
import { describePresence } from '../nearby/presence';
import { REASON_TEXT, room, type ChatMessage, type RoomState } from '../nearby/room';
import { formatSas } from '../nearby/sdp';
import { useNow, useRoom } from '../nearby/useRoom';

const NAME_KEY = 'nearby-name-v1'; // только на этом устройстве: не в базе и не в синхронизации
const loadName = () => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } };
const saveName = (v: string) => { try { localStorage.setItem(NAME_KEY, v); } catch { /* приватный режим */ } };

const webrtcOk = () => typeof RTCPeerConnection !== 'undefined';

export function RoomSheet({ onClose }: { onClose: () => void }) {
  const s = useRoom();
  return (
    <Sheet title="Рядом" onClose={onClose}>
      <div className="room">
        {s.phase === 'idle' && <Start />}
        {(s.phase === 'creating' || s.phase === 'joining') && <Busy text="Связываемся с релеем…" />}
        {s.phase === 'waiting' && <Waiting s={s} />}
        {s.phase === 'connecting' && <Busy text={s.peerName ? `Соединяемся с ${s.peerName}…` : 'Соединяемся…'} />}
        {s.phase === 'approval' && <Approval s={s} />}
        {s.phase === 'awaiting' && <Awaiting s={s} />}
        {s.phase === 'active' && <Chat s={s} />}
        {s.phase === 'closed' && <Closed s={s} />}
      </div>
    </Sheet>
  );
}

function Start() {
  const toast = useToast();
  const [name, setName] = useState(loadName);
  const [code, setCode] = useState('');
  const [share, setShare] = useState(true);
  const ready = relayConfigured() && webrtcOk();

  const go = (fn: () => void) => { unlockAudio(); saveName(name.trim()); fn(); };

  return (
    <>
      <p className="sub room-lead">Связь с другом по залу: «ты где», «подстрахуй», что он делает сейчас. Сообщения идут напрямую между телефонами, не проходят через сервер и не попадают в дневник.</p>
      {!relayConfigured() && <p className="room-note">В этой сборке не задан адрес релея (VITE_ROOM_RELAY_URL), поэтому комнату по коду создать нельзя.</p>}
      {relayConfigured() && !webrtcOk() && <p className="room-note">{REASON_TEXT.unsupported}</p>}

      <div className="field">
        <label htmlFor="room-name">Твоё имя для друга</label>
        <input id="room-name" className="input" maxLength={MAX_NAME} placeholder="Как тебя зовут" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </div>

      <h3 className="room-h">Создать комнату</h3>
      <div className="row"><div className="grow">Показывать, что я делаю<div className="meta">Упражнение, подход и отдых. Вес и повторы не передаются.</div></div><Toggle label="Показывать, что я делаю" checked={share} onChange={setShare} /></div>
      <button className="btn primary block" disabled={!ready} onClick={() => go(() => room.createRoom(name, share))} style={{ marginTop: 10 }}>Создать комнату</button>

      <h3 className="room-h">Присоединиться</h3>
      <div className="field">
        <label htmlFor="room-code">Код от друга</label>
        <input id="room-code" className="input room-code-input" inputMode="text" autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false}
          placeholder="K7M4-P2QX" maxLength={9} value={code} onChange={(e) => setCode(formatCodeInput(e.target.value))} />
      </div>
      <button className="btn block" disabled={!ready || !normalizeCode(code)} onClick={() => go(() => { room.joinRoom(code, name, share); toast('Подключаемся…'); })}>Присоединиться</button>

      <p className="sub room-foot">Интернет нужен только на несколько секунд, пока телефоны находят друг друга. Дальше связь идёт напрямую: оба телефона должны быть в одной сети (хотспот), VPN на это время лучше выключить. Если приложение закрыть или заблокировать экран, комната закроется.</p>
    </>
  );
}

function Busy({ text }: { text: string }) {
  return (
    <>
      <p className="room-status">{text}</p>
      <button className="btn block ghost" onClick={() => room.leave()}>Отмена</button>
    </>
  );
}

function Waiting({ s }: { s: RoomState }) {
  const toast = useToast();
  const now = useNow(true);
  const left = Math.max(0, Math.round(((s.expiresAt ?? now) - now) / 1000));
  const copy = async () => {
    try { await navigator.clipboard.writeText(s.code ?? ''); toast('Код скопирован'); } catch { toast('Не удалось скопировать'); }
  };
  return (
    <>
      <p className="sub">Назовите этот код другу: «Рядом» → «Присоединиться».</p>
      <div className="room-code" aria-label={`Код комнаты ${s.code}`}>{s.code}</div>
      <p className="room-status">Ждём друга… код действует ещё {formatClock(left)}</p>
      <button className="btn block" onClick={copy}>Скопировать код</button>
      <button className="btn block ghost" style={{ marginTop: 8 }} onClick={() => room.leave()}>Отменить</button>
    </>
  );
}

function Sas({ sas }: { sas: string | null }) {
  return <div className="room-sas" aria-label={`Код сверки ${sas ?? ''}`}>{sas ? formatSas(sas) : '—'}</div>;
}

function Approval({ s }: { s: RoomState }) {
  return (
    <>
      <p className="room-status"><b>{s.peerName || 'Друг'}</b> хочет присоединиться.</p>
      <Sas sas={s.sas} />
      <p className="sub">Сверьте код с экраном друга. Если коды не совпадают, нажмите «Отклонить»: связь могли подменить.</p>
      <button className="btn primary block" style={{ marginTop: 14 }} onClick={() => room.approve()}>Разрешить</button>
      <button className="btn danger ghost block" style={{ marginTop: 8 }} onClick={() => room.reject()}>Отклонить</button>
    </>
  );
}

function Awaiting({ s }: { s: RoomState }) {
  return (
    <>
      <p className="room-status">Ожидаем подтверждения от <b>{s.peerName || 'хоста'}</b>.</p>
      <Sas sas={s.sas} />
      <p className="sub">Этот код должен совпасть с тем, что на экране у друга.</p>
      <button className="btn block ghost" style={{ marginTop: 14 }} onClick={() => room.leave()}>Выйти</button>
    </>
  );
}

function Closed({ s }: { s: RoomState }) {
  const reason = s.reason ?? 'generic';
  const again = reason === 'lost' || reason === 'peer-left' || reason === 'expired' || reason === 'rejected' || reason === 'timeout';
  return (
    <>
      <p className="room-status" role="alert">{REASON_TEXT[reason]}</p>
      {s.messages.length > 0 && <Log messages={s.messages} peerName={s.peerName} />}
      <button className="btn primary block" style={{ marginTop: 14 }} onClick={() => room.dismiss()}>{again ? 'Создать комнату заново' : 'Попробовать снова'}</button>
    </>
  );
}

function Log({ messages, peerName }: { messages: ChatMessage[]; peerName: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [messages.length]);
  return (
    <div className="room-log" ref={ref} role="log" aria-live="polite">
      {messages.length === 0 && <p className="sub room-empty">Пока тихо. Напишите «Я здесь» или позовите друга.</p>}
      {messages.map((m) => m.kind === 'call'
        ? <div key={m.id} className="bubble sys">{m.from === 'me' ? 'Вы позвали' : `${peerName || 'Друг'} зовёт вас`}</div>
        : <div key={m.id} className={'bubble ' + m.from}>{m.text}</div>)}
    </div>
  );
}

function Chat({ s }: { s: RoomState }) {
  const timer = useRestTimer();
  const [text, setText] = useState('');
  const [calling, setCalling] = useState(false);
  const toast = useToast();
  const hasRest = s.remote?.p.phase === 'resting';
  const now = useNow(!!hasRest);
  const d = s.remote ? describePresence(s.remote, now) : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (room.sendChat(text)) setText('');
  };
  const call = () => {
    if (room.call()) { setCalling(true); window.setTimeout(() => setCalling(false), 5000); }
    else toast('Подождите пару секунд перед повторным вызовом');
  };

  return (
    <>
      <div className={'room-presence' + (d?.stale ? ' stale' : '')}>
        <div className="who">{s.peerName || 'Друг'}</div>
        <div className="what">{d ? d.text : 'пока не прислал, что делает'}{d?.stale ? ' · давно не обновлялось' : ''}</div>
      </div>
      {timer.active && <div className="sub room-own-rest">Твой отдых: {formatClock(timer.remainingSec)}{timer.paused ? ' (пауза)' : ''}</div>}

      <div className="chips wrap room-quick" role="group" aria-label="Быстрые фразы">
        {QUICK_PHRASES.map((q) => <button key={q.id} className="chip" onClick={() => room.sendQuick(q.id)}>{q.text}</button>)}
      </div>
      <button className="btn block room-call" onClick={call} disabled={calling}>{calling ? 'Позвали…' : 'Позвать'}</button>

      <Log messages={s.messages} peerName={s.peerName} />

      <form className="room-compose" onSubmit={submit}>
        <input className="input" aria-label="Сообщение" maxLength={MAX_TEXT} placeholder="Сообщение" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" enterKeyHint="send" />
        <button className="btn primary" type="submit" disabled={!text.trim()}>Отправить</button>
      </form>

      <div className="row"><div className="grow">Показывать, что я делаю</div><Toggle label="Показывать, что я делаю" checked={s.sharePresence} onChange={(v) => room.setSharePresence(v)} /></div>
      <button className="btn danger ghost block" onClick={() => room.leave()}>Выйти из комнаты</button>
    </>
  );
}
