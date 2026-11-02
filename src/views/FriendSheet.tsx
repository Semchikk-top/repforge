import { useEffect, useState } from 'react';
import { relayConfigured } from '../nearby/config';
import { platform } from '../platform';
import { formatCodeInput, normalizeCode } from '../nearby/code';
import { unlockAudio } from '../nearby/alert';
import { formatSas } from '../nearby/sdp';
import { useNow } from '../nearby/useRoom';
import { BUNDLE_ERROR_TEXT, makeBundleText, parseBundleText, type ParsedBundle } from '../social/bundle';
import { keyFingerprint } from '../social/crypto';
import { FRIEND_REASON_TEXT, type FriendLinkState } from '../social/friendlink';
import { useFriendLink, useProfile } from '../social/hooks';
import { friendLink, friendStore } from '../social/instance';
import { buildMySnapshots, getFriend, getProfile, saveSnapshots } from '../social/store';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';
import { formatClock } from '../lib';
import { download as exportDownload } from '../db/exporter';

/** Добавление друга и обновление рейтинга: по коду (живое соединение) или файлом. Дневник друзьям не передаётся. */
export function FriendSheet({ onClose }: { onClose: () => void }) {
  const s = useFriendLink();
  const profile = useProfile();
  return (
    <Sheet title="Друзья: обмен рейтингом" onClose={() => { if (s.phase === 'closed' || s.phase === 'done') friendLink.dismiss(); onClose(); }}>
      <div className="room">
        {profile === null && <p className="room-note">Сначала создайте профиль в «Профиль → Друзья»: он нужен, чтобы подписывать ваши итоги.</p>}
        {profile && s.phase === 'idle' && <Start />}
        {(s.phase === 'creating' || s.phase === 'joining' || s.phase === 'connecting' || s.phase === 'verifying') && <Busy s={s} />}
        {s.phase === 'waiting' && <Waiting s={s} />}
        {s.phase === 'confirm' && <Confirm s={s} />}
        {s.phase === 'syncing' && <p className="room-status">Обмениваемся итогами…</p>}
        {s.phase === 'done' && <Done s={s} onClose={onClose} />}
        {s.phase === 'closed' && <Closed s={s} />}
      </div>
    </Sheet>
  );
}

function Start() {
  const [code, setCode] = useState('');
  const toast = useToast();
  const live = relayConfigured();
  return (
    <>
      <p className="sub room-lead">Друг видит только итоги за период (нагрузку по упражнениям и кардио), подписанные вашим ключом. Тренировки, заметки, замеры тела, маршруты и ассистент не передаются.</p>
      <h3 className="room-h">По коду</h3>
      {!live && <p className="room-note">{platform.info.native ? 'Адрес релея не задан: укажи его в окне «Рядом» (комната по коду). Пока можно использовать обмен файлом ниже.' : 'В этой сборке не задан адрес релея: по коду добавить нельзя. Используйте обмен файлом ниже.'}</p>}
      <button className="btn primary block" disabled={!live} onClick={() => { unlockAudio(); void friendLink.invite(); }}>Создать приглашение</button>
      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="fr-code">Код от друга</label>
        <input id="fr-code" className="input room-code-input" autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="K7M4-P2QX" maxLength={9} value={code} onChange={(e) => setCode(formatCodeInput(e.target.value))} />
      </div>
      <button className="btn block" disabled={!live || !normalizeCode(code)} onClick={() => { void friendLink.join(code); toast('Подключаемся…'); }}>Подключиться</button>
      <p className="sub room-foot">Нужно, чтобы приложение было открыто у обоих. Без TURN-сервера связь устанавливается только в одной сети (хотспот, домашний Wi-Fi); иначе остаётся обмен файлом. Повторное соединение с уже добавленным другом обновляет его итоги без подтверждений.</p>
      <FileExchange />
    </>
  );
}

function Busy({ s }: { s: FriendLinkState }) {
  return (
    <>
      <p className="room-status">{s.phase === 'verifying' ? 'Проверяем личность друга…' : 'Соединяемся…'}</p>
      <button className="btn block ghost" onClick={() => friendLink.cancel()}>Отмена</button>
    </>
  );
}

function Waiting({ s }: { s: FriendLinkState }) {
  const toast = useToast();
  const now = useNow(true);
  const left = Math.max(0, Math.round(((s.expiresAt ?? now) - now) / 1000));
  return (
    <>
      <p className="sub">Назовите этот код другу: «Друзья» → «Подключиться».</p>
      <div className="room-code" aria-label={`Код приглашения ${s.code}`}>{s.code}</div>
      <p className="room-status">Ждём друга… код действует ещё {formatClock(left)}</p>
      <button className="btn block" onClick={async () => { try { await navigator.clipboard.writeText(s.code ?? ''); toast('Код скопирован'); } catch { toast('Не удалось скопировать'); } }}>Скопировать код</button>
      <button className="btn block ghost" style={{ marginTop: 8 }} onClick={() => friendLink.cancel()}>Отменить</button>
    </>
  );
}

