import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { platform } from '../platform';
import { useSettings } from './settings';
import { planRestNotification, REST_ADD_ACTION, REST_ADD_SEC, REST_TAG } from './notifyPlan';
import { addState, isPaused as isPausedState, pauseState, remainingMs, restoreState, resumeState, startState, type TimerState } from './timerCore';

// Логика (пауза, ±секунды, восстановление) вынесена в timerCore.ts: там её проверяют тесты.

const LS_KEY = 'rest-timer-v1';
const ENDED_KEY = 'rest-ended-v1'; // когда закончился последний отдых: от этого момента считается время следующего подхода

type Stored = TimerState;

interface Ctx {
  active: boolean;
  remainingSec: number;
  totalSec: number;
  paused: boolean;
  start: (sec: number) => void;
  add: (sec: number) => void;
  skip: () => void;   // «Пропустить»: отдых закончен сейчас, это запоминается
  cancel: () => void; // убрать отдых без отметки о конце (отмена галочки, завершение тренировки)
  lastEndedAt: number | null;
  pause: () => void;
  resume: () => void;
}

const TimerContext = createContext<Ctx>({
  active: false, remainingSec: 0, totalSec: 0, paused: false,
  start: () => {}, add: () => {}, skip: () => {}, cancel: () => {}, lastEndedAt: null, pause: () => {}, resume: () => {}
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
    const parsed = JSON.parse(raw);
    const now = Date.now();
    const st = restoreState(parsed, now);
    // отдых закончился, пока приложение было закрыто: момент конца всё равно нужен для времени подхода
    if (!st && parsed && typeof parsed.endsAt === 'number' && typeof parsed.pausedLeftMs !== 'number' && parsed.endsAt <= now) saveEnded(parsed.endsAt);
    return st;
  } catch { return null; }
}

function saveEnded(t: number) {
  try { localStorage.setItem(ENDED_KEY, String(t)); } catch { /* хранилище недоступно: время подхода просто не запишется */ }
}

function loadEnded(): number | null {
  try {
    const v = Number(localStorage.getItem(ENDED_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch { return null; }
}

export function RestTimerProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const [state, setState] = useState<Stored | null>(loadStored);
  const [endedAt, setEndedAt] = useState<number | null>(loadEnded); // после loadStored: он мог записать конец отдыха
  const [now, setNow] = useState(Date.now());
  const firedFor = useRef<number | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const persist = (s: Stored | null) => {
    if (s) localStorage.setItem(LS_KEY, JSON.stringify(s)); else localStorage.removeItem(LS_KEY);
  };

  const markEnded = useCallback((t: number) => { saveEnded(t); setEndedAt(t); }, []);

  const fire = useCallback(() => {
    const st = settingsRef.current;
    if (st.sound) beep();
    if (st.vibrate) platform.haptics.vibrate([250, 120, 250, 120, 400]);
    // в нативной оболочке об этом уже сообщило запланированное уведомление; в браузере показываем своё
    if (document.hidden && !platform.notifications.background) void platform.notifications.show({ title: 'Отдых закончился', body: 'Пора на следующий подход', tag: REST_TAG });
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
    markEnded(Date.now());
    persist(null);
    setState(null);
  }, [markEnded]);

  const cancel = useCallback(() => {
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
    const trigger = (silent = false) => {
      if (firedFor.current === state.endsAt) return;
      firedFor.current = state.endsAt;
      markEnded(state.endsAt);
      if (!silent) fire();
      persist(null);
      setTimeout(() => setState((cur) => (cur && cur.endsAt === state.endsAt ? null : cur)), 1200);
    };
    const ms = state.endsAt - Date.now();
    const t = setTimeout(() => trigger(), Math.max(0, ms));
    // вернулись после конца отдыха: в нативной оболочке сигнал уже подало уведомление, повторять звук не нужно
    const offResume = platform.lifecycle.onResume(() => { if (Date.now() >= state.endsAt) trigger(platform.notifications.background); });
    return () => { clearTimeout(t); offResume(); };
  }, [state, fire, markEnded]);

  // Нативная оболочка: пока приложение свёрнуто, JS может быть заморожен, поэтому окончание отдыха планируем
  // системным уведомлением в момент ухода в фон и снимаем при возврате (на экране сигнал подаёт само приложение).
  const visibleRef = useRef(true);
  useEffect(() => {
    if (!platform.notifications.background) return;
    const apply = () => {
      const plan = planRestNotification(state, visibleRef.current, Date.now());
      if (plan.kind === 'schedule') {
        void platform.notifications.schedule(REST_TAG, plan.at, {
          title: 'Отдых закончился', body: 'Пора на следующий подход', tag: REST_TAG, channel: 'rest-timer',
          actions: [{ id: REST_ADD_ACTION, title: `+${REST_ADD_SEC} с` }]
        });
      } else void platform.notifications.cancel(REST_TAG);
    };
    const offPause = platform.lifecycle.onPause(() => { visibleRef.current = false; apply(); });
    const offResume = platform.lifecycle.onResume(() => { visibleRef.current = true; apply(); });
    if (!visibleRef.current) apply(); // состояние изменилось уже после ухода в фон
    return () => { offPause(); offResume(); };
  }, [state]);

  // кнопка «+15 с» под уведомлением: запускает ещё один короткий отдых
  useEffect(() => platform.notifications.onAction((actionId, tag) => {
    if (tag === REST_TAG && actionId === REST_ADD_ACTION) start(REST_ADD_SEC);
  }), [start]);

  const remainingSec = state ? remainingMs(state, now) / 1000 : 0;

  return (
    <TimerContext.Provider value={{ active: !!state, remainingSec, totalSec: state?.total ?? 0, paused: isPaused, start, add, skip, cancel, lastEndedAt: endedAt, pause, resume }}>
      {children}
    </TimerContext.Provider>
  );
}

export const useRestTimer = () => useContext(TimerContext);
