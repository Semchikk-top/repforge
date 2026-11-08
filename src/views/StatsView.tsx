import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import {
  averageDayDurationMs, bestEffortRecords, cardioSessions, currentStreakWeeks, dailyStats, detectPlateaus, e1rmSeries, finished, loadRatio,
  LOAD_PERIODS, muscleLoad, personalRecords, weeklyDistance, weeklyStats, type LoadMetric
} from '../domain/analytics';
import { avgPace, formatHMS, formatKm, formatPace } from '../cardio/geo';
import { BodySection } from './BodySection';
import { MUSCLE_LABELS, type CheckIn, type Exercise, type Workout } from '../domain/types';
import { formatDuration, formatNum, parseDate } from '../lib';
import { averageRestSec, averageSetSec, exerciseRestStats, exerciseTempoStats, exerciseTimeStats, formatSetTime } from '../domain/setTiming';
import { go } from '../state/router';
import { PhotosSection } from './PhotosSection';
import { useSettings } from '../state/settings';
import { BarChart, HBars, LineChart } from '../ui/Charts';
import { CountUp } from '../ui/CountUp';
import { Heatmap } from '../ui/Heatmap';
import { MuscleLoadTable, RoseChart } from '../ui/RoseChart';
import { checkInSeries, seriesAverage, type SeriesMetric } from '../domain/checkin';

const shortDate = (s: string) => parseDate(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
const chartDate = (s: string) => parseDate(s).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });

export function StatsView() {
  const { settings, update } = useSettings();
  const workouts = useLiveQuery(() => db.workouts.toArray(), [], [] as Workout[]);
  const exList = useLiveQuery(() => db.exercises.toArray(), [], [] as Exercise[]);
  const exMap = useMemo(() => new Map(exList.map((e) => [e.id, e])), [exList]);
  const deep = settings.analyticsMode === 'deep';

  const done = finished(workouts);
  const weeks = useMemo(() => weeklyStats(workouts, 8), [workouts]);
  const prs = useMemo(() => personalRecords(workouts).slice(0, 8), [workouts]);
  const streak = useMemo(() => currentStreakWeeks(workouts), [workouts]);
  const thisWeek = weeks[weeks.length - 1];

  const heat = useMemo(() => Object.fromEntries(dailyStats(workouts).map((d) => [d.date, d])), [workouts]);

  return (
    <div>
      <div className="page-head"><h1>Аналитика</h1></div>

      <div className="seg" data-i={deep ? 1 : 0} role="group" aria-label="Режим аналитики">
        <button className={deep ? '' : 'on'} onClick={() => update({ analyticsMode: 'basic' })}>Основная</button>
        <button className={deep ? 'on' : ''} onClick={() => update({ analyticsMode: 'deep' })}>Глубокая</button>
      </div>

      {done.length === 0 ? (
        <p className="empty" style={{ marginTop: 20 }}>Здесь появятся графики, когда ты завершишь первую тренировку.</p>
      ) : (
        <>
          <div className="kpis section">
            <div className="kpi"><div className="bignum"><CountUp value={thisWeek.days} /></div><div className="sub">{thisWeek.days === 1 ? 'тренировочный день' : 'тренировочных дней'} на этой неделе{thisWeek.sessions > thisWeek.days ? ` (тренировок ${thisWeek.sessions})` : ''}</div></div>
            <div className="kpi"><div className="bignum"><CountUp value={thisWeek.volume / 1000} format={(n) => formatNum(Math.round(n * 10) / 10)} /></div><div className="sub">т объём за неделю</div></div>
            <div className="kpi"><div className="bignum"><CountUp value={streak} /></div><div className="sub">{streak === 1 ? 'неделя' : 'недель'} подряд</div></div>
          </div>

          <div className="section">
            <h2>Активность</h2>
            <Heatmap stats={heat} days={364} />
          </div>

          <div className="section">
            <h2>Объём по неделям, кг</h2>
            <BarChart data={weeks.map((w, i) => ({ label: chartDate(w.start), value: w.volume, highlight: i === weeks.length - 1 }))} />
          </div>

          <div className="section">
            <h2>Тренировочных дней по неделям</h2>
            <BarChart data={weeks.map((w, i) => ({ label: chartDate(w.start), value: w.days, highlight: i === weeks.length - 1 }))} />
          </div>

          <div className="section">
            <h2>Личные рекорды</h2>
            <div className="list">
              {prs.map((p) => (
                <div key={p.exerciseId} className="row">
                  <div className="grow">
                    <div className="title">{exMap.get(p.exerciseId)?.name ?? 'Упражнение'}</div>
                    <div className="meta">{formatNum(p.weight)} кг × {p.reps} · {shortDate(p.date)}</div>
                  </div>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600 }}>{formatNum(Math.round(p.e1rm))}</div>
                </div>
              ))}
            </div>
            <p className="sub">Справа расчётный максимум на одно повторение (формула Эпли).</p>
            <button className="btn block" onClick={() => go('records')}>Все рекорды</button>
          </div>

          <div className="section">
            <h2>Рейтинги</h2>
            <p className="sub">Сравните нагрузку с друзьями: общую, по упражнениям и кардио. Друзья видят только итоги, не дневник.</p>
            <button className="btn block" onClick={() => go('ratings')}>Открыть рейтинги</button>
          </div>

          <CardioStats workouts={workouts} exMap={exMap} />

          <SetTimeStats workouts={workouts} exMap={exMap} deep={deep} />

          <PhotosSection />

          <BodySection />

          <CheckInTrends />

          {deep && <DeepStats workouts={workouts} exMap={exMap} />}
        </>
      )}
    </div>
  );
}

