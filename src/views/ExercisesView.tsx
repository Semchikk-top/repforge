import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { putExercise, softDelete, getDeviceId } from '../db/repo';
import { MUSCLE_LABELS, type Exercise, type MuscleGroup } from '../domain/types';
import { uid } from '../lib';
import { fieldToRest, formatRest, REST_PRESETS, restToField } from '../domain/rest';
import { useSettings } from '../state/settings';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';

export function ExercisesView() {
  const all = useLiveQuery(() => db.exercises.toArray(), [], [] as Exercise[]);
  const [q, setQ] = useState('');
  const [muscle, setMuscle] = useState<MuscleGroup | 'all'>('all');
  const [edit, setEdit] = useState<Exercise | 'new' | null>(null);

  const list = useMemo(
    () => all.filter((e) => !e.deletedAt && (muscle === 'all' || e.muscle === muscle) && e.name.toLowerCase().includes(q.trim().toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    [all, q, muscle]
  );

  return (
    <div>
      <div className="page-head">
        <h1>Упражнения</h1>
        <button className="btn small primary" onClick={() => setEdit('new')}>Добавить</button>
      </div>
      <input className="input" placeholder="Поиск по названию" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск" />
      <div className="chips" style={{ marginTop: 10 }}>
        <button className={'chip' + (muscle === 'all' ? ' on' : '')} onClick={() => setMuscle('all')}>Все</button>
        {(Object.keys(MUSCLE_LABELS) as MuscleGroup[]).map((m) => (
          <button key={m} className={'chip' + (muscle === m ? ' on' : '')} onClick={() => setMuscle(m)}>{MUSCLE_LABELS[m]}</button>
        ))}
      </div>
      <div className="list">
        {list.map((e) => (
          <button key={e.id} className="row" onClick={() => setEdit(e)}>
            <div className="grow">
              <div className="title">{e.name}</div>
              <div className="meta">{MUSCLE_LABELS[e.muscle]} · {e.equipment}{e.restSec ? ` · отдых ${formatRest(e.restSec)}` : ''}</div>
            </div>
          </button>
        ))}
        {list.length === 0 && <p className="empty">Ничего не найдено.</p>}
      </div>
      {edit && <ExerciseSheet exercise={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </div>
  );
}

function ExerciseSheet({ exercise, onClose }: { exercise: Exercise | null; onClose: () => void }) {
  const toast = useToast();
  const { settings } = useSettings();
  const [name, setName] = useState(exercise?.name ?? '');
  const [muscle, setMuscle] = useState<MuscleGroup>(exercise?.muscle ?? 'chest');
  const [equipment, setEquipment] = useState(exercise?.equipment ?? '');
  const [rest, setRest] = useState(restToField(exercise?.restSec)); // '' — как в настройках
  const [note, setNote] = useState(exercise?.note ?? '');

  const save = async () => {
    const base = exercise ?? { id: uid(), createdAt: Date.now(), custom: true };
    await putExercise({
      ...(base as Exercise),
      name: name.trim(),
      muscle,
      equipment: equipment.trim() || 'Свой вес',
      restSec: fieldToRest(rest),
      note: note.trim() || undefined,
      deviceId: await getDeviceId()
    });
    toast(exercise ? 'Изменения сохранены' : 'Упражнение добавлено');
    onClose();
  };

  const remove = async () => {
    if (!exercise) return;
    if (!confirm(`Удалить «${exercise.name}»? В старых тренировках оно останется.`)) return;
    await softDelete('exercises', exercise.id);
    toast('Упражнение удалено');
    onClose();
  };

  return (
    <Sheet title={exercise ? 'Упражнение' : 'Новое упражнение'} onClose={onClose}>
      <div className="field"><label htmlFor="ex-name">Название</label><input id="ex-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="field">
        <label htmlFor="ex-muscle">Группа мышц</label>
        <select id="ex-muscle" className="input" value={muscle} onChange={(e) => setMuscle(e.target.value as MuscleGroup)}>
          {(Object.keys(MUSCLE_LABELS) as MuscleGroup[]).map((m) => <option key={m} value={m}>{MUSCLE_LABELS[m]}</option>)}
        </select>
      </div>
      <div className="field"><label htmlFor="ex-eq">Оборудование</label><input id="ex-eq" className="input" value={equipment} onChange={(e) => setEquipment(e.target.value)} placeholder="Штанга, гантели, тренажёр…" /></div>
      <div className="field">
        <label htmlFor="ex-rest">Отдых между подходами</label>
        <select id="ex-rest" className="input" value={rest} onChange={(e) => setRest(e.target.value)}>
          <option value="">Как в настройках ({formatRest(settings.defaultRestSec)})</option>
          {(REST_PRESETS as readonly number[]).map((v) => <option key={v} value={String(v)}>{formatRest(v)}</option>)}
          {rest !== '' && !(REST_PRESETS as readonly number[]).includes(Number(rest)) && <option value={rest}>{formatRest(Number(rest))} (своё значение)</option>}
        </select>
        <span className="sub">Таймер отдыха в тренировке берёт это значение, а без него общую настройку.</span>
      </div>
      <div className="field"><label htmlFor="ex-note">Заметка о технике</label><textarea id="ex-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <button className="btn primary block" disabled={!name.trim()} onClick={save}>Сохранить</button>
      {exercise && <button className="btn danger ghost block" style={{ marginTop: 10 }} onClick={remove}>Удалить упражнение</button>}
    </Sheet>
  );
}
