// Игровой журнал. Ничего не хранится «счётчиком»: опыт, монеты и уровень выводятся из записей.
// Записи детерминированы по id (wk:<тренировка>, ach:<достижение>, buy:<предмет>, state),
// поэтому два устройства, записавшие одно и то же, не создают дублей и не спорят при синхронизации.
import type { SyncMeta } from '../domain/types';

export type Slot = 'avatar' | 'frame' | 'banner' | 'accent' | 'title';
export const SLOTS: Slot[] = ['avatar', 'frame', 'banner', 'accent', 'title'];

export interface WorkoutAward extends SyncMeta { kind: 'workout'; workoutId: string; date: string; xp: number; coins: number }
export interface AchievementUnlock extends SyncMeta { kind: 'achievement'; achId: string; xp: number; coins: number; at: number }
export interface Purchase extends SyncMeta { kind: 'purchase'; itemId: string; price: number; at: number }
export interface GameState extends SyncMeta { kind: 'state'; equipped: Partial<Record<Slot, string>>; nickname?: string }

export type GameRow = WorkoutAward | AchievementUnlock | Purchase | GameState;
