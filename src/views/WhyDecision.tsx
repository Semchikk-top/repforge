import { useState } from 'react';
import { catalog as defaultCatalog, type Catalog } from '../content/catalog';
import { EDU_NOTICE } from '../content/types';
import { principleOf, renderWhy, type Why } from '../domain/explain';
import { IconInfo } from '../ui/Icons';
import { Sheet } from '../ui/Sheet';
import { LearnMore } from '../ui/LearnMore';
import { openExternal } from '../ui/openExternal';

/** Шторка «Почему так»: слой 1 — факт из твоих данных (считает код), слой 2 — принцип из справочника, если он опубликован. */
export function WhyDecisionSheet({ whys, onClose, catalog = defaultCatalog }: { whys: Why[]; onClose: () => void; catalog?: Catalog }) {
  const ids = [...new Set(whys.map(principleOf))];
  const notes = ids.map((id) => catalog.principle(id)).filter((p): p is NonNullable<typeof p> => p !== null);
  return (
    <Sheet title="Почему так" onClose={onClose}>
      <div className="why-card" data-testid="why-decision">
        {whys.map((w, i) => <p key={i} className="why-fact" data-testid="why-fact">{renderWhy(w)}</p>)}
        {notes.map((n) => {
          const sources = catalog.principleSources(n);
          return (
            <section key={n.id} className="why-principle" data-testid="why-principle">
              <h4>Принцип: {n.title}</h4>
              {n.status !== 'published' && <p className="why-draft" role="note">{n.status === 'draft' ? 'Черновик: текст ещё не проверен человеком.' : 'Проверено, но ещё не опубликовано.'} Виден только в предпросмотре.</p>}
              <p>{n.summary}</p>
              <ul className="why-list">{n.points.map((t) => <li key={t}>{t}</li>)}</ul>
              {sources.length > 0 && (
                <p className="why-src">Источники:{' '}
                  {sources.map((s, i) => <span key={s.id}>{i > 0 && '; '}<button className="link-btn" onClick={() => void openExternal(s.url)}>{s.title}</button>, {s.author}, {s.license}</span>)}.
                </p>
              )}
            </section>
          );
        })}
        <LearnMore lessons={ids.flatMap((id) => catalog.lessonsForPrinciple(id))} onNavigate={onClose} />
        {notes.length > 0 && <div className="why-foot"><p className="why-notice">{EDU_NOTICE}</p></div>}
      </div>
    </Sheet>
  );
}

/** Кнопка ⓘ рядом с решением приложения. Ничего не показывает сама: открывается только по нажатию. */
export function WhyDecisionButton({ whys, label, catalog }: { whys: (Why | null)[]; label: string; catalog?: Catalog }) {
  const [open, setOpen] = useState(false);
  const list = whys.filter((w): w is Why => w !== null);
  if (list.length === 0) return null;
  return (
    <>
      <button className="info-btn" aria-label={`Почему так: ${label}`} onClick={() => setOpen(true)}><IconInfo size={18} /></button>
      {open && <WhyDecisionSheet whys={list} onClose={() => setOpen(false)} catalog={catalog} />}
    </>
  );
}
