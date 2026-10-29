import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import type { Workout } from '../domain/types';
import { workoutSetsCount, workoutVolume } from '../domain/analytics';
import { addDays, formatDateLong, formatNum, toDateStr, todayStr, weekStart } from '../lib';
import { go } from '../state/router';
import { IconChevL, IconChevR } from '../ui/Icons';
import { StartSheet, type StartMode } from '../ui/StartSheet';
import { duplicateWorkout } from '../db/repo';

const DOW = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const STATUS_LABEL = { planned: 'Запланирована', active: 'Идёт', done: 'Завершена' } as const;

export function CalendarView() {
  const today = todayStr();
  const [cursor, setCursor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [sel, setSel] = useState(today);
  const [sheet, setSheet] = useState<StartMode | null>(null);
  const [dir, setDir] = useState<'fwd' | 'back'>('fwd');

  const workouts = useLiveQuery(() => db.workouts.toArray().then((w) => w.filter((x) => !x.deletedAt)), [], [] as Workout[]);

  const byDate = useMemo(() => {
    const m = new Map<string, Workout[]>();
    for (const w of workouts) m.set(w.date, [...(m.get(w.date) ?? []), w]);
    return m;
  }, [workouts]);

  const cells = useMemo(() => {
    const start = weekStart(cursor);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [cursor]);

  const monthLabel = `${cursor.toLocaleDateString('ru-RU', { month: 'long' })} ${cursor.getFullYear()}`;
  const dayWorkouts = byDate.get(sel) ?? [];
  const shift = (n: number) => { setDir(n > 0 ? 'fwd' : 'back'); setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + n, 1)); };
  const mode: StartMode = sel === today ? 'start' : sel > today ? 'plan' : 'log';

  return (
    <div>
      <div className="page-head"><h1>Календарь</h1></div>

      <div className="cal-head">
        <button className="icon-btn" onClick={() => shift(-1)} aria-label="Предыдущий месяц"><IconChevL /></button>
        <span className="month cap">{monthLabel}</span>
        <button className="icon-btn" onClick={() => shift(1)} aria-label="Следующий месяц"><IconChevR /></button>
      </div>

      <div key={cursor.getTime()} className={'cal-grid ' + dir}>
        {DOW.map((d) => <div key={d} className="cal-dow">{d}</div>)}
        {cells.map((d) => {
          const ds = toDateStr(d);
          const ws = byDate.get(ds) ?? [];
          const mark = ws.some((w) => w.status !== 'planned') ? 'done' : ws.length ? 'planned' : 'none';
          const cls = ['cal-day', d.getMonth() !== cursor.getMonth() ? 'out' : '', ds === today ? 'today' : '', ds === sel ? 'sel' : ''].join(' ');
          return (
            <button key={ds} className={cls} onClick={() => setSel(ds)} aria-label={formatDateLong(ds)} aria-pressed={ds === sel}>
              {d.getDate()}
              <span className={'mark ' + mark} />
            </button>
          );
        })}
      </div>

      <div className="section">
        <h2 key={sel} className="swap cap">{formatDateLong(sel)}</h2>
        <div key={sel + dayWorkouts.length} className="list">
          {dayWorkouts.map((w) => (
            <div key={w.id} className="row" style={{ alignItems: 'center' }}>
              <button className="grow" style={{ textAlign: 'left', background: 'none', border: 'none', color: 'inherit', padding: 0 }} onClick={() => go(`workout/${w.id}`)}>
                <div className="title">{w.title}</div>
                <div className="meta">
                  {STATUS_LABEL[w.status]}
                  {w.status !== 'planned' && workoutSetsCount(w) > 0 && ` · ${workoutSetsCount(w)} подх. · ${formatNum(Math.round(workoutVolume(w)))} кг`}
                  {w.status === 'planned' && w.exercises.length > 0 && ` · ${w.exercises.length} упр.`}
                </div>
              </button>
              {w.status === 'done' && (
                <button className="btn small ghost" onClick={async (e) => { e.stopPropagation(); const nw = await duplicateWorkout(w.id); if (nw) go(`workout/${nw.id}`); }}>Дублировать</button>
              )}
              <button className="icon-btn" style={{ width: 32, height: 32 }} onClick={() => go(`workout/${w.id}`)} aria-label="Открыть"><IconChevR size={18} /></button>
            </div>
          ))}
          {dayWorkouts.length === 0 && <p className="empty">В этот день ничего нет.</p>}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button className="btn primary" style={{ flex: 1 }} onClick={() => setSheet(mode)}>
            {mode === 'start' ? 'Начать тренировку' : mode === 'plan' ? 'Запланировать' : 'Записать тренировку'}
          </button>
          {mode === 'start' && <button className="btn" onClick={() => setSheet('plan')}>На потом</button>}
        </div>
      </div>

      {sheet && <StartSheet date={sel} mode={sheet} onClose={() => setSheet(null)} />}
    </div>
  );
}
