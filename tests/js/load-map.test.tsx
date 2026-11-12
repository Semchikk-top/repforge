import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildBundle } from '../../src/content/build';
import { makeCatalog } from '../../src/content/catalog';
import type { Card, Muscle, Source } from '../../src/content/types';
import { STRENGTH_MUSCLES } from '../../src/domain/analytics';
import { cardWeights, loadMap, MAP_PERIODS, SECONDARY_WEIGHT, type WeightResolver } from '../../src/domain/loadMap';
import type { Exercise, SetEntry, Workout } from '../../src/domain/types';
import { BodyMap, BodyMapTable } from '../../src/ui/BodyMap';

const meta = (id: string) => ({ id, createdAt: 0, updatedAt: 0, deviceId: 'test' });
const ex = (id: string, muscle: Exercise['muscle'], custom = false): Exercise => ({ ...meta(id), name: id, muscle, equipment: '', custom });
const exMap = new Map([ex('seed-001', 'chest'), ex('seed-002', 'back'), ex('mine', 'biceps', true), ex('seed-run', 'cardio')].map((e) => [e.id, e]));
const set = (extra: Partial<SetEntry> = {}): SetEntry => ({ id: Math.random().toString(36).slice(2), weight: 50, reps: 8, done: true, ...extra });
const workout = (id: string, date: string, parts: [string, SetEntry[]][]): Workout => ({
  ...meta(id), date, title: id, status: 'done', exercises: parts.map(([exerciseId, sets], i) => ({ id: `${id}-${i}`, exerciseId, sets }))
});
const now = new Date(2026, 10, 11, 12, 0); // 11 ноября 2026
const by = (r: ReturnType<typeof loadMap>) => Object.fromEntries(r.map((m) => [m.muscle, m]));

const muscles: Muscle[] = [
  { id: 'pectoralis-major', name: 'Большая грудная', group: 'chest', side: 'front' },
  { id: 'pectoralis-minor', name: 'Малая грудная', group: 'chest', side: 'front' },
  { id: 'deltoid-anterior', name: 'Дельта (передняя)', group: 'shoulders', side: 'front' },
  { id: 'triceps-brachii', name: 'Трицепс', group: 'triceps', side: 'back' },
  { id: 'heart', name: 'Сердце', group: 'cardio', side: 'both' }
];
const src: Source = { id: 's1', title: 'T', author: 'A', url: 'https://example.org', license: 'CC-BY-4.0', retrievedAt: '2026-11-08' };
const card = (over: Partial<Card> = {}): Card => ({
  id: 'seed-001', summary: 'x', primaryMuscles: ['pectoralis-major', 'pectoralis-minor'], secondaryMuscles: ['deltoid-anterior', 'triceps-brachii'],
  function: 'x', cues: ['a', 'b'], mistakes: ['a', 'b'], swapNote: 'x', sources: ['s1'], status: 'published', reviewedAt: '2026-11-08', contentVersion: 1, ...over
});
const cat = makeCatalog(buildBundle([card()], muscles, [src]));
const withCards: WeightResolver = (e) => { const c = cat.card(e.id); return c ? cardWeights(c, cat.groupOf) : null; };
const noCards: WeightResolver = () => null;

describe('веса групп по карточке', () => {
  it('основные мышцы 1, вспомогательные 0,5; две мышцы одной группы не удваивают подход', () => {
    const w = cardWeights(card(), cat.groupOf)!;
    expect(w.get('chest')).toBe(1);
    expect(w.get('shoulders')).toBe(SECONDARY_WEIGHT);
    expect(w.get('triceps')).toBe(0.5);
    expect(w.size).toBe(3);
  });
  it('если группа и основная, и вспомогательная, берётся большее', () => {
    const w = cardWeights(card({ primaryMuscles: ['pectoralis-major'], secondaryMuscles: ['pectoralis-minor'] }), cat.groupOf)!;
    expect(w.get('chest')).toBe(1);
  });
  it('неизвестные и несиловые группы пропускаются; пустой итог — null', () => {
    expect(cardWeights(card({ primaryMuscles: ['heart'], secondaryMuscles: ['unknown'] }), cat.groupOf)).toBeNull();
  });
});

