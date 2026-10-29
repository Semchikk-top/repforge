import { useEffect, useMemo, useState } from 'react';
import { db } from '../db/db';
import type { CardioEntry, Workout } from '../domain/types';
import { Sheet } from '../ui/Sheet';
import { RouteMap } from './RouteMap';
import { avgPace, decodePoint, elevationFromPoints, formatHMS, formatKm, formatPace, formatSpeedKmh, isSameRoute, type Elevation } from './geo';
import { trimRoute } from './gpx';

export function ElevationChart({ profile }: { profile: Elevation }) {
  const W = 320, H = 90, pad = 4;
  const total = profile.dist[profile.dist.length - 1] || 1;
  const span = Math.max(1, profile.max - profile.min);
  const pts = profile.dist.map((d, i) => [pad + (d / total) * (W - 2 * pad), H - pad - ((profile.ele[i] - profile.min) / span) * (H - 2 * pad)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <div className="elev">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Профиль высоты">
        <path d={`${line} L${pts[pts.length - 1][0].toFixed(1)},${H - pad} L${pts[0][0].toFixed(1)},${H - pad} Z`} fill="var(--accent)" opacity={0.18} />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2.5} strokeLinejoin="round" />
      </svg>
      <div className="sub">Высота {Math.round(profile.min)}–{Math.round(profile.max)} м · набор {Math.round(profile.gain)} м · спуск {Math.round(profile.loss)} м (по GPS, приблизительно)</div>
    </div>
  );
}

interface Past { workout: Workout; cardio: CardioEntry; route: { lat: number; lon: number; ele: number | null }[] }

/** Прошлые пробежки по тому же маршруту: сравнение темпа и наложение маршрутов */
export function RouteCompare({ workoutId, current, currentRoute, zoneM, bike, onClose }: {
  workoutId: string; current: CardioEntry; currentRoute: { lat: number; lon: number; ele: number | null }[]; zoneM: number; bike: boolean; onClose: () => void;
}) {
  const [past, setPast] = useState<Past[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const ws = (await db.workouts.toArray()).filter((w) => !w.deletedAt && w.status === 'done' && w.id !== workoutId);
      const found: Past[] = [];
      for (const w of ws) {
        for (const we of w.exercises) {
          const id = we.cardio?.trackId;
          if (!id || !we.cardio) continue;
          const t = await db.tracks.get(id);
          if (!t || t.deletedAt) continue;
          const route = t.points.map(decodePoint);
          if (isSameRoute(currentRoute, route)) found.push({ workout: w, cardio: we.cardio, route });
        }
      }
      found.sort((a, b) => b.workout.date.localeCompare(a.workout.date));
      if (alive) setPast(found);
    })();
    return () => { alive = false; };
  }, [workoutId, currentRoute]);

  const curPace = avgPace(current.distanceM, current.durationSec);
  const sel = past?.find((p) => p.workout.id === picked) ?? null;
  const ghost = useMemo(() => (sel ? trimRoute(sel.route, zoneM) : undefined), [sel, zoneM]);
  const shown = useMemo(() => trimRoute(currentRoute, zoneM), [currentRoute, zoneM]);
  const fastest = past?.length ? Math.min(...past.map((p) => p.cardio.durationSec / Math.max(1, p.cardio.distanceM))) : null;

  return (
    <Sheet title="Тот же маршрут" onClose={onClose}>
      {past === null && <p className="sub">Ищу похожие маршруты…</p>}
      {past && past.length === 0 && <p className="empty">Похожих маршрутов в истории пока нет: нужна ещё хотя бы одна запись по такой же дистанции и примерно тому же пути.</p>}
      {past && past.length > 0 && (
        <>
          <p className="sub">Найдено прошлых пробежек: {past.length}. Нажми на строку, чтобы наложить маршрут (пунктир).</p>
          {shown.length > 1 && <RouteMap points={shown} ghost={ghost} />}
          <div className="list">
            {past.map((p) => {
              const pace = avgPace(p.cardio.distanceM, p.cardio.durationSec);
              const diff = curPace !== null && pace !== null ? curPace - pace : null; // минус — сегодня быстрее
              return (
                <button key={p.workout.id} className={'row' + (picked === p.workout.id ? ' on' : '')} onClick={() => setPicked(picked === p.workout.id ? null : p.workout.id)} aria-pressed={picked === p.workout.id}>
                  <div className="grow">
                    <div className="title">{new Date(p.workout.date + 'T00:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</div>
                    <div className="meta">{formatKm(p.cardio.distanceM)} км · {formatHMS(p.cardio.durationSec)} · {bike ? `${formatSpeedKmh(p.cardio.distanceM / p.cardio.durationSec)} км/ч` : `${formatPace(pace)} мин/км`}</div>
                  </div>
                  {diff !== null && !bike && <div className={'cmp ' + (diff <= 0 ? 'good' : 'bad')}>{diff <= 0 ? 'сегодня быстрее на' : 'сегодня медленнее на'} {Math.abs(Math.round(diff))} с/км</div>}
                </button>
              );
            })}
          </div>
          {fastest !== null && curPace !== null && <p className="sub" style={{ marginTop: 10 }}>{curPace / 1000 <= fastest ? 'Это лучшее время на этом маршруте.' : 'Лучшее время на этом маршруте было быстрее.'}</p>}
        </>
      )}
    </Sheet>
  );
}

export { elevationFromPoints };
