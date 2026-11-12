import { readFileSync, readdirSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildBundle } from '../../src/content/build';
import { makeCatalog } from '../../src/content/catalog';
import type { Principle, Source } from '../../src/content/types';
import { explainEaseReason, autoregulate } from '../../src/domain/autoregulation';
import { PRINCIPLE_OF, principleOf, renderWhy, type Why } from '../../src/domain/explain';
import { DEFAULT_HEAVY_RULES, explainHeavySet, isHeavySet } from '../../src/domain/heavy';
import { explainNext, suggestNext } from '../../src/domain/progression';
import { explainRest, resolveRest } from '../../src/domain/rest';
import { explainRestSuggestion, suggestRestChange } from '../../src/domain/restHints';
import type { Workout } from '../../src/domain/types';
import { WhyDecisionButton, WhyDecisionSheet } from '../../src/views/WhyDecision';

const set = (weight: number, reps: number, extra: object = {}) => ({ id: Math.random().toString(36), weight, reps, done: true, ...extra });
const w = (id: string, date: string, ex: string, sets: ReturnType<typeof set>[]): Workout =>
  ({ id, date, title: 't', status: 'done', finishedAt: Date.parse(date) + 1000, exercises: [{ id: 'a' + id, exerciseId: ex, sets }], createdAt: 0, updatedAt: 0, deviceId: 'd' } as unknown as Workout);