const TREND_METRICS: { key: SeriesMetric; label: string }[] = [
  { key: 'energy', label: 'Энергия' }, { key: 'mood', label: 'Настроение' }, { key: 'soreness', label: 'Болезненность' },
  { key: 'stress', label: 'Стресс' }, { key: 'sleepHours', label: 'Сон, ч' }
];

function CheckInTrends() {
  const rows = useLiveQuery(() => db.checkins.toArray(), [], [] as CheckIn[]);
  const [days, setDays] = useState<(typeof LOAD_PERIODS)[number]>(30);
  const [metric, setMetric] = useState<SeriesMetric>('energy');
  const points = useMemo(() => checkInSeries(rows, metric, days), [rows, metric, days]);
  const avg = seriesAverage(points);
  if (!rows.some((c) => !c.deletedAt)) return null; // чек-инов ещё не было: раздел не мозолит глаза
  const seg = (on: boolean) => 'btn small ' + (on ? 'primary' : 'ghost');
  return (
    <div className="section">
      <h2>Самочувствие</h2>
      <div className="chips" role="group" aria-label="Показатель">
        {TREND_METRICS.map((m) => <button key={m.key} className={'chip' + (metric === m.key ? ' on' : '')} aria-pressed={metric === m.key} onClick={() => setMetric(m.key)}>{m.label}</button>)}
      </div>
      <div style={{ display: 'flex', gap: 6, margin: '4px 0 8px' }} role="group" aria-label="Период">
        {LOAD_PERIODS.map((d) => <button key={d} className={seg(days === d)} aria-pressed={days === d} onClick={() => setDays(d)}>{d} дн.</button>)}
      </div>
      <LineChart unit="" points={points.map((p) => ({ label: chartDate(p.date), value: Math.round(p.value * 10) / 10 }))} />
      {avg !== null && <p className="sub">Среднее за период: {formatNum(Math.round(avg * 10) / 10)}. Дни без чек-ина в график не входят.</p>}
    </div>
  );
}

