import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { weekProgress } from '../domain/analytics';
import type { Exercise, Workout } from '../domain/types';
import { formatNum } from '../lib';
import { useSettings } from '../state/settings';

// Цели недели: сколько тренировок и километров осталось до плана
export function GoalsCard({ workouts }: { workouts: Workout[] }) {
  const { settings } = useSettings();
  const exercises = useLiveQuery(() => db.exercises.toArray(), [], [] as Exercise[]);
  const exMap = useMemo(() => new Map(exercises.map((e) => [e.id, e])), [exercises]);
  const prog = useMemo(() => weekProgress(workouts, exMap), [workouts, exMap]);
  const { weeklyGoalWorkouts: gw, weeklyGoalKm: gk } = settings;
  if (gw <= 0 && gk <= 0) return null;

  const Row = ({ label, value, goal, unit }: { label: string; value: number; goal: number; unit: string }) => {
    const pct = Math.min(100, Math.round((value / goal) * 100));
    const done = value >= goal;
    return (
      <>
        <div className="goal-row">
          <span>{label}</span>
          <span><b>{formatNum(value)}</b> из {formatNum(goal)} {unit}{done ? ' ✓' : ''}</span>
          <div className={'goal-bar' + (done ? ' done' : '')} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={goal} aria-valuenow={Math.min(value, goal)}><i style={{ width: pct + '%' }} /></div>
        </div>
      </>
    );
  };

  return (
    <div className="goal-card" aria-label="Цели недели">
      <h2 style={{ margin: '0 0 10px', fontSize: 18 }}>Цель недели</h2>
      {gw > 0 && <Row label="Тренировки" value={prog.workouts} goal={gw} unit="" />}
      {gk > 0 && <Row label="Бег и ходьба" value={prog.km} goal={gk} unit="км" />}
    </div>
  );
}
