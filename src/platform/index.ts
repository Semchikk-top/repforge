import type { Platform } from './types';
import { createWebPlatform } from './web';

export type { Platform, GeoFix, GeoErrorKind, NotifyPermission } from './types';

const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
let current: Platform = createWebPlatform(version);

/** Подмена реализации: нативная оболочка при старте, фейки в тестах. */
export function setPlatform(p: Platform): void { current = p; }

// Делегаты, а не сам объект: модули импортируют `platform` один раз, а реализацию можно подменить позже.
export const platform: Platform = {
  get info() { return current.info; },
  get geo() { return current.geo; },
  get notifications() { return current.notifications; },
  get wakeLock() { return current.wakeLock; },
  get haptics() { return current.haptics; },
  get lifecycle() { return current.lifecycle; },
  get secureStorage() { return current.secureStorage; },
  get files() { return current.files; },
  get heartRate() { return current.heartRate; },
  get backups() { return current.backups; },
  get scanner() { return current.scanner; },
  get speech() { return current.speech; }
};

export const isNative = (): boolean => current.info.native;

/** Запущено внутри Capacitor? Проверка без импорта плагинов, чтобы веб-сборка не тянула нативный код. */
export function detectCapacitor(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return !!cap?.isNativePlatform?.();
}

/** Вызывается один раз до первой отрисовки. В браузере ничего не загружает. */
export async function initPlatform(): Promise<void> {
  if (!detectCapacitor()) return;
  const { createNativePlatform } = await import('./native');
  setPlatform(await createNativePlatform(version));
}
