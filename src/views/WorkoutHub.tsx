import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { softDelete } from '../db/repo';
import type { Template, Workout } from '../domain/types';
import { todayStr } from '../lib';
import { go } from '../state/router';
import { IconChevR, IconNearby, IconTrash } from '../ui/Icons';
import { useRoomUi } from '../nearby/RoomProvider';
import { useRoom } from '../nearby/useRoom';
import { GoalsCard } from '../ui/GoalsCard';
import { StartSheet } from '../ui/StartSheet';
import { TemplateSheet } from './TemplateSheet';
import { useToast } from '../ui/Toast';

export function WorkoutHub() {
  const [sheet, setSheet] = useState(false);
  const [editing, setEditing] = useState<string | null>(null); // id шаблона в редакторе
  const toast = useToast();
  const roomUi = useRoomUi();
  const roomPhase = useRoom().phase;
  const today = todayStr();
  const workouts = useLiveQuery(() => db.workouts.toArray().then((w) => w.filter((x) => !x.deletedAt)), [], [] as Workout[]);
  const templates = useLiveQuery(() => db.templates.toArray().then((t) => t.filter((x) => !x.deletedAt)), [], [] as Template[]);

  const active = workouts.filter((w) => w.status === 'active');
  const planned = workouts.filter((w) => w.status === 'planned' && w.date === today);

  return (
    <div>
      <div className="page-head"><h1>Тренировка</h1></div>

      <GoalsCard workouts={workouts} />

      {active.length > 0 && (
        <div className="section" style={{ marginTop: 0 }}>
          <h2>Идёт сейчас</h2>
          <div className="list">
            {active.map((w) => (
              <button key={w.id} className="row" onClick={() => go(`workout/${w.id}`)}>
                <div className="grow"><div className="title">{w.title}</div><div className="meta">Продолжить</div></div>
                <IconChevR size={18} />
              </button>
            ))}
          </div>
        </div>
      )}

      {planned.length > 0 && (
        <div className="section">
          <h2>Запланировано на сегодня</h2>
          <div className="list">
            {planned.map((w) => (
              <button key={w.id} className="row" onClick={() => go(`workout/${w.id}`)}>
                <div className="grow"><div className="title">{w.title}</div><div className="meta">{w.exercises.length} упр.</div></div>
                <IconChevR size={18} />
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="section" style={active.length || planned.length ? undefined : { marginTop: 0 }}>
        <button className="btn primary block" onClick={() => setSheet(true)}>Начать новую тренировку</button>
      </div>

      <div className="section">
        <button className="btn block" onClick={() => go('programs')}>Программы тренировок</button>
      </div>

      <div className="section">
        <button className="row room-card" onClick={roomUi.openSheet}>
          <IconNearby size={26} />
          <div className="grow">
            <div className="title">Тренируешься с другом?</div>
            <div className="meta">{roomPhase === 'idle' ? 'Комната «Рядом»: связь и «что он делает сейчас»' : 'Комната открыта: нажми, чтобы вернуться'}</div>
          </div>
          <IconChevR size={18} />
        </button>
      </div>

      <div className="section">
        <h2>Шаблоны</h2>
        {templates.length === 0 && <p className="empty">Закончи тренировку и сохрани её как шаблон: в следующий раз начнёшь в одно касание.</p>}
        <div className="list">
          {templates.map((t) => (
            <div key={t.id} className="row">
              <div className="grow">
                <div className="title">{t.title}</div>
                <div className="meta">{t.exercises.length} упр.</div>
              </div>
              <button className="btn small ghost" aria-label={`Изменить шаблон ${t.title}`} onClick={() => setEditing(t.id)}>Изменить</button>
              <button className="icon-btn" aria-label={`Удалить шаблон ${t.title}`} onClick={async () => {
                if (confirm(`Удалить шаблон «${t.title}»?`)) { await softDelete('templates', t.id); toast('Шаблон удалён'); }
              }}><IconTrash size={20} /></button>
            </div>
          ))}
        </div>
      </div>

      {editing && (() => { const t = templates.find((x) => x.id === editing); return t ? <TemplateSheet template={t} onClose={() => setEditing(null)} /> : null; })()}
      {sheet && <StartSheet date={today} mode="start" onClose={() => setSheet(false)} />}
    </div>
  );
}