function MuscleLoadSection({ workouts, exMap }: { workouts: Workout[]; exMap: Map<string, Exercise> }) {
  const [days, setDays] = useState<(typeof LOAD_PERIODS)[number]>(30);
  const [metric, setMetric] = useState<LoadMetric>('sets');
  const [view, setView] = useState<'rose' | 'list'>('rose');
  const items = useMemo(() => muscleLoad(workouts, exMap, { days, metric }), [workouts, exMap, days, metric]);
  const empty = items.every((m) => m.share === 0);
  const seg = (on: boolean) => 'btn small ' + (on ? 'primary' : 'ghost');
  return (
    <div className="section">
      <h2>Нагрузка по мышцам</h2>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }} role="group" aria-label="Период">
        {LOAD_PERIODS.map((d) => <button key={d} className={seg(days === d)} aria-pressed={days === d} onClick={() => setDays(d)}>{d} дн.</button>)}
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ display: 'flex', gap: 6 }} role="group" aria-label="Метрика">
          <button className={seg(metric === 'sets')} aria-pressed={metric === 'sets'} onClick={() => setMetric('sets')}>Подходы</button>
          <button className={seg(metric === 'volume')} aria-pressed={metric === 'volume'} onClick={() => setMetric('volume')}>Тоннаж</button>
        </div>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }} role="group" aria-label="Вид">
          <button className={seg(view === 'list')} aria-pressed={view === 'list'} onClick={() => setView('list')}>Списки</button>
          <button className={seg(view === 'rose')} aria-pressed={view === 'rose'} onClick={() => setView('rose')}>Роза</button>
        </div>
      </div>
      {empty ? <p className="empty">За выбранный период силовых тренировок нет.</p> : (
        <>
          {view === 'rose'
            ? <RoseChart items={items} unit={metric === 'sets' ? 'подходы' : 'тоннаж'} />
            : <HBars unit={metric === 'sets' ? 'подх.' : 'кг'} rows={[...items].sort((a, b) => b.share - a.share).map((m) => ({ label: MUSCLE_LABELS[m.muscle], value: metric === 'sets' ? m.sets : Math.round(m.volume) }))} />}
          <MuscleLoadTable items={items} metric={metric} />
          <p className="sub">Доли считаются от твоего собственного объёма, без «идеальных» процентов. «К обычному» — отличие от среднего за последние 8 недель, в процентных пунктах. Разминка не учитывается, кардио показано отдельно.</p>
        </>
      )}
    </div>
  );
}

