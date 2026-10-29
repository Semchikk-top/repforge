import { useState } from 'react';
import { platesPerSide } from '../domain/plates';
import { useSettings } from '../state/settings';
import { Sheet } from './Sheet';

// Какие блины повесить на штангу: считается на одну сторону, гриф берётся из настроек
// formatNum округляет до десятых и превратил бы блин 1,25 кг в «1,3»
const fmt = (n: number) => String(Math.round(n * 100) / 100);

const ALL_PLATES = [50, 25, 20, 15, 10, 5, 2.5, 2, 1.25, 1, 0.5, 0.25];

export function PlateSheet({ initialWeight, onClose }: { initialWeight: number; onClose: () => void }) {
  const { settings, update } = useSettings();
  const [text, setText] = useState(initialWeight > 0 ? fmt(initialWeight) : '');
  const target = parseFloat(text.replace(',', '.'));
  const r = platesPerSide(target, settings.barWeight, settings.plates);

  return (
    <Sheet title="Блины на штангу" onClose={onClose}>
      <div className="field">
        <label htmlFor="pl-w">Вес на штанге, кг</label>
        <input id="pl-w" className="input" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.target.select()} />
      </div>
      <div className="field">
        <label htmlFor="pl-bar">Гриф</label>
        <select id="pl-bar" className="input" value={settings.barWeight} onChange={(e) => update({ barWeight: parseFloat(e.target.value) })}>
          {[7, 10, 15, 20, 25].map((n) => <option key={n} value={n}>{n} кг</option>)}
        </select>
      </div>

      <div className="field">
        <label>Какие блины есть</label>
        <div className="chips wrap" role="group" aria-label="Доступные блины">
          {ALL_PLATES.map((p) => {
            const on = settings.plates.includes(p);
            return <button key={p} className={'chip' + (on ? ' on' : '')} aria-pressed={on} onClick={() => update({ plates: on ? settings.plates.filter((x) => x !== p) : [...settings.plates, p].sort((a, b) => b - a) })}>{fmt(p)}</button>;
          })}
        </div>
        <span className="sub">Отметьте то, что реально есть в зале: расчёт пойдёт только из них.</span>
      </div>

      {!Number.isFinite(target) ? (
        <p className="sub">Введи вес, и я скажу, какие блины повесить.</p>
      ) : r.belowBar ? (
        <p className="sub">Это меньше грифа ({settings.barWeight} кг).</p>
      ) : (
        <div role="status">
          <div className="sub">На каждую сторону:</div>
          <div className="plates" aria-label="Блины на сторону">
            {r.perSide.length === 0 && <span className="sub">только гриф</span>}
            {r.perSide.map((p, i) => <span key={i} className="plate" style={{ height: 34 + Math.min(p, 25) * 1.6 }}>{fmt(p)}</span>)}
          </div>
          <p style={{ marginTop: 10 }}>Итого на штанге: <b>{fmt(r.achieved)} кг</b></p>
          {r.missing > 0 && <p className="sub">Точно набрать не получится: не хватает {fmt(r.missing)} кг из-за набора блинов.</p>}
        </div>
      )}
    </Sheet>
  );
}