function Confirm({ s }: { s: FriendLinkState }) {
  const [fp, setFp] = useState('');
  useEffect(() => { if (s.peer) void keyFingerprint(s.peer.publicKey).then(setFp); }, [s.peer]);
  return (
    <>
      <p className="room-status">Добавить в друзья <b>{s.peer?.displayName}</b>?</p>
      <div className="room-sas" aria-label={`Код сверки ${s.sas ?? ''}`}>{s.sas ? formatSas(s.sas) : '—'}</div>
      <p className="sub">Код сверки должен совпасть на обоих экранах. Если нет, нажмите «Отклонить»: канал могли подменить.</p>
      <p className="sub">Отпечаток ключа: <b>{fp || '…'}</b></p>
      <p className="sub">Друг получит только итоги за период. Позже это можно отключить или удалить его.</p>
      {s.iConfirmed
        ? <p className="room-status">Ждём подтверждения от друга…</p>
        : <button className="btn primary block" style={{ marginTop: 10 }} onClick={() => friendLink.confirm()}>Добавить в друзья</button>}
      <button className="btn danger ghost block" style={{ marginTop: 8 }} onClick={() => friendLink.decline()}>Отклонить</button>
    </>
  );
}

function Done({ s, onClose }: { s: FriendLinkState; onClose: () => void }) {
  const r = s.result;
  return (
    <>
      <p className="room-status" role="status">{r?.added ? `${s.peer?.displayName} добавлен(а) в друзья.` : `Итоги ${s.peer?.displayName ?? 'друга'} обновлены.`}</p>
      <p className="sub">{r && r.received > 0 ? `Получено снимков: ${r.received}.` : 'Снимков не получено: друг мог отключить обмен.'}{r && r.rejected > 0 ? ` Отклонено из-за неверной подписи или формата: ${r.rejected}.` : ''}</p>
      <button className="btn primary block" style={{ marginTop: 12 }} onClick={() => { friendLink.dismiss(); onClose(); }}>Готово</button>
    </>
  );
}

function Closed({ s }: { s: FriendLinkState }) {
  return (
    <>
      <p className="room-status" role="alert">{FRIEND_REASON_TEXT[s.reason ?? 'generic']}</p>
      <button className="btn primary block" style={{ marginTop: 12 }} onClick={() => friendLink.dismiss()}>Назад</button>
    </>
  );
}

const download = (name: string, text: string) => exportDownload(name, text, 'application/json');

/** Обмен без сети: подписанный файл со снимками. Показывается и без релея. */
function FileExchange() {
  const toast = useToast();
  const [text, setText] = useState('');
  const [pending, setPending] = useState<{ bundle: ParsedBundle; fp: string } | null>(null);
  const [error, setError] = useState('');

  const mine = async () => {
    const me = await getProfile();
    if (!me || !me.privateKey) { if (me) toast('Подпись заблокирована: введите пароль профиля на вкладке «Друзья»'); return null; }
    return makeBundleText({ profileId: me.profileId, publicKey: me.publicKey, displayName: me.displayName }, await buildMySnapshots());
  };

  const check = async (raw: string) => {
    setError(''); setPending(null);
    const first = await parseBundleText(raw, Date.now());
    if (!first.ok) { setError(BUNDLE_ERROR_TEXT[first.error]); return; }
    const known = await getFriend(first.bundle.card.profileId);
    if (known?.status === 'blocked') { setError('Этот человек в вашем списке блокировок.'); return; }
    if (known) {
      const pinned = await parseBundleText(raw, Date.now(), known.publicKey);
      if (!pinned.ok) { setError(BUNDLE_ERROR_TEXT[pinned.error]); return; }
      const n = await saveSnapshots(known.profileId, pinned.bundle.snapshots);
      await friendStore.touchFriend(known);
      toast(n > 0 ? `Итоги ${known.displayName} обновлены` : 'Это не новее того, что уже есть');
      setText('');
      return;
    }
    setPending({ bundle: first.bundle, fp: await keyFingerprint(first.bundle.card.publicKey) });
  };

  return (
    <>
      <h3 className="room-h">Файлом, без сети</h3>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn" style={{ flex: 1 }} onClick={async () => { const t = await mine(); if (t) { download(`итоги-${new Date().toISOString().slice(0, 10)}.json`, t); } }}>Мой снимок в файл</button>
        <button className="btn" style={{ flex: 1 }} onClick={async () => { const t = await mine(); if (!t) return; try { await navigator.clipboard.writeText(t); toast('Снимок скопирован'); } catch { toast('Не удалось скопировать'); } }}>Скопировать</button>
      </div>
      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="fr-paste">Снимок друга (вставьте текст или выберите файл)</label>
        <textarea id="fr-paste" className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder='{"type":"workout-pwa-friend-bundle", …' />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <label className="btn" style={{ flex: 1, textAlign: 'center' }}>Выбрать файл<input type="file" accept="application/json,.json" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f && f.size < 400_000) { const t = await f.text(); setText(t); await check(t); } else if (f) setError(BUNDLE_ERROR_TEXT['too-big']); }} /></label>
        <button className="btn primary" style={{ flex: 1 }} disabled={!text.trim()} onClick={() => void check(text)}>Проверить</button>
      </div>
      {error && <p className="room-note" role="alert" style={{ marginTop: 10 }}>{error}</p>}
      {pending && (
        <div className="room-presence" style={{ marginTop: 10 }}>
          <div className="who">{pending.bundle.card.displayName}</div>
          <div className="what">Новый человек. Отпечаток ключа: <b>{pending.fp}</b></div>
          <p className="sub">Подпись верна, но файл мог прислать кто угодно. Сверьте отпечаток с другом другим способом.</p>
          <button className="btn primary block" onClick={async () => {
            await friendStore.addFriend(pending.bundle.card);
            await saveSnapshots(pending.bundle.card.profileId, pending.bundle.snapshots);
            toast(`${pending.bundle.card.displayName} добавлен(а)`);
            setPending(null); setText('');
          }}>Добавить в друзья</button>
        </div>
      )}
    </>
  );
}
