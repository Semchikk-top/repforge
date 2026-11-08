import { useEffect, useRef, useState } from 'react';
import type { LatLon, PlannedRoute } from '../domain/types';
import { useSettings } from '../state/settings';
import { getMapConfig } from './mapConfig';

// Карта MapLibre. Библиотека, стили и тайлы грузятся только при показе этого компонента, а он показывается только
// по действию пользователя в уличном режиме. Любая беда (нет WebGL, не загрузился стиль, нет сети) = onFail:
// родитель возвращает схематичный RouteMap, а запись продолжается.

export type MapFailReason = 'webgl' | 'import' | 'style' | 'timeout';
export const MAP_LOAD_TIMEOUT_MS = 12_000;

export interface NavMapProps {
  route?: PlannedRoute | null;
  routeDone?: LatLon[];               // уже пройденная часть построенного маршрута
  waypoints?: LatLon[];               // точки при построении: первая — старт
  track?: LatLon[];                   // фактический трек
  current?: LatLon | null;
  follow?: boolean;                   // камера следует за текущей точкой
  onFollowChange?: (v: boolean) => void;
  onPick?: (p: LatLon) => void;       // нажатие на карту (выбор точки)
  onFail: (why: MapFailReason) => void;
  center?: LatLon | null;             // начальный центр, если текущей точки ещё нет
  className?: string;
}

const ll = (p: LatLon): [number, number] => [p.lon, p.lat];
const line = (pts: LatLon[]) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: pts.map(ll) } });
const fc = (features: unknown[]) => ({ type: 'FeatureCollection' as const, features }) as never;

export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

const COLORS = { route: '#3b82f6', done: '#94a3b8', track: '#f97316', start: '#22c55e', finish: '#ef4444', via: '#a855f7', me: '#ffffff' };

