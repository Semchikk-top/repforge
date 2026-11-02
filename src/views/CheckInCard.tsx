import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo } from 'react';
import { db } from '../db/db';
import { READINESS_TEXT, SLOT_LABEL, findCheckIn, readiness, type Readiness } from '../domain/checkin';
import { todayStr } from '../lib';
import { currentSlot } from '../state/checkinPlan';
import { go } from '../state/router';

/** Готовность и её составляющие: итоговое число не стоит отдельно от того, из чего оно сложилось. Это подсказка, а не медицинский показатель. */
export function ReadinessSummary({ r }: { r: Readiness }) {
  return (
    <div className="section">
      <h2>Готовность {r.score}</h2>
      <p>{READINESS_TEXT[r.level]}</p>
      <div className="list">
        {r.parts.map((p) => (
          <div key={p.key} className="row">
            <div className="grow"><div className="title">{p.label}</div></div>
            <div className="meta">{p.value} из 100</div>
          </div>
        ))}
      </div>
      <p className="sub">Простое среднее составляющих. Это ориентир на сегодня, а не оценка здоровья.</p>
    </div>
  );
}

/** Карточка на календаре: предлагает нужный сейчас слот, а если утро заполнено, показывает готовность. Серий и штрафов за пропуск нет. */
export function CheckInCard() {
  const date = todayStr();
  const rows = useLiveQuery(() => db.checkins.where('date').equals(date).toArray(), [date]);
  const slot = currentSlot();
  const morning = useMemo(() => (rows ? findCheckIn(rows, date, 'morning') : null), [rows, date]);
  const todo = useMemo(() => (rows ? findCheckIn(rows, date, slot) : null), [rows, date, slot]);
  if (!rows) return null;

  if (morning && slot === 'morning') {
    const r = readiness(morning);
    return (
      <button className="row" style={{ width: '100%', background: 'none', border: 'none', color: 'inherit', textAlign: 'left' }} onClick={() => go('checkin/morning')}>
        <div className="grow"><div className="title">Готовность {r.score}</div><div className="meta">{READINESS_TEXT[r.level]}</div></div>
      </button>
    );
  }
  if (todo) return null;
  return (
    <button className="row" style={{ width: '100%', background: 'none', border: 'none', color: 'inherit', textAlign: 'left' }} onClick={() => go(`checkin/${slot}`)}>
      <div className="grow">
        <div className="title">{slot === 'morning' ? 'Как самочувствие?' : 'Итог дня'}</div>
        <div className="meta">{SLOT_LABEL[slot]}, 15 секунд</div>
      </div>
    </button>
  );
}
