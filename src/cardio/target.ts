// Целевой темп (бег, ходьба) или скорость (велосипед), которые человек вводит перед тренировкой. Внутри — секунды на километр.

export const PACE_MIN_SEC = 150;   // 2:30 на км
export const PACE_MAX_SEC = 1200;  // 20:00 на км
export const SPEED_MIN_KMH = 3;
export const SPEED_MAX_KMH = 60;

/** «6:00», «6.30», «6 30» → секунды на километр; null, если не разобрать или нелепо. */
export function parsePace(text: string): number | null {
  const m = text.trim().match(/^(\d{1,2})\s*[:.,\s]\s*(\d{1,2})$/);
  if (!m) return null;
  const min = Number(m[1]), sec = Number(m[2]);
  if (sec >= 60) return null;
  const total = min * 60 + sec;
  return total >= PACE_MIN_SEC && total <= PACE_MAX_SEC ? total : null;
}

/** «25», «24,5» км/ч → секунды на километр. */
export function parseSpeedKmh(text: string): number | null {
  const v = Number(text.trim().replace(',', '.'));
  if (!Number.isFinite(v) || v < SPEED_MIN_KMH || v > SPEED_MAX_KMH) return null;
  return Math.round(3600 / v);
}

export function targetFromText(text: string, bike: boolean): number | null {
  return text.trim() === '' ? null : bike ? parseSpeedKmh(text) : parsePace(text);
}
