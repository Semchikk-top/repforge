import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSettings } from './settings';
import { addState, isPaused as isPausedState, pauseState, remainingMs, restoreState, resumeState, startState, type TimerState } from './timerCore';

// Логика (пауза, ±секунды, восстановление) вынесена в timerCore.ts: там её проверяют тесты.

const LS_KEY = 'rest-timer-v1';

type Stored = TimerState;

interface Ctx {
  active: boolean;
  remainingSec: number;
  totalSec: number;
  paused: boolean;
  start: (sec: number) => void;
  add: (sec: number) => void;
  skip: () => void;
  pause: () => void;
  resume: () => void;
}

const TimerContext = createContext<Ctx>({
  active: false, remainingSec: 0, totalSec: 0, paused: false,
  start: () => {}, add: () => {}, skip: () => {}, pause: () => {}, resume: () => {}
});

let audioCtx: AudioContext | null = null;
function unlockAudio() {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    audioCtx = audioCtx ?? new AC();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
  } catch { /* звук недоступен */ }
}

function beep() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  [0, 0.22, 0.44].forEach((offset, i) => {
    const osc = audioCtx!.createOscillator();
    const gain = audioCtx!.createGain();
    osc.type = 'sine';
    osc.frequency.value = i === 2 ? 1175 : 880;
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.35, now + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.18);
    osc.connect(gain).connect(audioCtx!.destination);
    osc.start(now + offset);
    osc.stop(now + offset + 0.2);
  });
}

function loadStored(): Stored | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    // на паузе таймер не истекает, сколько бы времени ни прошло
    return restoreState(JSON.parse(raw), Date.now());
  } catch { return null; }
}

export function RestTimerProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const [state, setState] = useState<Stored | null>(loadStored);
  const [now, setNow] = useState(Date.now());
  const firedFor = useRef<number | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const persist = (s: Stored | null) => {
    if (s) localStorage.setItem(LS_KEY, JSON.stringify(s)); else localStorage.removeItem(LS_KEY);
  };

  const fire = useCallback(() => {
    const st = settingsRef.current;
    if (st.sound) beep();
    if (st.vibrate && 'vibrate' in navigator) navigator.vibrate([250, 120, 250, 120, 400]);
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      void navigator.serviceWorker?.ready.then((reg) =>
        reg.showNotification('Отдых закончился', { body: 'Пора на следующий подход', tag: 'rest-timer' })
      );
    }
  }, []);

  const start = useCallback((sec: number) => {
    unlockAudio();
    const s = startState(sec, Date.now());
    firedFor.current = null;
    persist(s);
    setState(s);
    setNow(Date.now());
  }, []);

  const add = useCallback((sec: number) => {
    setState((prev) => {
      if (!prev) return prev;
      const s = addState(prev, sec, Date.now());
      firedFor.current = null;
      persist(s);
      return s;
    });
  }, []);

  const pause = useCallback(() => {
    setState((prev) => {
      if (!prev) return prev;
      const s = pauseState(prev, Date.now());
      if (s !== prev) persist(s);
      return s;
    });
  }, []);

  const resume = useCallback(() => {
    unlockAudio();
    setState((prev) => {
      if (!prev) return prev;
      const s = resumeState(prev, Date.now());
      if (s !== prev) { firedFor.current = null; persist(s); }
      return s;
    });
    setNow(Date.now());
  }, []);

  const skip = useCallback(() => {
    persist(null);
    setState(null);
  }, []);

  // отрисовка
  const isPaused = isPausedState(state);
  useEffect(() => {
    if (!state || isPaused) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [state, isPaused]);

  // срабатывание по точному времени (и при возврате в приложение)
  useEffect(() => {
    if (!state || isPausedState(state)) return;
    const trigger = () => {
      if (firedFor.current === state.endsAt) return;
      firedFor.current = state.endsAt;
      fire();
      persist(null);
      setTimeout(() => setState((cur) => (cur && cur.endsAt === state.endsAt ? null : cur)), 1200);
    };
    const ms = state.endsAt - Date.now();
    const t = setTimeout(trigger, Math.max(0, ms));
    const onVis = () => { if (document.visibilityState === 'visible' && Date.now() >= state.endsAt) trigger(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearTimeout(t); document.removeEventListener('visibilitychange', onVis); };
  }, [state, fire]);

  const remainingSec = state ? remainingMs(state, now) / 1000 : 0;

  return (
    <TimerContext.Provider value={{ active: !!state, remainingSec, totalSec: state?.total ?? 0, paused: isPaused, start, add, skip, pause, resume }}>
      {children}
    </TimerContext.Provider>
  );
}

export const useRestTimer = () => useContext(TimerContext);