describe('карта нагрузки', () => {
  const history = [workout('w1', '2026-11-10', [['seed-001', [set(), set(), set(), set({ warmup: true }), set({ done: false })]]])];

  it('все десять групп присутствуют всегда, периоды 7 и 28', () => {
    expect([...MAP_PERIODS]).toEqual([7, 28]);
    const r = loadMap([], exMap, withCards, { days: 7, now });
    expect(r.map((m) => m.muscle)).toEqual(STRENGTH_MUSCLES);
    expect(r.every((m) => m.weighted === 0 && m.level === 0 && m.vsUsual === null)).toBe(true);
  });

  it('с карточкой: три рабочих подхода жима дают груди 3, плечам и трицепсу по 1,5; разминка и невыполненные не считаются', () => {
    const r = by(loadMap(history, exMap, withCards, { days: 7, now }));
    expect(r.chest.weighted).toBe(3);
    expect(r.shoulders.weighted).toBe(1.5);
    expect(r.triceps.weighted).toBe(1.5);
    expect(r.back.weighted).toBe(0);
    expect(r.chest.level).toBe(1);
    expect(r.shoulders.level).toBe(0.5);
  });

  it('без карточки подход целиком идёт в группу упражнения, у своих упражнений карточка не применяется', () => {
    const w = [workout('w1', '2026-11-10', [['seed-002', [set(), set()]], ['mine', [set()]], ['seed-run', [set()]]])];
    const r = by(loadMap(w, exMap, withCards, { days: 7, now }));
    expect(r.back.weighted).toBe(2); // у seed-002 карточки нет
    expect(r.biceps.weighted).toBe(1);
    expect(STRENGTH_MUSCLES.reduce((a, m) => a + r[m].weighted, 0)).toBe(3); // кардио не входит
  });

  it('резолвер не зовётся для своих упражнений', () => {
    const called: string[] = [];
    loadMap([workout('w1', '2026-11-10', [['mine', [set()]]])], exMap, (e) => { called.push(e.id); return null; }, { days: 7, now });
    expect(called).toEqual([]);
  });

  it('период ограничивает дни: тренировка 20 дней назад видна за 28, но не за 7', () => {
    const old = [workout('w1', '2026-10-22', [['seed-001', [set()]]])];
    expect(by(loadMap(old, exMap, noCards, { days: 7, now })).chest.weighted).toBe(0);
    expect(by(loadMap(old, exMap, noCards, { days: 28, now })).chest.weighted).toBe(1);
  });

  it('«к обычному»: пока истории меньше четырёх недель, сравнения нет', () => {
    expect(by(loadMap(history, exMap, noCards, { days: 7, now })).chest.vsUsual).toBeNull();
  });

  it('«к обычному»: с историей сравнивается с собственным средним за 8 недель, без норм объёма', () => {
    // 8 недель назад начали, по 4 подхода груди раз в неделю (всего 32), на этой неделе 8 подходов
    const ws: Workout[] = [];
    for (let k = 1; k <= 7; k++) { const d = new Date(now); d.setDate(d.getDate() - 7 * k); ws.push(workout('h' + k, d.toISOString().slice(0, 10), [['seed-001', [set(), set(), set(), set()]]])); }
    ws.push(workout('now', '2026-11-10', [['seed-001', Array.from({ length: 8 }, () => set())]]));
    const chest = by(loadMap(ws, exMap, noCards, { days: 7, now })).chest;
    expect(chest.weekly).toBe(8);
    expect(chest.baselineWeekly).toBe((7 * 4 + 8) / 8);
    expect(chest.vsUsual).toBe(Math.round((8 / 4.5 - 1) * 100));
    expect(by(loadMap(ws, exMap, noCards, { days: 7, now })).back.vsUsual).toBeNull(); // раньше группу не нагружали
  });
});

describe('схема тела', () => {
  const items = loadMap([workout('w1', '2026-11-10', [['seed-001', [set(), set(), set()]]])], exMap, withCards, { days: 28, now });
  it('рисует спереди и сзади, подпись читается экранным диктором, чужих изображений нет', () => {
    const html = renderToStaticMarkup(<BodyMap items={items} days={28} />);
    expect(html).toContain('role="img"');
    expect(html).toContain('Карта нагрузки за 28 дней, оценка по подходам');
    expect(html).toContain('Грудь 3');
    expect(html).toContain('Спереди');
    expect(html).toContain('Сзади');
    expect(html).not.toMatch(/<image|<img|href=/);
  });
  it('без данных подпись говорит об этом', () => {
    expect(renderToStaticMarkup(<BodyMap items={loadMap([], exMap, noCards, { now })} days={7} />)).toContain('Нет данных за период');
  });
  it('таблица: числа текстом, самая нагруженная группа первой, прочерк вместо сравнения без истории', () => {
    const html = renderToStaticMarkup(<BodyMapTable items={items} />);
    expect(html.indexOf('Грудь')).toBeLessThan(html.indexOf('Спина'));
    expect(html).toContain('>1.5<');
    expect(html).toContain('—');
  });
});

describe('справочник отдаёт группы мышц', () => {
  it('muscleGroups есть в сборке только для использованных мышц; у старой сборки groupOf даёт null', () => {
    const b = buildBundle([card()], muscles, [src]);
    expect(b.muscleGroups).toEqual({ 'pectoralis-major': 'chest', 'pectoralis-minor': 'chest', 'deltoid-anterior': 'shoulders', 'triceps-brachii': 'triceps' });
    expect(makeCatalog({ ...b, muscleGroups: undefined }).groupOf('pectoralis-major')).toBeNull();
  });
});
