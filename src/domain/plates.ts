export const DEFAULT_PLATES = [25, 20, 15, 10, 5, 2.5, 1.25];

export interface PlateResult {
  perSide: number[];   // блины на одну сторону грифа, от большего к меньшему
  achieved: number;    // реальный вес на штанге
  missing: number;     // сколько не хватает до цели из-за набора блинов, кг (0 — точно)
  belowBar: boolean;   // цель меньше самого грифа
}

/** Какие блины повесить на каждую сторону штанги. Считаем в граммах, чтобы не копить ошибки округления. */
export function platesPerSide(target: number, bar: number, plates: number[] = DEFAULT_PLATES): PlateResult {
  if (!Number.isFinite(target) || !Number.isFinite(bar) || target < bar) return { perSide: [], achieved: bar, missing: 0, belowBar: Number.isFinite(target) && target < bar };
  let rest = Math.round(((target - bar) / 2) * 1000);
  const perSide: number[] = [];
  for (const p of [...plates].sort((a, b) => b - a)) {
    const g = Math.round(p * 1000);
    if (g <= 0) continue;
    while (rest >= g && perSide.length < 20) { perSide.push(p); rest -= g; }
  }
  const sum = perSide.reduce((a, b) => a + b, 0);
  return { perSide, achieved: Math.round((bar + 2 * sum) * 100) / 100, missing: Math.round(2 * rest) / 1000, belowBar: false };
}
