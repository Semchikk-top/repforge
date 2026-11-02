import { useLiveQuery } from 'dexie-react-hooks';
import { useMemo, useState } from 'react';
import { db } from '../db/db';
import { MUSCLE_LABELS, type CheckIn, type Exercise, type Workout } from '../domain/types';
import { reviewPrompt, shouldShowWeeklyReview, weeklyReview } from '../domain/weeklyReview';
import { formatNum } from '../lib';
import { useSettings } from '../state/settings';
import { go } from '../state/router';
import { Sheet } from '../ui/Sheet';

const SEEN = 'weeklyReview.seen';
const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0');

/** Карточка недельного разбора. Только по включённой настройке, один раз в неделю, закрывается; уведомлений нет. */
export function WeeklyReviewCard() {
  const { settings } = useSettings();
  const data = useLiveQuery(async () => {
    const [workouts, exercises, checkins, seen] = await Promise.all([db.workouts.toArray(), db.exercises.toArray(), db.checkins.toArray(), db.kv.get(SEEN)]);
    return { workouts, exercises, checkins, seen: typeof seen?.value === 'string' ? seen.value : null };
  }, []);
  const [open, setOpen] = useState(false);

  const review = useMemo(() => {
    if (!data || !settings.weeklyReviewEnabled) return null;
    const exMap = new Map<string, Exercise>(data.exercises.map((e) => [e.id, e]));
    return weeklyReview(data.workouts as Workout[], exMap, data.checkins as CheckIn[]);
  }, [data, settings.weeklyReviewEnabled]);

  if (!data || !review || !shouldShowWeeklyReview({ enabled: settings.weeklyReviewEnabled, review, seenWeek: data.seen })) return null;
  const close = () => { setOpen(false); void db.kv.put({ key: SEEN, value: review.weekStart }); };
  const t = review.totals;

  return (
    <div className="section" role="region" aria-label="Недельный разбор">
      <h2>Итоги недели {review.weekStart.slice(5).split('-').reverse().join('.')}–{review.weekEnd.slice(5).split('-').reverse().join('.')}</h2>
      <p>Тренировок {t.workouts}{review.previous.workouts ? ` (неделей раньше ${review.previous.workouts})` : ''}, подходов {t.sets}, тоннаж {formatNum(Math.round(t.volume))} кг.</p>
      {review.suggestions.map((s) => <p key={s}>{s}</p>)}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button className="btn small" onClick={() => setOpen(true)}>Подробнее</button>
        <button className="btn small ghost" onClick={close}>Скрыть</button>
      </div>

      {open && (
        <Sheet title="Разбор недели" onClose={() => setOpen(false)}>
          <p className="sub">Считается на этом устройстве, данные никуда не отправляются.</p>
          {review.growth.length > 0 && (
            <div className="section" style={{ marginTop: 0 }}>
              <h2>Что выросло</h2>
              <div className="list">{review.growth.map((g) => <div key={g.exerciseId} className="row"><div className="grow"><div className="title">{g.name}</div></div><div className="meta">{formatNum(g.before)} → {formatNum(g.after)} кг (+{Math.round(g.pct * 100)}%)</div></div>)}</div>
              <p className="sub">Расчётный максимум на одно повторение.</p>
            </div>
          )}
          {review.plateaus.length > 0 && (
            <div className="section">
              <h2>Где застой</h2>
              <div className="list">{review.plateaus.map((p) => <div key={p.exerciseId} className="row"><div className="grow"><div className="title">{p.name}</div></div><div className="meta">без роста в последних тренировках</div></div>)}</div>
            </div>
          )}
          <div className="section">
            <h2>Нагрузка по группам</h2>
            <div className="list">
              {review.load.filter((m) => m.sets > 0 || m.baselineShare > 0).map((m) => (
                <div key={m.muscle} className="row"><div className="grow"><div className="title">{MUSCLE_LABELS[m.muscle]}</div></div><div className="meta">{m.share}% · к обычному {signed(m.delta)} п. п.</div></div>
              ))}
            </div>
            <p className="sub">Доли подходов за неделю против твоего среднего за 8 недель.</p>
          </div>
          {review.readiness && <p>Среднее самочувствие по утренним чек-инам: {review.readiness.avg} из 100 ({review.readiness.days} дн.). Это ориентир, а не оценка здоровья.</p>}
          <button className="btn block" style={{ marginTop: 8 }} onClick={async () => { await db.kv.put({ key: 'assistant.prefill', value: reviewPrompt(review) }); close(); go('assistant'); }}>Обсудить с ассистентом</button>
          <p className="sub">Текст попадёт в поле ввода, и ты увидишь его перед отправкой.</p>
          <button className="btn ghost block" style={{ marginTop: 8 }} onClick={close}>Скрыть до следующей недели</button>
        </Sheet>
      )}
    </div>
  );
}
