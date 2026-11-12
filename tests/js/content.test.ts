import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildBundle } from '../../src/content/build';
import { makeCatalog } from '../../src/content/catalog';
import { EDU_NOTICE, type Card, type Muscle, type Principle, type Source } from '../../src/content/types';
import { ALLOWED_LICENSES, FORBIDDEN, LIMITS, validateCard, validateMuscles, validatePrinciple, validateSources } from '../../src/content/validate';
import { movementOf } from '../../src/domain/movements';
import { SEED_EXERCISES } from '../../src/domain/seed';
import { MUSCLE_LABELS } from '../../src/domain/types';

const readJson = <T,>(rel: string): T => JSON.parse(readFileSync(new URL(`../../content/${rel}`, import.meta.url), 'utf8')) as T;
const muscles = readJson<Muscle[]>('muscles.json');
const sources = readJson<Source[]>('sources.json');
const files = readdirSync(new URL('../../content/exercises/', import.meta.url)).filter((f) => f.endsWith('.json')).sort();
const cards = files.map((f) => readJson<Card>(`exercises/${f}`));
const pfiles = readdirSync(new URL('../../content/principles/', import.meta.url)).filter((f) => f.endsWith('.json')).sort();
const principles = pfiles.map((f) => readJson<Principle>(`principles/${f}`));

const ctx = { muscleIds: new Set(muscles.map((m) => m.id)), sourceIds: new Set(['wiki-bench', ...sources.map((s) => s.id)]), exerciseIds: new Set(SEED_EXERCISES.map((e) => e.id)) };
const goodSource: Source = { id: 'wiki-bench', title: 'Жим лёжа', author: 'Авторы Википедии', url: 'https://example.org/bench', license: 'CC-BY-SA-4.0', retrievedAt: '2026-11-08' };
const good = (over: Partial<Card> = {}): Card => ({ ...cards.find((c) => c.id === 'seed-001')!, status: 'published', reviewedAt: '2026-11-08', sources: ['wiki-bench'], techniqueReview: { by: 'тренер', at: '2026-11-08' }, ...over });

describe('содержимое в content/', () => {
  it('справочник мышц и реестр источников проходят проверку', () => {
    expect(validateMuscles(muscles, Object.keys(MUSCLE_LABELS))).toEqual([]);
    expect(validateSources(sources, '2999-01-01')).toEqual([]);
    expect(sources.map((x) => x.license)).toEqual(expect.arrayContaining(['CC-BY-4.0']));
    expect(muscles.length).toBeGreaterThanOrEqual(35);
    expect(muscles.length).toBeLessThanOrEqual(45);
  });

  it('все карточки на диске проходят проверку, файл назван по id, у силовых упражнений есть «движение»', () => {
    const own = { ...ctx, sourceIds: new Set(sources.map((s) => s.id)) };
    files.forEach((f, i) => expect(f).toBe(`${cards[i].id}.json`));
    for (const c of cards) {
      expect(validateCard(c, own), c.id).toEqual([]);
      const ex = SEED_EXERCISES.find((e) => e.id === c.id)!;
      if (ex.muscle !== 'cardio') expect(movementOf({ id: ex.id, name: ex.name, muscle: ex.muscle }), ex.name).not.toBeNull();
    }
  });

  it('пилотные карточки и первая пачка (грудь и спина): жим лёжа, приседания, становая, подтягивания, планка', () => {
    expect(cards.map((c) => c.id)).toEqual(expect.arrayContaining(['seed-001', 'seed-005', 'seed-010', 'seed-011', 'seed-027']));
    expect(cards.map((c) => SEED_EXERCISES.find((e) => e.id === c.id)!.name)).toEqual(
      expect.arrayContaining(['Жим штанги лёжа', 'Приседания со штангой', 'Становая тяга', 'Подтягивания', 'Планка']));
  });

  it('у каждого упражнения первых 32 (версия 1.3.0) есть карточка; карточки новых (seed-033 и дальше) готовит конвейер знаний', () => {
    const ids = new Set(cards.map((c) => c.id));
    for (const e of SEED_EXERCISES.slice(0, 32)) expect(ids.has(e.id), e.name).toBe(true);
    for (const id of ids) expect(SEED_EXERCISES.some((e) => e.id === id), id).toBe(true);
  });

  it('content/exercise_names.json (для ассистента) совпадает с seed.ts', () => {
    expect(readJson<Record<string, string>>('exercise_names.json')).toEqual(Object.fromEntries(SEED_EXERCISES.map((e) => [e.id, e.name])));
  });

  it('черновик, не прошедший проверку человеком, не опубликован сам: статус меняется только вручную', () => {
    for (const c of cards.filter((x) => x.status === 'draft')) expect(c.reviewedAt).toBeNull();
  });
});

