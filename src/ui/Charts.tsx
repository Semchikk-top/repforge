import { formatNum } from '../lib';

interface BarDatum { label: string; value: number; highlight?: boolean }

export function BarChart({ data, unit = '' }: { data: BarDatum[]; unit?: string }) {
  const W = 320, H = 150, padB = 22, padT = 16;
  const max = Math.max(1, ...data.map((d) => d.value));
  const bw = W / data.length;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Столбчатая диаграмма">
      {data.map((d, i) => {
        const h = ((H - padB - padT) * d.value) / max;
        const x = i * bw + bw * 0.18;
        const w = bw * 0.64;
        return (
          <g key={i}>
            <rect className="bar" style={{ ["--i" as string]: i }} x={x} y={H - padB - h} width={w} height={Math.max(h, d.value > 0 ? 2 : 0)} rx={3} fill={d.highlight ? 'var(--accent)' : 'var(--bar)'} />
            {d.value > 0 && <text className="lbl" x={x + w / 2} y={H - padB - h - 4} textAnchor="middle">{formatNum(Math.round(d.value))}{unit}</text>}
            <text x={x + w / 2} y={H - 6} textAnchor="middle">{d.label}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** Линейный график. trend рисует пунктирную линию регрессии — видно направление,
 *  даже когда точки прыгают туда-сюда (вес тела, 1ПМ). */
export function LineChart({ points, unit = 'кг', trend = false }: { points: { label: string; value: number }[]; unit?: string; trend?: boolean }) {
  const W = 320, H = 150, padL = 8, padR = 8, padT = 18, padB = 22;
  if (points.length < 2) return <p className="empty">Нужно хотя бы две точки.</p>;
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = Math.max(1, max - min);
  const xs = (i: number) => padL + ((W - padL - padR) * i) / (points.length - 1);
  const ys = (v: number) => padT + (H - padT - padB) * (1 - (v - min) / span);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)},${ys(p.value).toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  let trendPath: string | null = null;
  if (trend && points.length >= 3) {
    const n = points.length;
    const meanX = (n - 1) / 2;
    const meanY = vals.reduce((a, b) => a + b, 0) / n;
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i - meanX) * (vals[i] - meanY); den += (i - meanX) ** 2; }
    const slope = den ? num / den : 0;
    const at = (i: number) => meanY + slope * (i - meanX);
    trendPath = `M${xs(0).toFixed(1)},${ys(at(0)).toFixed(1)} L${xs(n - 1).toFixed(1)},${ys(at(n - 1)).toFixed(1)}`;
  }
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="График прогресса">
      {trendPath && <path d={trendPath} fill="none" stroke="var(--muted, #888)" strokeWidth={1.5} strokeDasharray="5 4" opacity={0.7} />}
      <path className="line" pathLength={1} d={d} fill="none" stroke="var(--accent)" strokeWidth={2.5} strokeLinejoin="round" />
      {points.map((p, i) => <circle className="dot" key={i} cx={xs(i)} cy={ys(p.value)} r={3} fill="var(--accent)" />)}
      <text x={padL} y={H - 6}>{points[0].label}</text>
      <text x={W - padR} y={H - 6} textAnchor="end">{last.label}</text>
      <text x={W - padR} y={ys(last.value) - 8} textAnchor="end">{formatNum(Math.round(last.value * 10) / 10)} {unit}</text>
    </svg>
  );
}

export function HBars({ rows, unit }: { rows: { label: string; value: number }[]; unit: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="list">
      {rows.map((r) => (
        <div key={r.label} style={{ padding: '7px 0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
            <span>{r.label}</span>
            <span className="sub">{r.value} {unit}</span>
          </div>
          <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 3, marginTop: 4 }}>
            <div className="hbar-fill" style={{ width: `${(r.value / max) * 100}%`, height: '100%', background: 'var(--accent)', borderRadius: 3 }} />
          </div>
        </div>
      ))}
    </div>
  );
}
