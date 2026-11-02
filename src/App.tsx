import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { db } from './db/db';
import { ensureSeeds, getDeviceId, newWorkout } from './db/repo';
import { ensureProfileMeta } from './social/store';
import { startWorldSync } from './social/world';
import { todayStr } from './lib';
import { go, replace, useRoute } from './state/router';
import { pairWithCode, startSyncEngine } from './sync/sync';
import { parsePairLink } from './sync/server-url';
import { confirmServer } from './sync/pairLink';
import { platform } from './platform';
import { useToast } from './ui/Toast';
import { useRestTimer } from './state/timer';
import { BottomNav } from './ui/BottomNav';
import { TimerBar } from './ui/TimerBar';
import { CalendarView } from './views/CalendarView';
import { ExercisesView } from './views/ExercisesView';
import { WorkoutHub } from './views/WorkoutHub';
import { WorkoutSession } from './views/WorkoutSession';
import { useReminder } from './state/reminder';
import { useScheduledReminders } from './state/reminderSchedule';
import { useCheckInReminders } from './state/checkinReminders';
import { useAutoBackup } from './state/autoBackupHook';
import { IconSpark } from './ui/Icons';
import { PairingApproval } from './ui/PairingApproval';
import { RoomBar } from './ui/RoomBar';
import { useRoom } from './nearby/useRoom';
import { GameEffects } from './game/GameEffects';
import { SyncNotice } from './ui/SyncNotice';

// Редко открываемые экраны грузятся по требованию: главный чанк меньше, первый экран появляется быстрее.
// Календарь, «Тренировка», упражнения и сама тренировка остаются в основном чанке: они нужны сразу и без сети.
const LegalView = lazy(() => import('./views/LegalView').then((m) => ({ default: m.LegalView })));
const SettingsView = lazy(() => import('./views/SettingsView').then((m) => ({ default: m.SettingsView })));
const StatsView = lazy(() => import('./views/StatsView').then((m) => ({ default: m.StatsView })));
const RatingsView = lazy(() => import('./views/RatingsView').then((m) => ({ default: m.RatingsView })));
const AssistantView = lazy(() => import('./views/AssistantView').then((m) => ({ default: m.AssistantView })));
const RecordsView = lazy(() => import('./views/RecordsView').then((m) => ({ default: m.RecordsView })));
const ProgramsView = lazy(() => import('./views/ProgramsView').then((m) => ({ default: m.ProgramsView })));
const CheckInView = lazy(() => import('./views/CheckInView').then((m) => ({ default: m.CheckInView })));
const OnboardingView = lazy(() => import('./views/OnboardingView').then((m) => ({ default: m.OnboardingView })));
const ProfileView = lazy(() => import('./views/ProfileView').then((m) => ({ default: m.ProfileView })));
const DiagnosticsView = lazy(() => import('./views/DiagnosticsView'));

// Код одноразовый, а StrictMode запускает эффекты дважды: защищаемся от повторного запроса
const pairing = new Map<string, Promise<void>>();
function pairOnce(code: string, baseUrl = '') {
  const key = `${baseUrl}|${code}`;
  if (!pairing.has(key)) pairing.set(key, pairWithCode(code, baseUrl));
  return pairing.get(key)!;
}

const NAV_ORDER = ['calendar', 'workout', 'stats', 'exercises', 'profile', 'assistant'];

/** Фоновая работа не должна конкурировать с первым экраном: даём браузеру дорисовать календарь. */
function scheduleIdle(fn: () => void) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 250); // Safari до недавних версий не умеет requestIdleCallback
}

