import { useEffect, useRef, useState } from 'react';
import { db } from './db/db';
import { ensureSeeds, getDeviceId, newWorkout } from './db/repo';
import { ensureProfileMeta } from './social/store';
import { startWorldSync } from './social/world';
import { todayStr } from './lib';
import { go, replace, useRoute } from './state/router';
import { pairWithCode, startSyncEngine } from './sync/sync';
import { useToast } from './ui/Toast';
import { useRestTimer } from './state/timer';
import { BottomNav } from './ui/BottomNav';
import { TimerBar } from './ui/TimerBar';
import { CalendarView } from './views/CalendarView';
import { ExercisesView } from './views/ExercisesView';
import { SettingsView } from './views/SettingsView';
import { StatsView } from './views/StatsView';
import { RatingsView } from './views/RatingsView';
import { WorkoutHub } from './views/WorkoutHub';
import { WorkoutSession } from './views/WorkoutSession';
import { AssistantView } from './views/AssistantView';
import { RecordsView } from './views/RecordsView';
import { ProgramsView } from './views/ProgramsView';
import { useReminder } from './state/reminder';
import { IconSpark } from './ui/Icons';
import { PairingApproval } from './ui/PairingApproval';
import { RoomBar } from './ui/RoomBar';
import { useRoom } from './nearby/useRoom';
import { ProfileView } from './views/ProfileView';
import { GameEffects } from './game/GameEffects';

// Код одноразовый, а StrictMode запускает эффекты дважды: защищаемся от повторного запроса
const pairing = new Map<string, Promise<void>>();
function pairOnce(code: string) {
  if (!pairing.has(code)) pairing.set(code, pairWithCode(code));
  return pairing.get(code)!;
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

  // быстрые ссылки (ярлыки на иконке приложения): #/quick/start и #/quick/current
  const { due, dismiss } = useReminder();
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
  const navTab = tab === 'pair' || tab === 'settings' ? 'profile' : tab === 'records' || tab === 'ratings' ? 'stats' : tab === 'programs' ? 'workout' : tab === 'quick' ? 'workout' : tab;

  // Направление перехода: вкладка правее или экран «глубже» — въезжает справа, иначе слева
  const level = NAV_ORDER.indexOf(navTab) * 2 + ((tab === 'workout' && segs[1]) || tab === 'records' || tab === 'ratings' || tab === 'programs' || tab === 'settings' ? 1 : 0);
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
  else if (tab === 'stats') view = <StatsView />;
  else if (tab === 'records') view = <RecordsView />;
  else if (tab === 'ratings') view = <RatingsView />;
  else if (tab === 'programs') view = <ProgramsView />;
  else if (tab === 'quick') view = <p className="empty">Открываю…</p>;
  else if (tab === 'exercises') view = <ExercisesView />;
  else if (tab === 'assistant') view = <AssistantView />;
  else if (tab === 'pair') view = <p className="empty">Подключаю устройство…</p>;
  else if (tab === 'settings') view = <SettingsView />;
  else if (tab === 'profile') view = <ProfileView initialTab={segs[1]} />;
  else view = <CalendarView />;

  return (
    <div className="app">
      {ready && <PairingApproval />}
      {ready && <GameEffects />}
      {due && (
        <div className="reminder" role="status">
          <span>Сегодня по плану: <b>{due.title}</b></span>
          <button className="btn small primary" onClick={() => { dismiss(); go(`workout/${due.id}`); }}>Открыть</button>
          <button className="btn small ghost" onClick={dismiss}>Скрыть</button>
        </div>
      )}
      {inChat ? (
        <div key={viewKey} className={'view view-' + dirRef.current.dir}>{view}</div>
      ) : (
        <>
          <main className={'page' + (timer.active ? ' has-timer' : '') + (roomPhase !== 'idle' ? ' has-room' : '')}>
            <div key={viewKey} className={'view view-' + dirRef.current.dir}>{view}</div>
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
