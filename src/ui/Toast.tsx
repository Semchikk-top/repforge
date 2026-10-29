import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

const ToastContext = createContext<(msg: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ msg: string; n: number; out: boolean } | null>(null);
  const timers = useRef<number[]>([]);

  const show = useCallback((msg: string) => {
    timers.current.forEach(window.clearTimeout);
    setToast((t) => ({ msg, n: (t?.n ?? 0) + 1, out: false }));
    timers.current = [
      window.setTimeout(() => setToast((t) => (t ? { ...t, out: true } : t)), 2400),
      window.setTimeout(() => setToast(null), 2650)
    ];
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && <div key={toast.n} className={'toast' + (toast.out ? ' out' : '')} role="status">{toast.msg}</div>}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
