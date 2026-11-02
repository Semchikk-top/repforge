// Расхождение часов с сервером. Побеждает запись с большим updatedAt, поэтому устройство со сбитыми часами
// может молча перезаписывать свежие правки других (или проигрывать им). Сервер в каждом ответе называет своё время,
// а клиент сравнивает его с серединой интервала запроса (так сетевая задержка почти не искажает оценку).

export interface ClockSample {
  /** Время сервера минус время этого устройства, мс. Отрицательное: часы устройства спешат. */
  offsetMs: number;
  /** Сколько длился запрос, мс: точность оценки не лучше половины этого числа. */
  rttMs: number;
  /** Когда измерено (по часам устройства). */
  at: number;
}

/** Меньшее расхождение не предупреждаем: обычный дрейф и округление секунд. */
export const CLOCK_WARN_MS = 2 * 60_000;
/** Измерения по очень медленным запросам не годятся: оценка плавает на десятки секунд. */
export const MAX_RTT_MS = 30_000;

export function measureClock(sentAt: number, receivedAt: number, serverTime: number): ClockSample | null {
  if (!Number.isFinite(serverTime) || serverTime <= 0 || receivedAt < sentAt) return null;
  const rttMs = receivedAt - sentAt;
  if (rttMs > MAX_RTT_MS) return null;
  return { offsetMs: Math.round(serverTime - (sentAt + receivedAt) / 2), rttMs, at: receivedAt };
}

export interface ClockProblem {
  /** true: часы этого устройства впереди сервера. */
  ahead: boolean;
  offsetMs: number;
}

/** Есть ли заметное расхождение. Запас по задержке: при плохой связи оценка неточна, не пугаем зря. */
export function clockProblem(s: ClockSample | null | undefined): ClockProblem | null {
  if (!s) return null;
  if (Math.abs(s.offsetMs) <= Math.max(CLOCK_WARN_MS, s.rttMs)) return null;
  return { ahead: s.offsetMs < 0, offsetMs: s.offsetMs };
}

export function formatSkew(offsetMs: number): string {
  const abs = Math.abs(offsetMs);
  const min = Math.round(abs / 60_000);
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  if (h < 48) return rest ? `${h} ч ${rest} мин` : `${h} ч`;
  return `${Math.round(h / 24)} дн.`;
}

export function clockMessage(p: ClockProblem): string {
  return `Часы этого устройства ${p.ahead ? 'спешат' : 'отстают'} относительно сервера на ${formatSkew(p.offsetMs)}. ` +
    'Из-за этого правки с разных устройств могут перезаписывать друг друга не в том порядке. ' +
    'Включи в настройках телефона автоматическую дату и время (и проверь часы на ПК).';
}
