import { useEffect, useState } from 'react';
import { formatNum } from '../lib';
import { IconMinus, IconPlus } from './Icons';

interface Props {
  value: number;
  step: number;
  min?: number;
  unit: string;
  done?: boolean;
  decimals?: boolean;
  onChange: (v: number) => void;
}

export function Stepper({ value, step, min = 0, unit, done, decimals, onChange }: Props) {
  const [text, setText] = useState(formatNum(value));
  useEffect(() => setText(formatNum(value)), [value]);

  const commit = (raw: string) => {
    const n = parseFloat(raw.replace(',', '.'));
    if (Number.isFinite(n)) onChange(Math.max(min, decimals ? Math.round(n * 100) / 100 : Math.round(n)));
    else setText(formatNum(value));
  };
  const bump = (dir: 1 | -1) => onChange(Math.max(min, Math.round((value + dir * step) * 100) / 100));

  return (
    <div className={'stepper' + (done ? ' done' : '')}>
      <button type="button" onClick={() => bump(-1)} aria-label={`Меньше, ${unit}`}><IconMinus size={18} /></button>
      <div className="mid">
        <input
          inputMode={decimals ? 'decimal' : 'numeric'}
          value={text}
          aria-label={unit}
          onChange={(e) => setText(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
          onFocus={(e) => e.target.select()}
        />
        <span className="unit">{unit}</span>
      </div>
      <button type="button" onClick={() => bump(1)} aria-label={`Больше, ${unit}`}><IconPlus size={18} /></button>
    </div>
  );
}
