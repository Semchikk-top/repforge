import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../sync/sync';
import { createInvite, KIND_LABEL, qrDataUrl, type Invite } from '../sync/pairing';
import { IconCheck } from '../ui/Icons';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

async function deviceIds(): Promise<Map<string, string>> {
  try {
    const r = await apiFetch('/api/devices');
    const list = (await r.json()) as { id: string; name: string; revoked: number }[];
    return new Map(list.filter((d) => !d.revoked).map((d) => [d.id, d.name]));
  } catch {
    return new Map();
  }
}

export function InviteSheet({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [invite, setInvite] = useState<Invite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [joined, setJoined] = useState<string | null>(null);
  const known = useRef<Map<string, string> | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const inv = await createInvite();
      setInvite(inv);
      setSel(inv.best ?? 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось создать приглашение');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  // ждём, пока в списке устройств появится новое, и сообщаем об успехе
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const cur = await deviceIds();
      if (!alive) return;
      if (!known.current) { known.current = cur; return; }
      for (const [id, name] of cur) if (!known.current.has(id)) { setJoined(name); return; }
    };
    void tick();
    const t = setInterval(() => void tick(), 2000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const left = invite ? Math.max(0, Math.round((invite.expiresAt * 1000 - now) / 1000)) : 0;
  useEffect(() => { if (invite && left === 0 && !joined) void load(); }, [invite, left, joined, load]);

  const cand = invite?.candidates[sel];
  const usable = invite?.candidates.filter((c) => c.reachable) ?? [];

  const copy = async () => {
    if (!cand) return;
    try { await navigator.clipboard.writeText(cand.link); toast('Ссылка скопирована'); }
    catch { toast('Выдели ссылку и скопируй вручную'); }
  };

  return (
    <Sheet title="Подключить телефон рядом" onClose={onClose}>
      {joined ? (
        <div className="invite-done">
          <div className="invite-check"><IconCheck size={32} /></div>
          <h2>Подключено</h2>
          <p className="sub">{joined}</p>
          <button className="btn primary block" style={{ marginTop: 16 }} onClick={onClose}>Готово</button>
        </div>
      ) : error ? (
        <>
          <p className="msg-error" role="alert">{error}</p>
          <button className="btn block" style={{ marginTop: 12 }} onClick={() => void load()}>Повторить</button>
        </>
      ) : !invite ? (
        <p className="empty">Готовлю код…</p>
      ) : (
        <>
          {cand && cand.reachable && cand.qr ? (
            <>
              <p className="sub" style={{ marginBottom: 12 }}>Наведи камеру телефона на код и открой ссылку. Дальше приложение подключится само.</p>
              <div className="qr-box"><img src={qrDataUrl(cand.qr)} alt="QR-код для подключения" /></div>
              {usable.length > 1 && (
                <div className="chips" style={{ marginTop: 12, justifyContent: 'center' }} role="group" aria-label="Адрес сервера">
                  {invite.candidates.map((c, i) => c.reachable && (
                    <button key={c.url} className={'chip' + (i === sel ? ' on' : '')} onClick={() => setSel(i)}>{KIND_LABEL[c.kind]}</button>
                  ))}
                </div>
              )}
              {!cand.secure && (
                <p className="notice" style={{ marginTop: 12 }}>Это адрес по HTTP. Подключиться можно, но установить приложение на телефон и пользоваться таймером в фоне не получится: для этого нужен HTTPS (Tailscale, см. README).</p>
              )}
              <div className="linkrow">
                <input className="input" readOnly value={cand.link} aria-label="Ссылка для подключения" onFocus={(e) => e.target.select()} />
                <button className="btn small" onClick={() => void copy()}>Копировать</button>
              </div>
            </>
          ) : (
            <p className="msg-error" role="alert">
              Не нашёл адрес, по которому телефон сможет достучаться до сервера. Включи Tailscale и выполни на ПК <code>sudo tailscale serve --bg 8000</code>,
              либо запусти сервер с <code>--host 0.0.0.0</code> для локальной сети.
            </p>
          )}
          <div className="invite-code">
            <div>
              <div className="sub">Код для ручного ввода</div>
              <div className="code-text">{invite.code.slice(0, 4)}-{invite.code.slice(4)}</div>
            </div>
            <div className="sub" style={{ textAlign: 'right' }}>Действует<br />{mmss(left)}</div>
          </div>
          <button className="btn ghost block" style={{ marginTop: 8 }} onClick={() => void load()}>Новый код</button>
        </>
      )}
    </Sheet>
  );
}
