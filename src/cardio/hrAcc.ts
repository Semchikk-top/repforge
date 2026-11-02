// Накопитель пульса за тренировку: средний (взвешенный по времени), максимальный и время по зонам.
// Хранится вместе с записью (`cardio.active`), поэтому переживает перезапуск приложения.
import { validHr, zoneFor } from './hr';

export interface HrAcc {
  n: number;            // принятых отсчётов
  sec: number;          // секунд, за которые считается среднее
  sum: number;          // сумма bpm × секунды
  max: number;
  last: number | null;  // время последнего отсчёта, мс
  zoneSec: [number, number, number, number, number];
}

export const MAX_GAP_SEC = 5; // разрыв больше этого (пауза, потеря связи) во время не засчитываем

export const newHrAcc = (): HrAcc => ({ n: 0, sec: 0, sum: 0, max: 0, last: null, zoneSec: [0, 0, 0, 0, 0] });

export function addHr(acc: HrAcc, bpm: number, t: number, maxHr: number): HrAcc {
  if (!validHr(bpm)) return acc; // 0 и мусор от датчика без контакта
  const gap = acc.last === null ? 0 : (t - acc.last) / 1000;
  const dt = gap > 0 && gap <= MAX_GAP_SEC ? gap : 0;
  const zoneSec = [...acc.zoneSec] as HrAcc['zoneSec'];
  const z = zoneFor(bpm, maxHr);
  if (z && dt > 0) zoneSec[z.n - 1] += dt;
  return { n: acc.n + 1, sec: acc.sec + dt, sum: acc.sum + bpm * dt, max: Math.max(acc.max, bpm), last: t, zoneSec };
}

/** Итог для записи; null, если отсчётов слишком мало, чтобы называть это средним. */
export function summarizeHr(acc: HrAcc): { hrAvg: number; hrMax: number } | null {
  if (acc.n < 5) return null;
  const avg = acc.sec > 0 ? acc.sum / acc.sec : 0;
  if (avg <= 0) return null;
  return { hrAvg: Math.round(avg), hrMax: acc.max };
}
