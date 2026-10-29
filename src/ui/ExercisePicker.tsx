import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { MUSCLE_LABELS, type Exercise, type MuscleGroup } from '../domain/types';
import { Sheet } from './Sheet';

export function ExercisePicker({ onPick, onClose, multi }: { onPick: (ids: string[]) => void; onClose: () => void; multi?: boolean }) {
  const all = useLiveQuery(() => db.exercises.toArray(), [], [] as Exercise[]);
  const [q, setQ] = useState('');
  const [muscle, setMuscle] = useState<MuscleGroup | 'all'>('all');
  const [picked, setPicked] = useState<string[]>([]);

  const list = useMemo(
    () =>
      all
        .filter((e) => !e.deletedAt)
        .filter((e) => muscle === 'all' || e.muscle === muscle)
        .filter((e) => e.name.toLowerCase().includes(q.trim().toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    [all, q, muscle]
  );

  const toggle = (id: string) => {
    if (!multi) { onPick([id]); return; }
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };

  return (
    <Sheet title="Выбор упражнения" onClose={onClose}>
      <input className="input" placeholder="Поиск по названию" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="chips" style={{ marginTop: 10 }}>
        <button className={'chip' + (muscle === 'all' ? ' on' : '')} onClick={() => setMuscle('all')}>Все</button>
        {(Object.keys(MUSCLE_LABELS) as MuscleGroup[]).map((m) => (
          <button key={m} className={'chip' + (muscle === m ? ' on' : '')} onClick={() => setMuscle(m)}>{MUSCLE_LABELS[m]}</button>
        ))}
      </div>
      <div className="list">
        {list.map((e) => (
          <button key={e.id} className="row" onClick={() => toggle(e.id)}>
            <div className="grow">
              <div className="title">{e.name}</div>
              <div className="meta">{MUSCLE_LABELS[e.muscle]} · {e.equipment}</div>
            </div>
            {multi && <span style={{ color: picked.includes(e.id) ? 'var(--accent)' : 'var(--muted)' }}>{picked.includes(e.id) ? 'Выбрано' : ''}</span>}
          </button>
        ))}
        {list.length === 0 && <p className="empty">Ничего не найдено. Добавь своё упражнение на вкладке «Упражнения».</p>}
      </div>
      {multi && (
        <button className="btn primary block" style={{ marginTop: 12 }} disabled={!picked.length} onClick={() => onPick(picked)}>
          Добавить ({picked.length})
        </button>
      )}
    </Sheet>
  );
}