export default function App() {
  const [ready, setReady] = useState(false);
  const segs = useRoute();
  const timer = useRestTimer();
  const toast = useToast();
  const roomPhase = useRoom().phase;

  useEffect(() => {
    let alive = true;
    // ensureSeeds и deviceId независимы — читаем их параллельно. ensureProfileMeta идёт после deviceId:
    // putProfile проставляет deviceId, и при гонке двух первых чтений они могли бы создать разные личности.
    void Promise.all([ensureSeeds(), getDeviceId()])
      .then(() => ensureProfileMeta())
      .catch(() => { /* локальная инициализация не должна блокировать UI навсегда */ })
      .finally(() => {
        if (!alive) return;
        setReady(true);
        // Синхронизация и мировой рейтинг ходят в сеть: запускаем их после первой отрисовки,
        // иначе они отбирают канал и главный поток у календаря.
        scheduleIdle(() => { void startSyncEngine(); startWorldSync(); });
      });
    return () => { alive = false; };
  }, []);

  // ссылка из QR: #/pair/КОД — подключаем устройство автоматически
  const pairCode = segs[0] === 'pair' ? segs[1] : undefined;
  useEffect(() => {
    if (!ready || !pairCode) return;
    pairOnce(pairCode)
      .then(() => toast('Устройство подключено'))
      .catch((e: unknown) => toast(e instanceof Error ? e.message : 'Не удалось подключиться'))
      .finally(() => replace('settings'));
  }, [ready, pairCode, toast]);

  // нативная оболочка: workout://pair?url=…&code=… открывает приложение и подключает устройство.
  // Ссылку мог прислать кто угодно, а подключение отправляет на сервер все данные, поэтому адрес показываем и спрашиваем.
  useEffect(() => {
    if (!ready) return;
    return platform.lifecycle.onOpenUrl((url) => {
      let target;
      try { target = parsePairLink(url); } catch (e) { toast(e instanceof Error ? e.message : 'Ссылка не подошла'); return; }
      if (!target) return;
      if (!confirmServer(target.baseUrl)) return;
      pairOnce(target.code, target.baseUrl)
        .then(() => toast('Устройство подключено'))
        .catch((e: unknown) => toast(e instanceof Error ? e.message : 'Не удалось подключиться'))
        .finally(() => replace('settings'));
    });
  }, [ready, toast]);

  // быстрые ссылки (ярлыки на иконке приложения): #/quick/start и #/quick/current
  const { due, dismiss } = useReminder();
  useScheduledReminders();
  useCheckInReminders();
  useAutoBackup();
  const quickBusy = useRef(false);
  useEffect(() => {
    if (!ready || segs[0] !== 'quick' || quickBusy.current) return;
    quickBusy.current = true;
    void (async () => {
      const active = await db.workouts.where('status').equals('active').filter((w) => !w.deletedAt).first();
      if (segs[1] === 'start' && !active) {
        const w = await newWorkout({ date: todayStr(), status: 'active', title: 'Тренировка', startedAt: Date.now(), exercises: [] });
        replace(`workout/${w.id}`);
      } else replace(active ? `workout/${active.id}` : 'workout');
    })().finally(() => { quickBusy.current = false; });
  }, [ready, segs]);

  const tab = segs[0] ?? 'calendar';
  const navTab = tab === 'pair' || tab === 'settings' || tab === 'diagnostics' || tab === 'privacy' ? 'profile' : tab === 'records' || tab === 'ratings' ? 'stats' : tab === 'checkin' ? 'calendar' : tab === 'start' ? 'workout' : tab === 'programs' ? 'workout' : tab === 'quick' ? 'workout' : tab;

  // Направление перехода: вкладка правее или экран «глубже» — въезжает справа, иначе слева
  const level = NAV_ORDER.indexOf(navTab) * 2 + ((tab === 'workout' && segs[1]) || tab === 'records' || tab === 'ratings' || tab === 'programs' || tab === 'settings' || tab === 'diagnostics' || tab === 'privacy' ? 1 : 0);
  const viewKey = tab + '/' + (segs[1] ?? '');
  const prevLevel = useRef<number | null>(null);
  const dirRef = useRef<{ key: string; dir: 'fwd' | 'back' | 'up' }>({ key: '', dir: 'up' });
  if (dirRef.current.key !== viewKey) {
    const p = prevLevel.current;
    dirRef.current = { key: viewKey, dir: p === null || p === level ? 'up' : level > p ? 'fwd' : 'back' };
  }
  useEffect(() => { prevLevel.current = level; window.scrollTo(0, 0); }, [level, viewKey]);

  const inChat = tab === 'assistant';
  const showFab = tab !== 'pair' && !(tab === 'workout' && segs[1]);

  let view;
  if (!ready) view = <p className="empty">Загрузка…</p>;
  else if (tab === 'workout' && segs[1]) view = <WorkoutSession key={segs[1]} id={segs[1]} />;
  else if (tab === 'workout') view = <WorkoutHub />;
  else if (tab === 'checkin') view = <CheckInView key={segs[1]} slot={segs[1] === 'evening' ? 'evening' : 'morning'} />;
  else if (tab === 'start') view = <OnboardingView />;
  else if (tab === 'stats') view = <StatsView />;
  else if (tab === 'records') view = <RecordsView />;
  else if (tab === 'ratings') view = <RatingsView />;
  else if (tab === 'programs') view = <ProgramsView />;
  else if (tab === 'quick') view = <p className="empty">Открываю…</p>;
  else if (tab === 'exercises') view = <ExercisesView />;
  else if (tab === 'assistant') view = <AssistantView />;
  else if (tab === 'pair') view = <p className="empty">Подключаю устройство…</p>;
  else if (tab === 'settings') view = <SettingsView />;
  else if (tab === 'diagnostics') view = <DiagnosticsView />;
  else if (tab === 'privacy') view = <LegalView />;
  else if (tab === 'profile') view = <ProfileView initialTab={segs[1]} />;
  else view = <CalendarView />;

  return (
    <div className="app">
      {ready && <PairingApproval />}
      {ready && <GameEffects />}
      {ready && <SyncNotice />}
      {due && (
        <div className="reminder" role="status">
          <span>Сегодня по плану: <b>{due.title}</b></span>
          <button className="btn small primary" onClick={() => { dismiss(); go(`workout/${due.id}`); }}>Открыть</button>
          <button className="btn small ghost" onClick={dismiss}>Скрыть</button>
        </div>
      )}
      {inChat ? (
        <div key={viewKey} className={'view view-' + dirRef.current.dir}><Suspense fallback={<p className="empty">Загрузка…</p>}>{view}</Suspense></div>
      ) : (
        <>
          <main className={'page' + (timer.active ? ' has-timer' : '') + (roomPhase !== 'idle' ? ' has-room' : '')}>
            <div key={viewKey} className={'view view-' + dirRef.current.dir}><Suspense fallback={<p className="empty">Загрузка…</p>}>{view}</Suspense></div>
          </main>
          {ready && showFab && (
            <button className={'fab' + (timer.active ? ' with-timer' : '')} onClick={() => go('assistant')} aria-label="Ассистент"><IconSpark size={26} /></button>
          )}
          <RoomBar />
          <TimerBar />
          <BottomNav current={navTab} />
        </>
      )}
    </div>
  );
}