describe('валидатор ловит плохие карточки', () => {
  it('хорошая карточка проходит', () => { expect(validateCard(good(), ctx)).toEqual([]); });

  const bad: [string, Partial<Card>, RegExp][] = [
    ['упражнения нет в seed.ts', { id: 'seed-999' }, /нет в domain\/seed\.ts/],
    ['мышцы нет в справочнике', { primaryMuscles: ['biceps-of-doom'] }, /нет в справочнике/],
    ['мышца дважды', { secondaryMuscles: ['pectoralis-major'] }, /дважды/],
    ['нет основных мышц', { primaryMuscles: [] }, /primaryMuscles/],
    ['источника нет в реестре', { sources: ['nowhere'] }, /нет в sources\.json/],
    ['опубликовано без источника', { sources: [] }, /без источника/],
    ['опубликовано без даты проверки', { reviewedAt: null }, /reviewedAt/],
    ['черновик с датой проверки', { status: 'draft', reviewedAt: '2026-11-08' }, /null/],
    ['неизвестный статус', { status: 'approved' as never }, /status/],
    ['слишком длинный текст', { summary: 'а'.repeat(400) }, /summary/],
    ['одна подсказка вместо 2–4', { cues: ['Только одна'] }, /cues/],
    ['пять ошибок вместо 2–4', { mistakes: ['aaaaaa', 'bbbbbb', 'cccccc', 'dddddd', 'eeeeee'] }, /mistakes/],
    ['лекарства', { summary: 'Упражнение помогает, если принимать обезболивающие препараты перед подходом.' }, /запрещённая тема/],
    ['диагноз и лечение', { function: 'Лечение грыжи диска и диагноз по боли в спине.' }, /запрещённая тема/],
    ['диета и добавки', { swapNote: 'Подойдёт любая диета и спортивные добавки для роста.' }, /запрещённая тема/],
    ['обещание «как тренер»', { cues: ['Приложение заменяет тренера полностью', 'Ещё одна подсказка'] }, /запрещённая тема|обещание/],
    ['«сертификат»', { swapNote: 'Выдаёт сертификат о прохождении упражнения.' }, /запрещённая тема/],
    ['published без проверки техники', { techniqueReview: null }, /проверка техники специалистом/],
    ['проверка техники без даты', { techniqueReview: { by: 'тренер', at: 'вчера' } }, /techniqueReview\.at/],
    ['проверка техники без автора', { techniqueReview: { by: '', at: '2026-11-08' } }, /techniqueReview\.by/],
    ['версия содержимого не число', { contentVersion: 0 }, /contentVersion/]
  ];
  for (const [name, over, re] of bad) it(name, () => { expect(validateCard(good(over), ctx).join('\n')).toMatch(re); });

  it('источник без лицензии, с чужой лицензией и без https отклоняется', () => {
    expect(validateSources([{ ...goodSource }], '2026-11-08')).toEqual([]);
    expect(validateSources([{ ...goodSource, license: '' }]).join()).toMatch(/лицензия/);
    expect(validateSources([{ ...goodSource, license: 'All-Rights-Reserved' }]).join()).toMatch(/не разрешена/);
    expect(validateSources([{ ...goodSource, url: 'http://example.org' }]).join()).toMatch(/https/);
    expect(validateSources([{ ...goodSource, retrievedAt: '08.11.2026' }]).join()).toMatch(/дата/);
    expect(validateSources([{ ...goodSource }, { ...goodSource }]).join()).toMatch(/повтор/);
    expect(ALLOWED_LICENSES).not.toContain('CC-BY-NC-4.0');
  });

  it('справочник мышц: повтор, неизвестная группа, плохая сторона', () => {
    const m = (over: Partial<Muscle>): Muscle => ({ id: 'x-muscle', name: 'Х', group: 'chest', side: 'front', ...over });
    expect(validateMuscles([m({}), m({})], Object.keys(MUSCLE_LABELS)).join()).toMatch(/повтор/);
    expect(validateMuscles([m({ group: 'wings' })], Object.keys(MUSCLE_LABELS)).join()).toMatch(/группа/);
    expect(validateMuscles([m({ side: 'left' as never })], Object.keys(MUSCLE_LABELS)).join()).toMatch(/side/);
  });
});

