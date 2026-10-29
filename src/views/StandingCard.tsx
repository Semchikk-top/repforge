import { formatNum } from '../lib';

const plural = (n: number, one: string, few: string, many: string) => {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};

export interface StandingInfo {
  rank: number;
  of: number;
  tied: boolean;
  /** Сколько не хватает до ближайшего выше. */
  toNext: number | null;
  nextName: string | null;
  /** Отрыв от ближайшего ниже. */
  lead: number | null;
}

/** Ваше место и расстояние до соседей по таблице; общая карточка для друзей и мира. */
export function StandingCard({ s, fmt }: { s: StandingInfo; fmt: (v: number) => string }) {
  const first = s.rank === 1;
  const headline = s.of === 1 ? 'Пока вы один в таблице'
    : first ? (s.tied ? `Вы на 1 месте (делите с другими) из ${s.of}` : 'Вы лидируете')
    : `Вы на ${s.rank} месте из ${formatNum(s.of)}`;
  return (
    <div className={'standing' + (first && s.of > 1 ? ' top' : '')} role="status">
      <div className="standing-h">{headline}</div>
      <div className="sub">
        {s.toNext !== null && s.nextName && <>До «{s.nextName}»: {fmt(s.toNext)}. </>}
        {s.lead !== null && <>Отрыв от следующего: {fmt(s.lead)}.</>}
        {s.of > 1 && s.toNext === null && s.lead === null && s.tied && <>Все результаты равны.</>}
      </div>
    </div>
  );
}

export { plural };
