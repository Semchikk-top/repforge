import { addDays, toDateStr } from '../lib';

export function Heatmap({ counts, days = 365 }: { counts: Record<string, number>; days?: number }) {
  const end = new Date();
  const start = addDays(new Date(end.getFullYear(), end.getMonth(), end.getDate()), -(days - 1));
  const cells: { d: Date; c: number }[] = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    cells.push({ d, c: counts[toDateStr(d)] ?? 0 });
  }
  const max = Math.max(1, ...cells.map((c) => c.c));
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(53, 10px)', gap: 2, minWidth: 600 }}>
        {cells.map((c) => (
          <div key={c.d.toISOString()} title={`${c.d.toLocaleDateString('ru-RU')}: ${c.c} тр.`}
            style={{ width: 10, height: 10, borderRadius: 2, background: c.c === 0 ? 'var(--surface-2)' : `rgba(124, 92, 255, ${0.2 + (c.c / max) * 0.8})` }} />
        ))}
      </div>
    </div>
  );
}
