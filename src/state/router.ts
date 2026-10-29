import { useEffect, useState, useCallback } from 'react';

// Минимальный hash-роутер: системная кнопка «назад» на Android работает как ожидается.
const read = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);

export function useRoute() {
  const [segs, setSegs] = useState<string[]>(read);
  useEffect(() => {
    const on = () => setSegs(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return segs;
}

export const go = (path: string) => { location.hash = '/' + path.replace(/^\//, ''); };
// Без новой записи в истории: ссылка с одноразовым кодом не должна оставаться в «назад» и в истории браузера
export const replace = (path: string) => {
  history.replaceState(null, '', '#/' + path.replace(/^\//, ''));
  window.dispatchEvent(new HashChangeEvent('hashchange'));
};
export const back = () => history.back();

export function useGo() {
  return useCallback(go, []);
}
