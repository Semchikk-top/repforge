import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { bestEffortRecords, cardioSessions, dailyStats, daySummaryText, exerciseRecords, type ExerciseRecord } from '../domain/analytics';
import { MUSCLE_LABELS, isCardio, type Exercise, type MuscleGroup, type Workout } from '../domain/types';
import { formatHMS, formatKm } from '../cardio/geo';
import { formatNum, parseDate } from '../lib';
import { go } from '../state/router';
import { IconBack } from '../ui/Icons';

type Metric = 'weight' | 'e1rm' | 'setVolume' | 'sessionVolume';
type Sort = 'recent' | 'name' | 'value';

const METRICS: { id: Metric; label: string }[] = [
  { id: 'weight', label: 'Вес' },
  { id: 'e1rm', label: '1ПМ' },
  { id: 'setVolume', label: 'Объём подхода' },
  { id: 'sessionVolume', label: 'Объём за день' }
];
const SORTS: { id: Sort; label: string }[] = [{ id: 'recent', label: 'Свежие' }, { id: 'value', label: 'По значению' }, { id: 'name', label: 'По названию' }];

const shortDate = (s: string) => parseDate(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
const isFresh = (date: string) => Date.now() - parseDate(date).getTime() < 14 * 86400000;

function pick(r: ExerciseRecord, m: Metric): { value: number; date: string; text: string; meta: string } | null {
  if (m === 'weight' && r.maxWeight) return { value: r.maxWeight.value, date: r.maxWeight.date, text: `${formatNum(r.maxWeight.value)} кг`, meta: `× ${r.maxWeight.reps}` };
  if (m === 'e1rm' && r.maxE1rm) return { value: r.maxE1rm.value, date: r.maxE1rm.date, text: `≈ ${formatNum(Math.round(r.maxE1rm.value))} кг`, meta: `из ${formatNum(r.maxE1rm.weight)} × ${r.maxE1rm.reps}` };
  if (m === 'setVolume' && r.maxSetVolume) return { value: r.maxSetVolume.value, date: r.maxSetVolume.date, text: `${formatNum(Math.round(r.maxSetVolume.value))} кг`, meta: `${formatNum(r.maxSetVolume.weight)} × ${r.maxSetVolume.reps}` };
  if (m === 'sessionVolume' && r.maxSessionVolume) return { value: r.maxSessionVolume.value, date: r.maxSessionVolume.date, text: `${formatNum(Math.round(r.maxSessionVolume.value))} кг`, meta: 'за одну тренировку' };
  return null;
}

export function RecordsView() {
  const workouts = useLiveQuery(() => db.workouts.toArray(), [], [] as Workout[]);
  const exList = useLiveQuery(() => db.exercises.toArray(), [], [] as Exercise[]);
  const exMap = useMemo(() => new Map(exList.map((e) => [e.id, e])), [exList]);

  const [metric, setMetric] = useState<Metric>('e1rm');
  const [sort, setSort] = useState<Sort>('recent');
  const [muscle, setMuscle] = useState<MuscleGroup | 'all'>('all');
  const [query, setQuery] = useState('');

  const records = useMemo(() => exerciseRecords(workouts), [workouts]);
  const cardio = useMemo(() => cardioSessions(workouts, exMap), [workouts, exMap]);
  const efforts = useMemo(() => bestEffortRecords(cardio), [cardio]);
  const longest = useMemo(() => cardio.filter((x) => x.sport !== 'bike').reduce<(typeof cardio)[number] | null>((a, x) => (!a || x.distanceM > a.distanceM ? x : a), null), [cardio]);

  // самый тяжёлый тренировочный день: сводка по всем тренировкам дня (рекорды упражнений «за тренировку» считаются отдельно)
  const heaviestDay = useMemo(() => dailyStats(workouts).reduce<ReturnType<typeof dailyStats>[number] | null>((a, d) => (d.volumeKg > 0 && (!a || d.volumeKg > a.volumeKg) ? d : a), null), [workouts]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = records
      .map((r) => ({ r, ex: exMap.get(r.exerciseId), v: pick(r, metric), reps: r.maxReps }))
      .filter((x) => x.ex && !x.ex.deletedAt && !isCardio(x.ex))
      .filter((x) => muscle === 'all' || x.ex!.muscle === muscle)
      .filter((x) => !q || x.ex!.name.toLowerCase().includes(q))
      .filter((x) => x.v || x.reps);   // упражнения без весов показываем по повторениям
    list.sort((a, b) => {
      if (sort === 'name') return a.ex!.name.localeCompare(b.ex!.name, 'ru');
      if (sort === 'value') return (b.v?.value ?? 0) - (a.v?.value ?? 0);
      return (b.v?.date ?? b.reps!.date).localeCompare(a.v?.date ?? a.reps!.date);
    });
    return list;
  }, [records, exMap, metric, sort, muscle, query]);

  return (
    <div>
      <div className="head-row">
        <button className="icon-btn" onClick={() => go('stats')} aria-label="К аналитике"><IconBack /></button>
        <h1 style={{ margin: 0 }}>Рекорды</h1>
      </div>

      {(efforts.length > 0 || longest) && (
        <div className="section">
          <h2>Бег и ходьба</h2>
          <div className="list">
            {efforts.map((e) => (
              <div key={e.meters} className="row">
                <div className="grow"><div className="title">Лучшие {e.meters / 1000} км</div><div className="meta">{shortDate(e.date)}{isFresh(e.date) ? ' · новый' : ''}</div></div>
                <div className="rec-value">{formatHMS(e.sec)}</div>
              </div>
            ))}
            {longest && (
              <div className="row">
                <div className="grow"><div className="title">Самая длинная</div><div className="meta">{shortDate(longest.date)} · {formatHMS(longest.durationSec)}</div></div>
                <div className="rec-value">{formatKm(longest.distanceM)} км</div>
              </div>
            )}
          </div>
        </div>
      )}

      {heaviestDay && (
        <div className="section">
          <h2>Самый тяжёлый день</h2>
          <div className="list">
            <div className="row">
              <div className="grow"><div className="title">{shortDate(heaviestDay.date)}</div><div className="meta">{daySummaryText(heaviestDay)}</div></div>
            </div>
          </div>
        </div>
      )}

      <div className="section">
        <h2>Силовые</h2>
        <div className="chips wrap" role="group" aria-label="Что считать рекордом">
          {METRICS.map((m) => <button key={m.id} className={'chip' + (metric === m.id ? ' on' : '')} onClick={() => setMetric(m.id)}>{m.label}</button>)}
        </div>
        <div className="chips wrap" role="group" aria-label="Сортировка" style={{ marginTop: 8 }}>
          {SORTS.map((o) => <button key={o.id} className={'chip' + (sort === o.id ? ' on' : '')} onClick={() => setSort(o.id)}>{o.label}</button>)}
        </div>
        <input className="input" style={{ marginTop: 10 }} placeholder="Поиск по названию" aria-label="Поиск" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="chips" role="group" aria-label="Группа мышц" style={{ marginTop: 8 }}>
          <button className={'chip' + (muscle === 'all' ? ' on' : '')} onClick={() => setMuscle('all')}>Все</button>
          {(Object.keys(MUSCLE_LABELS) as MuscleGroup[]).filter((m) => m !== 'cardio').map((m) => (
            <button key={m} className={'chip' + (muscle === m ? ' on' : '')} onClick={() => setMuscle(m)}>{MUSCLE_LABELS[m]}</button>
          ))}
        </div>

        {rows.length === 0 && <p className="empty">{records.length === 0 ? 'Рекорды появятся после первой завершённой тренировки.' : 'Ничего не найдено.'}</p>}
        <div className="list" style={{ marginTop: 12 }}>
          {rows.map(({ r, ex, v, reps }) => (
            <div key={r.exerciseId} className="row">
              <div className="grow">
                <div className="title">{ex!.name}</div>
                <div className="meta">{v ? `${v.meta} · ${shortDate(v.date)}` : `Без веса · ${shortDate(reps!.date)}`}{(v?.date ?? reps!.date) && isFresh(v?.date ?? reps!.date) ? ' · новый' : ''}</div>
              </div>
              <div className="rec-value">{v ? v.text : `${reps!.value} повт.`}</div>
            </div>
          ))}
        </div>
        <p className="sub">1ПМ считается по формуле Эпли. Рекорд засчитывается по первому достижению значения.</p>
      </div>
    </div>
  );
}
