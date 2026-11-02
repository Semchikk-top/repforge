import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { db } from '../db/db';
import { platform } from '../platform';
import type { GeoWatchHandle } from '../platform/types';
import type { CardioEntry, Sport } from '../domain/types';
import { useSettings } from '../state/settings';
import { useWakeLock } from '../state/wakelock';
import { useToast } from '../ui/Toast';
import { RouteMap } from './RouteMap';
import { zoneFor } from './hr';
import { addHr, newHrAcc, summarizeHr, type HrAcc } from './hrAcc';
import { startHrSession, type HrSession, type HrState } from './hrSession';
import {
  Tracker, avgPace, bestEfforts, encodeTrack, formatHMS, formatKm, formatPace, formatSpeedKmh, voiceText,
  type Fix, type TrackPoint, type TrackerState
} from './geo';

export interface ActiveRecording { workoutId: string; weId: string; sport: Sport; savedAt: number; state: TrackerState; hr?: HrAcc }
const HR_DEVICE_KEY = 'hr.device';
const ACTIVE_KEY = 'cardio.active';

export const loadActive = async (): Promise<ActiveRecording | null> => ((await db.kv.get(ACTIVE_KEY))?.value as ActiveRecording | undefined) ?? null;
export const clearActive = () => db.kv.delete(ACTIVE_KEY);

export const gpsSupport = (): string | null => platform.geo.unsupportedReason();

type Status = 'searching' | 'recording' | 'paused';

export function toEntry(tracker: Tracker, hr?: HrAcc): { entry: Omit<CardioEntry, 'source' | 'trackId'>; track: TrackPoint[] } {
  const st = tracker.stats();
  const track = encodeTrack(tracker.state.points);
  return {
    entry: {
      distanceM: Math.round(st.distanceM), durationSec: Math.round(st.movingSec), elevGainM: Math.round(st.elevGainM),
      splits: st.splits.map((x) => Math.round(x)), best: bestEfforts(tracker.state.points),
      ...(hr ? summarizeHr(hr) ?? {} : {}) // пульс с датчика, если он был и отсчётов достаточно
    },
    track
  };
}

// Экран записи: крупные цифры, пауза и завершение. Пока экран открыт, телефон не гасит дисплей.
export function CardioRecorder({ workoutId, weId, sport, title, resume, onFinish, onDiscard, onMinimize }: {
  workoutId: string; weId: string; sport: Sport; title: string; resume?: ActiveRecording;
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
  const hrZone = hrBpm && settings.maxHr ? zoneFor(hrBpm, settings.maxHr) : null;

  // голос и вибрация на каждом пройденном километре
  const spoken = useRef(tracker.current.stats().splits.length);
  useEffect(() => {
    const n = stats.splits.length;
    if (n <= spoken.current) return;
    spoken.current = n;
    if (settings.voiceCues && 'speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(voiceText(n, stats.splits[n - 1], sport === 'bike'));
      u.lang = 'ru-RU';
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    }
    if (settings.vibrate) platform.haptics.vibrate(200);
  }, [stats.splits, settings.voiceCues, settings.vibrate, sport]);

  const setStatus = (s: Status) => { statusRef.current = s; setStatusState(s); };

  const persist = useCallback(() => {
    const v: ActiveRecording = { workoutId, weId, sport, savedAt: Date.now(), state: tracker.current.state, ...(hrAcc.current.n > 0 ? { hr: hrAcc.current } : {}) };
    void db.kv.put({ key: ACTIVE_KEY, value: v });
  }, [workoutId, weId, sport]);

  const stopWatch = () => { if (watchId.current !== null) { watchId.current.stop(); watchId.current = null; } };

  const startWatch = useCallback(() => {
    if (watchId.current !== null) return;
    watchId.current = platform.geo.watch(
      (pos) => {
        setLostSignal(false);
        setAcc(pos.acc);
        if (statusRef.current === 'paused') return;
        const fix: Fix = { t: pos.t, lat: pos.lat, lon: pos.lon, acc: pos.acc, ele: pos.ele };
        if (tracker.current.push(fix) && statusRef.current === 'searching') setStatus('recording');
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
  }, [persist, toast]);

  const pause = () => { stopWatch(); setStatus('paused'); persist(); };
  const resumeRec = () => { tracker.current.breakSegment(); setStatus('searching'); startWatch(); };

  const finish = () => {
    const st = tracker.current.stats();
    if (st.distanceM < 50 && !confirm('Записано меньше 50 м. Сохранить всё равно?')) return;
    stopWatch();
    onFinish(toEntry(tracker.current, hrAcc.current));
  };
  const discard = () => { if (confirm('Удалить эту запись? Пройденный путь пропадёт.')) { stopWatch(); onDiscard(); } };

  const bike = sport === 'bike';
  const avg = useMemo(() => avgPace(stats.distanceM, stats.movingSec), [stats]);
  const avgSpeed = stats.movingSec > 0 ? stats.distanceM / stats.movingSec : null;
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
          <RouteMap points={route} live />
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
