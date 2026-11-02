import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { checkInId, readiness } from '../domain/checkin';
import { shouldOfferOnboarding } from '../domain/starter';
import { todayAdvice, type TodayAction, type TodayButton } from '../domain/today';
import type { Workout } from '../domain/types';
import { duplicateWorkout, putWorkout } from '../db/repo';
import { todayStr } from '../lib';
import { go } from '../state/router';
import { StartSheet } from '../ui/StartSheet';
import { useToast } from '../ui/Toast';
import { dismissOnboarding, ONBOARDING_DISMISSED } from './onboardingState';

/** Дата, которая сама переключается в полночь: приложение могут не закрывать сутками. */
function useToday(): string {
  const [today, setToday] = useState(todayStr);
  useEffect(() => {
    const t = setInterval(() => setToday((cur) => { const n = todayStr(); return n === cur ? cur : n; }), 30_000);
    return () => clearInterval(t);
  }, []);
  return today;
}

/**
 * «Что делать сегодня»: один главный совет на первом экране. Логика в domain/today.ts, здесь только данные и кнопки.
 * Заменяет прежнюю карточку «Только начинаешь?»: подбор программы теперь первый шаг пути новичка.
 */
export function TodayCard() {
  const today = useToday();
  const toast = useToast();
  const [sheet, setSheet] = useState(false);
  const [busy, setBusy] = useState(false);

  const data = useLiveQuery(async () => {
    const [workouts, templates, programs, dismissed, morning] = await Promise.all([
      db.workouts.toArray().then((w) => w.filter((x) => !x.deletedAt)),
      db.templates.filter((t) => !t.deletedAt).count(),
      db.programs.filter((p) => !p.deletedAt).count(),
      db.kv.get(ONBOARDING_DISMISSED),
      db.checkins.get(checkInId(today, 'morning'))
    ]);
    return {
      workouts, hasPlan: templates + programs > 0,
      onboardingOffered: shouldOfferOnboarding({ workouts: workouts.length, templates, programs }, dismissed?.value === true),
      readiness: morning && !morning.deletedAt ? readiness(morning).level : null
    };
  }, [today]);

  const advice = useMemo(() => (data ? todayAdvice({ today, ...data }) : null), [data, today]);
  if (!data || !advice) return null;

  const run = async (action: TodayAction) => {
    if (busy) return;
    setBusy(true);
    try {
      switch (action.type) {
        case 'open': go(`workout/${action.workoutId}`); break;
        case 'start': setSheet(true); break;
        case 'onboarding': go('start'); break;
        case 'repeat': {
          const w = await duplicateWorkout(action.workoutId, today);
          if (w) go(`workout/${w.id}`); else toast('Не нашёл тренировку для повтора');
          break;
        }
        case 'move': {
          const w: Workout | undefined = data.workouts.find((x) => x.id === action.workoutId);
          if (!w) { toast('Тренировка уже изменилась: обнови экран'); break; }
          await putWorkout({ ...w, date: today });
          go(`workout/${w.id}`);
          break;
        }
      }
    } finally { setBusy(false); }
  };

  const btn = (b: TodayButton, cls: string) => <button className={'btn ' + cls} disabled={busy} onClick={() => void run(b.action)}>{b.label}</button>;

  return (
    <div className={`today-card k-${advice.kind}`} role="region" aria-label="Что делать сегодня">
      <div className="today-kicker">Сегодня</div>
      <h2 className="today-head">{advice.headline}</h2>
      <p className="today-detail">{advice.detail}</p>
      {advice.steps && (
        <ol className="today-steps" aria-label="Первые шаги">
          {advice.steps.map((s) => (
            <li key={s.text} className={s.done ? 'done' : ''}><span className="tick" aria-hidden="true" />{s.text}{s.done && <span className="sr-only"> (сделано)</span>}</li>
          ))}
        </ol>
      )}
      {(advice.primary || advice.secondary) && (
        <div className="today-actions">
          {advice.primary && btn(advice.primary, 'primary')}
          {advice.secondary && btn(advice.secondary, advice.primary ? '' : 'primary')}
        </div>
      )}
      {advice.kind === 'first' && data.onboardingOffered && (
        <button className="btn small ghost today-skip" onClick={() => void dismissOnboarding()}>Не нужен подбор программы</button>
      )}
      {sheet && <StartSheet date={today} mode="start" onClose={() => setSheet(false)} />}
    </div>
  );
}
