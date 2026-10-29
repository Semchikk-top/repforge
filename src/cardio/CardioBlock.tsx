import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { putTrack, softDelete } from '../db/repo';
import { lastCardio } from '../domain/analytics';
import { sportOf, type CardioEntry, type Exercise, type Workout, type WorkoutExercise } from '../domain/types';
import { uid } from '../lib';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';
import { CardioRecorder, clearActive, gpsSupport, loadActive, toEntry, type ActiveRecording } from './CardioRecorder';
import { RouteMap } from './RouteMap';
import { estimateMaxHr, validHr, zoneFor, zoneRanges } from './hr';
import { ElevationChart, RouteCompare } from './CardioExtras';
import { useSettings } from '../state/settings';
import { toGpx, trimRoute } from './gpx';
import { Tracker, analyzeSplits, avgPace, decodePoint, elevationFromPoints, formatHMS, formatKm, formatPace, formatSpeedKmh, type TrackPoint } from './geo';

interface Props {
  workout: Workout;
  we: WorkoutExercise;
  exercise: Exercise | undefined;
  history: Workout[];
  onBegin: () => void;                          // начать тренировку, если она ещё в плане
  onSave: (c: CardioEntry | undefined) => Promise<unknown>;
}

export function CardioBlock({ workout, we, exercise, history, onBegin, onSave }: Props) {
  const toast = useToast();
  const { settings } = useSettings();
  const sport = exercise ? sportOf(exercise) : 'run';
  const bike = sport === 'bike';
  const c = we.cardio;

  const [rec, setRec] = useState<{ resume?: ActiveRecording } | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [pending, setPending] = useState<ActiveRecording | null>(null);
  const [manual, setManual] = useState(false);
  const [pulse, setPulse] = useState(false);
  const [byPace, setByPace] = useState(false);
  const [compare, setCompare] = useState(false);

  // запись могла прерваться (перезагрузка страницы, закрытая вкладка): предлагаем продолжить или сохранить
  useEffect(() => {
    void loadActive().then((a) => { if (a && a.weId === we.id && a.workoutId === workout.id) setPending(a); });
  }, [we.id, workout.id]);

  const track = useLiveQuery(() => (c?.trackId ? db.tracks.get(c.trackId) : undefined), [c?.trackId]);
  const fullRoute = useMemo(() => (track && !track.deletedAt ? track.points.map(decodePoint) : []), [track]);
  const route = useMemo(() => trimRoute(fullRoute, settings.privacyZoneM), [fullRoute, settings.privacyZoneM]);
  const elevation = useMemo(() => elevationFromPoints(route), [route]);
  const analysis = useMemo(() => (c?.splits ? analyzeSplits(c.splits) : null), [c?.splits]);
  const hiddenByZone = fullRoute.length > 1 && route.length === 0;
  const last = useMemo(() => lastCardio(history, we.exerciseId, workout.id), [history, we.exerciseId, workout.id]);

  const saveRecording = async (entry: Omit<CardioEntry, 'source' | 'trackId'>, points: TrackPoint[]) => {
    const old = c?.trackId;
    const id = uid();
    await putTrack({ id, createdAt: Date.now(), workoutId: workout.id, points });
    if (old) await softDelete('tracks', old);
    await onSave({ ...entry, source: 'gps', trackId: id });
    await clearActive();
    setRec(null); setMinimized(false); setPending(null);
    toast('Маршрут сохранён');
  };

  const exportGpx = () => {
    if (!track || track.deletedAt) return;
    const name = `${exercise?.name ?? 'Тренировка'} ${workout.date}`;
    const xml = toGpx(name, workout.startedAt ?? Date.parse(workout.date), track.points, settings.privacyZoneM);
    const url = URL.createObjectURL(new Blob([xml], { type: 'application/gpx+xml' }));
    const a = document.createElement('a');
    a.href = url; a.download = `${workout.date}-${sport}.gpx`;
    document.body.appendChild(a); a.click(); a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  const remove = async () => {
    if (!confirm('Удалить результат и маршрут?')) return;
    if (c?.trackId) await softDelete('tracks', c.trackId);
    await onSave(undefined);
  };

  const begin = (resume?: ActiveRecording) => { onBegin(); setPending(null); setMinimized(false); setRec({ resume }); };

  const finishPending = async () => {
    if (!pending) return;
    const { entry, track: pts } = toEntry(new Tracker(sport, pending.state));
    if (entry.distanceM < 20) { await clearActive(); setPending(null); toast('Запись была слишком короткой, отброшена'); return; }
    await saveRecording(entry, pts);
  };

  const gpsNote = gpsSupport();
  const pace = c ? avgPace(c.distanceM, c.durationSec) : null;
  const speed = c && c.durationSec > 0 ? c.distanceM / c.durationSec : null;

  return (
    <div className="cardio">
      {!c && last && (
        <div className="hint">В прошлый раз: {formatKm(last.distanceM)} км, {bike ? `${formatSpeedKmh(last.distanceM / Math.max(1, last.durationSec))} км/ч` : `${formatPace(avgPace(last.distanceM, last.durationSec))} мин/км`}</div>
      )}

      {pending && !rec && (
        <div className="notice" role="status">
          <p style={{ margin: 0 }}>Есть незавершённая запись: {formatKm(pending.state.distanceM)} км. Приложение могло закрыться посреди тренировки.</p>
          <div className="conn-actions">
            <button className="btn small primary" onClick={() => begin(pending)}>Продолжить</button>
            <button className="btn small" onClick={() => void finishPending()}>Сохранить как есть</button>
            <button className="btn small danger" onClick={async () => { if (confirm('Отбросить незавершённую запись?')) { await clearActive(); setPending(null); } }}>Отбросить</button>
          </div>
        </div>
      )}

      {rec && minimized && (
        <button className="btn primary block" onClick={() => setMinimized(false)}>Идёт запись. Открыть</button>
      )}

      {!c && !rec && !pending && (
        <>
          <div className="conn-actions" style={{ marginTop: 10 }}>
            <button className="btn primary" disabled={!!gpsNote} onClick={() => begin()}>Начать запись GPS</button>
            <button className="btn" onClick={() => setManual(true)}>Ввести вручную</button>
          </div>
          {gpsNote && <p className="sub" style={{ marginTop: 8 }}>{gpsNote}</p>}
        </>
      )}

      {c && (
        <>
          <div className="cardio-grid">
            <div><div className="cardio-num">{formatKm(c.distanceM)}</div><div className="sub">км</div></div>
            <div><div className="cardio-num">{formatHMS(c.durationSec)}</div><div className="sub">время</div></div>
            <div><div className="cardio-num">{bike ? formatSpeedKmh(speed) : formatPace(pace)}</div><div className="sub">{bike ? 'км/ч' : 'мин/км'}</div></div>
            {c.elevGainM ? <div><div className="cardio-num">{c.elevGainM}</div><div className="sub">м набор</div></div> : null}
          </div>
          {route.length > 1 && <RouteMap points={route} colorByPace={byPace} />}
          {route.length > 2 && <div className="chips wrap"><button className={'chip' + (byPace ? ' on' : '')} aria-pressed={byPace} onClick={() => setByPace(!byPace)}>Цвет по темпу</button>{byPace && <span className="sub" style={{ alignSelf: 'center' }}>синий: медленнее, оранжевый: быстрее</span>}</div>}
          {elevation && <ElevationChart profile={elevation} />}
          {hiddenByZone && <p className="sub">Маршрут короче зоны приватности ({settings.privacyZoneM} м с каждого конца), поэтому скрыт.</p>}
          {route.length > 1 && settings.privacyZoneM > 0 && <p className="sub">Начало и конец маршрута скрыты (зона приватности {settings.privacyZoneM} м).</p>}
          {c.splits && c.splits.length > 0 && <Splits splits={c.splits} bike={bike} />}
          {analysis && !bike && <p className="sub" style={{ marginTop: 8 }}>{analysis.text}</p>}
          {c.best && Object.keys(c.best).length > 0 && (
            <p className="sub" style={{ marginTop: 8 }}>
              Лучшие отрезки: {Object.entries(c.best).map(([m, t]) => `${Number(m) / 1000} км — ${formatHMS(t)}`).join(' · ')}
            </p>
          )}
          {c.hrAvg ? <p className="sub" style={{ marginTop: 8 }}>Пульс {c.hrAvg}{c.hrMax ? ` (макс. ${c.hrMax})` : ''} уд/мин{(() => { const z = settings.maxHr ? zoneFor(c.hrAvg, settings.maxHr) : null; return z ? ` · зона ${z.n}: ${z.name}` : settings.maxHr ? '' : ' · задайте максимальный пульс, чтобы увидеть зону'; })()}</p> : null}
          <div className="ex-actions">
            <button className="btn small" onClick={() => setPulse(true)}>{c.hrAvg ? 'Пульс' : 'Добавить пульс'}</button>
            {c.source === 'manual' && <button className="btn small" onClick={() => setManual(true)}>Изменить</button>}
            {c.source === 'gps' && fullRoute.length > 1 && <button className="btn small" onClick={exportGpx}>Экспорт GPX</button>}
            {c.source === 'gps' && fullRoute.length > 1 && <button className="btn small" onClick={() => setCompare(true)}>Тот же маршрут</button>}
            <button className="btn small ghost danger" onClick={() => void remove()}>Удалить результат</button>
          </div>
        </>
      )}

      {rec && (
        <div style={{ display: minimized ? 'none' : undefined }}>
          <CardioRecorder
            workoutId={workout.id} weId={we.id} sport={sport} title={exercise?.name ?? 'Запись'} resume={rec.resume}
            onFinish={(r) => void saveRecording(r.entry, r.track)}
            onDiscard={async () => { await clearActive(); setRec(null); setMinimized(false); }}
            onMinimize={() => setMinimized(true)}
          />
        </div>
      )}

      {compare && c && <RouteCompare workoutId={workout.id} current={c} currentRoute={fullRoute} zoneM={settings.privacyZoneM} bike={bike} onClose={() => setCompare(false)} />}

      {pulse && c && <PulseSheet entry={c} onClose={() => setPulse(false)} onSave={async (e) => { await onSave(e); setPulse(false); }} />}

      {manual && <ManualCardio initial={c} bike={bike} onClose={() => setManual(false)} onSave={async (entry) => { await onSave(entry); setManual(false); }} />}
    </div>
  );
}

function Splits({ splits, bike }: { splits: number[]; bike: boolean }) {
  const max = Math.max(...splits), min = Math.min(...splits);
  return (
    <div className="splits" aria-label="Километры">
      {splits.map((s, i) => (
        <div key={i} className="split-row">
          <span className="split-km">{i + 1}</span>
          <div className="split-bar"><i style={{ width: `${40 + (60 * (max - s)) / Math.max(1, max - min || 1)}%`, opacity: s === min ? 1 : 0.55 }} /></div>
          <span className="split-t">{bike ? `${formatSpeedKmh(1000 / s)} км/ч` : formatHMS(s)}</span>
        </div>
      ))}
    </div>
  );
}

function ManualCardio({ initial, bike, onSave, onClose }: { initial?: CardioEntry; bike: boolean; onSave: (c: CardioEntry) => Promise<void>; onClose: () => void }) {
  const [km, setKm] = useState(initial ? String(initial.distanceM / 1000) : '');
  const [h, setH] = useState(initial ? String(Math.floor(initial.durationSec / 3600)) : '0');
  const [m, setM] = useState(initial ? String(Math.floor((initial.durationSec % 3600) / 60)) : '');
  const [s, setS] = useState(initial ? String(initial.durationSec % 60) : '0');

  const distanceM = Math.round(parseFloat(km.replace(',', '.')) * 1000);
  const durationSec = (parseInt(h, 10) || 0) * 3600 + (parseInt(m, 10) || 0) * 60 + (parseInt(s, 10) || 0);
  const valid = Number.isFinite(distanceM) && distanceM > 0 && distanceM <= 1_000_000 && durationSec > 0 && durationSec <= 48 * 3600;

  return (
    <Sheet title="Результат вручную" onClose={onClose}>
      <div className="field">
        <label htmlFor="mc-km">Дистанция, км</label>
        <input id="mc-km" className="input" inputMode="decimal" value={km} onChange={(e) => setKm(e.target.value)} placeholder="5.2" />
      </div>
      <div className="field">
        <label>Время</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" aria-label="Часы" inputMode="numeric" value={h} onChange={(e) => setH(e.target.value)} />
          <input className="input" aria-label="Минуты" inputMode="numeric" value={m} onChange={(e) => setM(e.target.value)} placeholder="мин" />
          <input className="input" aria-label="Секунды" inputMode="numeric" value={s} onChange={(e) => setS(e.target.value)} />
        </div>
        <span className="sub">часы · минуты · секунды</span>
      </div>
      {valid && <p className="sub">{bike ? `Средняя скорость ${formatSpeedKmh(distanceM / durationSec)} км/ч` : `Средний темп ${formatPace(avgPace(distanceM, durationSec))} мин/км`}</p>}
      <button className="btn primary block" disabled={!valid} onClick={() => void onSave({ source: 'manual', distanceM, durationSec, ...(initial?.hrAvg ? { hrAvg: initial.hrAvg } : {}), ...(initial?.hrMax ? { hrMax: initial.hrMax } : {}) })}>Сохранить</button>
    </Sheet>
  );
}

/** Пульс вводится вручную (с часов, датчика или тренажёра); максимальный пульс хранится в настройках и нужен для зон. */
function PulseSheet({ entry, onSave, onClose }: { entry: CardioEntry; onSave: (c: CardioEntry) => Promise<void>; onClose: () => void }) {
  const { settings, update } = useSettings();
  const [avg, setAvg] = useState(entry.hrAvg ? String(entry.hrAvg) : '');
  const [mx, setMx] = useState(entry.hrMax ? String(entry.hrMax) : '');
  const [maxHr, setMaxHr] = useState(settings.maxHr ? String(settings.maxHr) : '');
  const [age, setAge] = useState('');
  const a = parseInt(avg, 10), m = parseInt(mx, 10), cap = parseInt(maxHr, 10);
  const avgOk = avg === '' || validHr(a);
  const mxOk = mx === '' || (validHr(m) && (avg === '' || m >= a));
  const capOk = maxHr === '' || (validHr(cap) && cap >= 100);
  const effective = capOk && maxHr !== '' ? cap : 0;
  const zone = effective && validHr(a) ? zoneFor(a, effective) : null;
  const ageN = parseInt(age, 10);

  return (
    <Sheet title="Пульс" onClose={onClose}>
      <div className="field"><label htmlFor="hr-avg">Средний пульс, уд/мин</label><input id="hr-avg" className="input" inputMode="numeric" value={avg} onChange={(e) => setAvg(e.target.value)} /></div>
      <div className="field"><label htmlFor="hr-max">Максимальный за тренировку</label><input id="hr-max" className="input" inputMode="numeric" value={mx} onChange={(e) => setMx(e.target.value)} />{!mxOk && <span className="sub">Должен быть не меньше среднего, от 30 до 240</span>}</div>
      <div className="field">
        <label htmlFor="hr-cap">Ваш предельный пульс (для зон)</label>
        <input id="hr-cap" className="input" inputMode="numeric" value={maxHr} onChange={(e) => setMaxHr(e.target.value)} placeholder="например, 185" />
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <input className="input" aria-label="Возраст" inputMode="numeric" value={age} onChange={(e) => setAge(e.target.value)} placeholder="возраст" />
          <button className="btn" disabled={!(ageN >= 10 && ageN <= 100)} onClick={() => setMaxHr(String(estimateMaxHr(ageN)))}>Оценить</button>
        </div>
        <span className="sub">Оценка по возрасту (208 − 0,7 × возраст) приблизительна; точнее знать свой реальный максимум.</span>
      </div>
      {zone && <p>Зона {zone.n}: {zone.name}</p>}
      {effective >= 100 && (
        <div className="hr-zones" aria-label="Пульсовые зоны">
          {zoneRanges(effective).map(({ zone: z, lo, hi }) => <div key={z.n} className={'sub' + (zone?.n === z.n ? ' on' : '')}>Зона {z.n} · {z.name}: {lo}–{hi}</div>)}
        </div>
      )}
      <button className="btn primary block" style={{ marginTop: 10 }} disabled={!avgOk || !mxOk || !capOk} onClick={() => {
        update({ maxHr: effective });
        const { hrAvg: _a, hrMax: _m, ...rest } = entry;
        void onSave({ ...rest, ...(validHr(a) ? { hrAvg: a } : {}), ...(validHr(m) ? { hrMax: m } : {}) });
      }}>Сохранить</button>
    </Sheet>
  );
}
