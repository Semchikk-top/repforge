import { MUSCLE_LABELS, type MuscleGroup } from '../domain/types';
import type { MapLoad } from '../domain/loadMap';
import { formatNum } from '../lib';

// Схема тела: собственный рисунок из простых форм, без чужих изображений. Левая сторона рисуется один раз и отражается.
// Цвет — доля от самой нагруженной группы за период; точные числа всегда рядом в таблице (BodyMapTable).

type Shape = { d: string; mirror?: boolean };
type Side = Partial<Record<MuscleGroup, Shape[]>>;

const FRONT: Side = {
  chest: [{ d: 'M58,46 L58,70 Q44,74 39,64 Q38,52 46,47 Z', mirror: true }],
  shoulders: [{ d: 'M22,52 Q22,41 32,41 Q42,43 42,54 Q40,63 30,63 Q22,62 22,52 Z', mirror: true }],
  biceps: [{ d: 'M20,66 Q20,62 26,62 Q32,62 32,66 L31,88 Q26,92 21,88 Z', mirror: true }],
  forearms: [{ d: 'M17,94 Q17,91 22,91 Q28,91 28,94 L27,124 Q22,128 18,124 Z', mirror: true }],
  core: [{ d: 'M47,74 L73,74 L71,112 Q60,118 49,112 Z' }],
  legs: [{ d: 'M44,128 L59,128 L58,176 Q57,190 50,190 Q42,180 44,128 Z', mirror: true }],
  calves: [{ d: 'M47,196 L57,196 L55,234 Q52,240 49,234 Z', mirror: true }]
};

const BACK: Side = {
  back: [{ d: 'M60,40 L46,48 Q37,62 42,84 L49,108 L71,108 L78,84 Q83,62 74,48 Z' }],
  shoulders: [{ d: 'M22,52 Q22,41 32,41 Q42,43 42,54 Q40,63 30,63 Q22,62 22,52 Z', mirror: true }],
  triceps: [{ d: 'M20,66 Q20,62 26,62 Q32,62 32,66 L31,88 Q26,92 21,88 Z', mirror: true }],
  forearms: [{ d: 'M17,94 Q17,91 22,91 Q28,91 28,94 L27,124 Q22,128 18,124 Z', mirror: true }],
  glutes: [{ d: 'M59,110 L59,136 Q46,140 42,128 Q40,116 49,110 Z', mirror: true }],
  legs: [{ d: 'M43,140 L59,140 L58,180 Q57,192 50,192 Q41,182 43,140 Z', mirror: true }],
  calves: [{ d: 'M45,198 L58,198 L56,232 Q51,238 47,232 Z', mirror: true }]
};

const ORDER: MuscleGroup[] = ['back', 'chest', 'core', 'glutes', 'legs', 'calves', 'shoulders', 'biceps', 'triceps', 'forearms'];
/** Прозрачность заливки: пустая группа почти не видна, самая нагруженная насыщена. */
const alpha = (level: number) => (level <= 0 ? 0 : 0.18 + 0.77 * level);
const W = 120, H = 252;

function Figure({ side, label, items }: { side: Side; label: string; items: Map<MuscleGroup, MapLoad> }) {
  const mirrored = (x: Shape, key: string, fill: string, op: number, title: string) => (
    <g key={key}>
      <path d={x.d} fill={fill} fillOpacity={op} stroke="var(--border, currentColor)" strokeOpacity={0.55} strokeWidth={0.8}><title>{title}</title></path>
      {x.mirror && <path d={x.d} transform={`translate(${W},0) scale(-1,1)`} fill={fill} fillOpacity={op} stroke="var(--border, currentColor)" strokeOpacity={0.55} strokeWidth={0.8}><title>{title}</title></path>}
    </g>
  );
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="body-fig" aria-hidden="true" focusable="false">
      {/* нейтральная основа: голова, шея, туловище, таз, стопы */}
      <g fill="var(--border, currentColor)" fillOpacity={0.16}>
        <circle cx={60} cy={18} r={13} />
        <rect x={54} y={30} width={12} height={10} rx={3} />
        <path d="M38,44 L82,44 L80,128 L40,128 Z" />
        <ellipse cx={51} cy={246} rx={8} ry={4} /><ellipse cx={69} cy={246} rx={8} ry={4} />
      </g>
      {ORDER.flatMap((g) => (side[g] ?? []).map((x, i) => {
        const it = items.get(g);
        const title = `${MUSCLE_LABELS[g]}: ${it ? formatNum(it.weighted) : 0}`;
        return mirrored(x, `${g}${i}`, 'var(--accent)', it ? alpha(it.level) : 0, title);
      }))}
      {/* контуры пустых групп, чтобы форма читалась без заливки */}
      <title>{label}</title>
    </svg>
  );
}

const sign = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');

/** Карта нагрузки: вид спереди и сзади. Оценка по подходам, не измерение. */
export function BodyMap({ items, days }: { items: MapLoad[]; days: number }) {
  const by = new Map(items.map((m) => [m.muscle, m]));
  const empty = items.every((m) => m.weighted === 0);
  const summary = empty ? 'Нет данных за период' : items.map((m) => `${MUSCLE_LABELS[m.muscle]} ${formatNum(m.weighted)}`).join(', ');
  return (
    <div className="body-map" role="img" aria-label={`Карта нагрузки за ${days} дней, оценка по подходам. ${summary}`} data-testid="body-map">
      <figure><Figure side={FRONT} label="Вид спереди" items={by} /><figcaption>Спереди</figcaption></figure>
      <figure><Figure side={BACK} label="Вид сзади" items={by} /><figcaption>Сзади</figcaption></figure>
    </div>
  );
}

/** Те же числа текстом. «К обычному» — отличие от твоего среднего за восемь недель, в процентах. */
export function BodyMapTable({ items }: { items: MapLoad[] }) {
  const rows = [...items].sort((a, b) => b.weighted - a.weighted);
  return (
    <table className="muscle-table" style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10 }} data-testid="body-map-table">
      <caption style={{ textAlign: 'left', fontSize: 13, opacity: 0.7, paddingBottom: 4 }}>Оценка подходов по группам</caption>
      <thead>
        <tr style={{ textAlign: 'left', fontSize: 12, opacity: 0.7 }}>
          <th scope="col">Группа</th>
          <th scope="col" style={{ textAlign: 'right' }}>Подходы (оценка)</th>
          <th scope="col" style={{ textAlign: 'right' }}>К обычному</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => (
          <tr key={m.muscle}>
            <th scope="row" style={{ textAlign: 'left', fontWeight: 400 }}>{MUSCLE_LABELS[m.muscle]}</th>
            <td style={{ textAlign: 'right' }}>{formatNum(m.weighted)}</td>
            <td style={{ textAlign: 'right' }} aria-label={m.vsUsual === null ? 'сравнивать пока не с чем' : `отличие ${sign(m.vsUsual)} процентов`}>{m.vsUsual === null ? '—' : `${sign(m.vsUsual)}%`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
