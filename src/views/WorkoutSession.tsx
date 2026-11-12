import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { newTemplateFromWorkout, putExercise, putTemplate, putWorkout, softDelete } from '../db/repo';
import { lastPerformance, workoutSetsCount, workoutVolume } from '../domain/analytics';
import { makeSet, makeWorkoutExercise } from '../domain/ops';
import { SET_KIND_LABELS, SET_KIND_SHORT, isCardio, type CardioEntry, type Exercise, type SetEntry, type SetKind, type Workout, type WorkoutExercise } from '../domain/types';
import { groupInfo, linkWithNext, restAfter, splitAfter } from '../domain/superset';
import { cleanupLabel, shouldShowCleanup } from '../domain/cleanup';
import { planAfterSet } from '../state/cleanupCore';
import { useCleanupGate } from '../state/cleanupGate';
import { blocksOf, insertAt, moveBlock, restoreLayout, stepBlock, templateWithWorkoutOrder } from '../domain/reorder';
import { forecastSec, formatForecast } from '../domain/forecast';
import { explainRest, formatRest, REST_SOURCE_LABEL, resolveRest } from '../domain/rest';
import { explainRestSuggestion, lastRest, restDismissKey, suggestRestChange, SUGGEST_MIN_WORKOUTS, type RestSuggestion, type WorkoutRest } from '../domain/restHints';
import { formatSetTime, needsManualStart, resolveSetStart, workSecBetween } from '../domain/setTiming';
import { explainNext, suggestNext } from '../domain/progression';
import { WhyDecisionButton } from './WhyDecision';
import { PlateSheet } from '../ui/PlateSheet';
import { formatKm } from '../cardio/geo';
import { formatClock, formatDateLong, formatDuration, formatNum } from '../lib';
import { back, go } from '../state/router';
import { useSettings } from '../state/settings';
import { useRestTimer } from '../state/timer';
import { submitWorld } from '../social/world';
import { reconcileGame, type Reconciled } from '../game/store';
import { Glyph } from '../game/glyphs';
import { useWakeLock } from '../state/wakelock';
import { ExercisePicker } from '../ui/ExercisePicker';
import { IconArrowDown, IconArrowUp, IconBack, IconCheck, IconGrip, IconNearby, IconSpark, IconSwap, IconTrash } from '../ui/Icons';
import { useBlockDrag } from '../ui/useBlockDrag';
import { swapExercise } from '../domain/swap';
import { SwapSheet } from './SwapSheet';
import { WhyButton, WhyCardSheet } from './WhyCardSheet';
import { useRoomUi } from '../nearby/RoomProvider';
import { useRoom } from '../nearby/useRoom';
import { Sheet } from '../ui/Sheet';
import { EaseCard } from './EaseCard';
import { CountUp } from '../ui/CountUp';
import { Stepper } from '../ui/Stepper';
import { useToast } from '../ui/Toast';

// GPS-запись, карта и ручной ввод кардио нужны только в кардио-упражнении: грузим при первом показе
const CardioBlock = lazy(() => import('../cardio/CardioBlock').then((m) => ({ default: m.CardioBlock })));