describe('принципы («почему так»)', () => {
  const pctx = { sourceIds: new Set(['wiki-bench', ...sources.map((s) => s.id)]) };
  const goodP = (over: Partial<Principle> = {}): Principle => ({ id: 'progressive-overload', title: 'Прогрессивная нагрузка', summary: 'Нагрузка должна понемногу расти, чтобы был прогресс.', points: ['Меняй один параметр за раз.', 'Шаги небольшие.'], sources: ['wiki-bench'], status: 'published', reviewedAt: '2026-11-08', contentVersion: 1, ...over });

  it('12 тем из ROADMAP на диске проходят проверку, файл назван по id', () => {
    expect(principles).toHaveLength(12);
    pfiles.forEach((f, i) => expect(f).toBe(`${principles[i].id}.json`));
    for (const p of principles) expect(validatePrinciple(p, pctx), p.id).toEqual([]);
    expect(principles.map((p) => p.id)).toEqual(expect.arrayContaining(['progressive-overload', 'rest-between-sets', 'heavy-session', 'effort-reps-in-reserve', 'deload-week', 'movement-variety']));
  });
  it('хороший принцип проходит', () => { expect(validatePrinciple(goodP(), pctx)).toEqual([]); });
  const bad: [string, Partial<Principle>, RegExp][] = [
    ['id как у упражнения', { id: 'seed-001' }, /seed-/],
    ['плохой id', { id: 'Прогрессия' }, /id/],
    ['одна точка вместо 2–4', { points: ['Только одна.'] }, /points/],
    ['источника нет', { sources: ['nowhere'] }, /нет в sources\.json/],
    ['published без источника', { sources: [] }, /без источника/],
    ['published без даты', { reviewedAt: null }, /reviewedAt/],
    ['черновик с датой', { status: 'draft' }, /null/],
    ['диета и добавки', { summary: 'Помогает правильная диета и спортивные добавки каждый день.' }, /запрещённая тема/],
    ['диагноз', { points: ['Так можно поставить диагноз по боли.', 'Ещё один пункт.'] }, /запрещённая тема/]
  ];
  for (const [name, over, re] of bad) it(name, () => { expect(validatePrinciple(goodP(over), pctx).join('\n')).toMatch(re); });

  it('в сборку идут только опубликованные принципы; их источники тоже', () => {
    const notes = [goodP(), goodP({ id: 'warm-up', status: 'draft', reviewedAt: null, sources: [] })];
    const b = buildBundle([], muscles, [goodSource], { principles: notes });
    expect(Object.keys(b.principles)).toEqual(['progressive-overload']);
    expect(Object.keys(b.sources)).toEqual(['wiki-bench']);
    expect(Object.keys(buildBundle([], muscles, [goodSource], { principles: notes, preview: true }).principles)).toEqual(['progressive-overload', 'warm-up']);
  });
});