describe('объяснение совпадает с решением', () => {
  it('прогрессия: код причины соответствует виду подсказки на разных историях', () => {
    const today = new Date('2026-10-20T10:00:00');
    const cases: [string, Workout[], string][] = [
      ['add-reps 1', [w('1', '2026-10-15', 'x', [set(80, 8), set(80, 9)])], 'next-add-reps'],
      ['add-reps 2 (легко)', [w('1', '2026-10-15', 'x', [set(80, 8, { rpe: 6 }), set(80, 8, { rpe: 7 })])], 'next-add-reps'],
      ['add-weight', [w('1', '2026-10-15', 'x', [set(80, 12), set(80, 12)])], 'next-add-weight'],
      ['add-weight легко', [w('1', '2026-10-15', 'x', [set(80, 12, { rpe: 6 })])], 'next-add-weight'],
      ['hold', [w('1', '2026-10-15', 'x', [set(80, 8, { rpe: 10 })])], 'next-hold-rpe'],
      ['comeback', [w('1', '2026-09-01', 'x', [set(80, 8)])], 'next-comeback'],
      ['deload', [w('1', '2026-10-01', 'x', [set(80, 10)]), w('2', '2026-10-05', 'x', [set(80, 9)]), w('3', '2026-10-09', 'x', [set(80, 8)])], 'next-deload']
    ];
    for (const [name, hist, code] of cases) {
      const s = suggestNext(hist, 'x', 2.5, undefined, today);
      const why = explainNext(hist, 'x', 2.5, undefined, today);
      expect(s, name).not.toBeNull();
      expect(why?.code, name).toBe(code);
    }
    expect(explainNext([], 'x', 2.5)).toBeNull();
  });

  it('прогрессия: числа в факте берутся из той же подсказки', () => {
    const hist = [w('1', '2026-10-15', 'x', [set(80, 13), set(80, 12)])];
    const s = suggestNext(hist, 'x', 2.5)!;
    const why = explainNext(hist, 'x', 2.5)!;
    expect(s.kind).toBe('add-weight');
    expect(why).toMatchObject({ code: 'next-add-weight', reps: 12, steps: 1 });
    expect(renderWhy(why)).toContain('12+');
  });

  it('«тяжёлый подход»: explainHeavySet и isHeavySet не расходятся ни на какой сетке значений', () => {
    for (const record of [0, 20, 60, 100, 140]) for (const weight of [0, 10, 40, 51, 80, 85, 100, 140]) for (const reps of [0, 1, 3, 6, 7, 12]) {
      expect(explainHeavySet(weight, reps, record).code === 'heavy-yes', `${weight}×${reps} при рекорде ${record}`).toBe(isHeavySet(weight, reps, record));
    }
    expect(explainHeavySet(80, 3, 0).code).toBe('heavy-no-record');
    expect(explainHeavySet(80, 10, 100).code).toBe('heavy-many-reps');
    expect(explainHeavySet(50, 3, 100).code).toBe('heavy-light');
    const yes = explainHeavySet(90, 3, 100) as Extract<Why, { code: 'heavy-yes' }>;
    expect(yes.share).toBe(DEFAULT_HEAVY_RULES.share);
    expect(renderWhy(yes)).toMatch(/90.*3.*тяжёлый/);
  });

  it('отдых: источник из упражнения или из настроек совпадает с resolveRest', () => {
    for (const ex of [{ restSec: 150 }, {}, null, undefined]) {
      const r = resolveRest(ex as never, 90);
      const why = explainRest(ex as never, 90);
      expect(why.code).toBe(r.source === 'exercise' ? 'rest-exercise' : 'rest-settings');
      expect((why as { sec: number }).sec).toBe(r.sec);
    }
    expect(renderWhy(explainRest({ restSec: 150 }, 90))).toContain('2:30');
  });

  it('предложение другого отдыха: факт содержит среднее, текущее и предложенное', () => {
    // отдых между подходами измеряется по completedAt и workSec: делаем по 150 с отдыха при заданных 90
    const mk = (id: string, d: string, gap: number): Workout => {
      const base = Date.parse(d + 'T10:00:00');
      const sets = [0, 1, 2].map((i) => ({ id: `s${i}`, weight: 50, reps: 8, done: true, workSec: 30, completedAt: base + i * (gap + 30) * 1000 }));
      return { id, date: d, title: 't', status: 'done', finishedAt: base + 600000, exercises: [{ id: 'a' + id, exerciseId: 'x', sets }], createdAt: 0, updatedAt: 0, deviceId: 'd' } as unknown as Workout;
    };
    const hist = [mk('1', '2026-10-01', 150), mk('2', '2026-10-05', 150), mk('3', '2026-10-09', 150)];
    const sug = suggestRestChange(hist, 'x', 90);
    expect(sug).not.toBeNull();
    const why = explainRestSuggestion(sug!);
    expect(why).toMatchObject({ code: 'rest-suggest', direction: 'longer', currentSec: 90, sec: sug!.sec, workouts: 3 });
    expect(renderWhy(why)).toMatch(/дольше/);
  });

  it('облегчение: причины совпадают с причинами решения', () => {
    const a = autoregulate({ readiness: { score: 30, level: 'low' } as never, sleepHours: 5, loadRatio: 1.7, plateauNames: ['Жим'] });
    expect(a.mode).toBe('ease');
    const whys = a.reasons.map(explainEaseReason);
    expect(whys.map((x) => x.code)).toEqual(a.reasons.map((r) => `ease-${r.key}`));
    for (const x of whys) expect(renderWhy(x)).toMatch(/^Причина: /);
  });
});

describe('принципы для объяснений существуют', () => {
  const ids = new Set(readdirSync(new URL('../../content/principles/', import.meta.url)).map((f) => f.replace(/\.json$/, '')));
  it('каждый код причины ссылается на принцип из content/principles', () => {
    for (const [code, id] of Object.entries(PRINCIPLE_OF)) expect(ids.has(id), `${code} → ${id}`).toBe(true);
  });
  it('у каждого кода есть факт и принцип', () => {
    const samples: Why[] = [
      { code: 'rest-exercise', sec: 90 }, { code: 'rest-settings', sec: 90 },
      { code: 'rest-suggest', direction: 'shorter', currentSec: 120, avgSec: 80, workouts: 3, sec: 75 },
      { code: 'next-comeback', weeks: 4, weight: 72.5 }, { code: 'next-deload', weight: 80, reps: 10 }, { code: 'next-hold-rpe', rpe: 9.5 },
      { code: 'next-add-weight', reps: 12, steps: 2, rpe: 6 }, { code: 'next-add-reps', add: 1, rpe: null },
      { code: 'heavy-yes', weight: 90, reps: 3, record: 100, threshold: 80, share: 0.85, maxReps: 6 }, { code: 'heavy-light', weight: 50, reps: 3, record: 100, threshold: 80 },
      { code: 'heavy-many-reps', reps: 10, maxReps: 6 }, { code: 'heavy-no-record' },
      { code: 'ease-sleep', text: 'сон 5 ч' }, { code: 'ease-readiness', text: 'готовность 30 из 100' }, { code: 'ease-load', text: 'нагрузка 1,7× обычной' }, { code: 'ease-plateau', text: 'вес не растёт: Жим' }
    ];
    expect(new Set(samples.map((s) => s.code))).toEqual(new Set(Object.keys(PRINCIPLE_OF)));
    for (const s of samples) { expect(renderWhy(s).length, s.code).toBeGreaterThan(15); expect(principleOf(s)).toBeTruthy(); }
  });
});

