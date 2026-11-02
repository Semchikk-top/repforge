import { useMemo, useRef, useState } from 'react';
import { db } from '../db/db';
import { applyImportPlan } from '../db/repo';
import {
  buildImportPlan, parseWorkoutImport, suggestResolutions, type ParsedImport, type Resolution, type Suggestion, type WeightUnit
} from '../domain/importWorkouts';
import { MUSCLE_LABELS, type Exercise, type MuscleGroup, type Workout } from '../domain/types';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';

const MAX_BYTES = 30 * 1024 * 1024;
const STRENGTH_GROUPS = (Object.keys(MUSCLE_LABELS) as MuscleGroup[]).filter((m) => m !== 'cardio');
const FORMAT_LABEL = { hevy: 'Hevy', strong: 'Strong' } as const;

interface Loaded { parsed: ParsedImport; suggestions: Map<string, Suggestion>; exercises: Exercise[]; workouts: Workout[]; names: [string, number][] }

/** Импорт из CSV Hevy и Strong: выбрать файл, посмотреть, что будет сделано, сопоставить упражнения и подтвердить. Ничего не перезаписывает. */
export function ImportWorkoutsSheet({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [choice, setChoice] = useState<Map<string, Resolution>>(new Map());
  const [unit, setUnit] = useState<WeightUnit>('kg');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ workouts: number; exercises: number } | null>(null);

  const pick = async (file: File) => {
    setError('');
    if (file.size > MAX_BYTES) { setError('Файл слишком большой для импорта.'); return; }
    const r = parseWorkoutImport(await file.text());
    if (!r.ok) { setError(r.error); setLoaded(null); return; }
    const [exercises, workouts] = await Promise.all([db.exercises.toArray(), db.workouts.toArray()]);
    const counts = new Map<string, number>();
    for (const w of r.data.workouts) for (const e of w.exercises) counts.set(e.name, (counts.get(e.name) ?? 0) + e.sets.length);
    const names = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const suggestions = suggestResolutions(names.map(([n]) => n), exercises);
    setChoice(new Map([...suggestions].map(([n, s]) => [n, s.resolution])));
    setUnit(r.data.detectedUnit ?? 'kg');
    setLoaded({ parsed: r.data, suggestions, exercises, workouts, names });
  };

  const plan = useMemo(
    () => (loaded ? buildImportPlan(loaded.parsed, choice, unit, { workouts: loaded.workouts, exercises: loaded.exercises }) : null),
    [loaded, choice, unit]
  );
  const sortedExercises = useMemo(() => (loaded ? [...loaded.exercises].filter((e) => !e.deletedAt && e.muscle !== 'cardio').sort((a, b) => a.name.localeCompare(b.name, 'ru')) : []), [loaded]);

  const set = (name: string, r: Resolution) => setChoice((p) => new Map(p).set(name, r));
  const valueOf = (name: string) => { const r = choice.get(name); return !r ? 'skip' : r.kind === 'existing' ? `ex:${r.exerciseId}` : r.kind; };
  const onSelect = (name: string, v: string) => {
    if (v === 'skip') set(name, { kind: 'skip' });
    else if (v === 'new') { const cur = choice.get(name); set(name, { kind: 'new', name, muscle: cur?.kind === 'new' ? cur.muscle : null }); }
    else set(name, { kind: 'existing', exerciseId: v.slice(3) });
  };

  const run = async () => {
    if (!plan || plan.unresolved.length || plan.workouts.length === 0 || busy) return;
    setBusy(true);
    try {
      const r = await applyImportPlan(plan);
      setDone({ workouts: r.workouts, exercises: r.exercises });
      toast(`Импортировано тренировок: ${r.workouts}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Не удалось импортировать');
    } finally { setBusy(false); }
  };

  const attention = loaded?.names.filter(([n]) => loaded.suggestions.get(n)!.reason === 'guess' || loaded.suggestions.get(n)!.reason === 'cardio' || (plan?.unresolved.includes(n) ?? false)) ?? [];
  const auto = loaded?.names.filter(([n]) => !attention.some(([a]) => a === n)) ?? [];

  const row = ([name, sets]: [string, number]) => {
    const r = choice.get(name);
    return (
      <div key={name} className="field" style={{ marginBottom: 10 }}>
        <label htmlFor={`imp-${name}`}>{name} <span className="sub">· подходов: {sets}</span></label>
        <select id={`imp-${name}`} className="input" value={valueOf(name)} onChange={(e) => onSelect(name, e.target.value)}>
          <option value="new">Создать новое упражнение</option>
          <option value="skip">Пропустить</option>
          <optgroup label="Мои упражнения">
            {sortedExercises.map((e) => <option key={e.id} value={`ex:${e.id}`}>{e.name}</option>)}
          </optgroup>
        </select>
        {r?.kind === 'new' && (
          <select className="input" aria-label={`Группа мышц для «${name}»`} value={r.muscle ?? ''} onChange={(e) => set(name, { kind: 'new', name, muscle: (e.target.value || null) as MuscleGroup | null })}>
            <option value="">Выбери группу мышц</option>
            {STRENGTH_GROUPS.map((m) => <option key={m} value={m}>{MUSCLE_LABELS[m]}</option>)}
          </select>
        )}
        {loaded?.suggestions.get(name)?.reason === 'cardio' && r?.kind === 'skip' && <span className="sub">Кардио в этой версии не переносится.</span>}
      </div>
    );
  };

  return (
    <Sheet title="Импорт из Hevy или Strong" onClose={onClose}>
      <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f); e.target.value = ''; }} />

      {done ? (
        <>
          <p>Готово: добавлено тренировок {done.workouts}{done.exercises ? `, новых упражнений ${done.exercises}` : ''}. Существующие записи не менялись.</p>
          <button className="btn primary block" onClick={onClose}>Закрыть</button>
        </>
      ) : !loaded || !plan ? (
        <>
          <p className="sub">Выбери CSV-файл, который вы выгрузили из Hevy или Strong. Ничего не изменится, пока ты не подтвердишь на следующем шаге.</p>
          {error && <p role="alert" style={{ color: 'var(--danger)' }}>{error}</p>}
          <button className="btn primary block" onClick={() => fileRef.current?.click()}>Выбрать файл</button>
        </>
      ) : (
        <>
          <div className="section" style={{ marginTop: 0 }}>
            <h2>Что в файле</h2>
            <p>
              {FORMAT_LABEL[loaded.parsed.format]}: тренировок к импорту <b>{plan.workouts.length}</b>
              {plan.from && <>, {plan.from} — {plan.to}</>}, подходов {plan.sets}.
            </p>
            {plan.duplicates > 0 && <p className="sub">Уже есть в приложении и будут пропущены: {plan.duplicates}.</p>}
            {loaded.parsed.skippedSets > 0 && <p className="sub">Подходы без повторов (время, дистанция) не переносятся: {loaded.parsed.skippedSets}.</p>}
            {loaded.parsed.badRows > 0 && <p className="sub">Строк, которые не удалось прочитать: {loaded.parsed.badRows}.</p>}
          </div>

          {loaded.parsed.detectedUnit === null ? (
            <div className="field" role="group" aria-label="Единица веса">
              <label>В каких единицах вес в файле?</label>
              <div className="chips">
                {(['kg', 'lb'] as const).map((u) => <button key={u} className={'chip' + (unit === u ? ' on' : '')} aria-pressed={unit === u} onClick={() => setUnit(u)}>{u === 'kg' ? 'Килограммы' : 'Фунты'}</button>)}
              </div>
              <span className="sub">Файл Strong не говорит об этом сам. Фунты будут переведены в килограммы.</span>
            </div>
          ) : <p className="sub">Единицы веса в файле: {loaded.parsed.detectedUnit === 'kg' ? 'килограммы' : 'фунты'}.</p>}

          <div className="section">
            <h2>Упражнения</h2>
            {attention.length > 0 && (
              <>
                <p className="sub">Эти упражнения не нашлись среди твоих. Выбери, что с ними сделать.</p>
                {attention.map(row)}
              </>
            )}
            {auto.length > 0 && (
              <details>
                <summary>Сопоставлено автоматически: {auto.length}</summary>
                <div style={{ marginTop: 8 }}>{auto.map(row)}</div>
              </details>
            )}
          </div>

          {plan.unresolved.length > 0 && <p className="sub" role="status">Осталось выбрать решение для упражнений: {plan.unresolved.length}.</p>}
          {plan.newExercises.length > 0 && <p className="sub">Будет создано новых упражнений: {plan.newExercises.length}.</p>}
          <p className="sub">Импортированные тренировки считаются выполненными и учитываются в аналитике и рекордах, но не дают опыта, монет и достижений.</p>
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn ghost" style={{ flex: 1 }} onClick={onClose}>Отмена</button>
            <button className="btn primary" style={{ flex: 2 }} disabled={busy || plan.unresolved.length > 0 || plan.workouts.length === 0} onClick={() => void run()}>
              {plan.workouts.length === 0 ? 'Импортировать нечего' : `Импортировать ${plan.workouts.length}`}
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}
