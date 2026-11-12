import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { putWorkout } from '../db/repo';
import { detectPlateaus } from '../domain/analytics';
import { autoregulate, canUndoEase, explainEaseReason, easeAppliedKey, easeWorkout, reliableLoadRatio } from '../domain/autoregulation';
import { checkInId, readiness } from '../domain/checkin';
import { todayStr } from '../lib';
import { useToast } from '../ui/Toast';
import { WhyDecisionButton } from './WhyDecision';

interface Applied { pct: number; at: number }

/**
 * «Сегодня с поправкой на состояние»: предложение снизить нагрузку по чек-ину, нагрузке за неделю и застою.
 * Правила в domain/autoregulation.ts. Ничего не меняется без нажатия «Сделать легче»; отметка о применении
 * лежит в локальном хранилище kv, поэтому схема базы не меняется.
 */
export function EaseCard({ workoutId, compact = false }: { workoutId: string; compact?: boolean }) {
  const toast = useToast();
  const today = todayStr();

  const data = useLiveQuery(async () => {
    const [workout, morning, all, exercises, applied] = await Promise.all([
      db.workouts.get(workoutId),
      db.checkins.get(checkInId(today, 'morning')),
      db.workouts.toArray().then((w) => w.filter((x) => !x.deletedAt)),
      db.exercises.toArray(),
      db.kv.get(easeAppliedKey(workoutId))
    ]);
    return { workout, morning: morning && !morning.deletedAt ? morning : null, all, exercises, applied: (applied?.value as Applied | undefined) ?? null };
  }, [workoutId, today]);

  const advice = useMemo(() => {
    if (!data?.workout || data.workout.deletedAt || data.workout.status === 'done' || data.workout.date !== today) return null;
    const ids = new Set(data.workout.exercises.map((we) => we.exerciseId));
    const names = new Map(data.exercises.map((e) => [e.id, e.name]));
    const plateauNames = detectPlateaus(data.all).filter((p) => ids.has(p.exerciseId)).map((p) => names.get(p.exerciseId) ?? 'упражнение');
    return autoregulate({
      readiness: data.morning ? readiness(data.morning) : null,
      sleepHours: data.morning?.sleepHours,
      loadRatio: reliableLoadRatio(data.all),
      plateauNames
    });
  }, [data, today]);

  if (!data?.workout || !advice || !advice.known) return null;

  const apply = async () => {
    if (!advice.plan) return;
    const cur = await db.workouts.get(workoutId);
    if (!cur) return;
    const r = easeWorkout(cur, advice.plan);
    if (r.workout === cur) { toast('Нечего облегчать: все подходы выполнены или без веса'); return; }
    await putWorkout(r.workout);
    await db.kv.put({ key: easeAppliedKey(workoutId), value: { pct: advice.plan.pct, at: Date.now() } satisfies Applied });
    const parts = [r.lowered ? `вес −${advice.plan.pct}% в ${r.lowered} подходах` : '', r.dropped ? `убрано подходов: ${r.dropped}` : ''].filter(Boolean);
    toast(`Сделал легче: ${parts.join(', ')}`, {
      label: 'Отменить',
      run: () => { void (async () => {
        const now = await db.workouts.get(workoutId);
        if (!now) return;
        // после поправки тренировку могли продолжить: тогда откат стёр бы новые отметки, поэтому отказываем
        if (!canUndoEase(now, r.workout)) { toast('Тренировка уже изменилась, отменить поправку нельзя'); return; }
        await putWorkout({ ...now, exercises: cur.exercises });
        await db.kv.delete(easeAppliedKey(workoutId));
      })(); }
    });
  };

  if (advice.mode === 'normal') {
    return (
      <div className={'ease-card normal' + (compact ? ' compact' : '')} role="region" aria-label="Состояние на сегодня">
        <div className="ease-head">{advice.headline}<WhyDecisionButton whys={advice.reasons.map(explainEaseReason)} label="состояние на сегодня" /></div>
        <p className="ease-detail">{advice.detail}</p>
        {advice.reasons.length > 0 && <ul className="ease-reasons">{advice.reasons.map((r) => <li key={r.key}>{r.text}</li>)}</ul>}
      </div>
    );
  }

  return (
    <div className={'ease-card' + (compact ? ' compact' : '')} role="region" aria-label="Сегодня с поправкой на состояние">
      <div className="ease-head">{advice.headline}<WhyDecisionButton whys={advice.reasons.map(explainEaseReason)} label="состояние на сегодня" /></div>
      <ul className="ease-reasons" aria-label="Причины">{advice.reasons.map((r) => <li key={r.key}>{r.text}</li>)}</ul>
      {data.applied
        ? <p className="ease-detail">Поправка применена: вес снижен на {data.applied.pct}%. Дальше работай по самочувствию.</p>
        : (
          <>
            <p className="ease-detail">{advice.detail}</p>
            <div className="today-actions"><button className="btn primary" onClick={() => void apply()}>Сделать легче</button></div>
          </>
        )}
    </div>
  );
}
