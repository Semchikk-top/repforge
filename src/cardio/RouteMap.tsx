import { useMemo } from 'react';
import { fitRoute, segmentSpeeds, speedColor, speedRange } from './geo';

type P = { lat: number; lon: number; t?: number };

// Маршрут линией без подложки: работает офлайн и ничего не отправляет наружу.
// colorByPace красит отрезки от синего (медленно) к оранжевому (быстро); ghost рисует поверх для сравнения прошлую пробежку.
export function RouteMap({ points, live, colorByPace, ghost }: { points: P[]; live?: boolean; colorByPace?: boolean; ghost?: { lat: number; lon: number }[] }) {
  const W = 320, H = 220;
  const all = useMemo(() => fitRoute(ghost && ghost.length > 1 ? [...points, ...ghost] : points, W, H), [points, ghost]);
  const xy = all.slice(0, points.length);
  const gxy = ghost && ghost.length > 1 ? all.slice(points.length) : [];

  const segments = useMemo(() => {
    if (!colorByPace || points.length < 3 || points.some((p) => typeof p.t !== 'number')) return null;
    const speeds = segmentSpeeds(points as { t: number; lat: number; lon: number }[]);
    const [lo, hi] = speedRange(speeds);
    const runs: { color: string; d: string }[] = [];
    speeds.forEach((v, i) => {
      const color = speedColor(Math.round(((v - lo) / Math.max(1e-6, hi - lo)) * 10) / 10 * (hi - lo) + lo, lo, hi);
      const a = xy[i], b = xy[i + 1];
      const last = runs[runs.length - 1];
      if (last && last.color === color) last.d += ` L${b.x.toFixed(1)},${b.y.toFixed(1)}`;
      else runs.push({ color, d: `M${a.x.toFixed(1)},${a.y.toFixed(1)} L${b.x.toFixed(1)},${b.y.toFixed(1)}` });
    });
    return runs;
  }, [colorByPace, points, xy]);

  if (xy.length < 2) {
    return <div className="route route-empty" role="img" aria-label="Маршрут"><span>{live ? 'Маршрут появится, когда начнёшь двигаться' : 'Маршрут не записан'}</span></div>;
  }
  const d = xy.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const a = xy[0], b = xy[xy.length - 1];
  return (
    <svg className="route" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Маршрут пробежки">
      {gxy.length > 1 && <path d={gxy.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} fill="none" stroke="var(--muted)" strokeWidth={3} strokeDasharray="6 6" strokeLinejoin="round" opacity={0.8} />}
      {segments
        ? segments.map((r, i) => <path key={i} d={r.d} fill="none" stroke={r.color} strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" />)
        : <path d={d} fill="none" stroke="var(--accent)" strokeWidth={3.5} strokeLinejoin="round" strokeLinecap="round" />}
      <circle cx={a.x} cy={a.y} r={5.5} fill="#3fb950" stroke="var(--bg)" strokeWidth={2} />
      <circle cx={b.x} cy={b.y} r={live ? 6.5 : 5.5} fill={live ? 'var(--text)' : 'var(--danger)'} stroke="var(--bg)" strokeWidth={2}>
        {live && <animate attributeName="r" values="5;8;5" dur="1.6s" repeatCount="indefinite" />}
      </circle>
    </svg>
  );
}
