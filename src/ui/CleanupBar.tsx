import { useEffect, useRef, useState } from 'react';
import { useCleanupGate } from '../state/cleanupGate';
import { IconCheck } from './Icons';

/** Нижняя плашка уборки инвентаря: стоит на месте таймера отдыха и сменяется им после галочки. Не таймер. */
export function CleanupBar() {
  const { gate, confirm } = useCleanupGate();
  const [mounted, setMounted] = useState(!!gate);
  const last = useRef(gate);
  if (gate) last.current = gate;

  // даём плашке плавно уехать вниз, прежде чем убрать её из дерева
  useEffect(() => {
    if (gate) { setMounted(true); return; }
    const t = setTimeout(() => setMounted(false), 240);
    return () => clearTimeout(t);
  }, [gate]);

  if (!mounted || !last.current) return null;
  const shown = gate ?? last.current;

  return (
    <div className={'timer cleanup' + (gate ? '' : ' out')} role="status" aria-live="polite">
      <div className="timer-inner">
        <div>
          <div className="cleanup-title">Убери инвентарь</div>
          <div className="label">{shown.label}</div>
        </div>
        <div className="ctl">
          <button className="check on cleanup-check" onClick={confirm} aria-label="Инвентарь убран" disabled={!gate}><IconCheck /></button>
        </div>
      </div>
    </div>
  );
}
