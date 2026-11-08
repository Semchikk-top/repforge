import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { IconClose } from './Icons';

const EXIT_MS = 200;

/** onBeforeClose: вернуть false, чтобы не закрывать (например, пользователь передумал терять несохранённые правки). */
export function Sheet({ title, onClose, onBeforeClose, children }: { title: string; onClose: () => void; onBeforeClose?: () => boolean; children: ReactNode }) {
  const [closing, setClosing] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  // сначала проигрываем анимацию закрытия, потом сообщаем родителю
  const requestClose = useCallback(() => {
    if (timer.current) return;
    if (onBeforeClose && !onBeforeClose()) return;
    setClosing(true);
    timer.current = window.setTimeout(onClose, EXIT_MS);
  }, [onClose, onBeforeClose]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestClose]);

  return (
    <div className={'sheet-backdrop' + (closing ? ' closing' : '')} onClick={requestClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={requestClose} aria-label="Закрыть"><IconClose /></button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}
