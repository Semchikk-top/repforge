import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { putTemplate } from '../db/repo';
import { blocksOf } from '../domain/reorder';
import {
  addToDraft, applyDraft, draftOf, draftValid, isDirty, patchInDraft, programsUsing, removeFromDraft, renameDraft, stepInDraft, TITLE_MAX
} from '../domain/templateEdit';
import { isCardio, type Exercise, type Program, type Template } from '../domain/types';
import { ExercisePicker } from '../ui/ExercisePicker';
import { IconArrowDown, IconArrowUp, IconTrash } from '../ui/Icons';
import { Sheet } from '../ui/Sheet';
import { Stepper } from '../ui/Stepper';
import { useToast } from '../ui/Toast';
import { useSettings } from '../state/settings';

/** Редактор шаблона: правки живут в черновике, пока не нажато «Сохранить». Закрытие без сохранения спрашивает подтверждение. */
export function TemplateSheet({ template, onClose }: { template: Template; onClose: () => void }) {
  const toast = useToast();
  const { settings } = useSettings();
  const [draft, setDraft] = useState(() => draftOf(template));
  const [picker, setPicker] = useState(false);
  const exercises = useLiveQuery(() => db.exercises.toArray(), [], [] as Exercise[]);
  const programs = useLiveQuery(() => db.programs.toArray(), [], [] as Program[]);
  const exMap = useMemo(() => new Map(exercises.map((e) => [e.id, e])), [exercises]);
  const used = useMemo(() => programsUsing(programs, template.id), [programs, template.id]);
  const blocks = useMemo(() => blocksOf(draft.exercises), [draft.exercises]);
  const blockOf = (i: number) => blocks.findIndex((b) => i >= b.start && i < b.end);

  const dirty = isDirty(template, draft);
  const valid = draftValid(draft);

  const confirmDiscard = () => !dirty || confirm('Закрыть без сохранения? Правки шаблона пропадут.');

  const save = async () => {
    await putTemplate(applyDraft(template, draft));
    toast('Шаблон сохранён');
    onClose();
  };

  const addMany = (ids: string[]) => {
    setPicker(false);
    setDraft((d) => ids.reduce((acc, id) => addToDraft(acc, id, isCardio(exMap.get(id))), d));
  };

  return (
    <Sheet title="Шаблон" onClose={onClose} onBeforeClose={confirmDiscard}>
      <div className="field">
        <label htmlFor="tpl-name">Название</label>
        <input id="tpl-name" className="input" maxLength={TITLE_MAX} value={draft.title} onChange={(e) => setDraft(renameDraft(draft, e.target.value))} />
      </div>

      {used.length > 0 && (
        <p className="notice" role="status">
          Шаблон используется в {used.length === 1 ? 'программе' : 'программах'}: {used.map((p) => `«${p.title}»`).join(', ')}. Уже назначенные тренировки не изменятся, а новые будут созданы по обновлённому шаблону.
        </p>
      )}

      {draft.exercises.length === 0 && <p className="empty">В шаблоне нет упражнений. Добавь хотя бы одно.</p>}

      <div className="tpl-list">
        {draft.exercises.map((e, i) => {
          const ex = exMap.get(e.exerciseId);
          const cardio = isCardio(ex);
          const b = blockOf(i);
          return (
            <div key={i} className="tpl-ex">
              <div className="tpl-ex-head">
                <div className="grow">
                  <div className="title">{e.group && <span className="ss-chip" title="Суперсет">∞</span>}{ex?.name ?? 'Удалённое упражнение'}</div>
                  {cardio && <div className="meta">Кардио: дистанцию и время записывают во время тренировки</div>}
                </div>
                <button className="icon-btn" aria-label="Выше" disabled={b === 0} onClick={() => setDraft(stepInDraft(draft, i, -1))}><IconArrowUp size={18} /></button>
                <button className="icon-btn" aria-label="Ниже" disabled={b === blocks.length - 1} onClick={() => setDraft(stepInDraft(draft, i, 1))}><IconArrowDown size={18} /></button>
                <button className="icon-btn" aria-label={`Убрать ${ex?.name ?? 'упражнение'} из шаблона`} onClick={() => setDraft(removeFromDraft(draft, i))}><IconTrash size={18} /></button>
              </div>
              {!cardio && (
                <div className="tpl-steppers">
                  <Stepper value={e.sets} step={1} min={1} unit="подх." onChange={(v) => setDraft(patchInDraft(draft, i, { sets: v }))} />
                  <Stepper value={e.reps} step={1} min={1} unit="повт." onChange={(v) => setDraft(patchInDraft(draft, i, { reps: v }))} />
                  <Stepper value={e.weight} step={settings.weightStep} unit="кг" decimals onChange={(v) => setDraft(patchInDraft(draft, i, { weight: v }))} />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button className="btn block" style={{ marginTop: 10 }} onClick={() => setPicker(true)}>Добавить упражнение</button>
      <p className="sub">Вес в шаблоне нужен для первой тренировки: потом подставляется результат из истории.</p>
      <button className="btn primary block" disabled={!valid || !dirty} onClick={() => void save()}>Сохранить</button>
      <button className="btn ghost block" style={{ marginTop: 8 }} onClick={() => { if (confirmDiscard()) onClose(); }}>Отмена</button>

      {picker && <ExercisePicker multi onPick={addMany} onClose={() => setPicker(false)} />}
    </Sheet>
  );
}
