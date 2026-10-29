import { useCallback, useEffect, useRef, useState } from 'react';
import { decidePending, fetchPending, type PendingRequest } from '../sync/pairing';
import { useSyncStatus } from '../sync/useSync';
import { Sheet } from './Sheet';
import { useToast } from './Toast';

// Всплывает на подключённом устройстве, когда другое просит подключиться.
export function PairingApproval() {
  const st = useSyncStatus();
  const toast = useToast();
  const [list, setList] = useState<PendingRequest[]>([]);
  const dismissed = useRef(new Set<string>());
  const active = st.configured && !st.unauthorized;

  const poll = useCallback(async () => {
    if (document.visibilityState !== 'visible') return;
    setList((await fetchPending()).filter((r) => !dismissed.current.has(r.id)));
  }, []);

  useEffect(() => {
    if (!active) { setList([]); return; }
    void poll();
    const t = setInterval(() => void poll(), 3000);
    const onVis = () => void poll();
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [active, poll]);

  const req = list[0];
  if (!req) return null;

  const hide = () => { dismissed.current.add(req.id); setList((l) => l.filter((r) => r.id !== req.id)); };
  const decide = async (approve: boolean) => {
    const ok = await decidePending(req.id, approve);
    hide();
    toast(!ok ? 'Запрос уже устарел' : approve ? 'Устройство подключается' : 'Запрос отклонён');
  };

  return (
    <Sheet title="Запрос на подключение" onClose={hide}>
      <p>Устройство <strong>{req.name}</strong> просит подключиться к серверу{req.ip ? <> (адрес <code>{req.ip}</code>)</> : null}.</p>
      <div className="pin" aria-label={`Код сверки ${req.pin}`}>{req.pin}</div>
      <p className="sub">Если на телефоне виден такой же код, нажми «Разрешить». Если код другой или ты ничего не запрашивал, откажи.</p>
      <button className="btn primary block" style={{ marginTop: 16 }} onClick={() => void decide(true)}>Разрешить</button>
      <button className="btn ghost block" style={{ marginTop: 8 }} onClick={() => void decide(false)}>Отклонить</button>
    </Sheet>
  );
}
