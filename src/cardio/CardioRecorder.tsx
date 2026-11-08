import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { db } from '../db/db';
import { platform } from '../platform';
import type { GeoWatchHandle } from '../platform/types';
import { INTERVAL_ROLE_LABELS, type CardioEntry, type CardioPlace, type IntervalLap, type IntervalPlan, type LatLon, type PlannedRoute, type Sport } from '../domain/types';
import { useSettings } from '../state/settings';
import { useWakeLock } from '../state/wakelock';
import { useToast } from '../ui/Toast';
import { RouteMap } from './RouteMap';
import { NavMap, type MapFailReason } from './NavMap';
import {
  ANNOUNCE_THRESHOLDS, indexRoute, initialNavState, markRerouteAttempt, navStep, remainingWaypoints, rerouteDue, resetForNewRoute, routePart,
  type NavState, type NavStatus
} from './nav';
import { SpeechQueue } from './speechQueue';
import {
  eventPhrase, expandPlan, finalLaps, initialIntervalState, intervalStep, lengthLabel, skipStep, stepProgress, targetLabel, validatePlan,
  type IntervalEvent, type IntervalSample, type IntervalState, type Step
} from './intervals';
import {
  arrivedText, backOnRouteText, coachStep, finishText, initialCoachState, maneuverText, offRouteText, rerouteFailText, rerouteOkText, reroutingText, startText,
  type CoachState
} from './voice';
import { planRoute, RouteError } from './valhalla';
import { zoneFor } from './hr';
import { addHr, newHrAcc, summarizeHr, type HrAcc } from './hrAcc';
import { startHrSession, type HrSession, type HrState } from './hrSession';
import {
  Tracker, avgPace, bestEfforts, encodeTrack, formatHMS, formatKm, formatPace, formatSpeedKmh, voiceText,
  type Fix, type TrackPoint, type TrackerState
} from './geo';

export interface ActiveRecording {
  workoutId: string; weId: string; sport: Sport; savedAt: number; state: TrackerState; hr?: HrAcc;
  place?: CardioPlace;                 // старые записи без поля считаются «просто запись»
  plan?: PlannedRoute;                 // построенный маршрут: нужен, чтобы после перезапуска продолжить навигацию
  nav?: NavState;
  targetPaceSecPerKm?: number | null;
  intervals?: { plan: IntervalPlan; state: IntervalState; activeSec: number }; // интервальная тренировка: план и где в нём остановились
}
const HR_DEVICE_KEY = 'hr.device';
const ACTIVE_KEY = 'cardio.active';

export const loadActive = async (): Promise<ActiveRecording | null> => ((await db.kv.get(ACTIVE_KEY))?.value as ActiveRecording | undefined) ?? null;
export const clearActive = () => db.kv.delete(ACTIVE_KEY);

export const gpsSupport = (): string | null => platform.geo.unsupportedReason();

type Status = 'searching' | 'recording' | 'paused';

export function toEntry(tracker: Tracker, hr?: HrAcc, place?: CardioPlace): { entry: Omit<CardioEntry, 'source' | 'trackId'>; track: TrackPoint[] } {
  const st = tracker.stats();
  const track = encodeTrack(tracker.state.points);
  return {
    entry: {
      distanceM: Math.round(st.distanceM), durationSec: Math.round(st.movingSec), elevGainM: Math.round(st.elevGainM),
      splits: st.splits.map((x) => Math.round(x)), best: bestEfforts(tracker.state.points),
      ...(hr ? summarizeHr(hr) ?? {} : {}), // пульс с датчика, если он был и отсчётов достаточно
      ...(place ? { place } : {})
    },
    track
  };
}

/** Отрезки интервальной тренировки из сохранённой записи: для итога, в том числе после перезапуска. */
export function lapsOf(a: Pick<ActiveRecording, 'intervals'>, tracker: Tracker, hr: number | null = null, maxHr: number | null = null): IntervalLap[] {
  if (!a.intervals || validatePlan(a.intervals.plan) !== null) return [];
  const st = tracker.stats();
  return finalLaps(expandPlan(a.intervals.plan), a.intervals.state, { activeSec: a.intervals.activeSec, distanceM: st.distanceM, paceSecPerKm: st.paceSecPerKm, hrBpm: hr, maxHr });
}

