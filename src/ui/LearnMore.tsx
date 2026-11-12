import { go } from '../state/router';

/** Ссылки «Узнать больше» из карточек и решений приложения. Пусто, если уроков про это нет. */
export function LearnMore({ lessons, onNavigate }: { lessons: { courseId: string; courseTitle: string; lesson: { id: string; title: string } }[]; onNavigate?: () => void }) {
  if (lessons.length === 0) return null;
  return (
    <div className="learn-more" data-testid="learn-more">
      <h4>Узнать больше</h4>
      {lessons.map((r) => <button key={r.courseId + r.lesson.id} className="link-btn" onClick={() => { onNavigate?.(); go(`learn/${r.courseId}/${r.lesson.id}`); }}>Урок «{r.lesson.title}»</button>)}
    </div>
  );
}
