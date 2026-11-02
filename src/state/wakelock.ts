import { useEffect } from 'react';
import { platform } from '../platform';

// Не даём экрану гаснуть, пока открыта активная тренировка.
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let release: (() => void) | null = null;
    let cancelled = false;

    const acquire = async () => {
      const r = await platform.wakeLock.acquire();
      if (cancelled) { r(); return; }
      release?.(); // браузер сам снимает блокировку в фоне, но нативная оболочка — нет
      release = r;
    };

    void acquire();
    const off = platform.lifecycle.onResume(() => void acquire());
    return () => {
      cancelled = true;
      off();
      release?.();
    };
  }, [active]);
}
