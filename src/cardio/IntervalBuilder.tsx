import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../ui/Toast';
import type { IntervalPhase, IntervalPlan, IntervalTarget, Sport } from '../domain/types';
import { deleteTemplate, loadTemplates, saveTemplate, MAX_TITLE, type IntervalTemplate } from './intervalTemplates';
import { LENGTH_UNITS, lengthFromInput, lengthToInput, MAX_REPS, planSummary, targetLabel, validatePlan, type LengthUnit } from './intervals';
import { targetFromText } from './target';

interface LenField { text: string; unit: LengthUnit }
interface TargetField { kind: 'none' | 'pace' | 'zone'; text: string; zone: 1 | 2 | 3 | 4 | 5 }
interface Form { warmup: LenField; reps: string; work: LenField; workTarget: TargetField; rest: LenField; restTarget: TargetField; cooldown: LenField }

const noTarget: TargetField = { kind: 'none', text: '', zone: 4 };
const DEFAULT: Form = {
  warmup: { text: '5', unit: 'min' }, reps: '6', work: { text: '1', unit: 'min' }, workTarget: noTarget,
  rest: { text: '1', unit: 'min' }, restTarget: noTarget, cooldown: { text: '5', unit: 'min' }
};

function toForm(p: IntervalPlan, bike: boolean): Form {
  const len = (l: IntervalPlan['warmup']): LenField => (l ? lengthToInput(l) : { text: '', unit: 'min' });
  const tgt = (t: IntervalTarget | undefined): TargetField => {
    if (!t) return noTarget;
    if (t.kind === 'zone') return { kind: 'zone', text: '', zone: t.zone };
    return { kind: 'pace', text: bike ? String(Math.round((3600 / t.secPerKm) * 10) / 10).replace('.', ',') : `${Math.floor(t.secPerKm / 60)}:${String(Math.round(t.secPerKm % 60)).padStart(2, '0')}`, zone: 4 };
  };
  return { warmup: len(p.warmup), reps: String(p.reps), work: len(p.work.length), workTarget: tgt(p.work.target), rest: len(p.rest?.length), restTarget: tgt(p.rest?.target), cooldown: len(p.cooldown) };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/** Форма в план. Пустые разминка, отдых и заминка означают «нет»; заполненное с ошибкой даёт понятное сообщение. */
function toPlan(f: Form, bike: boolean): Parsed<IntervalPlan> {
  const opt = (x: LenField, name: string): Parsed<IntervalPlan['warmup']> => {
    if (!x.text.trim()) return { ok: true, value: undefined };
    const l = lengthFromInput(x.text, x.unit);
    return l ? { ok: true, value: l } : { ok: false, error: `${name}: проверь число (время от 5 секунд, дистанция от 20 м)` };
  };
  const target = (t: TargetField, name: string): Parsed<IntervalTarget | undefined> => {
    if (t.kind === 'none') return { ok: true, value: undefined };
    if (t.kind === 'zone') return { ok: true, value: { kind: 'zone', zone: t.zone } };
    const sec = targetFromText(t.text, bike);
    return sec === null ? { ok: false, error: `${name}: ${bike ? 'скорость от 3 до 60 км/ч' : 'темп вида 4:30, от 2:30 до 20:00'}` } : { ok: true, value: { kind: 'pace', secPerKm: sec } };
  };
  const warmup = opt(f.warmup, 'Разминка'); if (!warmup.ok) return warmup;
  const cooldown = opt(f.cooldown, 'Заминка'); if (!cooldown.ok) return cooldown;
  const workLen = lengthFromInput(f.work.text, f.work.unit);
  if (!workLen) return { ok: false, error: 'Работа: проверь число (время от 5 секунд, дистанция от 20 м)' };
  const workTarget = target(f.workTarget, 'Цель работы'); if (!workTarget.ok) return workTarget;
  const restLen = opt(f.rest, 'Отдых'); if (!restLen.ok) return restLen;
  const restTarget = target(f.restTarget, 'Цель отдыха'); if (!restTarget.ok) return restTarget;
  const reps = /^\d+$/.test(f.reps.trim()) ? Number(f.reps) : NaN;
  if (!Number.isInteger(reps) || reps < 1 || reps > MAX_REPS) return { ok: false, error: `Повторов от 1 до ${MAX_REPS}` };
  const work: IntervalPhase = { length: workLen, ...(workTarget.value ? { target: workTarget.value } : {}) };
  const plan: IntervalPlan = {
    ...(warmup.value ? { warmup: warmup.value } : {}), reps, work,
    ...(restLen.value ? { rest: { length: restLen.value, ...(restTarget.value ? { target: restTarget.value } : {}) } } : {}),
    ...(cooldown.value ? { cooldown: cooldown.value } : {})
  };
  const err = validatePlan(plan);
  return err ? { ok: false, error: err } : { ok: true, value: plan };
}

function LengthInput({ id, label, value, onChange }: { id: string; label: string; value: LenField; onChange: (v: LenField) => void }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="row" style={{ gap: 6 }}>
        <input id={id} className="input grow" inputMode="decimal" value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} />
        <select className="input" aria-label={`${label}: единица`} value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value as LengthUnit })}>
          {LENGTH_UNITS.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
        </select>
      </div>
    </div>
  );
}