export function WorkoutSession({ id }: { id: string }) {
  const { settings } = useSettings();
  const timer = useRestTimer();
  const cleanup = useCleanupGate();
  const toast = useToast();
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve()); // очередь записи подходов
  const roomUi = useRoomUi();
  const roomPhase = useRoom().phase;
  const dropRef = useRef<(from: number, to: number) => void>(() => {}); // подставляется ниже, когда тренировка загружена
  const reorder = useBlockDrag((from, to) => dropRef.current(from, to));

  const workout = useLiveQuery(() => db.workouts.get(id), [id]);
  const history = useLiveQuery(() => db.workouts.toArray(), [], [] as Workout[]);
  const exList = useLiveQuery(() => db.exercises.toArray(), [], [] as Exercise[]);
  const exMap = useMemo(() => new Map(exList.map((e) => [e.id, e])), [exList]);
  // прогноз: оставшиеся подходы по их среднему времени плюс отдых; пересчитывается при правках, а не каждую секунду
  const forecast = useMemo(
    () => (workout && workout.status !== 'done'
      ? forecastSec(workout.exercises, history.filter((h) => h.id !== workout.id), settings.defaultRestSec, (x) => isCardio(exMap.get(x.exerciseId)), (x) => resolveRest(exMap.get(x.exerciseId), settings.defaultRestSec).sec)
      : null),
    [workout, history, exMap, settings.defaultRestSec]
  );

  // подсказки по отдыху: что было в прошлый раз и не пора ли изменить отдых упражнения (только предложение)
  const dismissRows = useLiveQuery(() => db.kv.where('key').startsWith('rest.dismiss.').toArray(), [], [] as { key: string; value: unknown }[]);
  const restInfo = useMemo(() => {
    const m = new Map<string, { last: WorkoutRest | null; suggestion: RestSuggestion | null }>();
    if (!workout || workout.status !== 'active') return m;
    const dismissed = new Map(dismissRows.map((r) => [r.key, typeof r.value === 'number' ? r.value : 0]));
    for (const we of workout.exercises) {
      const ex = exMap.get(we.exerciseId);
      if (!ex || isCardio(ex) || m.has(we.exerciseId)) continue;
      const cur = resolveRest(ex, settings.defaultRestSec).sec;
      m.set(we.exerciseId, {
        last: lastRest(history, we.exerciseId, workout.id),
        suggestion: suggestRestChange(history, we.exerciseId, cur, { excludeWorkoutId: workout.id, dismissedAfter: dismissed.get(restDismissKey(we.exerciseId)) })
      });
    }
    return m;
  }, [workout, history, exMap, settings.defaultRestSec, dismissRows]);

  const [picker, setPicker] = useState(false);
  const [swapping, setSwapping] = useState<string | null>(null); // id записи упражнения, которое заменяем
  const [why, setWhy] = useState<{ id: string; name: string } | null>(null); // карточка «Зачем это»
  const [summary, setSummary] = useState(false);
  const [reward, setReward] = useState<Reconciled | null>(null);
  const [now, setNow] = useState(Date.now());
  const [popId, setPopId] = useState<string | null>(null);
  const [plates, setPlates] = useState<number | null>(null);
  const [openSet, setOpenSet] = useState<string | null>(null);

  // плашка уборки живёт только на экране тренировки: ушли с экрана — молча закрываем
  const dismissCleanup = cleanup.dismiss;
  useEffect(() => dismissCleanup, [dismissCleanup]);

  const isActive = workout?.status === 'active';
  useWakeLock(!!isActive && settings.keepAwake);

  useEffect(() => {
    if (!isActive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isActive]);

  if (workout === undefined) return <p className="empty">Загрузка…</p>;
  if (!workout || workout.deletedAt) {
    return (
      <div>
        <p className="empty">Тренировка не найдена.</p>
        <button className="btn" onClick={() => go('calendar')}>К календарю</button>
      </div>
    );
  }

  const save = (patch: Partial<Workout>) => putWorkout({ ...workout, ...patch });
  // перестановка с отменой: возвращаем порядок и связки, какими они были, не трогая остальные правки
  const reorderWithUndo = (next: WorkoutExercise[], msg: string) => {
    const prev = workout.exercises;
    void save({ exercises: next });
    toast(msg, { label: 'Отменить', run: () => { void db.workouts.get(workout.id).then((cur) => { if (cur) void putWorkout({ ...cur, exercises: restoreLayout(cur.exercises, prev) }); }); } });
  };
  dropRef.current = (from, to) => reorderWithUndo(moveBlock(workout.exercises, from, to), 'Порядок изменён');
  // Берём свежую запись из базы, а не замкнутую копию: два быстрых изменения подряд (тип подхода и заметка)
  // иначе затирали друг друга, пока экран не успел обновиться.
  // Изменения идут строго по очереди: параллельное чтение-запись тоже теряло бы правки.
  const updateExercise = (weId: string, fn: (we: WorkoutExercise) => WorkoutExercise) => {
    const run = async () => {
      const cur = (await db.workouts.get(workout.id)) ?? workout;
      return putWorkout({ ...cur, exercises: cur.exercises.map((we) => (we.id === weId ? fn(we) : we)) });
    };
    const p = writeQueue.current.then(run, run);
    writeQueue.current = p.catch(() => undefined);
    return p;
  };

  const updateSet = (weId: string, setId: string, patch: Partial<SetEntry>) =>
    updateExercise(weId, (we) => ({ ...we, sets: we.sets.map((s) => (s.id === setId ? { ...s, ...patch } : s)) }));

  const info = groupInfo(workout.exercises);
  // блок = одиночное упражнение или суперсет целиком: его двигают вместе
  const blocks = blocksOf(workout.exercises);
  const blockNo: number[] = [];
  blocks.forEach((b, bi) => { for (let i = b.start; i < b.end; i++) blockNo[i] = bi; });

  const toggleDone = (we: WorkoutExercise, s: SetEntry) => {
    const done = !s.done;
    const at = Date.now();
    // Висящая плашка уборки закрывается молча при любой новой отметке: приоритет у действия пользователя,
    // отложенный отдых за прошлое упражнение не запускается.
    cleanup.dismiss();
    // время подхода: от «Начать» или от конца отдыха до этой галочки; при отмене галочки стираем
    let patch: Partial<SetEntry> = { done, completedAt: done ? at : undefined };
    if (done) {
      const ex0 = workout.exercises.findIndex((x) => x.id === we.id);
      const restRunning = timer.active && timer.remainingSec > 0;
      const start = isActive ? resolveSetStart(workout.exercises, ex0, s, timer.lastEndedAt, restRunning) : null;
      patch = { ...patch, workSec: workSecBetween(start, at) };
    } else {
      patch = { ...patch, workSec: undefined, startedAt: undefined };
    }
    void updateSet(we.id, s.id, patch);
    if (done) { setPopId(s.id); window.setTimeout(() => setPopId((p) => (p === s.id ? null : p)), 450); }
    if (done && isActive) {
      const ex = exMap.get(we.exerciseId);
      const ei = workout.exercises.findIndex((x) => x.id === we.id);
      const next = we.sets[we.sets.findIndex((x) => x.id === s.id) + 1];
      const rest = restAfter({ superset: info[ei], nextSetKind: next?.kind, restSec: resolveRest(ex, settings.defaultRestSec).sec });
      // последний рабочий подход упражнения (или связки): вместо отдыха плашка уборки, отдых стартует после галочки
      const cleanupOpts = { exercises: workout.exercises, groupInfo: info, index: ei, exerciseMap: exMap };
      const plan = planAfterSet({ enabled: settings.cleanupEnabled, show: shouldShowCleanup({ ...cleanupOpts, set: s }), rest, label: cleanupLabel(cleanupOpts) });
      if (plan.kind === 'gate') cleanup.open(plan.gate);
      else if (plan.kind === 'rest') timer.start(plan.sec);
      else if (info[ei]?.nextIndex != null) {
        const n = workout.exercises[info[ei].nextIndex!];
        toast(`Дальше ${info[info[ei].nextIndex!].label}: ${exMap.get(n.exerciseId)?.name ?? 'упражнение'}`);
      }
    }
    if (!done) timer.cancel();
  };

  const addSet = (we: WorkoutExercise) => {
    const last = we.sets[we.sets.length - 1];
    void updateExercise(we.id, (x) => ({ ...x, sets: [...x.sets, makeSet(last?.weight ?? 0, last?.reps ?? 10)] }));
  };

  const removeLastSet = (we: WorkoutExercise) => {
    if (we.sets.length <= 1) return;
    void updateExercise(we.id, (x) => ({ ...x, sets: x.sets.slice(0, -1) }));
  };

  const acceptRest = async (ex: Exercise, sec: number) => {
    await putExercise({ ...ex, restSec: sec });
    toast(`Отдых для «${ex.name}»: ${formatRest(sec)}`);
  };
  const dismissRest = (exerciseId: string) => { void db.kv.put({ key: restDismissKey(exerciseId), value: Date.now() }); };

  const removeExercise = (we: WorkoutExercise) => {
    cleanup.dismiss();
    const name = exMap.get(we.exerciseId)?.name ?? 'упражнение';
    if (we.cardio?.trackId) {
      // у кардио вместе с упражнением удаляется записанный трек, это не вернуть: спрашиваем заранее
      if (!confirm(`Убрать «${name}» из тренировки?`)) return;
      void softDelete('tracks', we.cardio.trackId);
      void save({ exercises: workout.exercises.filter((x) => x.id !== we.id) });
      return;
    }
    const at = workout.exercises.findIndex((x) => x.id === we.id);
    void save({ exercises: workout.exercises.filter((x) => x.id !== we.id) });
    toast(`«${name}» убрано`, { label: 'Вернуть', run: () => { void db.workouts.get(workout.id).then((cur) => { if (cur) void putWorkout({ ...cur, exercises: insertAt(cur.exercises, we, at) }); }); } });
  };

  const doSwap = async (weId: string, next: Exercise) => {
    setSwapping(null);
    // свежая запись из базы и общая очередь записи: как у остальных правок тренировки
    const run = async () => {
      const cur = (await db.workouts.get(workout.id)) ?? workout;
      const r = swapExercise(cur, weId, next, history, exMap);
      if (!r.ok) return r;
      await putWorkout(r.workout);
      return r;
    };
    const p = writeQueue.current.then(run, run);
    writeQueue.current = p.catch(() => undefined);
    const r = await p;
    toast(r.ok ? `Заменено на «${next.name}»${r.mode === 'split' ? ': выполненные подходы остались у прежнего' : ''}` : r.reason === 'nothing-left' ? 'Все подходы уже выполнены, заменять нечего' : r.reason === 'cardio' ? 'Кардио заменить нельзя' : 'Не удалось заменить');
  };

  const addExercises = (ids: string[]) => {
    setPicker(false);
    void save({ exercises: [...workout.exercises, ...ids.map((eid) => makeWorkoutExercise(eid, history, workout.id, exMap.get(eid)))] });
  };

  const start = () => save({ status: 'active', startedAt: Date.now(), date: workout.date });
  const finish = async () => {
    timer.cancel();
    cleanup.dismiss();
    await save({ status: 'done', finishedAt: Date.now() });
    void submitWorld().catch(() => { /* итоги уйдут при следующей попытке; ошибка видна в рейтинге */ });
    // награда считается до показа итогов, но её сбой не должен мешать завершить тренировку
    setReward(await reconcileGame().catch(() => null));
    setSummary(true);
  };
  const reopen = () => { cleanup.dismiss(); return save({ status: 'active', finishedAt: undefined }); };

  const remove = async () => {
    if (!confirm('Удалить тренировку? Это действие нельзя отменить.')) return;
    timer.cancel();
    cleanup.dismiss();
    for (const t of await db.tracks.where('workoutId').equals(workout.id).toArray()) if (!t.deletedAt) await softDelete('tracks', t.id);
    await softDelete('workouts', workout.id);
    toast('Тренировка удалена');
    go('calendar');
  };

  const elapsed = workout.startedAt ? (isActive ? now : workout.finishedAt ?? now) - workout.startedAt : 0;
  const doneCount = workoutSetsCount(workout);

  return (
    <div>
      <div className="page-head" style={{ alignItems: 'center' }}>
        <button className="icon-btn" style={{ marginLeft: -10 }} onClick={() => (window.history.length > 1 ? back() : go('calendar'))} aria-label="Назад"><IconBack /></button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <input
            className="input"
            style={{ fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 600, border: 0, background: 'transparent', padding: 0, minHeight: 36 }}
            value={workout.title}
            aria-label="Название тренировки"
            onChange={(e) => save({ title: e.target.value })}
          />
          <div className="sub cap">
            {formatDateLong(workout.date)}
            {isActive && ` · ${formatClock(elapsed / 1000)}`}
            {forecast && ` · ${isActive ? 'осталось ' : ''}≈ ${formatForecast(forecast.sec)}`}
          </div>
        </div>
        <button className="icon-btn room-btn" onClick={roomUi.openSheet} aria-label="Рядом: комната с другом"><IconNearby />{roomPhase !== 'idle' && <i className="room-dot" aria-hidden="true" />}</button>
        <button className="icon-btn" onClick={() => go('assistant')} aria-label="Спросить ассистента"><IconSpark /></button>
      </div>

      {workout.status !== 'done' && <EaseCard workoutId={workout.id} compact />}

      {workout.status === 'planned' && (
        <button className="btn primary block" onClick={start} style={{ marginBottom: 8 }}>Начать тренировку</button>
      )}

      {workout.exercises.length === 0 && <p className="empty">Добавь первое упражнение.</p>}

      {workout.exercises.map((we, idx) => {
        const ex = exMap.get(we.exerciseId);
        const cardio = isCardio(ex);
        const last = cardio ? null : lastPerformance(history, we.exerciseId, workout.id);
        const sug = cardio ? null : suggestNext(history, we.exerciseId, settings.weightStep, workout.id, new Date());
        const todo = we.sets.filter((x) => !x.done);
        const sugUseful = !!sug && todo.some((x) => x.weight !== sug.weight || x.reps !== sug.reps);
        return (
          <section key={we.id} data-block={blockNo[idx]} className={'ex-block' + (info[idx].label ? ' in-superset' : '')} style={{ '--i': Math.min(idx, 6) } as CSSProperties}>
            <div className="ex-head">
              {blocks.length > 1 && (
                <button className="icon-btn drag-handle" aria-label={info[idx].label ? 'Перетащить суперсет' : 'Перетащить упражнение'} {...reorder.handleProps(blockNo[idx])}><IconGrip size={20} /></button>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="ex-name">{info[idx].label && <span className="ss-chip" title="Суперсет">{info[idx].label}</span>}{ex?.name ?? 'Удалённое упражнение'}{ex && !ex.custom && <WhyButton exerciseId={ex.id} name={ex.name} onOpen={() => setWhy({ id: ex.id, name: ex.name })} />}</div>
                {!cardio && workout.status !== 'done' && (() => {
                  const r = resolveRest(ex, settings.defaultRestSec);
                  const ri = restInfo.get(we.exerciseId);
                  const anyDone = we.sets.some((x) => x.done);
                  return (
                    <>
                      <div className="hint rest-hint">
                        Отдых {formatRest(r.sec)} · {REST_SOURCE_LABEL[r.source]}
                        {isActive && anyDone && ri?.last ? ` · в прошлый раз отдыхал ${formatRest(ri.last.avgSec)}` : ''}
                        <WhyDecisionButton whys={[explainRest(ex, settings.defaultRestSec)]} label="отдых" />
                      </div>
                      {isActive && ex && ri?.suggestion && (
                        <div className="hint suggest hold">
                          Последние {SUGGEST_MIN_WORKOUTS} тренировки ты отдыхаешь {ri.suggestion.direction === 'longer' ? 'дольше' : 'короче'}, чем стоит ({formatRest(ri.suggestion.currentSec)}): около {formatRest(ri.suggestion.avgsSec.reduce((a, x) => a + x, 0) / ri.suggestion.avgsSec.length)}.{' '}
                          <button className="link-btn" onClick={() => void acceptRest(ex, ri.suggestion!.sec)}>Поставить {formatRest(ri.suggestion.sec)}</button>{' '}
                          <button className="link-btn" onClick={() => dismissRest(we.exerciseId)}>Не сейчас</button>
                          <WhyDecisionButton whys={[explainRestSuggestion(ri.suggestion)]} label="предложенный отдых" />
                        </div>
                      )}
                    </>
                  );
                })()}
                {last && (
                  <div className="hint">
                    В прошлый раз: {last.sets.map((s) => `${formatNum(s.weight)}×${s.reps}${s.kind && s.kind !== 'normal' ? ` (${SET_KIND_SHORT[s.kind]})` : ''}`).join(', ')}
                  </div>
                )}
                {sug && (sugUseful || sug.kind === 'hold') && (
                  <div className={'hint suggest ' + sug.kind}>
                    Идея на сегодня: {formatNum(sug.weight)}×{sug.reps}<WhyDecisionButton whys={[explainNext(history, we.exerciseId, settings.weightStep, workout.id, new Date())]} label="идея на сегодня" />{' '}
                    {sugUseful && <button className="link-btn" onClick={() => void updateExercise(we.id, (x) => ({ ...x, sets: x.sets.map((st) => (st.done ? st : { ...st, weight: sug.weight, reps: sug.reps })) }))}>Подставить</button>}{' '}
                    <button className="link-btn" onClick={async () => { await db.kv.put({ key: 'assistant.prefill', value: `Что мне делать сегодня в упражнении «${ex?.name ?? 'упражнение'}»? Учти историю. Подсказка приложения: ${formatNum(sug.weight)}×${sug.reps} (${sug.reason}).` }); go('assistant'); }}>Спросить ассистента</button>
                    <span className="why">{sug.reason}</span>
                  </div>
                )}
              </div>
              {!cardio && <button className="icon-btn" aria-label="Заменить упражнение" onClick={() => setSwapping(we.id)}><IconSwap size={20} /></button>}
              <button className="icon-btn" aria-label="Убрать упражнение" onClick={() => removeExercise(we)}><IconTrash size={20} /></button>
            </div>

            {cardio && (
              <Suspense fallback={<p className="sub">Загрузка…</p>}>
                <CardioBlock
                  workout={workout} we={we} exercise={ex} history={history}
                  onBegin={() => { if (workout.status === 'planned') void start(); }}
                  onSave={(c: CardioEntry | undefined) => updateExercise(we.id, (x) => ({ ...x, cardio: c }))}
                />
              </Suspense>
            )}

            {!cardio && we.sets.map((s, i) => (
              <div key={s.id}>
              <div className="set-row">
                <button className={'set-idx' + ((s.kind && s.kind !== 'normal') || s.warmup ? ' kind' : '')} aria-label={`Подход ${i + 1}: тип и заметка`} aria-expanded={openSet === s.id} onClick={() => setOpenSet(openSet === s.id ? null : s.id)}>
                  {i + 1}{s.warmup ? <sup>Р</sup> : s.kind && s.kind !== 'normal' && <sup>{SET_KIND_SHORT[s.kind]}</sup>}{(s.note || s.rpe) && <i className="note-dot" aria-hidden="true" />}
                </button>
                <Stepper value={s.weight} step={settings.weightStep} unit="кг" decimals done={s.done} onChange={(v) => updateSet(we.id, s.id, { weight: v })} />
                <Stepper value={s.reps} step={1} unit="повт." done={s.done} min={0} onChange={(v) => updateSet(we.id, s.id, { reps: v })} />
                <button className={'check' + (s.done ? ' on' : '') + (popId === s.id ? ' pop' : '')} onClick={() => toggleDone(we, s)} aria-label={s.done ? 'Отменить подход' : 'Отметить подход выполненным'} aria-pressed={s.done}>
                  <IconCheck />
                </button>
              </div>
              {isActive && !s.done && needsManualStart(workout.exercises, idx, s.id) && (
                <div className="set-time">
                  {typeof s.startedAt === 'number'
                    ? <span className="running">идёт {formatSetTime(Math.max(0, now - s.startedAt) / 1000)}</span>
                    : <button className="link-btn" onClick={() => void updateSet(we.id, s.id, { startedAt: Date.now() })}>▶ Начать подход</button>}
                </div>
              )}
              {s.done && typeof s.workSec === 'number' && <div className="set-time"><span className="took">⏱ {formatSetTime(s.workSec)}</span></div>}
              {openSet === s.id && (
                <div className="set-extra">
                  <div className="seg three" data-i={(['normal', 'drop', 'restpause'] as SetKind[]).indexOf(s.kind ?? 'normal')} role="group" aria-label="Тип подхода">
                    {(['normal', 'drop', 'restpause'] as SetKind[]).map((k) => (
                      <button key={k} className={(s.kind ?? 'normal') === k ? 'on' : ''} onClick={() => void updateSet(we.id, s.id, { kind: k === 'normal' ? undefined : k })}>{SET_KIND_LABELS[k]}</button>
                    ))}
                  </div>
              <div className="chips wrap" role="group" aria-label="Разминка">
                <button className={'chip' + (s.warmup ? ' on' : '')} aria-pressed={!!s.warmup} onClick={() => void updateSet(we.id, s.id, { warmup: s.warmup ? undefined : true })}>Разминка</button>
                {!cardio && last && last.sets.length > 0 && (
                  <button className="chip" onClick={() => {
                    const ls = last.sets.find(x => !x.warmup) || last.sets[last.sets.length - 1];
                    void updateSet(we.id, s.id, { weight: ls.weight, reps: ls.reps, kind: ls.kind, warmup: ls.warmup, rpe: undefined });
                  }}>Как в прошлый раз</button>
                )}
                <span className="sub" style={{ alignSelf: 'center' }}>не входит в объём, рекорды и рейтинги</span>
              </div>
                  <div className="chips wrap" role="group" aria-label="Усилие, RPE">
                    <span className="sub" style={{ alignSelf: 'center' }}>RPE</span>
                    {[6, 7, 8, 9, 10].map((v) => (
                      <button key={v} className={'chip' + (s.rpe === v ? ' on' : '')} aria-pressed={s.rpe === v} onClick={() => void updateSet(we.id, s.id, { rpe: s.rpe === v ? undefined : v })}>{v}</button>
                    ))}
                  </div>
                  <input className="input" aria-label="Заметка к подходу" maxLength={200} placeholder="Заметка: техника, самочувствие" value={s.note ?? ''} onChange={(e) => void updateSet(we.id, s.id, { note: e.target.value || undefined })} />
                </div>
              )}
              {(s.note || s.rpe) && openSet !== s.id && <div className="set-note">{s.rpe ? `RPE ${s.rpe}` : ''}{s.rpe && s.note ? ' · ' : ''}{s.note}</div>}
              </div>
            ))}

            {(!cardio || blocks.length > 1) && (
              <div className="ex-actions">
                {!cardio && <>
                <button className="btn small" onClick={() => addSet(we)}>Добавить подход</button>
                {info[idx].label && !info[idx].isLast
                  ? <button className="btn small ghost" onClick={() => void save({ exercises: splitAfter(workout.exercises, idx) })}>Разорвать суперсет</button>
                  : idx < workout.exercises.length - 1 && <button className="btn small ghost" onClick={() => void save({ exercises: linkWithNext(workout.exercises, idx) })}>Суперсет со следующим</button>}
                <button className="btn small ghost" onClick={() => setPlates((todo[0] ?? we.sets[we.sets.length - 1])?.weight ?? 0)}>Блины</button>
                {we.sets.length > 1 && <button className="btn small ghost" onClick={() => removeLastSet(we)}>Убрать последний</button>}
                </>}
                {blocks.length > 1 && <>
                  <button className="btn small ghost" disabled={blockNo[idx] === 0} aria-label={info[idx].label ? 'Суперсет выше' : 'Упражнение выше'} onClick={() => reorderWithUndo(stepBlock(workout.exercises, idx, -1), 'Порядок изменён')}><IconArrowUp size={16} /></button>
                  <button className="btn small ghost" disabled={blockNo[idx] === blocks.length - 1} aria-label={info[idx].label ? 'Суперсет ниже' : 'Упражнение ниже'} onClick={() => reorderWithUndo(stepBlock(workout.exercises, idx, 1), 'Порядок изменён')}><IconArrowDown size={16} /></button>
                  {blockNo[idx] < blocks.length - 2 && <button className="btn small ghost" onClick={() => reorderWithUndo(moveBlock(workout.exercises, blockNo[idx], blocks.length - 1), 'Перенесено в конец')}>В конец</button>}
                </>}
              </div>
            )}
          </section>
        );
      })}

      <button className="btn block" onClick={() => setPicker(true)} style={{ marginTop: 8 }}>Добавить упражнение</button>

      <div className="field" style={{ marginTop: 20 }}>
        <label htmlFor="wk-note">Заметка</label>
        <textarea id="wk-note" className="input" value={workout.note ?? ''} onChange={(e) => save({ note: e.target.value })} placeholder="Самочувствие, сон, что получилось или нет" />
      </div>

      {isActive && (
        <button className="btn primary block" onClick={finish} disabled={doneCount === 0 && workout.exercises.length === 0}>
          Завершить тренировку
        </button>
      )}
      {workout.status === 'done' && (
        <button className="btn block" onClick={reopen}>Вернуть в работу</button>
      )}
      <button className="btn danger ghost block" style={{ marginTop: 10 }} onClick={remove}>Удалить тренировку</button>

      {picker && <ExercisePicker multi onPick={addExercises} onClose={() => setPicker(false)} />}
      {swapping && (() => {
        const we = workout.exercises.find((x) => x.id === swapping);
        const target = we && exMap.get(we.exerciseId);
        return target ? <SwapSheet target={target} all={exList} history={history} present={new Set(workout.exercises.map((x) => x.exerciseId))} onPick={(e) => void doSwap(swapping, e)} onClose={() => setSwapping(null)} /> : null;
      })()}
      {why && <WhyCardSheet exerciseId={why.id} name={why.name} onClose={() => setWhy(null)} />}
      {plates !== null && <PlateSheet initialWeight={plates} onClose={() => setPlates(null)} />}
      {summary && <FinishSheet workout={workout} reward={reward} onClose={() => { setSummary(false); go('calendar'); }} />}
    </div>
  );
}

function FinishSheet({ workout, reward, onClose }: { workout: Workout; reward: Reconciled | null; onClose: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(workout.title);
  const [saved, setSaved] = useState(false);
  const dur = workout.startedAt && workout.finishedAt ? workout.finishedAt - workout.startedAt : 0;
  const cardioM = workout.exercises.reduce((a, we) => a + (we.cardio?.distanceM ?? 0), 0);
  // шаблон, из которого начата тренировка: если порядок упражнений изменился, предлагаем запомнить новый
  const tpl = useLiveQuery(() => (workout.templateId ? db.templates.get(workout.templateId) : undefined), [workout.templateId]);
  const reordered = useMemo(() => (tpl && !tpl.deletedAt ? templateWithWorkoutOrder(tpl, workout) : null), [tpl, workout]);
  const [orderSaved, setOrderSaved] = useState(false);

  return (
    <Sheet title="Тренировка завершена" onClose={onClose}>
      <div className="kpis" style={{ marginBottom: 16 }}>
        <div className="kpi"><div className="bignum"><CountUp value={workoutSetsCount(workout)} /></div><div className="sub">подходов</div></div>
        {cardioM > 0 && workoutVolume(workout) === 0
          ? <div className="kpi"><div className="bignum" style={{ fontSize: 30, paddingTop: 8 }}>{formatKm(cardioM)}</div><div className="sub">км</div></div>
          : <div className="kpi"><div className="bignum"><CountUp value={workoutVolume(workout)} format={(n) => formatNum(Math.round(n))} /></div><div className="sub">кг объём</div></div>}
        <div className="kpi"><div className="bignum" style={{ fontSize: 30, paddingTop: 8 }}>{dur ? formatDuration(dur) : '—'}</div><div className="sub">время</div></div>
      </div>
      {reward && (reward.xpGained > 0 || reward.newAchievements.length > 0) && (
        <div className="reward-box">
          <div className="reward-row">
            <span className="reward-pill xp">+<CountUp value={reward.xpGained} format={(n) => String(Math.round(n))} /> XP</span>
            <span className="reward-pill coin"><Glyph name="coin" size={16} />+<CountUp value={reward.coinsGained} format={(n) => String(Math.round(n))} /></span>
          </div>
          {reward.after.level.level > reward.before.level.level && <div className="levelup">Новый уровень: {reward.after.level.level}!</div>}
          {reward.newAchievements.map((a) => (
            <div key={a.id} className="reward-ach"><span className={'ach-medal sm t-' + a.tier}><Glyph name={a.glyph} size={18} /></span><span><b>{a.title}</b><span className="meta"> · +{a.reward} монет</span></span></div>
          ))}
        </div>
      )}
      <div className="field">
        <label htmlFor="tpl-title">Название шаблона</label>
        <input id="tpl-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <button
        className="btn block"
        disabled={saved || !title.trim() || workout.exercises.length === 0}
        onClick={async () => { await newTemplateFromWorkout(workout, title.trim()); setSaved(true); toast('Шаблон сохранён'); }}
      >
        {saved ? 'Шаблон сохранён' : 'Сохранить как шаблон'}
      </button>
      {reordered && (
        <button
          className="btn block"
          style={{ marginTop: 10 }}
          disabled={orderSaved}
          onClick={async () => { await putTemplate(reordered); setOrderSaved(true); toast('Порядок сохранён в шаблоне'); }}
        >
          {orderSaved ? `Порядок сохранён в «${reordered.title}»` : `Запомнить порядок в шаблоне «${reordered.title}»`}
        </button>
      )}
      <button className="btn primary block" style={{ marginTop: 10 }} onClick={onClose}>Готово</button>
    </Sheet>
  );
}
