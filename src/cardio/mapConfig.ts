// Адреса внешних сервисов уличного режима. Все задаются при сборке (и, для CSP, на сервере), по умолчанию — публичные
// бесплатные сервисы без ключей. Свои копии (self-host) подставляются теми же переменными: см. README, раздел «Бег, ходьба и велосипед».
//
//   VITE_MAP_STYLE_LIGHT / VITE_MAP_STYLE_DARK — стиль карты (MapLibre style.json), по умолчанию OpenFreeMap
//   VITE_ROUTER_URL    — Valhalla (маршрут пешком и на велосипеде), по умолчанию публичный демо-сервер FOSSGIS
//   VITE_GEOCODER_URL  — Nominatim (поиск адреса), по умолчанию публичный сервер OpenStreetMap
//
// Те же адреса должны быть разрешены в CSP: WORKOUT_MAP_ORIGINS на сервере и VITE_MAP_STYLE_*/VITE_ROUTER_URL/VITE_GEOCODER_URL
// при `npm run build:public` (scripts/gen-headers.mjs берёт их из тех же переменных).

export const DEFAULT_STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/liberty';
export const DEFAULT_STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';
export const DEFAULT_ROUTER_URL = 'https://valhalla1.openstreetmap.de';
export const DEFAULT_GEOCODER_URL = 'https://nominatim.openstreetmap.org';

/** Только https:// (в отладочной сборке для локальной сети допустим http://) без логина и пароля; хвостовые «/» убираются. */
export function normalizeHttpUrl(v: unknown, allowHttp = false): string {
  if (typeof v !== 'string') return '';
  const s = v.trim().replace(/\/+$/, '');
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.username || u.password || !u.hostname) return '';
    if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) return '';
    return s;
  } catch { return ''; }
}

/** Источник (схема://хост[:порт]) из адреса: именно он должен быть в CSP. */
export function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}

const env = (name: string): unknown => (import.meta.env as Record<string, unknown> | undefined)?.[name];
const allowHttp = (): boolean => env('VITE_ALLOW_LAN_HTTP') === '1' || env('VITE_ALLOW_LAN_HTTP') === 1;

export interface MapConfig { styleLight: string; styleDark: string; routerUrl: string; geocoderUrl: string }

export function getMapConfig(): MapConfig {
  const http = allowHttp();
  return {
    styleLight: normalizeHttpUrl(env('VITE_MAP_STYLE_LIGHT'), http) || DEFAULT_STYLE_LIGHT,
    styleDark: normalizeHttpUrl(env('VITE_MAP_STYLE_DARK'), http) || DEFAULT_STYLE_DARK,
    routerUrl: normalizeHttpUrl(env('VITE_ROUTER_URL'), http) || DEFAULT_ROUTER_URL,
    geocoderUrl: normalizeHttpUrl(env('VITE_GEOCODER_URL'), http) || DEFAULT_GEOCODER_URL
  };
}
