import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { saveCheckIn } from '../db/repo';
import {
  CORE_METRICS, METRIC_LABEL, SLOT_LABEL, compareDay, findCheckIn, readiness, type CoreMetric
} from '../domain/checkin';
import type { CheckIn, CheckInSlot, Rating } from '../domain/types';
import { todayStr } from '../lib';
import { back, go } from '../state/router';
import { ReadinessSummary } from './CheckInCard';

const HINT: Record<CoreMetric, [string, string]> = {
  energy: ['нет сил', 'много сил'],
  mood: ['плохое', 'отличное'],
  soreness: ['не болят', 'сильно болят'],
  stress: ['спокойно', 'очень напряжённо']
};
const RATINGS: Rating[] = [1, 2, 3, 4, 5];
const SLEEP_HOURS = [4, 5, 6, 7, 8, 9];

function RatingRow({ label, hint, value, onChange }: { label: string; hint?: [string, string]; value: Rating | undefined; onChange: (v: Rating) => void }) {
  return (
    <div className="field" role="group" aria-label={label}>
      <label>{label}</label>
      <div className="chips" style={{ flexWrap: 'wrap' }}>
        {RATINGS.map((r) => <button key={r} type="button" className={'chip' + (value === r ? ' on' : '')} aria-pressed={value === r} onClick={() => onChange(r)} style={{ minWidth: 48, minHeight: 44 }}>{r}</button>)}
      </div>
      {hint && <span className="sub" style={{ display: 'flex', justifyContent: 'space-between' }}><span>1 · {hint[0]}</span><span>5 · {hint[1]}</span></span>}
    </div>
  );
}

/** Чек-ин самочувствия: 10–15 секунд, без обязательных текстовых полей. Пропуск ничем не наказывается. */
export function CheckInView({ slot }: { slot: CheckInSlot }) {
  const date = todayStr();
  const rows = useLiveQuery(() => db.checkins.where('date').equals(date).toArray(), [date]);
  const existing = useMemo(() => (rows ? findCheckIn(rows, date, slot) : null), [rows, date, slot]);
  const morning = useMemo(() => (rows ? findCheckIn(rows, date, 'morning') : null), [rows, date]);

  const [v, setV] = useState<Partial<Record<CoreMetric, Rating>>>({});
  const [sleepHours, setSleepHours] = useState<number | undefined>();
  const [sleepQuality, setSleepQuality] = useState<Rating | undefined>();
  const [sleepiness, setSleepiness] = useState<Rating | undefined>();
  const [note, setNote] = useState('');
  const [saved, setSaved] = useState<CheckIn | null>(null);
  const [loaded, setLoaded] = useState(false);

  // при повторном открытии подставляем уже сохранённые ответы
  useEffect(() => {
    if (!rows || loaded) return;
    setLoaded(true);
    if (!existing) return;
    setV({ energy: existing.energy, mood: existing.mood, soreness: existing.soreness, stress: existing.stress });
    setSleepHours(existing.sleepHours);
    setSleepQuality(existing.sleepQuality);
    setSleepiness(existing.sleepiness);
    setNote(existing.note ?? '');
  }, [rows, existing, loaded]);

  const ready = CORE_METRICS.every((k) => v[k] !== undefined);

  const submit = async () => {
    if (!ready) return;
    const row = await saveCheckIn({
      date, slot, energy: v.energy!, mood: v.mood!, soreness: v.soreness!, stress: v.stress!,
      sleepHours: slot === 'morning' ? sleepHours : undefined,
      sleepQuality: slot === 'morning' ? sleepQuality : undefined,
      sleepiness: slot === 'evening' ? sleepiness : undefined,
      note: slot === 'evening' ? note : undefined
    });
    if (row) setSaved(row);
  };

  if (saved) {
    const cmp = slot === 'evening' ? compareDay(morning, saved) : null;
    return (
      <div>
        <div className="page-head"><h1>{SLOT_LABEL[slot]}: готово</h1></div>
        {slot === 'morning' && <ReadinessSummary r={readiness(saved)} />}
        {cmp && (
          <div className="section">
            <h2>Утро и вечер</h2>
            <div className="list">
              {cmp.map((d) => (
                <div key={d.metric} className="row">
                  <div className="grow"><div className="title">{METRIC_LABEL[d.metric]}</div></div>
                  <div className="meta">{d.morning} → {d.evening}{d.trend === 'same' ? '' : d.trend === 'better' ? ' · лучше' : ' · хуже'}</div>
                </div>
              ))}
            </div>
            <p className="sub">Это наблюдение за день, а не вывод о причинах.</p>
          </div>
        )}
        {slot === 'evening' && !cmp && <p className="sub">Утреннего чек-ина сегодня не было, сравнивать пока не с чем. Это нормально.</p>}
        <button className="btn primary block" style={{ marginTop: 16 }} onClick={() => go('calendar')}>Готово</button>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head"><h1>{slot === 'morning' ? 'Как ты сегодня?' : 'Как прошёл день?'}</h1></div>
      {CORE_METRICS.map((k) => <RatingRow key={k} label={METRIC_LABEL[k]} hint={HINT[k]} value={v[k]} onChange={(r) => setV((p) => ({ ...p, [k]: r }))} />)}

      {slot === 'morning' ? (
        <>
          <div className="field" role="group" aria-label="Часы сна">
            <label>Сон, часов</label>
            <div className="chips" style={{ flexWrap: 'wrap' }}>
              {SLEEP_HOURS.map((h) => <button key={h} type="button" className={'chip' + (sleepHours === h ? ' on' : '')} aria-pressed={sleepHours === h} onClick={() => setSleepHours(sleepHours === h ? undefined : h)} style={{ minWidth: 48, minHeight: 44 }}>{h === 4 ? '≤4' : h === 9 ? '9+' : h}</button>)}
            </div>
          </div>
          <RatingRow label="Качество сна" value={sleepQuality} onChange={setSleepQuality} />
        </>
      ) : (
        <>
          <RatingRow label="Сонливость" hint={['бодро', 'клонит в сон']} value={sleepiness} onChange={setSleepiness} />
          <div className="field">
            <label htmlFor="ci-note">Заметка (необязательно)</label>
            <textarea id="ci-note" className="input" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        </>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="btn ghost" style={{ flex: 1 }} onClick={() => back()}>Пропустить</button>
        <button className="btn primary" style={{ flex: 2 }} disabled={!ready} onClick={() => void submit()}>{existing ? 'Обновить' : 'Сохранить'}</button>
      </div>
      {!ready && <p className="sub" style={{ marginTop: 8 }}>Отметь четыре пункта сверху, остальное по желанию.</p>}
    </div>
  );
}
