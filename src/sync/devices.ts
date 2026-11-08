// Карточки подключённых устройств: отозванное устройство остаётся в списке сутки и его можно вернуть,
// затем карточка исчезает. Сервер сам убирает такие записи; здесь то же правило на клиенте, чтобы карточка
// пропадала вовремя, не дожидаясь нового запроса списка.

/** Сколько отозванное устройство остаётся в списке (секунды). Совпадает с REVOKED_VISIBLE_SEC на сервере. */
export const REVOKED_VISIBLE_SEC = 24 * 3600;

export interface DeviceInfo {
  id: string;
  name: string;
  last_seen: number | null;
  revoked: number;
  current: boolean;
  /** Когда отозвано, секунды (у более старых серверов поля нет). */
  revokedAt?: number | null;
  /** До какого времени можно вернуть, секунды. */
  restorableUntil?: number | null;
}

const untilOf = (d: DeviceInfo): number | null => d.restorableUntil ?? (d.revokedAt != null ? d.revokedAt + REVOKED_VISIBLE_SEC : null);

/**
 * Вернуть устройство ещё можно: оно отозвано и срок не вышел. Если сервер не сообщил срок (старая версия без
 * восстановления), кнопку не показываем: такого запроса там нет.
 */
export function canRestore(d: DeviceInfo, nowSec: number): boolean {
  if (!d.revoked) return false;
  const until = untilOf(d);
  return until !== null && nowSec <= until;
}

/** Список без карточек, у которых срок восстановления вышел. Активные устройства и отозванные у старого сервера остаются. */
export function visibleDevices<T extends DeviceInfo>(list: T[], nowSec: number): T[] {
  return list.filter((d) => {
    if (!d.revoked) return true;
    const until = untilOf(d);
    return until === null || nowSec <= until;
  });
}

const two = (n: number) => String(n).padStart(2, '0');

/** «Отозвано, вернуть можно до 14:30» (сегодня) или «до 14:30 завтра». */
export function revokedLabel(d: DeviceInfo, nowSec: number): string {
  const until = untilOf(d);
  if (until === null) return 'Отозвано';
  const at = new Date(until * 1000);
  const sameDay = at.toDateString() === new Date(nowSec * 1000).toDateString();
  return `Отозвано, вернуть можно до ${two(at.getHours())}:${two(at.getMinutes())}${sameDay ? '' : ' завтра'}`;
}
