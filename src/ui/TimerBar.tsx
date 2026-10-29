import { useEffect, useRef, useState } from 'react';
import { useRestTimer } from '../state/timer';
import { formatClock } from '../lib';

export function TimerBar() {
  const { active, remainingSec, totalSec, paused, add, skip, pause, resume } = useRestTimer();
  const [mounted, setMounted] = useState(active);
  const last = useRef({ remainingSec, totalSec });
  if (active) last.current = { remainingSec, totalSec };

  // даём панели плавно уехать вниз, прежде чем убрать её из дерева
  useEffect(() => {
    if (active) { setMounted(true); return; }
    const t = setTimeout(() => setMounted(false), 240);
    return () => clearTimeout(t);
  }, [active]);

  if (!mounted) return null;
  const rem = active ? remainingSec : last.current.remainingSec;
  const total = active ? totalSec : last.current.totalSec;
  const pct = total > 0 ? Math.min(100, (rem / total) * 100) : 0;
  const finished = active && !paused && rem <= 0;

  return (
    <div className={'timer' + (active ? '' : ' out') + (finished ? ' finished' : '') + (paused ? ' paused' : '')} role="timer" aria-live="off">
      <div className="timer-inner">
        <div>
          <div className={'clock' + (rem > 0 && rem <= 3 && !paused ? ' low' : '')}>{formatClock(rem)}</div>
          <div className="label">{finished ? 'Отдых закончился' : paused ? 'Пауза' : 'Отдых между подходами'}</div>
        </div>
        <div className="ctl">
          {!finished && (
            <button className="btn small" onClick={paused ? resume : pause} aria-pressed={paused} aria-label={paused ? 'Продолжить отдых' : 'Поставить отдых на паузу'}>{paused ? 'Далее' : 'Пауза'}</button>
          )}
          <button className="btn small" onClick={() => add(-15)} aria-label="Минус 15 секунд">−15</button>
          <button className="btn small" onClick={() => add(15)} aria-label="Плюс 15 секунд">+15</button>
          <button className="btn small primary" onClick={skip}>Пропустить</button>
        </div>
        <div className="bar"><i style={{ width: `${pct}%` }} /></div>
      </div>
    </div>
  );
}