function TargetInput({ id, label, bike, value, onChange }: { id: string; label: string; bike: boolean; value: TargetField; onChange: (v: TargetField) => void }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="row" style={{ gap: 6 }}>
        <select id={id} className="input" value={value.kind} onChange={(e) => onChange({ ...value, kind: e.target.value as TargetField['kind'] })}>
          <option value="none">Без цели</option>
          <option value="pace">{bike ? 'Скорость' : 'Темп'}</option>
          <option value="zone">Пульсовая зона</option>
        </select>
        {value.kind === 'pace' && <input className="input grow" aria-label={`${label}: значение`} inputMode={bike ? 'decimal' : 'text'} value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} placeholder={bike ? '30 км/ч' : '4:30 /км'} />}
        {value.kind === 'zone' && (
          <select className="input" aria-label={`${label}: зона`} value={value.zone} onChange={(e) => onChange({ ...value, zone: Number(e.target.value) as TargetField['zone'] })}>
            {[1, 2, 3, 4, 5].map((z) => <option key={z} value={z}>Зона {z}</option>)}
          </select>
        )}
      </div>
    </div>
  );
}

/** Конструктор интервалов: сообщает родителю готовый план или null, пока форма заполнена с ошибкой. */
export function IntervalBuilder({ sport, onChange }: { sport: Sport; onChange: (plan: IntervalPlan | null) => void }) {
  const bike = sport === 'bike';
  const toast = useToast();
  const [form, setForm] = useState<Form>(DEFAULT);
  const [templates, setTemplates] = useState<IntervalTemplate[]>([]);
  const [title, setTitle] = useState('');
  const parsed = useMemo(() => toPlan(form, bike), [form, bike]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));

  useEffect(() => { onChange(parsed.ok ? parsed.value : null); }, [parsed, onChange]);
  useEffect(() => { void loadTemplates().then(setTemplates); }, []);

  const mine = templates.filter((t) => t.sport === sport);
  const save = async () => {
    if (!parsed.ok) return;
    const err = await saveTemplate(title, sport, parsed.value);
    if (err) { toast(err); return; }
    setTemplates(await loadTemplates()); setTitle(''); toast('Шаблон сохранён');
  };

  return (
    <div className="interval-builder">
      {mine.length > 0 && (
        <div className="field">
          <div className="sub">Мои шаблоны</div>
          <ul className="tpl-list">
            {mine.map((t) => (
              <li key={t.id} className="row">
                <button className="btn small grow" style={{ textAlign: 'left' }} onClick={() => setForm(toForm(t.plan, bike))}>{t.title}<span className="sub"> · {planSummary(t.plan)}</span></button>
                <button className="btn small ghost danger" aria-label={`Удалить шаблон ${t.title}`} onClick={() => { void deleteTemplate(t.id).then(loadTemplates).then(setTemplates); }}>Удалить</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      <LengthInput id="iv-warmup" label="Разминка (можно пусто)" value={form.warmup} onChange={(v) => set('warmup', v)} />
      <div className="field">
        <label htmlFor="iv-reps">Повторов</label>
        <input id="iv-reps" className="input" inputMode="numeric" value={form.reps} onChange={(e) => set('reps', e.target.value)} />
      </div>
      <LengthInput id="iv-work" label="Работа" value={form.work} onChange={(v) => set('work', v)} />
      <TargetInput id="iv-work-t" label="Цель работы" bike={bike} value={form.workTarget} onChange={(v) => set('workTarget', v)} />
      <LengthInput id="iv-rest" label="Отдых (можно пусто)" value={form.rest} onChange={(v) => set('rest', v)} />
      {form.rest.text.trim() !== '' && <TargetInput id="iv-rest-t" label="Цель отдыха" bike={bike} value={form.restTarget} onChange={(v) => set('restTarget', v)} />}
      <LengthInput id="iv-cool" label="Заминка (можно пусто)" value={form.cooldown} onChange={(v) => set('cooldown', v)} />
      {parsed.ok
        ? <p className="sub" role="status">{planSummary(parsed.value)}{parsed.value.work.target ? ` · работа ${targetLabel(parsed.value.work.target, bike)}` : ''}</p>
        : <p className="msg-error" role="status">{parsed.error}</p>}
      <div className="row" style={{ gap: 6 }}>
        <input className="input grow" aria-label="Название шаблона" maxLength={MAX_TITLE} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Название шаблона" />
        <button className="btn small" disabled={!parsed.ok || !title.trim()} onClick={() => void save()}>Сохранить</button>
      </div>
    </div>
  );
}