export function NavMap({ route, routeDone, waypoints, track, current, follow, onFollowChange, onPick, onFail, center, className }: NavMapProps) {
  const { settings } = useSettings();
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<import('maplibre-gl').Map | null>(null);
  const [ver, setVer] = useState(0);            // растёт, когда стиль (пере)загружен и слои нужно добавить заново
  const dark = settings.theme === 'dark' || (settings.theme === 'auto' && typeof matchMedia !== 'undefined' && !matchMedia('(prefers-color-scheme: light)').matches);
  const darkRef = useRef(dark);
  const cb = useRef({ onFail, onPick, onFollowChange });
  cb.current = { onFail, onPick, onFollowChange };
  const firstFollow = useRef(true);

  // создание карты
  useEffect(() => {
    let cancelled = false, loaded = false;
    let timer: number | undefined;
    if (!webglAvailable()) { cb.current.onFail('webgl'); return; }
    void (async () => {
      let lib: typeof import('maplibre-gl');
      try {
        const [m, workerUrl] = await Promise.all([
          import('maplibre-gl'),
          import('maplibre-gl/dist/maplibre-gl-worker.mjs?url').then((x) => x.default),
          import('maplibre-gl/dist/maplibre-gl.css')
        ]);
        lib = m;
        // воркер из собственных файлов: CSP остаётся строгим (worker-src 'self'), blob: не нужен
        lib.setWorkerUrl(workerUrl);
      } catch { if (!cancelled) cb.current.onFail('import'); return; }
      if (cancelled || !box.current) return;
      const cfg = getMapConfig();
      const c = current ?? center ?? route?.shape[0] ?? { lat: 55.75, lon: 37.62 };
      let map: import('maplibre-gl').Map;
      try {
        map = new lib.Map({
          container: box.current,
          style: darkRef.current ? cfg.styleDark : cfg.styleLight,
          center: ll(c), zoom: current || route ? 15 : 12,
          attributionControl: { compact: true, customAttribution: '© OpenStreetMap contributors · OpenFreeMap' },
          dragRotate: false, pitchWithRotate: false, touchPitch: false
        });
      } catch { cb.current.onFail('webgl'); return; }
      mapRef.current = map;
      timer = window.setTimeout(() => { if (!loaded && !cancelled) cb.current.onFail('timeout'); }, MAP_LOAD_TIMEOUT_MS);
      map.on('load', () => { loaded = true; window.clearTimeout(timer); });
      map.on('style.load', () => setVer((v) => v + 1));
      map.on('error', () => { if (!loaded && !cancelled) { window.clearTimeout(timer); cb.current.onFail('style'); } }); // после загрузки ошибки тайлов не страшны: останется линия на пустом фоне
      map.on('dragstart', (e) => { if ((e as { originalEvent?: unknown }).originalEvent) cb.current.onFollowChange?.(false); });
      map.on('click', (e) => cb.current.onPick?.({ lat: e.lngLat.lat, lon: e.lngLat.lng }));
    })();
    return () => { cancelled = true; window.clearTimeout(timer); mapRef.current?.remove(); mapRef.current = null; };
    // карта создаётся один раз; всё остальное обновляется эффектами ниже
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // смена темы: другой стиль, слои вернутся по style.load
  useEffect(() => {
    if (darkRef.current === dark) return;
    darkRef.current = dark;
    const cfg = getMapConfig();
    mapRef.current?.setStyle(dark ? cfg.styleDark : cfg.styleLight);
  }, [dark]);

  // слои и данные
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const set = (id: string, data: unknown) => {
      const src = map.getSource(id) as import('maplibre-gl').GeoJSONSource | undefined;
      if (src) src.setData(data as never);
    };
    if (!map.getSource('route')) {
      for (const id of ['route', 'done', 'track', 'points']) map.addSource(id, { type: 'geojson', data: fc([]) });
      map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLORS.route, 'line-width': 6, 'line-opacity': 0.85 } });
      map.addLayer({ id: 'done-line', type: 'line', source: 'done', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLORS.done, 'line-width': 6, 'line-opacity': 0.9 } });
      map.addLayer({ id: 'track-line', type: 'line', source: 'track', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLORS.track, 'line-width': 4 } });
      map.addLayer({
        id: 'points', type: 'circle', source: 'points',
        paint: {
          'circle-radius': ['case', ['==', ['get', 'kind'], 'me'], 8, 7],
          'circle-color': ['match', ['get', 'kind'], 'start', COLORS.start, 'finish', COLORS.finish, 'via', COLORS.via, COLORS.me],
          'circle-stroke-color': ['case', ['==', ['get', 'kind'], 'me'], COLORS.route, '#111827'], 'circle-stroke-width': 2.5
        }
      });
    }
    const wps = route?.waypoints ?? waypoints ?? [];
    set('route', route && route.shape.length > 1 ? fc([line(route.shape)]) : fc([]));
    set('done', routeDone && routeDone.length > 1 ? fc([line(routeDone)]) : fc([]));
    set('track', track && track.length > 1 ? fc([line(track)]) : fc([]));
    const pts: unknown[] = wps.map((p, i) => ({ type: 'Feature', properties: { kind: i === 0 ? 'start' : i === wps.length - 1 ? 'finish' : 'via' }, geometry: { type: 'Point', coordinates: ll(p) } }));
    if (current) pts.push({ type: 'Feature', properties: { kind: 'me' }, geometry: { type: 'Point', coordinates: ll(current) } });
    set('points', fc(pts));
  }, [ver, route, routeDone, waypoints, track, current]);

  // слежение камеры
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !follow || !current) return;
    if (firstFollow.current) { firstFollow.current = false; map.jumpTo({ center: ll(current), zoom: Math.max(map.getZoom(), 16) }); }
    else map.easeTo({ center: ll(current), duration: 700, zoom: Math.max(map.getZoom(), 16) });
  }, [follow, current]);

  return <div ref={box} className={'nav-map' + (className ? ' ' + className : '')} role="application" aria-label="Карта" />;
}
