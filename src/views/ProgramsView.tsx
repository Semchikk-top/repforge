import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { newWorkout, putProgram, softDelete } from '../db/repo';
import { WEEKDAY_SHORT, currentWeek, nextMonday, planProgram } from '../domain/programs';
import type { Exercise, Program, ProgramDay, Template, Workout } from '../domain/types';
import { parseDate, todayStr, uid } from '../lib';
import { go } from '../state/router';
import { IconBack, IconTrash } from '../ui/Icons';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/Toast';

const live = <T extends { deletedAt?: number | null }>(rows: T[]) => rows.filter((r) => !r.deletedAt);

export function ProgramsView() {
  const toast = useToast();
  const programs = useLiveQuery(() => db.programs.toArray().then(live), [], [] as Program[]);
  const templates = useLiveQuery(() => db.templates.toArray().then(live), [], [] as Template[]);
  const [editing, setEditing] = useState<Program | 'new' | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const tplMap = useMemo(() => new Map(templates.map((t) => [t.id, t])), [templates]);
  const active = programs.filter((p) => !p.archivedAt);
  const archived = programs.filter((p) => p.archivedAt);

  const setArchived = async (p: Program, archivedAt: number | null) => {
    await putProgram({ ...p, archivedAt });
    toast(archivedAt ? 'Программа в архиве' : 'Программа возвращена');
  };

  const assign = async (program: Program) => {
    const [workouts, exs] = await Promise.all([db.workouts.toArray(), db.exercises.toArray()]);
    const exMap = new Map<string, Exercise>(exs.map((e) => [e.id, e]));
    const { slots, skippedPast, missingTemplates } = planProgram({ program, templates: tplMap, existing: workouts, history: workouts, exMap });
    for (const sl of slots) {
      await newWorkout({ date: sl.date, status: 'planned', title: sl.title, exercises: sl.exercises, programId: program.id, programSlot: sl.programSlot, templateId: sl.templateId });
    }
    const parts = [slots.length ? `Назначено тренировок: ${slots.length}` : 'Новых тренировок нет'];
    if (skippedPast) parts.push(`прошедших дат пропущено: ${skippedPast}`);
    if (missingTemplates) parts.push(`удалённых шаблонов: ${missingTemplates}`);
    toast(parts.join('. '));
  };

  const remove = async (program: Program) => {
    if (!confirm(`Удалить программу «${program.title}»? Назначенные, но ещё не начатые тренировки из неё тоже уберутся.`)) return;
    const planned = (await db.workouts.toArray()).filter((w: Workout) => !w.deletedAt && w.programId === program.id && w.status === 'planned');
    for (const w of planned) await softDelete('workouts', w.id);
    await softDelete('programs', program.id);
    toast(planned.length ? `Программа удалена, убрано тренировок: ${planned.length}` : 'Программа удалена');
  };

  return (
    <div>
      <div className="head-row">
        <button className="icon-btn" onClick={() => go('workout')} aria-label="К тренировкам"><IconBack /></button>
        <h1 style={{ margin: 0 }}>Программы</h1>
      </div>
      <p className="sub">Цикл из недель: в одни и те же дни приложение само назначает тренировки в календарь по твоим шаблонам.</p>

      {active.length === 0 && (
        <p className="empty">{templates.length === 0 ? 'Для программы нужны шаблоны: закончи тренировку и сохрани её как шаблон.' : 'Активных программ нет.'}</p>
      )}
      <div className="list">
        {active.map((p) => {
          const week = currentWeek(p, todayStr());
          return (
            <div key={p.id} className="row program-row">
              <div className="grow">
                <div className="title">{p.title}</div>
                <div className="meta">
                  {p.weeks} нед. · {[...p.days].sort((a, b) => a.weekday - b.weekday).map((d) => WEEKDAY_SHORT[d.weekday - 1]).join(', ') || 'дни не выбраны'}
                  {' · '}{week ? `идёт неделя ${week} из ${p.weeks}` : parseDate(p.startDate) > new Date() ? `старт ${parseDate(p.startDate).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}` : 'завершена'}
                </div>
                <div className="conn-actions" style={{ justifyContent: 'flex-start' }}>
                  <button className="btn small primary" onClick={() => void assign(p)}>Назначить в календарь</button>
                  <button className="btn small" onClick={() => setEditing(p)}>Изменить</button>
                  <button className="btn small ghost" onClick={() => void setArchived(p, Date.now())}>В архив</button>
                </div>
              </div>
              <button className="icon-btn" aria-label={`Удалить программу ${p.title}`} onClick={() => void remove(p)}><IconTrash size={20} /></button>
            </div>
          );
        })}
      </div>

      {archived.length > 0 && (
        <>
          <button className="btn block ghost" style={{ marginTop: 10 }} onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? 'Скрыть архив' : `Архив (${archived.length})`}
          </button>
          {showArchived && (
            <div className="list" style={{ marginTop: 8 }}>
              {archived.map((p) => (
                <div key={p.id} className="row">
                  <div className="grow">
                    <div className="title">{p.title}</div>
                    <div className="meta">{p.weeks} нед. · в архиве с {new Date(p.archivedAt!).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}</div>
                  </div>
                  <button className="btn small ghost" onClick={() => void setArchived(p, null)}>Вернуть</button>
                  <button className="icon-btn" aria-label={`Удалить программу ${p.title}`} onClick={() => void remove(p)}><IconTrash size={20} /></button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <button className="btn primary block" style={{ marginTop: 14 }} disabled={templates.length === 0} onClick={() => setEditing('new')}>Создать программу</button>

      {editing && <ProgramSheet program={editing === 'new' ? null : editing} templates={templates} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ProgramSheet({ program, templates, onClose }: { program: Program | null; templates: Template[]; onClose: () => void }) {
  const [title, setTitle] = useState(program?.title ?? '');
  const [start, setStart] = useState(program?.startDate ?? nextMonday());
  const [weeks, setWeeks] = useState(program?.weeks ?? 4);
  const [days, setDays] = useState<Record<number, string>>(Object.fromEntries((program?.days ?? []).map((d) => [d.weekday, d.templateId])));

  const chosen: ProgramDay[] = Object.entries(days).filter(([, t]) => t).map(([d, t]) => ({ weekday: Number(d), templateId: t }));
  const valid = title.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(start) && weeks >= 1 && weeks <= 24 && chosen.length > 0;

  const toggle = (wd: number) => setDays((cur) => {
    const next = { ...cur };
    if (next[wd]) delete next[wd]; else next[wd] = templates[0]?.id ?? '';
    return next;
  });

  const save = async () => {
    await putProgram({ id: program?.id ?? uid(), createdAt: program?.createdAt ?? Date.now(), title: title.trim().slice(0, 60), startDate: start, weeks, days: chosen });
    onClose();
  };

  return (
    <Sheet title={program ? 'Программа' : 'Новая программа'} onClose={onClose}>
      <div className="field">
        <label htmlFor="pg-title">Название</label>
        <input id="pg-title" className="input" maxLength={60} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например, Сила на 8 недель" />
      </div>
      <div className="field">
        <label htmlFor="pg-start">Первая неделя начинается</label>
        <input id="pg-start" className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="pg-weeks">Недель в цикле</label>
        <input id="pg-weeks" className="input" type="number" min={1} max={24} inputMode="numeric" value={weeks} onChange={(e) => setWeeks(Math.min(24, Math.max(1, Math.round(Number(e.target.value)) || 1)))} />
      </div>
      <div className="field">
        <label>Дни и шаблоны</label>
        <div className="chips wrap" role="group" aria-label="Дни недели">
          {WEEKDAY_SHORT.map((n, i) => <button key={n} className={'chip' + (days[i + 1] ? ' on' : '')} aria-pressed={!!days[i + 1]} onClick={() => toggle(i + 1)}>{n}</button>)}
        </div>
        {WEEKDAY_SHORT.map((n, i) => days[i + 1] !== undefined && (
          <div key={n} className="program-day">
            <span>{n}</span>
            <select className="input" aria-label={`Шаблон на ${n}`} value={days[i + 1]} onChange={(e) => setDays({ ...days, [i + 1]: e.target.value })}>
              {templates.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
          </div>
        ))}
      </div>
      <button className="btn primary block" disabled={!valid} onClick={() => void save()}>Сохранить</button>
    </Sheet>
  );
}
