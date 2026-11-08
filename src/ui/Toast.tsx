import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

export interface ToastAction { label: string; run: () => void }
type Show = (msg: string, action?: ToastAction) => void;

const ToastContext = createContext<Show>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ msg: string; n: number; out: boolean; action?: ToastAction } | null>(null);
  const timers = useRef<number[]>([]);

  const hide = useCallback(() => {
    timers.current.forEach(window.clearTimeout);
    setToast(null);
  }, []);

  const show = useCallback<Show>((msg, action) => {
    timers.current.forEach(window.clearTimeout);
    setToast((t) => ({ msg, action, n: (t?.n ?? 0) + 1, out: false }));
    // с кнопкой «Отменить» показываем дольше: успеть нажать
    const ms = action ? 5000 : 2400;
    timers.current = [
      window.setTimeout(() => setToast((t) => (t ? { ...t, out: true } : t)), ms),
      window.setTimeout(() => setToast(null), ms + 250)
    ];
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div key={toast.n} className={'toast' + (toast.out ? ' out' : '')} role="status">
          {toast.msg}
          {toast.action && (
            <button
              style={{ marginLeft: 14, background: 'transparent', border: 0, color: 'inherit', font: 'inherit', fontWeight: 800, textDecoration: 'underline', minHeight: 32, cursor: 'pointer' }}
              onClick={() => { const run = toast.action!.run; hide(); run(); }}
            >{toast.action.label}</button>
          )}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
