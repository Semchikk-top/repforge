// Отдых между подходами: что взять для упражнения. Чистая логика, без React и базы.
// Приоритет: отдых из самого упражнения (exercise.restSec), иначе общая настройка (defaultRestSec).

import type { Why } from './explain';
import type { Exercise } from './types';

/** Варианты в редакторе упражнения. Пустое значение — «как в настройках». */
export const REST_PRESETS = [30, 60, 90, 120, 180] as const;

/** Разумные границы: короче не бывает осмысленного отдыха, длиннее часа таймер уже не нужен. */
export const REST_MIN_SEC = 5;
export const REST_MAX_SEC = 60 * 60;

export type RestSource = 'exercise' | 'settings';
export interface ResolvedRest { sec: number; source: RestSource }

/** Годное значение из упражнения или undefined: мусор в данных (0, NaN, отрицательное) считаем «не задано». */
export function ownRestSec(ex: Pick<Exercise, 'restSec'> | null | undefined): number | undefined {
  const v = ex?.restSec;
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  const sec = Math.round(v);
  return sec >= REST_MIN_SEC && sec <= REST_MAX_SEC ? sec : undefined;
}

/** Сколько отдыхать после подхода этого упражнения и откуда взято число. */
export function resolveRest(ex: Pick<Exercise, 'restSec'> | null | undefined, defaultRestSec: number): ResolvedRest {
  const own = ownRestSec(ex);
  return own !== undefined ? { sec: own, source: 'exercise' } : { sec: defaultRestSec, source: 'settings' };
}

export const REST_SOURCE_LABEL: Record<RestSource, string> = { exercise: 'из упражнения', settings: 'из настроек' };

/** «1:30» для подсказок. */
/** Почему у упражнения именно такой отдых (слой «факт» для «Почему так»). */
export function explainRest(ex: Pick<Exercise, 'restSec'> | null | undefined, defaultRestSec: number): Why {
  const r = resolveRest(ex, defaultRestSec);
  return r.source === 'exercise' ? { code: 'rest-exercise', sec: r.sec } : { code: 'rest-settings', sec: r.sec };
}

export function formatRest(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Значение для select в редакторе: '' — как в настройках. */
export const restToField = (restSec: number | undefined): string => (ownRestSec({ restSec }) !== undefined ? String(ownRestSec({ restSec })) : '');

/** Обратно: пустая строка и мусор дают undefined (поле у упражнения не хранится). */
export function fieldToRest(v: string): number | undefined {
  if (v === '') return undefined;
  return ownRestSec({ restSec: Number(v) });
}
