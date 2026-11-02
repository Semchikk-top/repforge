import { useMemo, useState } from 'react';
import { alternativesFor, historyHint, MOVEMENT_LABEL, movementOf, RELATION_LABEL, type Alternative } from '../domain/movements';
import type { Exercise, SetEntry, Workout } from '../domain/types';
import { formatNum } from '../lib';
import { Sheet } from '../ui/Sheet';

const fmt = (sets: SetEntry[]) => {
  const last = sets[sets.length - 1];
  return `${formatNum(last.weight)}×${last.reps}`;
};

/**
 * Замена упражнения в текущей тренировке: варианты по движению и мышце, у каждого свой последний результат
 * или результат похожего упражнения. Вес сам не переносится: подсказка помогает выбрать стартовый вес руками.
 */
export function SwapSheet({ target, all, history, present, onPick, onClose }: {
  target: Exercise; all: Exercise[]; history: Workout[]; present: Set<string>; onPick: (e: Exercise) => void; onClose: () => void;
}) {
  const [onlySimilar, setOnlySimilar] = useState(true);
  const alts = useMemo(() => alternativesFor(target, all, history, present), [target, all, history, present]);
  const shown = onlySimilar ? alts.filter((a) => a.relation !== 'same-muscle') : alts;
  const movement = movementOf(target);

  const line = (a: Alternative) => {
    if (a.own) return `Последний раз ${a.own.date}: ${fmt(a.own.sets)}`;
    const hint = historyHint(a.exercise, all, history);
    return hint ? `Своей истории нет. По «${hint.from.name}»: ${fmt(hint.sets)}` : 'Истории пока нет';
  };

  return (
    <Sheet title={`Заменить «${target.name}»`} onClose={onClose}>
      <p className="sub">{movement ? `Движение: ${MOVEMENT_LABEL[movement]}. ` : ''}Невыполненные подходы перейдут в выбранное упражнение, выполненные останутся как есть. История обоих упражнений не меняется.</p>
      <div className="chips" role="group" aria-label="Какие показывать">
        <button className={'chip' + (onlySimilar ? ' on' : '')} aria-pressed={onlySimilar} onClick={() => setOnlySimilar(true)}>Похожие</button>
        <button className={'chip' + (!onlySimilar ? ' on' : '')} aria-pressed={!onlySimilar} onClick={() => setOnlySimilar(false)}>Все на эту мышцу</button>
      </div>
      {shown.length === 0 ? <p className="empty">Подходящих упражнений нет. Можно переключить на «Все на эту мышцу».</p> : (
        <div className="list">
          {shown.map((a) => (
            <button key={a.exercise.id} className="row" style={{ width: '100%', background: 'none', border: 'none', color: 'inherit', textAlign: 'left', minHeight: 56 }} onClick={() => onPick(a.exercise)}>
              <div className="grow">
                <div className="title">{a.exercise.name}</div>
                <div className="meta">{RELATION_LABEL[a.relation]}{a.exercise.equipment ? ` · ${a.exercise.equipment}` : ''}</div>
                <div className="meta">{line(a)}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </Sheet>
  );
}
