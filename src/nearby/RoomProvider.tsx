import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { isCardio, type Exercise, type Workout } from '../domain/types';
import { useSettings } from '../state/settings';
import { useRestTimer } from '../state/timer';
import { useWakeLock } from '../state/wakelock';
import { useToast } from '../ui/Toast';
import { RoomSheet } from '../views/RoomSheet';
import { playCallSound, vibrateCall } from './alert';
import { buildPresence, type PresenceWorkout } from './presence';
import { room } from './room';
import { isInRoom, useRoom } from './useRoom';

interface RoomUi { openSheet(): void; closeSheet(): void; open: boolean }
const Ctx = createContext<RoomUi>({ openSheet: () => {}, closeSheet: () => {}, open: false });
export const useRoomUi = () => useContext(Ctx);

function toPresenceWorkout(w: Workout, exMap: Map<string, Exercise>): PresenceWorkout {
  return {
    title: w.title,
    exercises: w.exercises.map((we) => {
      const ex = exMap.get(we.exerciseId);
      return { name: ex?.name ?? 'Упражнение', cardio: isCardio(ex), cardioDone: !!we.cardio, sets: we.sets.map((s) => ({ done: s.done, completedAt: s.completedAt })) };
    })
  };
}

/**
 * Провайдер стоит выше роутера: связь не рвётся при переходах между экранами.
 * Соединения здесь не создаются: только подписки, Wake Lock, звук и presence из текущей тренировки.
 */
export function RoomProvider({ children }: { children: ReactNode }) {
  const state = useRoom();
  const { settings } = useSettings();
  const timer = useRestTimer();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const openRef = useRef(false); // чтобы всплывашка о сообщении не дублировала открытый чат
  openRef.current = open;
  const inRoom = isInRoom(state);

  const openSheet = useCallback(() => setOpen(true), []);
  const closeSheet = useCallback(() => setOpen(false), []);

  // экран не гаснет, пока комната жива: заблокированный телефон обрывает связь
  useWakeLock(inRoom);

  useEffect(() => { room.setViewing(open); }, [open]);

  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') room.onForeground(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // события комнаты → интерфейс
  useEffect(() => room.onEvent((e) => {
    if (e.type === 'approval') { setOpen(true); return; } // вход нужно подтвердить: сразу показываем код сверки
    const name = room.getState().peerName || 'Друг';
    if (e.type === 'call') {
      if (settings.vibrate) vibrateCall();
      if (settings.sound) playCallSound();
      toast(`${name} зовёт вас`);
    } else if (!document.hidden && !openRef.current) {
      toast(`${name}: ${e.text.length > 60 ? e.text.slice(0, 60) + '…' : e.text}`);
    }
  }), [settings.vibrate, settings.sound, toast]);

  // что делаю прямо сейчас: активная тренировка + таймер отдыха
  const workout = useLiveQuery(
    async () => (inRoom ? (await db.workouts.where('status').equals('active').filter((w) => !w.deletedAt).first()) ?? null : null),
    [inRoom], null
  );
  const exList = useLiveQuery(async () => (inRoom ? db.exercises.toArray() : []), [inRoom], [] as Exercise[]);
  const exMap = useMemo(() => new Map(exList.map((e) => [e.id, e])), [exList]);
  const restSec = Math.ceil(timer.remainingSec);

  useEffect(() => {
    if (!inRoom) return;
    room.updateLocalPresence(buildPresence({
      workout: workout ? toPresenceWorkout(workout, exMap) : null,
      // на паузе друг не должен видеть бегущий отсчёт: отдых скрыт, пока таймер стоит
      rest: timer.active && !timer.paused ? { remainingSec: restSec, totalSec: timer.totalSec } : null,
      share: state.sharePresence,
      now: Date.now()
    }));
  }, [inRoom, workout, exMap, timer.active, timer.paused, restSec, timer.totalSec, state.sharePresence]);

  return (
    <Ctx.Provider value={{ openSheet, closeSheet, open }}>
      {children}
      {open && <RoomSheet onClose={closeSheet} />}
    </Ctx.Provider>
  );
}
