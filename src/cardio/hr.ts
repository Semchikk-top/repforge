// Пульсовые зоны по доле от максимального пульса. Пульс вводится вручную (с часов или нагрудного датчика):
// браузер сам пульс не получает. Зоны ориентировочные, не медицинские.

export interface Zone { n: 1 | 2 | 3 | 4 | 5; from: number; to: number; name: string }
export const ZONES: Zone[] = [
  { n: 1, from: 0.5, to: 0.6, name: 'Восстановление' },
  { n: 2, from: 0.6, to: 0.7, name: 'Аэробная база' },
  { n: 3, from: 0.7, to: 0.8, name: 'Темповая' },
  { n: 4, from: 0.8, to: 0.9, name: 'Порог' },
  { n: 5, from: 0.9, to: 1.01, name: 'Максимум' }
];

/** Формула Танаки: 208 − 0,7 × возраст. Точнее «220 − возраст», но всё равно приблизительно. */
export const estimateMaxHr = (age: number): number => Math.round(208 - 0.7 * age);

/** Зона для пульса; null, если пульс ниже первой зоны или данные нелепые. */
export function zoneFor(hr: number, maxHr: number): Zone | null {
  if (!Number.isFinite(hr) || !Number.isFinite(maxHr) || hr <= 0 || maxHr < 100) return null;
  const f = hr / maxHr;
  return ZONES.find((z) => f >= z.from && f < z.to) ?? null;
}

/** Диапазоны зон в ударах в минуту для таблицы. */
export const zoneRanges = (maxHr: number): { zone: Zone; lo: number; hi: number }[] =>
  ZONES.map((zone) => ({ zone, lo: Math.round(zone.from * maxHr), hi: Math.min(maxHr, Math.round(zone.to * maxHr)) }));

export const validHr = (v: number): boolean => Number.isInteger(v) && v >= 30 && v <= 240;