function DeepStats({ workouts, exMap }: { workouts: Workout[]; exMap: Map<string, Exercise> }) {
  const plateaus = useMemo(() => detectPlateaus(workouts), [workouts]);
  const load = useMemo(() => loadRatio(workouts), [workouts]);
  const dur = useMemo(() => averageDayDurationMs(workouts), [workouts]);

  const trained = useMemo(() => {
    const ids = new Set<string>();
    for (const w of finished(workouts)) for (const we of w.exercises) if (we.sets.some((s) => s.done)) ids.add(we.exerciseId);
    return [...ids].filter((id) => exMap.has(id)).sort((a, b) => exMap.get(a)!.name.localeCompare(exMap.get(b)!.name, 'ru'));
  }, [workouts, exMap]);

  const [pick, setPick] = useState<string>('');
  const selected = pick && trained.includes(pick) ? pick : trained[0] ?? '';
  const series = useMemo(() => (selected ? e1rmSeries(workouts, selected) : []), [workouts, selected]);

  const ratioText =
    load.ratio === null ? 'Пока мало данных для сравнения.'
    : load.ratio > 1.5 ? 'Нагрузка резко выросла. Следи за восстановлением.'
    : load.ratio < 0.6 ? 'Нагрузка заметно ниже обычной.'
    : 'Нагрузка в привычных пределах.';

  return (
    <>
      <div className="section">
        <h2>Прогресс по упражнению</h2>
        {trained.length === 0 ? <p className="empty">Нет данных.</p> : (
          <>
            <select className="input" value={selected} onChange={(e) => setPick(e.target.value)} aria-label="Упражнение">
              {trained.map((id) => <option key={id} value={id}>{exMap.get(id)!.name}</option>)}
            </select>
            <div style={{ marginTop: 10 }}><LineChart points={series.map((p) => ({ label: chartDate(p.date), value: p.value }))} /></div>
            <p className="sub">Расчётный максимум на одно повторение по каждой тренировке.</p>
          </>
        )}
      </div>

      <MuscleLoadSection workouts={workouts} exMap={exMap} />

      <div className="section">
        <h2>Нагрузка</h2>
        <div className="kpis">
          <div className="kpi"><div className="bignum"><CountUp value={load.acute} format={(n) => formatNum(Math.round(n))} /></div><div className="sub">кг за 7 дней</div></div>
          <div className="kpi"><div className="bignum"><CountUp value={load.chronic} format={(n) => formatNum(Math.round(n))} /></div><div className="sub">кг в неделю обычно</div></div>
          <div className="kpi"><div className="bignum">{load.ratio === null ? '—' : load.ratio.toFixed(2)}</div><div className="sub">отношение</div></div>
        </div>
        <p className="sub" style={{ marginTop: 8 }}>{ratioText}</p>
        {dur && <p className="sub">Средняя длительность тренировочного дня: {formatDuration(dur)}.</p>}
      </div>

      <div className="section">
        <h2>Плато</h2>
        {plateaus.length === 0 ? <p className="empty">Застоя не видно: в упражнениях с историей есть рост или мало данных.</p> : (
          <div className="list">
            {plateaus.map((p) => (
              <div key={p.exerciseId} className="row">
                <div className="grow">
                  <div className="title">{exMap.get(p.exerciseId)?.name ?? 'Упражнение'}</div>
                  <div className="meta">В последних трёх тренировках рекорд ({formatNum(Math.round(p.best))} кг) не обновлялся</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function CardioStats({ workouts, exMap }: { workouts: Workout[]; exMap: Map<string, Exercise> }) {
  const sessions = useMemo(() => cardioSessions(workouts, exMap), [workouts, exMap]);
  const weeks = useMemo(() => weeklyDistance(sessions, 8), [sessions]);
  const records = useMemo(() => bestEffortRecords(sessions), [sessions]);
  if (sessions.length === 0) return null;

  const since = new Date(Date.now() - 30 * 86400000);
  const recent = sessions.filter((x) => parseDate(x.date) >= since && x.sport !== 'bike');
  const dist = recent.reduce((a, x) => a + x.distanceM, 0);
  const time = recent.reduce((a, x) => a + x.durationSec, 0);
  const all = sessions.filter((x) => x.sport !== 'bike');
  const longest = all.reduce<typeof all[number] | null>((a, x) => (!a || x.distanceM > a.distanceM ? x : a), null);

  return (
    <div className="section">
      <h2>Бег и ходьба</h2>
      <div className="kpis">
        <div className="kpi"><div className="bignum"><CountUp value={dist / 1000} format={(n) => formatNum(Math.round(n * 10) / 10)} /></div><div className="sub">км за 30 дней</div></div>
        <div className="kpi"><div className="bignum">{recent.length}</div><div className="sub">{recent.length === 1 ? 'пробежка' : 'занятий'}</div></div>
        <div className="kpi"><div className="bignum" style={{ fontSize: 30, paddingTop: 8 }}>{formatPace(avgPace(dist, time))}</div><div className="sub">средний темп, мин/км</div></div>
      </div>
      <h3 style={{ margin: '16px 0 4px', fontSize: 16 }}>Километры по неделям</h3>
      <BarChart data={weeks.map((w, i) => ({ label: chartDate(w.start), value: Math.round(w.km * 10) / 10, highlight: i === weeks.length - 1 }))} />
      {(records.length > 0 || longest) && (
        <div className="list" style={{ marginTop: 12 }}>
          {records.map((r) => (
            <div key={r.meters} className="row">
              <div className="grow"><div className="title">Лучшие {r.meters / 1000} км</div><div className="meta">{shortDate(r.date)}</div></div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600 }}>{formatHMS(r.sec)}</div>
            </div>
          ))}
          {longest && (
            <div className="row">
              <div className="grow"><div className="title">Самая длинная</div><div className="meta">{shortDate(longest.date)} · {formatHMS(longest.durationSec)}</div></div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600 }}>{formatKm(longest.distanceM)} км</div>
            </div>
          )}
        </div>
      )}
      <p className="sub">Лучшие отрезки считаются только по маршрутам, записанным через GPS.</p>
    </div>
  );
}

// Время подходов: от «Начать» или конца отдыха до галочки. Разминка не считается, подходы без времени тоже.
function SetTimeStats({ workouts, exMap, deep }: { workouts: Workout[]; exMap: Map<string, Exercise>; deep: boolean }) {
  const overall = useMemo(() => averageSetSec(workouts), [workouts]);
  const perExercise = useMemo(() => exerciseTimeStats(workouts).filter((x) => exMap.has(x.exerciseId)).slice(0, 8), [workouts, exMap]);
  const rest = useMemo(() => averageRestSec(workouts), [workouts]);
  const restBy = useMemo(() => new Map(exerciseRestStats(workouts).map((x) => [x.exerciseId, x])), [workouts]);
  const tempoBy = useMemo(() => new Map(exerciseTempoStats(workouts).map((x) => [x.exerciseId, x])), [workouts]);
  if (!overall) return null;
  return (
    <div className="section">
      <h2>Время подходов</h2>
      <div className="kpis">
        <div className="kpi"><div className="bignum">{formatSetTime(overall.avgSec)}</div><div className="sub">в среднем на подход</div></div>
        {rest
          ? <div className="kpi"><div className="bignum">{formatSetTime(rest.avgSec)}</div><div className="sub">отдых по таймеру</div></div>
          : <div className="kpi"><div className="bignum">{formatNum(overall.sets)}</div><div className="sub">подходов с временем</div></div>}
      </div>
      {deep && perExercise.length > 0 && (
        <div className="list" style={{ marginTop: 10 }}>
          {perExercise.map((x) => (
            <div key={x.exerciseId} className="row">
              <div className="grow">
                <div className="title">{exMap.get(x.exerciseId)!.name}</div>
                <div className="meta">{formatNum(x.sets)} подх. в {formatNum(x.sessions)} трен.: упражнение целиком в среднем {formatSetTime(x.avgExerciseSec)}</div>
                {(() => {
                  const r = restBy.get(x.exerciseId), t = tempoBy.get(x.exerciseId);
                  const parts: string[] = [];
                  if (t) parts.push(`темп ${formatNum(Math.round(t.secPerRep * 10) / 10)} с на повторение`);
                  if (t?.slowdownPct != null && Math.abs(t.slowdownPct) >= 10) parts.push(t.slowdownPct > 0 ? `к последнему подходу медленнее на ${Math.round(t.slowdownPct)}%` : `к последнему подходу быстрее на ${Math.round(-t.slowdownPct)}%`);
                  if (r && r.count >= 3) parts.push(`отдых ${formatSetTime(r.avgRestSec)}`);
                  return parts.length ? <div className="meta">{parts.join(' · ')}</div> : null;
                })()}
              </div>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, fontWeight: 600 }}>{formatSetTime(x.avgSetSec)}</div>
            </div>
          ))}
        </div>
      )}
      <p className="sub">Время самих подходов, без отдыха. Отдых берётся по таймеру с учётом «+15 с» и «Пропустить», ожидание после его конца входит уже в подход. Нажимай «Начать» у первого подхода упражнения, остальные считаются сами.</p>
    </div>
  );
}
