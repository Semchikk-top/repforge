import { addDays, toDateStr } from '../lib';
import { daySummaryText, type DayStat } from '../domain/analytics';

/** Цвет клетки зависит от дневного объёма; если объёма нет (кардио, только вес тела), считается число тренировок. */
export function Heatmap({ stats, days = 365 }: { stats: Record<string, DayStat>; days?: number }) {
  const end = new Date();
  const start = addDays(new Date(end.getFullYear(), end.getMonth(), end.getDate()), -(days - 1));
  const cells: { d: Date; s: DayStat | undefined; v: number }[] = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    const s = stats[toDateStr(d)];
    cells.push({ d, s, v: s ? (s.volumeKg > 0 ? s.volumeKg : s.sessions) : 0 });
  }
  const max = Math.max(1, ...cells.map((c) => c.v));
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(53, 10px)', gap: 2, minWidth: 600 }}>
        {cells.map((c) => (
          <div key={c.d.toISOString()} title={`${c.d.toLocaleDateString('ru-RU')}${c.s ? ': ' + daySummaryText(c.s) : ''}`}
            style={{ width: 10, height: 10, borderRadius: 2, background: c.v === 0 ? 'var(--surface-2)' : `rgba(124, 92, 255, ${0.2 + (c.v / max) * 0.8})` }} />
        ))}
      </div>
    </div>
  );
}