// Экран записи: крупные цифры, пауза и завершение. Пока экран открыт, телефон не гасит дисплей.
export function CardioRecorder({ workoutId, weId, sport, title, resume, place, plan: planIn, targetPaceSecPerKm, intervals: intervalsIn, onFinish, onDiscard, onMinimize }: {
  workoutId: string; weId: string; sport: Sport; title: string; resume?: ActiveRecording;
  place?: CardioPlace; plan?: PlannedRoute | null; targetPaceSecPerKm?: number | null; intervals?: IntervalPlan | null;
  onFinish: (r: { entry: Omit<CardioEntry, 'source' | 'trackId'>; track: TrackPoint[] }) => void;
  onDiscard: () => void;
  onMinimize: () => void;
}) {
  const toast = useToast();
  const { settings } = useSettings();
  const tracker = useRef(new Tracker(sport, resume?.state));
  const watchId = useRef<GeoWatchHandle | null>(null);
  const lastPersistAt = useRef(0);
  const hrAcc = useRef<HrAcc>(resume?.hr ?? newHrAcc());
  const hrSession = useRef<HrSession | null>(null);
  const [hrBpm, setHrBpm] = useState<number | null>(null);
  const [hrState, setHrState] = useState<HrState | 'off'>('off');
  const [hrName, setHrName] = useState<string | null>(null);
  const [hrError, setHrError] = useState<string | null>(null);
  const maxHrRef = useRef(settings.maxHr);
  maxHrRef.current = settings.maxHr;
  const statusRef = useRef<Status>(resume ? 'paused' : 'searching');
  const hiddenAt = useRef<number | null>(null);
  const [status, setStatusState] = useState<Status>(statusRef.current);
  const [stats, setStats] = useState(() => tracker.current.stats());
  const [route, setRoute] = useState<{ lat: number; lon: number }[]>(() => tracker.current.state.points);
  const [acc, setAcc] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lostSignal, setLostSignal] = useState(false);
  useWakeLock(true);

  // ---- уличный режим: построенный маршрут, навигация, голос ----
  const outdoor = place === 'outdoor';
  const [plan, setPlan] = useState<PlannedRoute | null>(resume?.plan ?? planIn ?? null);
  const routeIdx = useMemo(() => (plan ? indexRoute(plan.shape) : null), [plan]);
  const planRef = useRef(plan); planRef.current = plan;
  const idxRef = useRef(routeIdx); idxRef.current = routeIdx;
  const navRef = useRef<NavState>(resume?.nav ?? initialNavState());
  const [navStatus, setNavStatus] = useState<NavStatus | null>(null);
  const coachRef = useRef<CoachState>(initialCoachState());
  const targetRef = useRef<number | null>(resume?.targetPaceSecPerKm ?? targetPaceSecPerKm ?? null);
  const rerouting = useRef(false);

  // ---- интервалы: время считается только пока запись идёт, поэтому пауза замораживает отрезок ----
  // сохранённый план мог испортиться или устареть: проверяем, как и план из формы, иначе запись не стартует
  const resumedIv = resume?.intervals && validatePlan(resume.intervals.plan) === null ? resume.intervals : null;
  const ivPlan = resumedIv?.plan ?? intervalsIn ?? null;
  const ivSteps = useMemo<Step[]>(() => (ivPlan ? expandPlan(ivPlan) : []), [ivPlan]);
  const ivRef = useRef({ st: resumedIv?.state ?? initialIntervalState(), activeSec: resumedIv?.activeSec ?? 0, last: Date.now() });
  const [ivTick, setIvTick] = useState(0); // перерисовка экрана интервалов раз в секунду
  const [mapRequested, setMapRequested] = useState(false);
  const [mapFail, setMapFail] = useState<MapFailReason | null>(null);
  const [follow, setFollow] = useState(true);
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false); mutedRef.current = muted;
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const hrBpmRef = useRef<number | null>(null);
  const queue = useRef<SpeechQueue | null>(null);
  if (!queue.current) queue.current = new SpeechQueue({ speak: (t) => platform.speech.speak(t), stop: () => platform.speech.stop() });
  // озвучка никогда не мешает записи: все вызовы идут через очередь, которая глотает сбои движка
  const sayNav = (text: string, key?: string) => { if (!mutedRef.current && settingsRef.current.voiceNav) queue.current!.say({ text, priority: 'nav', key }); };
  const sayTrain = (text: string, key?: string, enabled: boolean = settingsRef.current.voiceCoach, ttlMs?: number) => { if (!mutedRef.current && enabled) queue.current!.say({ text, priority: 'training', key, ttlMs }); };

  // слова интервалов идут как тренировочные подсказки; устаревшие фразы (обратный отсчёт, «ускорься») в очереди не залёживаются
  const handleIvEvents = (events: IntervalEvent[]) => {
    for (const ev of events) {
      const quick = ev.kind === 'countdown' || ev.kind === 'off-target';
      sayTrain(eventPhrase(ev, sport === 'bike'), `iv-${ev.kind}-${ivRef.current.st.index}`, settingsRef.current.voiceCoach, quick ? 6000 : 20_000);
      if (settingsRef.current.vibrate) platform.haptics.vibrate(ev.kind === 'start' ? [200, 100, 200] : ev.kind === 'done' ? [300, 100, 300, 100, 300] : 100);
    }
  };
  const ivSample = (): IntervalSample => {
    const st = tracker.current.stats();
    return { activeSec: ivRef.current.activeSec, distanceM: st.distanceM, paceSecPerKm: st.paceSecPerKm, hrBpm: hrBpmRef.current, maxHr: maxHrRef.current || null };
  };
  const skipInterval = () => {
    const r = skipStep(ivSteps, ivRef.current.st, ivSample());
    ivRef.current.st = r.state; handleIvEvents(r.events); setIvTick((n) => n + 1); persist();
  };

  // Пульсометр: запомненный датчик подключается сам, новый выбирается кнопкой. Связь переустанавливается при обрывах.
  const hrSupported = platform.heartRate.unsupportedReason() === null;
  const connectHr = useCallback((id: string, name: string) => {
    void hrSession.current?.stop();
    setHrName(name);
    setHrError(null);
    hrSession.current = startHrSession(platform.heartRate, id, {
      sample: (s) => {
        if (s.contact === false || s.bpm < 30 || s.bpm > 240) { setHrBpm(null); return; }
        setHrBpm(s.bpm);
        if (statusRef.current === 'recording') hrAcc.current = addHr(hrAcc.current, s.bpm, Date.now(), maxHrRef.current);
      },
      state: (st) => { setHrState(st); if (st !== 'live') setHrBpm(null); }
    });
  }, []);
  useEffect(() => {
    if (!hrSupported) return;
    void db.kv.get(HR_DEVICE_KEY).then((row) => {
      const d = row?.value as { id: string; name: string } | undefined;
      if (d?.id) connectHr(d.id, d.name);
    });
    return () => { void hrSession.current?.stop(); hrSession.current = null; };
  }, [hrSupported, connectHr]);
  const pickHr = async () => {
    setHrError(null);
    try {
      const d = await platform.heartRate.pick();
      if (!d) return;
      await db.kv.put({ key: HR_DEVICE_KEY, value: d });
      connectHr(d.id, d.name);
    } catch (e) { setHrError(e instanceof Error ? e.message : 'Не удалось подключить пульсометр'); }
  };
  hrBpmRef.current = hrBpm;
  const hrZone = hrBpm && settings.maxHr ? zoneFor(hrBpm, settings.maxHr) : null;

  // голос и вибрация на каждом пройденном километре
  const spoken = useRef(tracker.current.stats().splits.length);
  useEffect(() => {
    const n = stats.splits.length;
    if (n <= spoken.current) return;
    spoken.current = n;
    sayTrain(voiceText(n, stats.splits[n - 1], sport === 'bike'), `km${n}`, settingsRef.current.voiceCues);
    if (settings.vibrate) platform.haptics.vibrate(200);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats.splits, settings.vibrate, sport]);

  const setStatus = (s: Status) => { statusRef.current = s; setStatusState(s); };

  const persist = useCallback(() => {
    const v: ActiveRecording = {
      workoutId, weId, sport, savedAt: Date.now(), state: tracker.current.state, ...(hrAcc.current.n > 0 ? { hr: hrAcc.current } : {}),
      ...(place ? { place } : {}), ...(planRef.current ? { plan: planRef.current, nav: navRef.current } : {}), targetPaceSecPerKm: targetRef.current,
      ...(ivPlan ? { intervals: { plan: ivPlan, state: ivRef.current.st, activeSec: ivRef.current.activeSec } } : {})
    };
    void db.kv.put({ key: ACTIVE_KEY, value: v });
  }, [workoutId, weId, sport, place, ivPlan]);

  // навигация по принятой точке и перестроение маршрута
  const persistRef = useRef<() => void>(() => {});
  persistRef.current = persist;
  const tryReroute = async (at: LatLon) => {
    const pl = planRef.current, idx = idxRef.current;
    if (!pl || !idx || rerouting.current) return;
    rerouting.current = true;
    const wps = [at, ...remainingWaypoints(pl, idx, navRef.current)];
    navRef.current = markRerouteAttempt(navRef.current, Date.now()); // считается и неудачная попытка: без сети не стучимся каждую секунду
    sayNav(reroutingText());
    try {
      const next = await planRoute(pl.profile, wps);
      planRef.current = next; idxRef.current = indexRoute(next.shape);
      navRef.current = resetForNewRoute(navRef.current);
      setPlan(next); setNavStatus(null);
      sayNav(rerouteOkText());
      persistRef.current();
    } catch (e) {
      sayNav(rerouteFailText(e instanceof RouteError && (e.kind === 'network' || e.kind === 'timeout'))); // остаёмся на сохранённом маршруте
    } finally { rerouting.current = false; }
  };
  const onAcceptedRef = useRef<(fix: Fix) => void>(() => {});
  onAcceptedRef.current = (fix) => {
    const pl = planRef.current, idx = idxRef.current;
    if (!pl || !idx || statusRef.current === 'paused') return;
    const r = navStep(pl, idx, navRef.current, { t: fix.t, lat: fix.lat, lon: fix.lon, acc: fix.acc });
    navRef.current = r.state;
    setNavStatus(r.status);
    for (const ev of r.events) {
      if (ev.kind === 'maneuver') sayNav(maneuverText(ev.maneuver, ev.thresholdM, ANNOUNCE_THRESHOLDS[pl.profile]), `m${ev.index}:${ev.thresholdM}`);
      else if (ev.kind === 'off-route') sayNav(offRouteText(ev.distM, ev.bearing));
      else if (ev.kind === 'back-on-route') sayNav(backOnRouteText());
      else sayNav(arrivedText());
    }
    if (rerouteDue(r.state, Date.now())) void tryReroute({ lat: fix.lat, lon: fix.lon });
  };

  const stopWatch = () => { if (watchId.current !== null) { watchId.current.stop(); watchId.current = null; } };

  const startWatch = useCallback(() => {
    if (watchId.current !== null) return;
    watchId.current = platform.geo.watch(
      (pos) => {
        setLostSignal(false);
        setAcc(pos.acc);
        if (statusRef.current === 'paused') return;
        const fix: Fix = { t: pos.t, lat: pos.lat, lon: pos.lon, acc: pos.acc, ele: pos.ele };
        const accepted = tracker.current.push(fix);
        if (accepted && statusRef.current === 'searching') setStatus('recording');
        if (accepted) onAcceptedRef.current(fix); // навигация видит те же принятые точки, что и трек
        // при погашенном экране таймеры браузерного движка замедляются, и сохранение раз в секунду может не успевать:
        // поэтому трек дополнительно сохраняем по приходу точек, не чаще раза в 10 секунд
        if (Date.now() - lastPersistAt.current > 10_000) { lastPersistAt.current = Date.now(); persist(); }
      },
      (kind) => {
        if (kind === 'denied') {
          setError(platform.info.native
            ? 'Доступ к местоположению запрещён. Разреши его для приложения в настройках телефона или введи результат вручную.'
            : 'Доступ к местоположению запрещён. Разреши его для этого сайта в настройках браузера или введи результат вручную.');
          stopWatch();
        } else setLostSignal(true);
      },
      { background: { title: 'Идёт запись маршрута', message: 'Нажми, чтобы вернуться к тренировке.' } }
    );
  }, [persist]);

  // запуск; при продолжении ждём нажатия «Продолжить»
  useEffect(() => {
    const unsupported = gpsSupport();
    if (unsupported) { setError(unsupported); return; }
    if (!resume) startWatch();
    return () => stopWatch();
  }, [resume, startWatch]);

  // обновление цифр и сохранение на случай перезагрузки страницы
  useEffect(() => {
    const t = window.setInterval(() => {
      setStats(tracker.current.stats());
      setRoute(tracker.current.state.points.slice());
      if (tracker.current.state.points.length) persist();
      const nowMs = Date.now();
      if (ivSteps.length) {
        const iv = ivRef.current;
        if (statusRef.current === 'recording') {
          iv.activeSec += Math.min(5, Math.max(0, (nowMs - iv.last) / 1000)); // длинный провал (экран был погашен) не засчитываем целиком
          const r = intervalStep(ivSteps, iv.st, ivSample());
          iv.st = r.state; handleIvEvents(r.events);
        }
        iv.last = nowMs;
        setIvTick((n) => n + 1);
      }
      if (statusRef.current === 'recording' && settingsRef.current.voiceCoach && !mutedRef.current) {
        const st = tracker.current.stats();
        const r = coachStep(
          { maxHr: maxHrRef.current, targetPaceSecPerKm: ivSteps.length ? null : targetRef.current, plannedM: planRef.current?.distanceM ?? null, bike: sport === 'bike' },
          coachRef.current,
          { t: Date.now(), distanceM: st.distanceM, movingSec: st.movingSec, paceSecPerKm: st.paceSecPerKm, hrBpm: hrBpmRef.current }
        );
        coachRef.current = r.state;
        r.say.forEach((t) => sayTrain(t));
      }
    }, 1000);
    const offPause = platform.lifecycle.onPause(() => { hiddenAt.current = Date.now(); persist(); });
    const offResume = platform.lifecycle.onResume(() => {
      // в браузере при погашенном экране точки не приходят; в нативной оболочке запись идёт и в фоне
      if (!platform.geo.background && hiddenAt.current && Date.now() - hiddenAt.current > 20000 && statusRef.current !== 'paused') {
        tracker.current.breakSegment(); // пока экран был выключен, точки могли не записываться
        toast('Экран был выключен: часть пути могла не записаться');
      }
      hiddenAt.current = null;
    });
    window.addEventListener('pagehide', persist);
    return () => { window.clearInterval(t); offPause(); offResume(); window.removeEventListener('pagehide', persist); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persist, toast, sport, ivSteps]);

  // приветствие при начале записи (не при продолжении после перезапуска)
  const startSpoken = useRef(!!resume);
  useEffect(() => {
    if (status !== 'recording' || startSpoken.current) return;
    startSpoken.current = true;
    const text = startText(planRef.current);
    if (planRef.current) sayNav(text); else sayTrain(text, 'start', settingsRef.current.voiceCues || settingsRef.current.voiceCoach);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const pause = () => { queue.current!.clear(); stopWatch(); setStatus('paused'); persist(); };
  const resumeRec = () => { tracker.current.breakSegment(); setStatus('searching'); startWatch(); };

  const finish = () => {
    const st = tracker.current.stats();
    if (st.distanceM < 50 && !confirm('Записано меньше 50 м. Сохранить всё равно?')) return;
    stopWatch();
    const result = toEntry(tracker.current, hrAcc.current, place);
    if (ivPlan) {
      const laps = lapsOf({ intervals: { plan: ivPlan, state: ivRef.current.st, activeSec: ivRef.current.activeSec } }, tracker.current, hrBpmRef.current, maxHrRef.current || null);
      if (laps.length) result.entry.laps = laps;
    }
    // итог звучит после закрытия экрана: очередь живёт в этом объекте и доиграет сама
    const any = settingsRef.current.voiceNav || settingsRef.current.voiceCues || settingsRef.current.voiceCoach;
    if (any && !mutedRef.current) queue.current!.say({ text: finishText({ distanceM: result.entry.distanceM, durationSec: result.entry.durationSec, hrAvg: result.entry.hrAvg }, sport === 'bike'), priority: 'training', ttlMs: 60_000 });
    onFinish(result);
  };
  const discard = () => { if (confirm('Удалить эту запись? Пройденный путь пропадёт.')) { queue.current!.clear(); stopWatch(); onDiscard(); } };

  const bike = sport === 'bike';
  const avg = useMemo(() => avgPace(stats.distanceM, stats.movingSec), [stats]);
  const avgSpeed = stats.movingSec > 0 ? stats.distanceM / stats.movingSec : null;
  const ivView = (() => {
    if (!ivSteps.length || ivTick < 0) return null;
    const { st, activeSec } = ivRef.current;
    if (st.done) return { label: 'Интервалы закончены', big: '✓', unit: '', target: '', next: 'Можно завершать запись', fraction: 1, canSkip: false };
    if (!st.started) return { label: 'Интервалы', big: '', unit: '', target: '', next: 'Начнутся вместе с записью', fraction: 0, canSkip: false };
    const step = ivSteps[st.index];
    if (!step) return null;
    const pr = stepProgress(step, st, { activeSec, distanceM: stats.distanceM });
    const label = step.role === 'work' || step.role === 'rest' ? `${INTERVAL_ROLE_LABELS[step.role]} ${step.rep} из ${step.reps}` : INTERVAL_ROLE_LABELS[step.role];
    const nx = ivSteps[st.index + 1];
    return {
      label,
      big: pr.unit === 'sec' ? formatHMS(Math.ceil(pr.remaining)).replace(/^00:/, '') : String(Math.ceil(pr.remaining / 10) * 10),
      unit: pr.unit === 'sec' ? '' : 'м',
      target: targetLabel(step.target, bike),
      next: nx ? `Дальше: ${INTERVAL_ROLE_LABELS[nx.role].toLowerCase()} ${lengthLabel(nx.length)}` : 'Это последний отрезок',
      fraction: pr.fraction, canSkip: true
    };
  })();
  const quality = acc === null ? null : acc <= 10 ? 'good' : acc <= 20 ? 'ok' : 'weak';

  return (
    <div className="rec-screen" role="dialog" aria-modal="true" aria-label="Запись маршрута">
      <header className="rec-head">
        <div className="grow">
          <div className="chat-title">{title}</div>
          <div className="sub">
            {status === 'recording' ? 'Идёт запись' : status === 'paused' ? 'Пауза' : error ? 'GPS недоступен' : lostSignal ? 'Нет сигнала GPS…' : 'Ищу сигнал GPS…'}
            {quality && <span className={'gps-dot ' + quality} title={`Точность ${Math.round(acc ?? 0)} м`} />}
          </div>
        </div>
        <button className="btn small ghost" onClick={onMinimize}>Свернуть</button>
      </header>

      {error ? (
        <div style={{ padding: 20 }}>
          <p className="msg-error">{error}</p>
          <button className="btn block" style={{ marginTop: 12 }} onClick={onDiscard}>Закрыть</button>
        </div>
      ) : (
        <>
          <div className="rec-main">
            <div className="rec-big" aria-live="off"><span>{formatKm(stats.distanceM)}</span><small>км</small></div>
            <div className="rec-row">
              <div><div className="rec-num">{formatHMS(stats.movingSec)}</div><div className="sub">время</div></div>
              <div><div className="rec-num">{bike ? formatSpeedKmh(stats.speedMps) : formatPace(stats.paceSecPerKm)}</div><div className="sub">{bike ? 'км/ч сейчас' : 'темп, мин/км'}</div></div>
              <div><div className="rec-num">{bike ? formatSpeedKmh(avgSpeed) : formatPace(avg)}</div><div className="sub">{bike ? 'км/ч средняя' : 'средний'}</div></div>
            </div>
          </div>
          {ivView && (
            <div className={'rec-interval' + (ivView.canSkip ? '' : ' idle')}>
              <div className="rec-iv-label" role="status" aria-live="polite">{ivView.label}</div>
              <div className="rec-iv-big" aria-live="off">{ivView.big}{ivView.unit && <small> {ivView.unit}</small>}</div>
              {ivView.target && <div className="sub">Цель: {ivView.target}</div>}
              <div className="rec-iv-bar" aria-hidden="true"><span style={{ width: `${Math.round(ivView.fraction * 100)}%` }} /></div>
              <div className="sub">{ivView.next}</div>
              {ivView.canSkip && <button className="btn small ghost" onClick={skipInterval}>Пропустить отрезок</button>}
            </div>
          )}
          {hrSupported && (
            <div className="rec-hr" aria-live="off">
              {hrBpm ? (
                <><span className="rec-hr-num">{hrBpm}</span> <small>уд/мин</small>{hrZone && <span className={'rec-hr-zone z' + hrZone.n}> зона {hrZone.n} · {hrZone.name}</span>}</>
              ) : hrState === 'connecting' || hrState === 'reconnecting' ? (
                <span className="sub">{hrName ?? 'Пульсометр'}: {hrState === 'connecting' ? 'подключаюсь…' : 'ищу связь…'}</span>
              ) : hrState === 'live' ? (
                <span className="sub">{hrName ?? 'Пульсометр'}: нет контакта с кожей</span>
              ) : (
                <button className="btn small" onClick={() => void pickHr()}>{hrState === 'failed' ? 'Пульсометр не найден: выбрать заново' : 'Подключить пульсометр'}</button>
              )}
              {hrError && <div className="msg-error" style={{ marginTop: 4 }}>{hrError}</div>}
            </div>
          )}
          {outdoor && plan && (
            <div className={'nav-strip' + (navStatus?.off ? ' off' : '')} role="status" aria-live="polite">
              {navStatus === null ? (
                <div className="nav-text">Маршрут {formatKm(plan.distanceM)} км. Иди, подсказки появятся с первыми точками GPS.</div>
              ) : navStatus.off ? (
                <div className="nav-text"><b>Вы вне маршрута</b>{navStatus.offRouteM !== null ? ` · ${Math.round(navStatus.offRouteM)} м до него` : ''}. Перестраиваю или вернись на линию.</div>
              ) : navStatus.arrived ? (
                <div className="nav-text"><b>Финиш.</b> Можно завершать запись.</div>
              ) : (
                <>
                  <div className="nav-dist">{navStatus.distToNextM === null ? '—' : navStatus.distToNextM >= 1000 ? `${(navStatus.distToNextM / 1000).toFixed(1)} км` : `${Math.round(navStatus.distToNextM / 5) * 5} м`}</div>
                  <div className="nav-text">{navStatus.nextIndex !== null ? plan.maneuvers[navStatus.nextIndex].instruction : 'Прямо до конца маршрута'}<div className="sub">Осталось {formatKm(navStatus.remainingM)} км</div></div>
                </>
              )}
            </div>
          )}
          {outdoor && (plan || mapRequested) && !mapFail ? (
            <>
              <NavMap
                className="tall" route={plan} routeDone={plan && routeIdx && navStatus ? routePart(routeIdx, 0, navStatus.alongM) : undefined}
                track={route} current={route.length ? route[route.length - 1] : null} follow={follow} onFollowChange={setFollow} onFail={setMapFail}
              />
              <div className="map-actions">
                {!follow && <button className="btn small" onClick={() => setFollow(true)}>Центрировать</button>}
              </div>
            </>
          ) : (
            <>
              {mapFail && <p className="msg-error" role="status">Карта недоступна, запись продолжается. Маршрут показан линией.</p>}
              <RouteMap points={route} live ghost={plan?.shape} />
              {outdoor && !plan && !mapFail && <button className="btn small ghost" onClick={() => setMapRequested(true)}>Показать карту</button>}
            </>
          )}
          {outdoor && platform.speech.available && (settings.voiceNav || settings.voiceCues || settings.voiceCoach) && (
            <button className="btn small ghost" aria-pressed={!muted} onClick={() => { if (!muted) queue.current!.clear(); setMuted(!muted); }}>{muted ? 'Включить голос' : 'Выключить голос'}</button>
          )}
          {stats.splits.length > 0 && (
            <div className="splits-line">Последний км: {formatHMS(stats.splits[stats.splits.length - 1])}{stats.elevGainM >= 1 ? ` · набор ${Math.round(stats.elevGainM)} м` : ''}</div>
          )}
          <div className="rec-actions">
            {status === 'paused'
              ? <button className="btn primary" onClick={resumeRec}>Продолжить</button>
              : <button className="btn" onClick={pause}>Пауза</button>}
            <button className="btn primary" onClick={finish}>Завершить</button>
          </div>
          <button className="btn danger ghost block" style={{ marginTop: 6 }} onClick={discard}>Отбросить запись</button>
          <p className="sub" style={{ textAlign: 'center', marginTop: 10 }}>{platform.geo.background ? 'Экран можно гасить: запись продолжится в фоне.' : 'Не блокируй телефон: в браузере трек пишется, только пока экран включён.'}</p>
        </>
      )}
    </div>
  );
}
