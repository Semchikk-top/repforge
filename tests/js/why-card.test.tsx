import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildBundle } from '../../src/content/build';
import { makeCatalog } from '../../src/content/catalog';
import type { Card, Muscle, Source } from '../../src/content/types';
import { WhyButton, WhyCardSheet } from '../../src/views/WhyCardSheet';

const muscles: Muscle[] = [
  { id: 'pectoralis-major', name: 'Большая грудная мышца', group: 'chest', side: 'front' },
  { id: 'triceps-brachii', name: 'Трёхглавая мышца плеча (трицепс)', group: 'triceps', side: 'back' }
];
const src: Source = { id: 's1', title: 'Жим лёжа (статья)', author: 'Авторы Википедии', url: 'https://example.org/a', license: 'CC-BY-SA-4.0', retrievedAt: '2026-11-08' };
const card = (over: Partial<Card> = {}): Card => ({
  id: 'seed-001', summary: 'Базовое жимовое движение для груди и трицепсов.', primaryMuscles: ['pectoralis-major'], secondaryMuscles: ['triceps-brachii'],
  function: 'Горизонтальное приведение плеча.', cues: ['Лопатки сведены.', 'Стопы в пол.'], mistakes: ['Отрыв таза.', 'Отбив от груди.'], swapNote: 'Жим гантелей.',
  sources: ['s1'], status: 'published', reviewedAt: '2026-11-08', contentVersion: 1, ...over
});
const cat = makeCatalog(buildBundle([card()], muscles, [src]));

describe('кнопка ⓘ', () => {
  it('есть у упражнения с карточкой', () => {
    const html = renderToStaticMarkup(<WhyButton exerciseId="seed-001" name="Жим штанги лёжа" onOpen={() => {}} catalog={cat} />);
    expect(html).toContain('aria-label="Зачем это: Жим штанги лёжа"');
  });
  it('нет у упражнения без карточки, у своего и без id', () => {
    for (const id of ['seed-002', 'my-custom-1', undefined]) expect(renderToStaticMarkup(<WhyButton exerciseId={id} name="X" onOpen={() => {}} catalog={cat} />)).toBe('');
  });
});

describe('шторка «Зачем это»', () => {
  const html = renderToStaticMarkup(<WhyCardSheet exerciseId="seed-001" name="Жим штанги лёжа" onClose={() => {}} catalog={cat} />);
  it('показывает суть, мышцы, технику, ошибки и замену', () => {
    for (const t of ['Жим штанги лёжа', 'Базовое жимовое движение', 'Большая грудная мышца', 'Трёхглавая мышца плеча', 'Лопатки сведены.', 'Отрыв таза.', 'Жим гантелей.']) expect(html).toContain(t);
  });
  it('внизу источник, автор, лицензия и строка про образовательный характер', () => {
    expect(html).toContain('data-testid="why-sources"');
    for (const t of ['Жим лёжа (статья)', 'Авторы Википедии', 'CC-BY-SA-4.0', 'Образовательная информация, не медицинская рекомендация.', 'Проверено человеком: 2026-11-08']) expect(html).toContain(t);
  });
  it('показывает, кто проверил технику', () => {
    const c = makeCatalog(buildBundle([card({ techniqueReview: { by: 'тренер Иван', at: '2026-11-09' } })], muscles, [src]));
    const h = renderToStaticMarkup(<WhyCardSheet exerciseId="seed-001" name="Жим" onClose={() => {}} catalog={c} />);
    expect(h).toContain('data-testid="why-technique"');
    expect(h).toContain('тренер Иван, 2026-11-09');
    expect(html).not.toContain('why-technique');
  });
  it('опубликованная карточка без пометки «черновик»; черновик в предпросмотре помечен', () => {
    expect(html).not.toContain('Черновик');
    const draft = makeCatalog(buildBundle([card({ status: 'draft', reviewedAt: null, sources: [] })], muscles, [src], { preview: true }));
    const h = renderToStaticMarkup(<WhyCardSheet exerciseId="seed-001" name="Жим" onClose={() => {}} catalog={draft} />);
    expect(h).toContain('Черновик: текст ещё не проверен человеком');
    expect(h).toContain('Источник пока не указан');
  });
  it('нет карточки: шторка ничего не рисует', () => {
    expect(renderToStaticMarkup(<WhyCardSheet exerciseId="seed-002" name="X" onClose={() => {}} catalog={cat} />)).toBe('');
  });
});

describe('правовая информация', () => {
  it('содержит блок про образовательный характер и (пока нет карточек) пометку про источники', async () => {
    const { LegalView } = await import('../../src/views/LegalView');
    const html = renderToStaticMarkup(<LegalView />);
    expect(html).toContain('data-testid="legal-edu"');
    expect(html).toContain('Образовательная информация, не медицинская рекомендация.');
    expect(html).toContain('не заменяют тренера или врача');
  });
});
