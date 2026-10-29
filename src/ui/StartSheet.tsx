import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { newWorkout } from '../db/repo';
import { exercisesFromTemplate } from '../domain/ops';
import type { Exercise, Template, WorkoutStatus } from '../domain/types';
import { go } from '../state/router';
import { Sheet } from './Sheet';

export type StartMode = 'plan' | 'start' | 'log';

const TITLES: Record<StartMode, string> = { plan: 'Запланировать тренировку', start: 'Начать тренировку', log: 'Записать тренировку' };

export function StartSheet({ date, mode, onClose }: { date: string; mode: StartMode; onClose: () => void }) {
  const templates = useLiveQuery(() => db.templates.toArray().then((t) => t.filter((x) => !x.deletedAt)), [], [] as Template[]);

  const create = async (t?: Template) => {
    const [history, exs] = await Promise.all([db.workouts.toArray(), db.exercises.toArray()]);
    const exMap = new Map<string, Exercise>(exs.map((e) => [e.id, e]));
    const status: WorkoutStatus = mode === 'plan' ? 'planned' : 'active';
    const w = await newWorkout({
      date,
      status,
      title: t?.title ?? 'Тренировка',
      startedAt: status === 'active' ? Date.now() : undefined,
      exercises: t ? exercisesFromTemplate(t, history, exMap) : []
    });
    onClose();
    go(`workout/${w.id}`);
  };

  return (
    <Sheet title={TITLES[mode]} onClose={onClose}>
      <button className="btn primary block" onClick={() => create()}>Пустая тренировка</button>
      <div className="section" style={{ marginTop: 18 }}>
        <h2>Из шаблона</h2>
        {templates.length === 0 && <p className="empty">Шаблонов пока нет. Сохрани любую завершённую тренировку как шаблон, и он появится здесь.</p>}
        <div className="list">
          {templates.map((t) => (
            <button key={t.id} className="row" onClick={() => create(t)}>
              <div className="grow">
                <div className="title">{t.title}</div>
                <div className="meta">{t.exercises.length} упр.</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  );
}
