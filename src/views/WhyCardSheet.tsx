import { catalog as defaultCatalog, type Catalog } from '../content/catalog';
import { EDU_NOTICE } from '../content/types';
import { Sheet } from '../ui/Sheet';
import { openExternal } from '../ui/openExternal';
import { IconInfo } from '../ui/Icons';
import { LearnMore } from '../ui/LearnMore';

/** Кнопка ⓘ: показывается только у упражнений, для которых есть карточка. Для своих упражнений её нет. */
export function WhyButton({ exerciseId, name, onOpen, catalog = defaultCatalog }: { exerciseId: string | undefined; name: string; onOpen: () => void; catalog?: Catalog }) {
  if (!catalog.has(exerciseId)) return null;
  return (
    <button className="info-btn" aria-label={`Зачем это: ${name}`} onClick={onOpen}><IconInfo size={18} /></button>
  );
}

function List({ items }: { items: string[] }) {
  return <ul className="why-list">{items.map((t) => <li key={t}>{t}</li>)}</ul>;
}

/** Шторка «Зачем это»: короткая карточка упражнения. Работает без сети: содержимое входит в сборку. */
export function WhyCardSheet({ exerciseId, name, onClose, catalog = defaultCatalog }: { exerciseId: string; name: string; onClose: () => void; catalog?: Catalog }) {
  const card = catalog.card(exerciseId);
  if (!card) return null;
  const sources = catalog.sourcesOf(card);
  const unpublished = card.status !== 'published';
  return (
    <Sheet title="Зачем это" onClose={onClose}>
      <div className="why-card" data-testid="why-card">
        <h3 className="why-name">{name}</h3>
        {unpublished && <p className="why-draft" role="note">{card.status === 'draft' ? 'Черновик: текст ещё не проверен человеком.' : 'Проверено, но ещё не опубликовано.'} Виден только в предпросмотре.</p>}
        <p className="why-summary">{card.summary}</p>

        <h4>Какие мышцы работают</h4>
        <p><b>Основные:</b> {catalog.muscleNames(card.primaryMuscles).join(', ')}.</p>
        {card.secondaryMuscles.length > 0 && <p><b>Помогают:</b> {catalog.muscleNames(card.secondaryMuscles).join(', ')}.</p>}
        <p className="sub">{card.function}</p>

        <h4>Подсказки по технике</h4>
        <List items={card.cues} />

        <h4>Типичные ошибки</h4>
        <List items={card.mistakes} />

        <h4>Чем заменить</h4>
        <p>{card.swapNote}</p>
        <LearnMore lessons={catalog.lessonsForExercise(exerciseId)} onNavigate={onClose} />

        <div className="why-foot">
          <p className="why-notice">{EDU_NOTICE}</p>
          {sources.length > 0 ? (
            <p className="why-src" data-testid="why-sources">
              Источники:{' '}
              {sources.map((s, i) => (
                <span key={s.id}>{i > 0 && '; '}<button className="link-btn" onClick={() => void openExternal(s.url)}>{s.title}</button>, {s.author}, {s.license}</span>
              ))}.
            </p>
          ) : (
            <p className="why-src" data-testid="why-sources">Источник пока не указан.</p>
          )}
          {card.reviewedAt && <p className="why-src">Проверено человеком: {card.reviewedAt}.</p>}
          {card.techniqueReview && <p className="why-src" data-testid="why-technique">Подсказки по технике и ошибки проверил: {card.techniqueReview.by}, {card.techniqueReview.at}.</p>}
        </div>
      </div>
    </Sheet>
  );
}
