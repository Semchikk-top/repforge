import { describe, expect, it } from 'vitest';
import { canRestore, REVOKED_VISIBLE_SEC as DAY, revokedLabel, visibleDevices, type DeviceInfo } from '../../src/sync/devices';

const dev = (over: Partial<DeviceInfo> = {}): DeviceInfo => ({ id: 'd', name: 'Телефон', last_seen: 1, revoked: 0, current: false, ...over });
const T0 = 1_800_000_000;
const revoked = (agoSec: number, extra: Partial<DeviceInfo> = {}) => dev({ revoked: 1, revokedAt: T0 - agoSec, restorableUntil: T0 - agoSec + DAY, ...extra });

describe('срок восстановления отозванного устройства', () => {
  it('сутки ровно: ещё можно, на секунду позже уже нельзя', () => {
    expect(canRestore(revoked(DAY), T0)).toBe(true);
    expect(canRestore(revoked(DAY + 1), T0)).toBe(false);
    expect(canRestore(revoked(10), T0)).toBe(true);
  });
  it('активное устройство восстанавливать не нужно', () => {
    expect(canRestore(dev(), T0)).toBe(false);
  });
  it('срок берётся и из revokedAt, если restorableUntil нет', () => {
    expect(canRestore(dev({ revoked: 1, revokedAt: T0 - 100 }), T0)).toBe(true);
    expect(canRestore(dev({ revoked: 1, revokedAt: T0 - DAY - 100 }), T0)).toBe(false);
  });
  it('старый сервер без срока: кнопки нет, карточка остаётся как раньше', () => {
    const old = dev({ revoked: 1 });
    expect(canRestore(old, T0)).toBe(false);
    expect(visibleDevices([old], T0)).toEqual([old]);
  });
});

describe('карточки в списке', () => {
  it('отозванное устройство пропадает через сутки, активные и недавно отозванные остаются', () => {
    const active = dev({ id: 'a' });
    const fresh = revoked(3600, { id: 'f' });
    const stale = revoked(DAY + 60, { id: 's' });
    expect(visibleDevices([active, fresh, stale], T0).map((d) => d.id)).toEqual(['a', 'f']);
  });
  it('карточка пропадает сама по ходу времени, без нового запроса к серверу', () => {
    const d = revoked(DAY - 30, { id: 'x' });
    expect(visibleDevices([d], T0).length).toBe(1);
    expect(visibleDevices([d], T0 + 31).length).toBe(0);
  });
  it('активное устройство, которое давно не заходило, не пропадает', () => {
    expect(visibleDevices([dev({ last_seen: 1 })], T0 + 10 * DAY).length).toBe(1);
  });
});

describe('подпись', () => {
  it('называет время, до которого можно вернуть', () => {
    const now = Math.floor(new Date(2026, 10, 5, 10, 0).getTime() / 1000);
    expect(revokedLabel(dev({ revoked: 1, restorableUntil: now + 3600 }), now)).toBe('Отозвано, вернуть можно до 11:00');
    expect(revokedLabel(dev({ revoked: 1, restorableUntil: now + 20 * 3600 }), now)).toBe('Отозвано, вернуть можно до 06:00 завтра');
    expect(revokedLabel(dev({ revoked: 1 }), now)).toBe('Отозвано');
  });
});
