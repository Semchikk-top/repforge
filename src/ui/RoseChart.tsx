import { MUSCLE_LABELS } from '../domain/types';
import type { MuscleLoad } from '../domain/analytics';

/**
 * Радиальная диаграмма («роза»): длина лепестка — доля группы от собственного объёма за период.
 * Сектора одинаковой ширины и в постоянном порядке, пустые группы остаются на месте. Рядом всегда идёт таблица
 * с теми же числами (см. MuscleLoadTable): диаграмма не единственный способ прочитать данные.
 */
export function RoseChart({ items, unit }: { items: MuscleLoad[]; unit: string }) {
  const S = 300, c = S / 2, rMax = 96, rMin = 10, labelR = 124;
  const n = items.length;
  const maxShare = Math.max(1, ...items.map((m) => m.share));
  const step = (Math.PI * 2) / n;
  const pt = (r: number, a: number) => [c + r * Math.sin(a), c - r * Math.cos(a)] as const;
  const empty = items.every((m) => m.share === 0);
  const summary = empty ? 'Нет данных за период' : items.map((m) => `${MUSCLE_LABELS[m.muscle]} ${m.share}%`).join(', ');

  return (
    <svg className="chart rose" viewBox={`0 0 ${S} ${S}`} role="img" aria-label={`Роза нагрузки. ${summary}`} style={{ maxWidth: 340, margin: '0 auto', display: 'block' }}>
      {[0.5, 1].map((k) => <circle key={k} cx={c} cy={c} r={rMin + (rMax - rMin) * k} fill="none" stroke="var(--border, currentColor)" strokeOpacity={0.25} strokeDasharray="2 3" />)}
      {items.map((m, i) => {
        const a0 = i * step - step / 2 + 0.03, a1 = i * step + step / 2 - 0.03, mid = i * step;
        const r = m.share === 0 ? 0 : rMin + ((rMax - rMin) * m.share) / maxShare;
        const [x0, y0] = pt(rMin, a0), [x1, y1] = pt(rMin, a1), [x2, y2] = pt(r, a1), [x3, y3] = pt(r, a0);
        const [lx, ly] = pt(labelR, mid);
        const d = `M${x0.toFixed(1)},${y0.toFixed(1)} A${rMin},${rMin} 0 0 1 ${x1.toFixed(1)},${y1.toFixed(1)} L${x2.toFixed(1)},${y2.toFixed(1)} A${r.toFixed(1)},${r.toFixed(1)} 0 0 0 ${x3.toFixed(1)},${y3.toFixed(1)} Z`;
        return (
          <g key={m.muscle}>
            {m.share > 0 && <path d={d} fill="var(--accent)" fillOpacity={0.85}><title>{`${MUSCLE_LABELS[m.muscle]}: ${m.share}%`}</title></path>}
            <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" fontSize={11} fill="currentColor" opacity={m.share === 0 ? 0.5 : 1}>
              {MUSCLE_LABELS[m.muscle]}
              <tspan x={lx} dy={12} fontSize={10} opacity={0.75}>{m.share}%</tspan>
            </text>
          </g>
        );
      })}
      <text x={c} y={c} textAnchor="middle" dominantBaseline="middle" fontSize={11} opacity={0.6}>{unit}</text>
    </svg>
  );
}

const sign = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');

/** Те же числа текстом: доступная альтернатива диаграмме. Отклонение — от собственного среднего за восемь недель. */
export function MuscleLoadTable({ items, metric }: { items: MuscleLoad[]; metric: 'sets' | 'volume' }) {
  return (
    <table className="muscle-table" style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10 }}>
      <caption style={{ textAlign: 'left', fontSize: 13, opacity: 0.7, paddingBottom: 4 }}>Доли по группам мышц</caption>
      <thead>
        <tr style={{ textAlign: 'left', fontSize: 12, opacity: 0.7 }}>
          <th scope="col">Группа</th>
          <th scope="col" style={{ textAlign: 'right' }}>{metric === 'sets' ? 'Подходы' : 'Тоннаж, кг'}</th>
          <th scope="col" style={{ textAlign: 'right' }}>Доля</th>
          <th scope="col" style={{ textAlign: 'right' }}>К обычному</th>
        </tr>
      </thead>
      <tbody>
        {items.map((m) => (
          <tr key={m.muscle}>
            <th scope="row" style={{ textAlign: 'left', fontWeight: 400 }}>{MUSCLE_LABELS[m.muscle]}</th>
            <td style={{ textAlign: 'right' }}>{metric === 'sets' ? m.sets : Math.round(m.volume)}</td>
            <td style={{ textAlign: 'right' }}>{m.share}%</td>
            <td style={{ textAlign: 'right' }} aria-label={`отклонение ${sign(m.delta)} процентных пунктов`}>{sign(m.delta)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
