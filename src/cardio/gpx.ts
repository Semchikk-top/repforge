import { decodePoint, haversine, type TrackPoint } from './geo';

type Pt = { lat: number; lon: number; t?: number; ele?: number | null };

function between<T extends Pt>(a: T, b: T, f: number): T {
  const mix = (x: number, y: number) => x + (y - x) * f;
  const out: Pt = { ...a, lat: mix(a.lat, b.lat), lon: mix(a.lon, b.lon) };
  if (typeof a.t === 'number' && typeof b.t === 'number') out.t = mix(a.t, b.t);
  if (typeof a.ele === 'number' && typeof b.ele === 'number') out.ele = mix(a.ele, b.ele);
  return out as T;
}

/** Зона приватности: срезаем ровно zoneM метров с начала и с конца маршрута (граница ставится внутри отрезка,
 *  а не по ближайшей точке: упрощённый маршрут может состоять всего из двух далёких точек).
 *  Если маршрут короче двух зон, он скрывается целиком. */
export function trimRoute<T extends Pt>(pts: T[], zoneM: number): T[] {
  if (!(zoneM > 0) || pts.length === 0) return pts;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon));
  const total = cum[cum.length - 1];
  if (total < 2 * zoneM + 30) return [];
  const from = zoneM, to = total - zoneM;
  const at = (d: number): T => {
    let i = 1;
    while (i < pts.length - 1 && cum[i] < d) i++;
    const seg = cum[i] - cum[i - 1];
    return between(pts[i - 1], pts[i], seg > 0 ? (d - cum[i - 1]) / seg : 0);
  };
  return [at(from), ...pts.filter((_, i) => cum[i] > from && cum[i] < to), at(to)];
}

export const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] as string));

/** GPX 1.1: открывается в Strava, Garmin Connect и любом приложении карт. Время идёт по времени движения (паузы вырезаны). */
export function toGpx(name: string, startMs: number, track: TrackPoint[], zoneM = 0): string {
  const pts = trimRoute(track.map(decodePoint), zoneM);
  const seg = pts.map((p) => {
    const ele = p.ele === null ? '' : `<ele>${p.ele.toFixed(1)}</ele>`;
    return `      <trkpt lat="${p.lat.toFixed(5)}" lon="${p.lon.toFixed(5)}">${ele}<time>${new Date(startMs + p.t * 1000).toISOString()}</time></trkpt>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="repforge" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${escapeXml(name)}</name><time>${new Date(startMs).toISOString()}</time></metadata>
  <trk>
    <name>${escapeXml(name)}</name>
    <trkseg>
${seg}
    </trkseg>
  </trk>
</gpx>
`;
}

/** Один GPX-файл с несколькими маршрутами (массовый экспорт). Маршруты, целиком попавшие в зону приватности, пропускаются. */
export function toMultiGpx(items: { name: string; startMs: number; track: TrackPoint[] }[], zoneM = 0): string {
  const trks = items.map((it) => {
    const pts = trimRoute(it.track.map(decodePoint), zoneM);
    if (pts.length < 2) return '';
    const seg = pts.map((p) => {
      const ele = p.ele === null ? '' : `<ele>${p.ele.toFixed(1)}</ele>`;
      return `      <trkpt lat="${p.lat.toFixed(5)}" lon="${p.lon.toFixed(5)}">${ele}<time>${new Date(it.startMs + p.t * 1000).toISOString()}</time></trkpt>`;
    }).join('\n');
    return `  <trk>\n    <name>${escapeXml(it.name)}</name>\n    <trkseg>\n${seg}\n    </trkseg>\n  </trk>`;
  }).filter(Boolean).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="repforge" xmlns="http://www.topografix.com/GPX/1/1">\n  <metadata><name>Маршруты</name></metadata>\n${trks}\n</gpx>\n`;
}
