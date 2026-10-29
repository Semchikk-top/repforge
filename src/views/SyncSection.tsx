import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { apiFetch, pairWithCode, syncNow, unpair } from '../sync/sync';
import { useSyncStatus } from '../sync/useSync';
import { useToast } from '../ui/Toast';
import { requestPairing } from '../sync/pairing';
import { InviteSheet } from './InviteSheet';

interface Dev { id: string; name: string; last_seen: number | null; revoked: number; current: boolean }

const fmt = (ms: number) => new Date(ms).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function SyncSection() {
  const st = useSyncStatus();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<Dev[]>([]);
  const [invite, setInvite] = useState(false);
  const [waitPin, setWaitPin] = useState<string | null>(null);
  const reqCtl = useRef<AbortController | null>(null);
  const pending = useLiveQuery(() => db.changes.where('synced').equals(0).count(), [], 0);
  const deviceId = useLiveQuery(async () => ((await db.kv.get('deviceId'))?.value as string | undefined) ?? '', [], '');

  const loadDevices = useCallback(async () => {
    try {
      const r = await apiFetch('/api/devices');
      if (r.ok) setDevices(await r.json());
    } catch { /* офлайн: список не обязателен */ }
  }, []);

  useEffect(() => { if (st.configured && !st.unauthorized) void loadDevices(); }, [st.configured, st.unauthorized, st.lastAt, loadDevices]);

  const connect = async () => {
    setBusy(true);
    try {
      await pairWithCode(code.trim());
      setCode('');
      toast('Устройство подключено');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Не удалось подключиться');
    } finally { setBusy(false); }
  };

  // телефон просит подключиться: PIN сверяется на ПК, дальше всё происходит само
  const ask = async () => {
    const ctl = new AbortController();
    reqCtl.current = ctl;
    try {
      await requestPairing({ signal: ctl.signal, onPin: setWaitPin });
      toast('Устройство подключено');
    } catch (e) {
      if ((e as Error).name !== 'AbortError') toast(e instanceof Error ? e.message : 'Не удалось подключиться');
    } finally {
      setWaitPin(null);
      reqCtl.current = null;
    }
  };

  const disconnect = async () => {
    if (!confirm('Отключить это устройство от сервера? Данные на устройстве останутся.')) return;
    await unpair();
    setDevices([]);
    toast('Устройство отключено');
  };

  const revoke = async (d: Dev) => {
    if (!confirm(`Отозвать доступ у «${d.name}»?`)) return;
    await apiFetch(`/api/devices/${d.id}`, { method: 'DELETE' });
    void loadDevices();
  };

  if (!st.configured) {
    return (
      <div className="section">
        <h2>Синхронизация</h2>
        <p className="sub">Подключи телефон к серверу на ПК. На ПК выполни <code>python -m server pair --url …</code>, там будет код и QR. Либо открой ссылку из QR на телефоне, и всё подключится само.</p>
        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="pair-code">Код подключения</label>
          <input id="pair-code" className="input" value={code} autoCapitalize="characters" autoComplete="off" placeholder="XXXX-XXXX" onChange={(e) => setCode(e.target.value)} />
        </div>
        <button className="btn primary block" disabled={busy || code.trim().length < 4} onClick={connect}>{busy ? 'Подключаю…' : 'Подключить'}</button>
        <div className="or"><span>или</span></div>
        {waitPin ? (
          <div className="pin-wait" role="status">
            <div className="sub">Подтверди на ПК, там должен появиться такой же код</div>
            <div className="pin">{waitPin}</div>
            <button className="btn ghost block" onClick={() => reqCtl.current?.abort()}>Отмена</button>
          </div>
        ) : (
          <>
            <button className="btn block" onClick={() => void ask()}>Запросить подключение к ПК</button>
            <p className="sub" style={{ marginTop: 6 }}>Работает, если приложение открыто по адресу сервера. Подтвердить нужно на устройстве, которое уже подключено.</p>
          </>
        )}
        <div className="row"><div className="grow">Идентификатор устройства</div><span className="sub">{deviceId.slice(0, 8)}</span></div>
      </div>
    );
  }

  return (
    <div className="section">
      <h2>Синхронизация</h2>
      <div className="row">
        <div className="grow">
          <div>{st.syncing ? 'Синхронизирую…' : st.error ? 'Не синхронизировано' : 'Синхронизировано'}</div>
          <div className="meta" style={st.error ? { color: 'var(--danger)' } : undefined}>
            {st.error ?? (st.lastAt ? `Последний раз: ${fmt(st.lastAt)}` : 'Ещё не было')}
          </div>
        </div>
        <button className="btn small" disabled={st.syncing || st.unauthorized} onClick={() => void syncNow()}>Сейчас</button>
      </div>
      <div className="row"><div className="grow">Изменений в очереди</div><span>{pending}</span></div>
      <button className="btn primary block" style={{ marginTop: 12 }} onClick={() => setInvite(true)} disabled={st.unauthorized}>Подключить телефон рядом</button>

      {devices.length > 0 && (
        <>
          <h2 style={{ marginTop: 16, fontSize: 18 }}>Устройства</h2>
          {devices.map((d) => (
            <div key={d.id} className="row">
              <div className="grow">
                <div>{d.name}{d.current ? ' (это устройство)' : ''}</div>
                <div className="meta">{d.revoked ? 'Отозвано' : d.last_seen ? `Был: ${fmt(d.last_seen * 1000)}` : 'Не заходило'}</div>
              </div>
              {!d.current && !d.revoked && <button className="btn small danger" onClick={() => revoke(d)}>Отозвать</button>}
            </div>
          ))}
        </>
      )}

      {st.unauthorized ? (
        <>
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="pair-code2">Новый код подключения</label>
            <input id="pair-code2" className="input" value={code} autoCapitalize="characters" autoComplete="off" onChange={(e) => setCode(e.target.value)} />
          </div>
          <button className="btn primary block" disabled={busy || code.trim().length < 4} onClick={connect}>Подключить заново</button>
        </>
      ) : null}
      <button className="btn danger ghost block" style={{ marginTop: 10 }} onClick={disconnect}>Отключить это устройство</button>
      {invite && <InviteSheet onClose={() => setInvite(false)} />}
    </div>
  );
}