describe('шторка «Почему так»', () => {
  const src: Source = { id: 's1', title: 'Источник', author: 'Автор', url: 'https://example.org/p', license: 'CC-BY-4.0', retrievedAt: '2026-11-08' };
  const note = (over: Partial<Principle> = {}): Principle => ({ id: 'rest-between-sets', title: 'Отдых между подходами', summary: 'Чем тяжелее подход, тем больше отдых.', points: ['Тяжёлым нужен долгий отдых.', 'Лёгким хватит короткого.'], sources: ['s1'], status: 'published', reviewedAt: '2026-11-08', contentVersion: 1, ...over });
  const whys: Why[] = [{ code: 'rest-exercise', sec: 150 }];

  it('без опубликованных принципов показывает только факт', () => {
    const h = renderToStaticMarkup(<WhyDecisionSheet whys={whys} onClose={() => {}} catalog={makeCatalog(buildBundle([], [], [src], { principles: [note({ status: 'draft', reviewedAt: null, sources: [] })] }))} />);
    expect(h).toContain('data-testid="why-fact"');
    expect(h).toContain('2:30');
    expect(h).not.toContain('why-principle');
    expect(h).not.toContain('Образовательная информация');
  });

  it('с опубликованным принципом показывает его, источник и строку про образовательный характер', () => {
    const h = renderToStaticMarkup(<WhyDecisionSheet whys={whys} onClose={() => {}} catalog={makeCatalog(buildBundle([], [], [src], { principles: [note()] }))} />);
    for (const t of ['Принцип: Отдых между подходами', 'Тяжёлым нужен долгий отдых.', 'Источник', 'CC-BY-4.0', 'Образовательная информация, не медицинская рекомендация.']) expect(h).toContain(t);
    expect(h).not.toContain('Черновик');
  });

  it('в предпросмотре черновик принципа помечен', () => {
    const h = renderToStaticMarkup(<WhyDecisionSheet whys={whys} onClose={() => {}} catalog={makeCatalog(buildBundle([], [], [], { preview: true, principles: [note({ status: 'draft', reviewedAt: null, sources: [] })] }))} />);
    expect(h).toContain('Черновик: текст ещё не проверен человеком.');
  });

  it('один принцип не повторяется, если у нескольких причин он общий', () => {
    const h = renderToStaticMarkup(<WhyDecisionSheet whys={[{ code: 'rest-exercise', sec: 60 }, { code: 'rest-settings', sec: 90 }]} onClose={() => {}} catalog={makeCatalog(buildBundle([], [], [src], { principles: [note()] }))} />);
    expect(h.match(/data-testid="why-principle"/g)).toHaveLength(1);
    expect(h.match(/data-testid="why-fact"/g)).toHaveLength(2);
  });

  it('кнопка ⓘ есть, когда причина известна, и нет, когда её нет', () => {
    expect(renderToStaticMarkup(<WhyDecisionButton whys={whys} label="отдых" />)).toContain('aria-label="Почему так: отдых"');
    expect(renderToStaticMarkup(<WhyDecisionButton whys={[null]} label="идея" />)).toBe('');
  });
});
