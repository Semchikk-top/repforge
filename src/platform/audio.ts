// Воспроизведение локальных аудиофайлов озвучки. Общее для браузера и нативной оболочки: <audio> есть и там и там.
import type { AudioPlayerApi } from './types';

/** Минимум, который нужен от <audio>; тесты подставляют свой. */
export interface AudioLike {
  src: string;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  onplaying: (() => void) | null;
  play(): Promise<void>;
  pause(): void;
}

export const PLAY_TIMEOUT_MS = 60_000;

export function createHtmlAudioPlayer(make: () => AudioLike = () => new Audio() as unknown as AudioLike): AudioPlayerApi {
  let current: { a: AudioLike; finish: (r: 'ended' | 'failed') => void } | null = null;

  const stop = async (): Promise<void> => {
    const c = current;
    if (!c) return;
    try { c.a.pause(); } catch { /* необязательно */ }
    c.finish('ended'); // оборвали сами: это не сбой, говорить поверх системным голосом не нужно
  };

  return {
    async play(url) {
      await stop();
      return new Promise<'ended' | 'failed'>((resolve) => {
        let a: AudioLike;
        try { a = make(); } catch { resolve('failed'); return; }
        let started = false, done = false;
        const timer = setTimeout(() => finish('ended'), PLAY_TIMEOUT_MS);
        const finish = (r: 'ended' | 'failed') => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          a.onended = a.onerror = a.onplaying = null;
          if (current?.a === a) current = null;
          resolve(r);
        };
        current = { a, finish };
        a.onplaying = () => { started = true; };
        a.onended = () => finish('ended');
        a.onerror = () => finish(started ? 'ended' : 'failed'); // ошибка до начала — запасной голос, после — уже договорили
        a.src = url;
        a.play().catch(() => finish(started ? 'ended' : 'failed')); // политика автозапуска или нет кодека
      });
    },
    stop
  };
}
