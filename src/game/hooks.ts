import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { useProfile } from '../social/hooks';
import { totalsOf, type Totals } from './ledger';
import type { GameRow } from './types';

const NONE: GameRow[] = [];

/** Опыт, монеты, достижения и наряд: всё выводится из журнала и обновляется само. */
export function useGame(): Totals & { name: string } {
  const rows = useLiveQuery(() => db.game.toArray(), [], NONE);
  const profile = useProfile();
  return useMemo(() => {
    const t = totalsOf(rows);
    return { ...t, name: profile?.displayName?.trim() || t.nickname || 'Атлет' };
  }, [rows, profile?.displayName]);
}
