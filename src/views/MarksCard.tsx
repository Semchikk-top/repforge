import { useLiveQuery } from 'dexie-react-hooks';
import { catalog as defaultCatalog, type Catalog } from '../content/catalog';
import { db } from '../db/db';
import { courseMark, isOutdatedMark, MARK_NOTICE } from '../domain/learning';
import type { LearningAttempt } from '../domain/types';
import { go } from '../state/router';

/** Блок в профиле: отметки о прохождении. Отдельно от наград и магазина; показывается только если есть курсы. */
export function MarksCard({ catalog = defaultCatalog }: { catalog?: Catalog }) {
  const attempts = useLiveQuery(() => db.learning.toArray().then((r) => r.filter((x) => !x.deletedAt)), [], [] as LearningAttempt[]);
  const courses = catalog.courses();
  if (courses.length === 0) return null;
  return (
    <div className="section" data-testid="marks-card">
      <h2>Знания</h2>
      {courses.map(({ course }) => {
        const m = courseMark(attempts, course.id);
        return (
          <button key={course.id} className="row" onClick={() => go(`learn/${course.id}`)}>
            <div className="grow"><div className="title">{course.title}</div>
              <div className="meta">{m.passed ? `Отметка о прохождении: ${m.firstPassedAt}${isOutdatedMark(m, course.contentVersion) ? ' (курс обновлён)' : ''}` : m.attempts ? `Попыток: ${m.attempts}, отметки пока нет` : 'Не начат'}</div></div>
          </button>
        );
      })}
      <p className="why-notice">{MARK_NOTICE}</p>
    </div>
  );
}

