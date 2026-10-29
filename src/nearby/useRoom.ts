import { useEffect, useState, useSyncExternalStore } from 'react';
import { room, type RoomState } from './room';

/** Состояние комнаты для React: менеджер живёт вне React, здесь только подписка. */
export const useRoom = (): RoomState => useSyncExternalStore(room.subscribe, room.getState, room.getState);

/** Текущее время, обновляется раз в `ms`, пока `on` истинно. */
export function useNow(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [on, ms]);
  return now;
}

/** «1 новое сообщение», «2 новых сообщения», «5 новых сообщений» */
export function newMessages(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return `${n} новое сообщение`;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} новых сообщения`;
  return `${n} новых сообщений`;
}

export const isInRoom = (s: RoomState): boolean => s.phase !== 'idle' && s.phase !== 'closed';