describe('сборка: только опубликованное', () => {
  const set = [good({ id: 'seed-001' }), good({ id: 'seed-005', status: 'reviewed' }), good({ id: 'seed-010', status: 'draft', reviewedAt: null, sources: [] })];
  const unused: Source = { ...goodSource, id: 'unused' };

  it('draft и reviewed в сборку не попадают', () => {
    const b = buildBundle(set, muscles, [goodSource, unused]);
    expect(Object.keys(b.cards)).toEqual(['seed-001']);
    expect(b.preview).toBe(false);
  });

  it('в сборку идут только использованные источники и названия мышц', () => {
    const b = buildBundle(set, muscles, [goodSource, unused]);
    expect(Object.keys(b.sources)).toEqual(['wiki-bench']);
    expect(b.muscles['pectoralis-major']).toBe('Большая грудная мышца');
    expect(Object.keys(b.muscles).length).toBeLessThan(muscles.length);
  });

  it('предпросмотр включает всё, но помечен preview', () => {
    const b = buildBundle(set, muscles, [goodSource], { preview: true });
    expect(Object.keys(b.cards)).toEqual(['seed-001', 'seed-005', 'seed-010']);
    expect(b.preview).toBe(true);
  });

  it('сборка без карточек работает и пуста', () => {
    expect(buildBundle([], muscles, sources)).toEqual({ schema: 1, preview: false, muscles: {}, sources: {}, cards: {}, muscleGroups: {}, principles: {}, courses: {} });
  });

  it('закоммиченный bundle собран без черновиков и содержит опубликованный справочник', () => {
    const b = JSON.parse(readFileSync(new URL('../../src/content/bundle.generated.json', import.meta.url), 'utf8'));
    expect(b.preview).toBe(false);
    expect(Object.keys(b.cards)).toHaveLength(32);
    expect(Object.keys(b.principles)).toHaveLength(12);
    expect(Object.keys(b.courses ?? {})).toEqual([]);
    for (const c of Object.values(b.cards) as Card[]) expect(c.status).toBe('published');
    for (const p of Object.values(b.principles) as Principle[]) expect(p.status).toBe('published');
  });
});

describe('справочник в интерфейсе', () => {
  const cat = makeCatalog(buildBundle([good()], muscles, [goodSource]));
  it('карточка есть у стартового упражнения, у своего и неизвестного — нет', () => {
    expect(cat.has('seed-001')).toBe(true);
    expect(cat.has('seed-002')).toBe(false);
    expect(cat.has('c4f2-custom-uid')).toBe(false);
    expect(cat.has(undefined)).toBe(false);
    expect(cat.card('seed-002')).toBeNull();
  });
  it('названия мышц и источники подставляются; строка про образовательный характер задана', () => {
    const c = cat.card('seed-001')!;
    expect(cat.muscleNames(c.primaryMuscles)).toContain('Большая грудная мышца');
    expect(cat.sourcesOf(c).map((s) => s.license)).toEqual(['CC-BY-SA-4.0']);
    expect(cat.allSources()).toHaveLength(1);
    expect(EDU_NOTICE).toBe('Образовательная информация, не медицинская рекомендация.');
  });
});

describe('правила из content/rules.json', () => {
  it('приложение и конвейер знаний читают один файл: лимиты, лицензии и запрещённые темы совпадают', async () => {
    const rules = (await import('../../content/rules.json')).default;
    expect(ALLOWED_LICENSES).toEqual(rules.allowedLicenses);
    expect(LIMITS).toEqual(rules.limits);
    expect(FORBIDDEN).toHaveLength(rules.forbidden.length);
    expect(FORBIDDEN.every((re) => re.flags === 'i')).toBe(true);
    expect(FORBIDDEN[2].test('нужен протеин')).toBe(true);
    expect(FORBIDDEN[2].test('жим штанги')).toBe(false);
  });
});
