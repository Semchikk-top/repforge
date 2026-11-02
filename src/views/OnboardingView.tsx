import { useMemo, useState } from 'react';
import { applyStarterPlan } from '../db/repo';
import {
  EQUIPMENT_LABEL, EXPERIENCE_LABEL, GOAL_LABEL, recommendPrograms, type Answers, type Equipment, type Experience, type Goal, type StarterPlan
} from '../domain/starter';
import { nextMonday, WEEKDAY_SHORT } from '../domain/programs';
import { go } from '../state/router';
import { useToast } from '../ui/Toast';
import { dismissOnboarding } from './onboardingState';


type Step = 0 | 1 | 2 | 3 | 4; // четыре вопроса и итог

function Choice<T extends string | number>({ label, options, value, onPick }: { label: string; options: { id: T; text: string; hint?: string }[]; value: T | undefined; onPick: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} style={{ display: 'grid', gap: 8 }}>
      {options.map((o) => (
        <button key={String(o.id)} className={'btn block' + (value === o.id ? ' primary' : '')} style={{ minHeight: 56, textAlign: 'left' }} aria-pressed={value === o.id} onClick={() => onPick(o.id)}>
          {o.text}{o.hint && <div className="meta" style={{ fontWeight: 400 }}>{o.hint}</div>}
        </button>
      ))}
    </div>
  );
}

/** Четыре вопроса и 2–3 предложенных программы. «Пропустить» доступно на каждом шаге и ничего не создаёт. */
export function OnboardingView() {
  const toast = useToast();
  const [step, setStep] = useState<Step>(0);
  const [a, setA] = useState<Partial<Answers>>({});
  const [busy, setBusy] = useState(false);

  const complete = (a.goal && a.experience && a.days && a.equipment) ? (a as Answers) : null;
  const plans = useMemo(() => (complete ? recommendPrograms(complete) : []), [complete]);

  const skip = () => { void dismissOnboarding(); go('calendar'); };
  const next = (patch: Partial<Answers>) => { setA((p) => ({ ...p, ...patch })); setStep((s) => (s + 1) as Step); };

  const choose = async (plan: StarterPlan) => {
    if (busy) return;
    setBusy(true);
    try {
      await applyStarterPlan(plan, nextMonday());
      await dismissOnboarding();
      toast('Программа создана');
      go('programs');
    } catch {
      toast('Не удалось создать программу');
      setBusy(false);
    }
  };

  const titles = ['Какая у тебя цель?', 'Какой у тебя опыт?', 'Сколько дней в неделю готов тренироваться?', 'Где будешь тренироваться?', 'Подходящие программы'];

  return (
    <div>
      <div className="page-head" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h1 style={{ flex: 1 }}>Стартовая программа</h1>
        <button className="btn small ghost" onClick={skip}>Пропустить</button>
      </div>
      <p className="sub">{step < 4 ? `Шаг ${step + 1} из 4. ` : ''}Ничего не создаётся, пока ты не выберешь программу.</p>
      <h2 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: '12px 0' }}>{titles[step]}</h2>

      {step === 0 && <Choice<Goal> label="Цель" value={a.goal} onPick={(goal) => next({ goal })} options={[
        { id: 'strength', text: GOAL_LABEL.strength, hint: 'Тяжёлые веса и мало повторов' },
        { id: 'muscle', text: GOAL_LABEL.muscle, hint: 'Средние веса и 8–12 повторов' },
        { id: 'general', text: GOAL_LABEL.general, hint: 'Спокойный темп без перегрузки' }
      ]} />}
      {step === 1 && <Choice<Experience> label="Опыт" value={a.experience} onPick={(experience) => next({ experience })} options={[
        { id: 'beginner', text: EXPERIENCE_LABEL.beginner }, { id: 'intermediate', text: EXPERIENCE_LABEL.intermediate }
      ]} />}
      {step === 2 && <Choice<number> label="Дней в неделю" value={a.days} onPick={(d) => next({ days: d as Answers['days'] })} options={[
        { id: 2, text: '2 дня', hint: 'Самый простой старт' }, { id: 3, text: '3 дня', hint: 'Золотая середина' }, { id: 4, text: '4 дня' }
      ]} />}
      {step === 3 && <Choice<Equipment> label="Оборудование" value={a.equipment} onPick={(equipment) => next({ equipment })} options={[
        { id: 'gym', text: EQUIPMENT_LABEL.gym }, { id: 'dumbbells', text: EQUIPMENT_LABEL.dumbbells }, { id: 'bodyweight', text: EQUIPMENT_LABEL.bodyweight }
      ]} />}

      {step === 4 && (
        <div style={{ display: 'grid', gap: 14 }}>
          {plans.map((p, i) => (
            <div key={p.id} className="section" style={{ margin: 0 }}>
              <h2 style={{ fontSize: 20 }}>{p.title}{i === 0 && <span className="sub"> · лучше всего подходит</span>}</h2>
              <p>{p.description}</p>
              <div className="list">
                {p.sessions.map((s, j) => (
                  <div key={s.title} className="row">
                    <div className="grow">
                      <div className="title">{WEEKDAY_SHORT[p.weekdays[j] - 1]} · {s.title}</div>
                      <div className="meta">{s.exercises.map((e) => e.name).join(', ')}</div>
                    </div>
                  </div>
                ))}
              </div>
              {p.note && <p className="sub">{p.note}</p>}
              <button className={'btn block ' + (i === 0 ? 'primary' : '')} style={{ marginTop: 8 }} disabled={busy} onClick={() => void choose(p)}>Выбрать эту программу</button>
            </div>
          ))}
          <p className="sub">Веса в шаблонах пустые: приложение подскажет их по ходу тренировок. Программу можно изменить или удалить в разделе «Программы».</p>
        </div>
      )}

      {step > 0 && step < 5 && <button className="btn ghost block" style={{ marginTop: 14 }} onClick={() => setStep((s) => (s - 1) as Step)}>Назад</button>}
    </div>
  );
}
