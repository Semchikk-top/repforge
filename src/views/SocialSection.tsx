import { useEffect, useState } from 'react';
import { keyFingerprint } from '../social/crypto';
import { useFriends, useProfile } from '../social/hooks';
import { blockFriend, deleteProfile, ensureProfile, ensureProfileMeta, removeFriend, renameProfile, setPermissions, unlockProfile } from '../social/store';
import { db } from '../db/db';
import { go } from '../state/router';
import { Toggle } from '../ui/Toggle';
import { useToast } from '../ui/Toast';
import { FriendSheet } from './FriendSheet';

const dateOf = (ms?: number) => (ms ? new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : 'нет');

/** Профиль → Друзья. Профиль синхронизируется между своими устройствами:
 *  ключ подписи — только в шифрованном паролем слепке, расшифровать его может
 *  устройство, на котором ввели тот же пароль. */
export function SocialSection() {
  const profile = useProfile();
  const friends = useFriends();
  const toast = useToast();
  const [name, setName] = useState('');
  const [pass, setPass] = useState('');
  const [unlockPass, setUnlockPass] = useState('');
  const [adding, setAdding] = useState(false);
  const [fp, setFp] = useState('');
  const [sure, setSure] = useState<string | null>(null);

  useEffect(() => { void ensureProfileMeta(); }, []);
  // синхронизация имени с профилем: при правке имени с другого устройства
  // profileId не меняется, а updatedAt — да (по нему и ловим обновление)
  useEffect(() => { if (profile) { setName(profile.displayName); void keyFingerprint(profile.publicKey).then(setFp); } }, [profile?.profileId, profile?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const accepted = friends.filter((f) => f.status === 'accepted');
  const blocked = friends.filter((f) => f.status === 'blocked');
  const keyState = !profile ? 'none' : profile.privateKey ? 'here' : profile.wrapped ? 'locked' : 'unportable';

  return (
    <div className="section">
      <h2>Профиль и друзья</h2>
      <p className="sub">Друзья видят только итоги за период, подписанные вашим ключом. Тренировки, заметки, замеры, маршруты и ассистент им недоступны.</p>

      {profile === undefined ? null : profile === null ? (
        <>
          <div className="field">
            <label htmlFor="pf-name">Имя для друзей</label>
            <input id="pf-name" className="input" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} placeholder="Как вас показывать" />
          </div>
          <div className="field">
            <label htmlFor="pf-pass">Пароль профиля (необязательно)</label>
            <input id="pf-pass" className="input" type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="Чтобы переносить профиль на другие устройства" />
            <span className="sub">С паролем профиль синхронизируется на подключённые устройства в зашифрованном виде: там вводится тот же пароль, и подпись работает. Без пароля ключ остаётся только в этом браузере. Пароль не восстанавливается: забыли — на новом устройстве придётся создать профиль заново.</span>
          </div>
          <button className="btn primary block" disabled={!name.trim()} onClick={async () => { try { await ensureProfile(name, pass); setPass(''); toast('Профиль создан'); } catch { toast('Браузер не поддерживает подписи'); } }}>Создать профиль</button>
          <p className="sub">Будет создан ключ подписи. Он не покидает устройства в открытом виде: по сети и в базе сервера ходит только слепок, зашифрованный паролем. Если очистить данные браузера, это будет уже новая личность: друзей придётся добавить заново.</p>
        </>
      ) : (
        <>
          <div className="field">
            <label htmlFor="pf-name">Имя для друзей</label>
            <input id="pf-name" className="input" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void renameProfile(name)} />
          </div>
          <p className="sub">Отпечаток ключа: <b>{fp || '…'}</b> ({profile.alg === 'ed25519' ? 'Ed25519' : 'ECDSA P-256'}). Его можно показать другу для сверки.</p>

          {keyState === 'locked' && (
            <div className="field" style={{ marginTop: 10 }}>
              <label htmlFor="pf-unlock">Профиль пришёл с другого устройства: введите его пароль, чтобы подписывать итоги и добавлять друзей здесь</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input id="pf-unlock" className="input" type="password" autoComplete="current-password" value={unlockPass} onChange={(e) => setUnlockPass(e.target.value)} />
                <button className="btn" onClick={async () => { if (await unlockProfile(unlockPass)) { setUnlockPass(''); toast('Подпись разблокирована'); } else toast('Неверный пароль'); }}>Разблокировать</button>
              </div>
            </div>
          )}
          {keyState === 'here' && profile.wrapped && <p className="sub">Профиль переносится на подключённые устройства в зашифрованном паролем виде; на каждом вводится тот же пароль.</p>}
          {keyState === 'here' && !profile.wrapped && <p className="sub">Этот профиль создан без пароля: ключ подписи остаётся только в этом браузере и на другие устройства не переносится.</p>}
          {keyState === 'unportable' && <p className="sub">Профиль создан до появления переноса и был без пароля: имя и личность синхронизируются, но ключ подписи остаётся только здесь. Чтобы подписывать на всех устройствах, создайте профиль заново с паролем (друзья увидят смену ключа и потребуют повторного подтверждения).</p>}

          <div className="list" style={{ marginTop: 12 }}>
            {accepted.length === 0 && <p className="sub">Друзей пока нет.</p>}
            {accepted.map((f) => (
              <div key={f.profileId} className="row" style={{ flexWrap: 'wrap' }}>
                <div className="grow">
                  <div className="title">{f.displayName}</div>
                  <div className="meta">итоги от {dateOf(f.lastSnapshotAt)}</div>
                </div>
                <label className="meta" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>В рейтинге<Toggle label={`${f.displayName}: участвует в рейтинге`} checked={f.permissions.leaderboard} onChange={(v) => void setPermissions(f.profileId, { leaderboard: v })} /></label>
                <div style={{ display: 'flex', gap: 8, width: '100%', marginTop: 8 }}>
                  <button className="btn small ghost" onClick={async () => { await blockFriend(f.profileId); toast('Заблокирован, его снимки удалены'); }}>Заблокировать</button>
                  {sure === f.profileId
                    ? <button className="btn small danger" onClick={async () => { await removeFriend(f.profileId); setSure(null); toast('Удалён вместе со снимками'); }}>Точно удалить</button>
                    : <button className="btn small ghost" onClick={() => setSure(f.profileId)}>Удалить</button>}
                </div>
              </div>
            ))}
          </div>

          <button className="btn block" style={{ marginTop: 10 }} onClick={() => setAdding(true)}>Добавить друга или обновить итоги</button>
          <button className="btn block ghost" style={{ marginTop: 8 }} onClick={() => go('ratings')}>Открыть рейтинги</button>
          {sure === 'profile'
            ? <button className="btn block danger" style={{ marginTop: 8 }} onClick={async () => { await deleteProfile(); setSure(null); toast('Профиль удалён'); }}>Точно удалить профиль и всех друзей</button>
            : <button className="btn block ghost" style={{ marginTop: 8, color: 'var(--danger, #d33)' }} onClick={() => setSure('profile')}>Удалить профиль</button>}
          {adding && <FriendSheet onClose={() => setAdding(false)} />}

          {blocked.length > 0 && (
            <>
              <h3 className="room-h">Заблокированные</h3>
              {blocked.map((f) => (
                <div key={f.profileId} className="row">
                  <div className="grow title">{f.displayName}</div>
                  <button className="btn small ghost" onClick={() => void db.friends.delete(f.profileId)}>Разблокировать</button>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
